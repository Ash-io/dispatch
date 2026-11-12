//! Anthropic's Messages API. Rust has no official Anthropic SDK, so this is
//! the documented raw HTTP + SSE shape.

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

use super::stream::{self, Flow};
use super::{body_message, client, AiEvent, Answer, Ask, Model};

const VERSION: &str = "2023-06-01";

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let msg = body_message(body);
    match status.as_u16() {
        401 => "Anthropic rejected the API key. Check it under Settings → AI assistant.".into(),
        404 => format!("Anthropic doesn't recognise that model: {msg}. Refresh the model list under Settings → AI assistant."),
        429 => format!("Rate limited by the Claude API: {msg}"),
        529 => "The Claude API is overloaded right now. Try again in a moment.".into(),
        _ => format!("Claude API error {}: {msg}", status.as_u16()),
    }
}

/// Every model the key can use, newest first, following pagination.
pub async fn list_models(base: &str, key: &str) -> Result<Vec<Model>, String> {
    let http = client(Duration::from_secs(30))?;
    let mut models = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut url = format!("{base}/models?limit=1000");
        if let Some(a) = &after {
            url.push_str(&format!("&after_id={a}"));
        }
        let resp = http.get(url).header("x-api-key", key).header("anthropic-version", VERSION).send().await.map_err(|e| format!("Couldn't reach the Claude API: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(api_error(status, &body));
        }
        let page: Value = serde_json::from_str(&body).map_err(|e| format!("Unexpected model list from Anthropic: {e}"))?;
        let parsed = parse_models(&page);
        let last = page["last_id"].as_str().map(String::from);
        models.extend(parsed);
        if page["has_more"].as_bool() != Some(true) || last.is_none() || last == after {
            break;
        }
        after = last;
    }
    Ok(models)
}

fn parse_models(page: &Value) -> Vec<Model> {
    page["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?.to_string();
                    let name = m["display_name"].as_str().filter(|n| *n != id).map(String::from);
                    Some(Model { id, name, detail: None })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn request_body(ask: &Ask) -> Value {
    let mut body = json!({
        "model": ask.model,
        "max_tokens": 64000,
        "stream": true,
        // On a policy decline, Anthropic re-runs the request on its recommended fallback model.
        "fallbacks": "default",
        "system": ask.system,
        "messages": [{ "role": "user", "content": ask.prompt }],
    });
    if let Some(schema) = &ask.schema {
        body["output_config"] = json!({ "format": { "type": "json_schema", "schema": schema } });
    }
    body
}

pub async fn ask(base: &str, key: &str, ask: Ask, cancel: Arc<Notify>, on_event: impl Fn(AiEvent)) -> Result<Answer, String> {
    // Adaptive thinking can pause before the first text, so allow quiet stretches.
    let resp = client(Duration::from_secs(300))?
        .post(format!("{base}/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", VERSION)
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .json(&request_body(&ask))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the Claude API: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(status, &resp.text().await.unwrap_or_default()));
    }
    let mut answer = Answer { model: ask.model.clone(), ..Default::default() };
    let mut refusal: Option<String> = None;
    stream::sse(resp, cancel, |data| {
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(Flow::More) };
        match v["type"].as_str().unwrap_or("") {
            "message_start" => {
                if let Some(m) = v["message"]["model"].as_str() {
                    answer.model = m.to_string();
                }
                answer.input_tokens = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_delta" if v["delta"]["type"] == "text_delta" => {
                let text = v["delta"]["text"].as_str().unwrap_or("").to_string();
                answer.text.push_str(&text);
                on_event(AiEvent::Text { text });
            }
            "message_delta" => {
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    answer.stop_reason = r.to_string();
                    if r == "refusal" {
                        refusal = Some(v["delta"]["stop_details"]["explanation"].as_str().or(v["stop_details"]["explanation"].as_str()).unwrap_or("").to_string());
                    }
                }
                answer.output_tokens = v["usage"]["output_tokens"].as_u64().unwrap_or(answer.output_tokens);
            }
            "message_stop" => return Ok(Flow::Done),
            "error" => return Err(format!("Claude API error: {}", v["error"]["message"].as_str().unwrap_or("unknown"))),
            _ => {}
        }
        Ok(Flow::More)
    })
    .await?;
    if let Some(why) = refusal {
        return Err(if why.is_empty() { "Claude declined this request.".into() } else { format!("Claude declined this request: {why}") });
    }
    if answer.stop_reason == "max_tokens" {
        answer.text.push_str("\n\n(The answer hit the length limit and was cut off.)");
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::super::stream::testing::server;
    use super::super::Kind;
    use super::*;

    fn ask_for(model: &str, schema: Option<Value>) -> Ask {
        Ask { provider: Kind::Anthropic, model: model.into(), system: "sys".into(), prompt: "hi".into(), schema }
    }

    #[test]
    fn body_shape() {
        let b = request_body(&ask_for("claude-opus-5", Some(json!({ "type": "object", "properties": {}, "required": [], "additionalProperties": false }))));
        assert_eq!(b["model"], "claude-opus-5");
        assert_eq!(b["stream"], true);
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["messages"][0]["content"], "hi");
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert!(b.get("thinking").is_none(), "adaptive thinking is the default on this model");
        assert!(request_body(&ask_for("claude-haiku-5-5", None)).get("output_config").is_none());
        assert_eq!(request_body(&ask_for("claude-haiku-5-5", None))["model"], "claude-haiku-5-5");
    }

    #[tokio::test]
    async fn streams_text_and_reports_usage() {
        let (url, seen) = server("text/event-stream", 200, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":12}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"pm.test(\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"'ok')\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".into());
        let deltas = Arc::new(std::sync::Mutex::new(Vec::new()));
        let d2 = deltas.clone();
        let a = ask(&url, "sk-test", ask_for("claude-opus-5", None), Default::default(), move |AiEvent::Text { text }| d2.lock().unwrap().push(text)).await.unwrap();
        assert_eq!(a.text, "pm.test('ok')");
        assert_eq!(*deltas.lock().unwrap(), vec!["pm.test(".to_string(), "'ok')".to_string()]);
        assert_eq!((a.input_tokens, a.output_tokens, a.stop_reason.as_str()), (12, 7, "end_turn"));
        let req = seen.recv().unwrap().to_lowercase();
        assert!(req.starts_with("post /messages"));
        assert!(req.contains("x-api-key: sk-test") && req.contains("anthropic-version: 2023-06-01") && req.contains("anthropic-beta: server-side-fallback-2026-07-01"));
    }

    #[tokio::test]
    async fn refusals_become_errors() {
        let (url, _) = server("text/event-stream", 200, "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":1}}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"},\"usage\":{\"output_tokens\":0}}\n\n".into());
        let e = ask(&url, "k", ask_for("claude-opus-5", None), Default::default(), |_| {}).await.unwrap_err();
        assert!(e.starts_with("Claude declined"), "{e}");
    }

    #[tokio::test]
    async fn lists_models_across_pages() {
        let (url, seen) = server("application/json", 200, r#"{"data":[{"id":"claude-opus-5","display_name":"Claude Opus 5","type":"model"},{"id":"claude-haiku-5-5","display_name":"claude-haiku-5-5"}],"has_more":false,"last_id":"claude-haiku-5-5"}"#.into());
        let m = list_models(&url, "sk").await.unwrap();
        assert_eq!(m, vec![Model { id: "claude-opus-5".into(), name: Some("Claude Opus 5".into()), detail: None }, Model { id: "claude-haiku-5-5".into(), name: None, detail: None }]);
        assert!(seen.recv().unwrap().to_lowercase().contains("x-api-key: sk"));
    }

    #[tokio::test]
    async fn bad_keys_say_so() {
        let (url, _) = server("application/json", 401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.into());
        assert!(list_models(&url, "nope").await.unwrap_err().contains("rejected the API key"));
    }

    #[test]
    fn friendly_api_errors() {
        assert!(api_error(reqwest::StatusCode::UNAUTHORIZED, "{}").contains("rejected the API key"));
        assert_eq!(api_error(reqwest::StatusCode::BAD_REQUEST, r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad thing"}}"#), "Claude API error 400: bad thing");
    }
}
