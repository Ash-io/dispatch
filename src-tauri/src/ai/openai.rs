//! OpenAI's Chat Completions API, and servers that copy it (OpenRouter, Groq,
//! LM Studio, vLLM and others): same client, different base URL.

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

use super::stream::{self, Flow};
use super::{body_message, client, AiEvent, Answer, Ask, Kind, Model};

fn api_error(kind: Kind, status: reqwest::StatusCode, body: &str) -> String {
    let who = if kind == Kind::Openai { "OpenAI" } else { "The server" };
    let msg = body_message(body);
    match status.as_u16() {
        401 | 403 => format!("{who} rejected the API key. Check it under Settings → AI assistant."),
        404 => format!("{who} returned 404: {msg}. Check the address and model under Settings → AI assistant."),
        429 => format!("Rate limited by {}: {msg}", if kind == Kind::Openai { "OpenAI" } else { "the server" }),
        _ => format!("{who} returned an error {}: {msg}", status.as_u16()),
    }
}

fn unreachable(kind: Kind, base: &str, e: reqwest::Error) -> String {
    if kind == Kind::Openai {
        format!("Couldn't reach OpenAI: {e}")
    } else {
        format!("Couldn't reach {base}: {e}")
    }
}

fn authed(req: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
    match key {
        Some(k) if !k.is_empty() => req.bearer_auth(k),
        _ => req,
    }
}

/// Model ids that can't hold a chat: embeddings, speech, images, moderation and the like.
pub fn is_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    const NOT_CHAT: [&str; 13] = ["embed", "tts", "whisper", "dall-e", "gpt-image", "moderation", "transcribe", "realtime", "audio", "davinci", "babbage", "sora", "rerank"];
    !NOT_CHAT.iter().any(|w| id.contains(w))
}

pub async fn list_models(kind: Kind, base: &str, key: Option<&str>) -> Result<Vec<Model>, String> {
    let resp = authed(client(Duration::from_secs(30))?.get(format!("{base}/models")), key).send().await.map_err(|e| unreachable(kind, base, e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error(kind, status, &body));
    }
    let v: Value = serde_json::from_str(&body).map_err(|_| format!("{base}/models didn't return a model list. Check the address: it usually ends in /v1."))?;
    let Some(list) = v["data"].as_array() else {
        return Err(format!("{base}/models didn't return a model list. Check the address: it usually ends in /v1."));
    };
    let mut models: Vec<(i64, Model)> = list
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            let name = m["name"].as_str().filter(|n| *n != id).map(String::from);
            Some((m["created"].as_i64().unwrap_or(0), Model { id, name, detail: None }))
        })
        .filter(|(_, m)| is_chat_model(&m.id))
        .collect();
    // Newest first, then by name, so the picker opens on current models.
    models.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    Ok(models.into_iter().map(|(_, m)| m).collect())
}

pub fn request_body(ask: &Ask, structured: bool) -> Value {
    let mut system = ask.system.clone();
    let mut body = json!({
        "model": ask.model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_tokens": 8192,
    });
    if let Some(schema) = &ask.schema {
        if structured {
            body["response_format"] = json!({ "type": "json_schema", "json_schema": { "name": "answer", "strict": true, "schema": schema } });
        } else {
            system.push_str(&format!("\n\nReply with only a JSON object matching this JSON Schema, with no other text:\n{schema}"));
        }
    }
    body["messages"] = json!([{ "role": "system", "content": system }, { "role": "user", "content": ask.prompt }]);
    body
}

pub async fn ask(kind: Kind, base: &str, key: Option<&str>, ask: Ask, cancel: Arc<Notify>, on_event: impl Fn(AiEvent)) -> Result<Answer, String> {
    let http = client(Duration::from_secs(300))?;
    let send = |structured: bool| authed(http.post(format!("{base}/chat/completions")), key).json(&request_body(&ask, structured)).send();
    let mut resp = send(true).await.map_err(|e| unreachable(kind, base, e))?;
    // Some compatible servers don't take json_schema; fall back to asking in the prompt.
    if ask.schema.is_some() && kind == Kind::Compatible && resp.status().as_u16() == 400 {
        resp = send(false).await.map_err(|e| unreachable(kind, base, e))?;
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(kind, status, &resp.text().await.unwrap_or_default()));
    }
    let mut answer = Answer { model: ask.model.clone(), ..Default::default() };
    let mut refusal = String::new();
    stream::sse(resp, cancel, |data| {
        if data.trim() == "[DONE]" {
            return Ok(Flow::Done);
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(Flow::More) };
        if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
            return Err(format!("{} error: {}", if kind == Kind::Openai { "OpenAI" } else { "Server" }, e["message"].as_str().unwrap_or("unknown")));
        }
        if let Some(m) = v["model"].as_str() {
            answer.model = m.to_string();
        }
        if let Some(choice) = v["choices"].get(0) {
            if let Some(text) = choice["delta"]["content"].as_str().filter(|t| !t.is_empty()) {
                answer.text.push_str(text);
                on_event(AiEvent::Text { text: text.to_string() });
            }
            if let Some(r) = choice["delta"]["refusal"].as_str() {
                refusal.push_str(r);
            }
            if let Some(r) = choice["finish_reason"].as_str() {
                answer.stop_reason = r.to_string();
            }
        }
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            answer.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(answer.input_tokens);
            answer.output_tokens = u["completion_tokens"].as_u64().unwrap_or(answer.output_tokens);
        }
        Ok(Flow::More)
    })
    .await?;
    if !refusal.is_empty() {
        return Err(format!("The model declined this request: {refusal}"));
    }
    if answer.stop_reason == "length" {
        answer.text.push_str("\n\n(The answer hit the length limit and was cut off.)");
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::super::stream::testing::server;
    use super::*;

    fn ask_for(schema: Option<Value>) -> Ask {
        Ask { provider: Kind::Openai, model: "gpt-5".into(), system: "sys".into(), prompt: "hi".into(), schema }
    }

    #[test]
    fn filters_non_chat_models() {
        for id in ["gpt-5", "gpt-4.1-mini", "o3", "llama-3.3-70b-versatile", "anthropic/claude-opus-5"] {
            assert!(is_chat_model(id), "{id}");
        }
        for id in ["text-embedding-3-large", "tts-1", "whisper-1", "dall-e-3", "gpt-image-1", "omni-moderation-latest", "gpt-4o-transcribe", "gpt-4o-realtime-preview", "gpt-4o-audio-preview"] {
            assert!(!is_chat_model(id), "{id}");
        }
    }

    #[test]
    fn body_shape() {
        let schema = json!({ "type": "object", "properties": {}, "required": [], "additionalProperties": false });
        let b = request_body(&ask_for(Some(schema.clone())), true);
        assert_eq!(b["model"], "gpt-5");
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "hi");
        assert_eq!(b["response_format"]["json_schema"]["strict"], true);
        let plain = request_body(&ask_for(Some(schema)), false);
        assert!(plain.get("response_format").is_none());
        assert!(plain["messages"][0]["content"].as_str().unwrap().contains("JSON Schema"));
    }

    #[tokio::test]
    async fn streams_text_and_usage() {
        let body = [
            r#"data: {"id":"c1","model":"gpt-5-2026","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#,
            r#"data: {"id":"c1","model":"gpt-5-2026","choices":[{"index":0,"delta":{"content":"pm.test("}}]}"#,
            r#"data: {"id":"c1","model":"gpt-5-2026","choices":[{"index":0,"delta":{"content":"'ok')"},"finish_reason":"stop"}]}"#,
            r#"data: {"id":"c1","model":"gpt-5-2026","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}"#,
            "data: [DONE]",
        ]
        .join("\n\n")
            + "\n\n";
        let (url, seen) = server("text/event-stream", 200, body);
        let a = ask(Kind::Openai, &url, Some("sk-test"), ask_for(None), Default::default(), |_| {}).await.unwrap();
        assert_eq!(a.text, "pm.test('ok')");
        assert_eq!((a.model.as_str(), a.stop_reason.as_str(), a.input_tokens, a.output_tokens), ("gpt-5-2026", "stop", 9, 4));
        let req = seen.recv().unwrap().to_lowercase();
        assert!(req.starts_with("post /chat/completions") && req.contains("authorization: bearer sk-test"));
    }

    #[tokio::test]
    async fn lists_chat_models_newest_first() {
        let (url, seen) = server("application/json", 200, r#"{"object":"list","data":[{"id":"gpt-4.1","created":100},{"id":"text-embedding-3-small","created":300},{"id":"gpt-5","created":200}]}"#.into());
        let m = list_models(Kind::Compatible, &url, None).await.unwrap();
        assert_eq!(m.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gpt-5", "gpt-4.1"]);
        assert!(!seen.recv().unwrap().to_lowercase().contains("authorization"), "no key, no header");
    }

    #[tokio::test]
    async fn wrong_address_is_explained() {
        let (url, _) = server("text/html", 200, "<html>hello</html>".into());
        assert!(list_models(Kind::Compatible, &url, None).await.unwrap_err().contains("usually ends in /v1"));
    }
}
