//! Ollama's native API, both on this machine and Ollama Cloud (ollama.com with
//! a Bearer key). Answers stream as newline-delimited JSON.

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

use super::stream::{self, Flow};
use super::{body_message, client, AiEvent, Answer, Ask, Kind, Model};

fn who(kind: Kind) -> &'static str {
    if kind == Kind::OllamaCloud { "Ollama Cloud" } else { "Ollama" }
}

fn api_error(kind: Kind, status: reqwest::StatusCode, body: &str) -> String {
    let msg = body_message(body);
    match status.as_u16() {
        401 | 403 => format!("{} rejected the API key. Check it under Settings → AI assistant.", who(kind)),
        404 => format!("{}: {msg}. Refresh the model list under Settings → AI assistant.", who(kind)),
        429 => format!("Rate limited by {}: {msg}", who(kind)),
        _ => format!("{} returned an error {}: {msg}", who(kind), status.as_u16()),
    }
}

fn unreachable(kind: Kind, base: &str, e: reqwest::Error) -> String {
    if kind == Kind::Ollama {
        format!("Couldn't reach Ollama at {base}. Check that it's running (ollama serve) and the address is right. ({e})")
    } else {
        format!("Couldn't reach Ollama Cloud: {e}")
    }
}

fn authed(req: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
    match key {
        Some(k) if !k.is_empty() => req.bearer_auth(k),
        _ => req,
    }
}

fn size_label(bytes: u64) -> String {
    let gb = bytes as f64 / 1e9;
    if gb >= 1.0 { format!("{gb:.1} GB") } else { format!("{:.0} MB", bytes as f64 / 1e6) }
}

pub async fn list_models(kind: Kind, base: &str, key: Option<&str>) -> Result<Vec<Model>, String> {
    let resp = authed(client(Duration::from_secs(30))?.get(format!("{base}/api/tags")), key).send().await.map_err(|e| unreachable(kind, base, e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error(kind, status, &body));
    }
    let v: Value = serde_json::from_str(&body).map_err(|_| format!("{base} didn't answer like Ollama. Check the address."))?;
    let Some(list) = v["models"].as_array() else {
        return Err(format!("{base} didn't answer like Ollama. Check the address."));
    };
    let models: Vec<Model> = list
        .iter()
        .filter_map(|m| {
            let id = m["model"].as_str().or(m["name"].as_str())?.to_string();
            if id.to_ascii_lowercase().contains("embed") {
                return None;
            }
            let d = &m["details"];
            let mut parts: Vec<String> = Vec::new();
            if let Some(p) = d["parameter_size"].as_str().filter(|s| !s.is_empty()) {
                parts.push(p.to_string());
            }
            if let Some(q) = d["quantization_level"].as_str().filter(|s| !s.is_empty()) {
                parts.push(q.to_string());
            }
            if kind == Kind::Ollama {
                if let Some(size) = m["size"].as_u64().filter(|s| *s > 0) {
                    parts.push(size_label(size));
                }
            }
            Some(Model { id, name: None, detail: (!parts.is_empty()).then(|| parts.join(" · ")) })
        })
        .collect();
    if models.is_empty() && kind == Kind::Ollama {
        return Err("Ollama is running but has no chat models yet. Pull one first, for example: ollama pull llama3.2".into());
    }
    Ok(models)
}

pub fn request_body(ask: &Ask) -> Value {
    let mut body = json!({
        "model": ask.model,
        "stream": true,
        "messages": [{ "role": "system", "content": ask.system }, { "role": "user", "content": ask.prompt }],
    });
    if let Some(schema) = &ask.schema {
        body["format"] = schema.clone();
    }
    body
}

pub async fn ask(kind: Kind, base: &str, key: Option<&str>, ask: Ask, cancel: Arc<Notify>, on_event: impl Fn(AiEvent)) -> Result<Answer, String> {
    // Local models can take a while to load before the first token.
    let resp = authed(client(Duration::from_secs(600))?.post(format!("{base}/api/chat")), key)
        .json(&request_body(&ask))
        .send()
        .await
        .map_err(|e| unreachable(kind, base, e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(kind, status, &resp.text().await.unwrap_or_default()));
    }
    let mut answer = Answer { model: ask.model.clone(), ..Default::default() };
    stream::lines(resp, cancel, |line| {
        if line.trim().is_empty() {
            return Ok(Flow::More);
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Ok(Flow::More) };
        if let Some(e) = v["error"].as_str() {
            return Err(format!("{}: {e}", who(kind)));
        }
        if let Some(text) = v["message"]["content"].as_str().filter(|t| !t.is_empty()) {
            answer.text.push_str(text);
            on_event(AiEvent::Text { text: text.to_string() });
        }
        if v["done"].as_bool() == Some(true) {
            answer.stop_reason = v["done_reason"].as_str().unwrap_or("stop").to_string();
            answer.input_tokens = v["prompt_eval_count"].as_u64().unwrap_or(0);
            answer.output_tokens = v["eval_count"].as_u64().unwrap_or(0);
            return Ok(Flow::Done);
        }
        Ok(Flow::More)
    })
    .await?;
    if answer.stop_reason == "length" {
        answer.text.push_str("\n\n(The answer hit the length limit and was cut off.)");
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::super::stream::testing::server;
    use super::*;

    #[tokio::test]
    async fn lists_local_models_with_detail() {
        let (url, seen) = server("application/json", 200, r#"{"models":[{"name":"llama3.2:latest","model":"llama3.2:latest","size":2019393189,"details":{"parameter_size":"3.2B","quantization_level":"Q4_K_M"}},{"name":"nomic-embed-text:latest","model":"nomic-embed-text:latest","size":274302450,"details":{}}]}"#.into());
        let m = list_models(Kind::Ollama, &url, None).await.unwrap();
        assert_eq!(m, vec![Model { id: "llama3.2:latest".into(), name: None, detail: Some("3.2B · Q4_K_M · 2.0 GB".into()) }]);
        let req = seen.recv().unwrap().to_lowercase();
        assert!(req.starts_with("get /api/tags") && !req.contains("authorization"));
    }

    #[tokio::test]
    async fn cloud_sends_the_key() {
        let (url, seen) = server("application/json", 200, r#"{"models":[{"name":"gpt-oss:120b","model":"gpt-oss:120b","size":65000000000,"details":{"parameter_size":"116.8B"}}]}"#.into());
        let m = list_models(Kind::OllamaCloud, &url, Some("ok-key")).await.unwrap();
        assert_eq!(m[0].detail.as_deref(), Some("116.8B"), "cloud models don't take local disk space");
        assert!(seen.recv().unwrap().to_lowercase().contains("authorization: bearer ok-key"));
    }

    #[tokio::test]
    async fn empty_local_install_says_what_to_do() {
        let (url, _) = server("application/json", 200, r#"{"models":[]}"#.into());
        assert!(list_models(Kind::Ollama, &url, None).await.unwrap_err().contains("ollama pull"));
    }

    #[tokio::test]
    async fn streams_ndjson() {
        let body = [
            r#"{"model":"llama3.2","message":{"role":"assistant","content":"pm.test("},"done":false}"#,
            r#"{"model":"llama3.2","message":{"role":"assistant","content":"'ok')"},"done":false}"#,
            r#"{"model":"llama3.2","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":20,"eval_count":6}"#,
        ]
        .join("\n")
            + "\n";
        let (url, seen) = server("application/x-ndjson", 200, body);
        let schema = json!({ "type": "object" });
        let a = ask(Kind::Ollama, &url, None, Ask { provider: Kind::Ollama, model: "llama3.2".into(), system: "s".into(), prompt: "p".into(), schema: Some(schema) }, Default::default(), |_| {}).await.unwrap();
        assert_eq!(a.text, "pm.test('ok')");
        assert_eq!((a.stop_reason.as_str(), a.input_tokens, a.output_tokens), ("stop", 20, 6));
        let req = seen.recv().unwrap();
        assert!(req.contains("\"format\":{\"type\":\"object\"}"));
    }

    #[tokio::test]
    async fn missing_model_is_explained() {
        let (url, _) = server("application/json", 404, r#"{"error":"model \"nope\" not found, try pulling it first"}"#.into());
        let e = ask(Kind::Ollama, &url, None, Ask { provider: Kind::Ollama, model: "nope".into(), system: "s".into(), prompt: "p".into(), schema: None }, Default::default(), |_| {}).await.unwrap_err();
        assert!(e.contains("not found") && e.contains("Refresh the model list"), "{e}");
    }
}
