//! The AI assistant's model providers. Keys stay on this side: the page only
//! learns which providers are connected and which models they offer.
//!
//! Each provider's key lives in the secrets store under `ai-key-<id>`. The
//! non-secret part (base URL, cached model list) is kept in `ai-providers.json`
//! in the app's data folder, so the page can't point a key at another host.

mod anthropic;
mod ollama;
mod openai;
mod stream;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

use crate::secrets;

/// Where the single Anthropic key was kept before there were several providers.
const LEGACY_KEY_SLOT: &str = "anthropic-api-key";
const STATE_FILE: &str = "ai-providers.json";

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Anthropic,
    Openai,
    Ollama,
    OllamaCloud,
    Compatible,
}

impl Kind {
    pub const ALL: [Kind; 5] = [Kind::Anthropic, Kind::Openai, Kind::Ollama, Kind::OllamaCloud, Kind::Compatible];

    pub fn id(self) -> &'static str {
        match self {
            Kind::Anthropic => "anthropic",
            Kind::Openai => "openai",
            Kind::Ollama => "ollama",
            Kind::OllamaCloud => "ollama-cloud",
            Kind::Compatible => "compatible",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::Anthropic => "Anthropic",
            Kind::Openai => "OpenAI",
            Kind::Ollama => "Ollama",
            Kind::OllamaCloud => "Ollama Cloud",
            Kind::Compatible => "OpenAI-compatible",
        }
    }

    fn default_base(self) -> Option<&'static str> {
        match self {
            Kind::Anthropic => Some("https://api.anthropic.com/v1"),
            Kind::Openai => Some("https://api.openai.com/v1"),
            Kind::Ollama => Some("http://localhost:11434"),
            Kind::OllamaCloud => Some("https://ollama.com"),
            Kind::Compatible => None,
        }
    }

    /// Whether the user may change the base URL.
    fn custom_base(self) -> bool {
        matches!(self, Kind::Ollama | Kind::Compatible)
    }

    fn needs_key(self) -> bool {
        matches!(self, Kind::Anthropic | Kind::Openai | Kind::OllamaCloud)
    }

    fn key_slot(self) -> String {
        format!("ai-key-{}", self.id())
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    /// Shown in the picker when it differs from the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Extra detail for local models, such as "8B · Q4_K_M · 4.9 GB".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// What the page sees for one provider. Never carries the key.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderState {
    pub id: Kind,
    #[serde(default)]
    pub label: String,
    pub base_url: String,
    #[serde(default)]
    pub has_key: bool,
    /// The base URL is on this machine, so nothing is sent elsewhere.
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub models: Vec<Model>,
    #[serde(default)]
    pub fetched_at: Option<u64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub provider: Kind,
    pub model: String,
    pub system: String,
    pub prompt: String,
    /// JSON Schema for structured output (every object needs additionalProperties: false).
    #[serde(default)]
    pub schema: Option<Value>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Text { text: String },
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub text: String,
    pub model: String,
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

pub(crate) fn client(read_timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(read_timeout)
        .user_agent(concat!("Dispatch/", env!("CARGO_PKG_VERSION")))
        .use_native_tls()
        .build()
        .map_err(|e| e.to_string())
}

/// The error message an API put in its body, or the start of the body.
pub(crate) fn body_message(body: &str) -> String {
    let v: Option<Value> = serde_json::from_str(body).ok();
    v.as_ref()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// Accepts "host:port", "http://host" and trailing slashes; returns a clean http(s) base.
pub fn normalize_base(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("Enter the server's address.".into());
    }
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| format!("\"{raw}\" isn't a valid address."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(format!("\"{raw}\" isn't an http or https address."));
    }
    Ok(with_scheme.trim_end_matches('/').to_string())
}

pub fn is_local(base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else { return false };
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_states(dir: &Path) -> Vec<ProviderState> {
    std::fs::read_to_string(dir.join(STATE_FILE)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_states(dir: &Path, states: &[ProviderState]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(states).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(STATE_FILE), json).map_err(|e| e.to_string())
}

fn upsert(dir: &Path, state: ProviderState) -> Result<(), String> {
    let mut all = read_states(dir);
    all.retain(|s| s.id != state.id);
    all.push(state);
    all.sort_by_key(|s| Kind::ALL.iter().position(|k| *k == s.id));
    write_states(dir, &all)
}

fn key_for(dir: &Path, kind: Kind) -> Result<Option<String>, String> {
    Ok(secrets::store_get(dir, &kind.key_slot())?.filter(|k| !k.is_empty()))
}

/// Moves the key from before multi-provider support into its new slot, once.
fn migrate(dir: &Path) -> Result<(), String> {
    let Some(old) = secrets::store_get(dir, LEGACY_KEY_SLOT)?.filter(|k| !k.is_empty()) else { return Ok(()) };
    if key_for(dir, Kind::Anthropic)?.is_none() {
        secrets::store_set(dir, &Kind::Anthropic.key_slot(), &old)?;
    }
    if !read_states(dir).iter().any(|s| s.id == Kind::Anthropic) {
        upsert(dir, fresh_state(Kind::Anthropic, Kind::Anthropic.default_base().unwrap_or_default().to_string(), true))?;
    }
    secrets::store_set(dir, LEGACY_KEY_SLOT, "")
}

fn fresh_state(kind: Kind, base: String, has_key: bool) -> ProviderState {
    ProviderState { id: kind, label: kind.label().into(), local: is_local(&base), base_url: base, has_key, models: vec![], fetched_at: None }
}

/// Connected providers, in a fixed order.
pub fn providers(dir: &Path) -> Result<Vec<ProviderState>, String> {
    migrate(dir)?;
    Ok(read_states(dir)
        .into_iter()
        .map(|mut s| {
            s.label = s.id.label().into();
            s.local = is_local(&s.base_url);
            s
        })
        .collect())
}

async fn list_models(kind: Kind, base: &str, key: Option<&str>) -> Result<Vec<Model>, String> {
    match kind {
        Kind::Anthropic => anthropic::list_models(base, key.unwrap_or("")).await,
        Kind::Openai | Kind::Compatible => openai::list_models(kind, base, key).await,
        Kind::Ollama | Kind::OllamaCloud => ollama::list_models(kind, base, key).await,
    }
}

/// Checks the key or address by listing models; saves only if that works.
pub async fn connect(dir: &Path, kind: Kind, key: Option<String>, base_url: Option<String>) -> Result<ProviderState, String> {
    let base = match (kind.custom_base(), base_url.as_deref().map(str::trim).filter(|b| !b.is_empty())) {
        (true, Some(b)) => normalize_base(b)?,
        (true, None) => match kind.default_base() {
            Some(b) => b.to_string(),
            None => return Err("Enter the server's address, such as https://openrouter.ai/api/v1.".into()),
        },
        (false, _) => kind.default_base().unwrap_or_default().to_string(),
    };
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    // A saved key is only reused at the address it was saved for, so the page
    // can't send it somewhere else by changing the address.
    let saved_base = read_states(dir).into_iter().find(|s| s.id == kind).map(|s| s.base_url);
    let key = match key {
        Some(k) => Some(k),
        None if saved_base.as_deref() == Some(base.as_str()) => key_for(dir, kind)?,
        None => None,
    };
    if kind.needs_key() && key.is_none() {
        return Err(format!("Paste your {} API key.", kind.label()));
    }
    let models = list_models(kind, &base, key.as_deref()).await?;
    secrets::store_set(dir, &kind.key_slot(), key.as_deref().unwrap_or(""))?;
    let mut state = fresh_state(kind, base, key.is_some());
    state.models = models;
    state.fetched_at = Some(now_secs());
    upsert(dir, state.clone())?;
    Ok(state)
}

/// Fetches the provider's models again with the saved credentials.
pub async fn refresh_models(dir: &Path, kind: Kind) -> Result<ProviderState, String> {
    let mut state = providers(dir)?.into_iter().find(|s| s.id == kind).ok_or_else(|| format!("{} isn't connected.", kind.label()))?;
    let key = key_for(dir, kind)?;
    state.models = list_models(kind, &state.base_url, key.as_deref()).await?;
    state.fetched_at = Some(now_secs());
    upsert(dir, state.clone())?;
    Ok(state)
}

pub fn disconnect(dir: &Path, kind: Kind) -> Result<(), String> {
    secrets::store_set(dir, &kind.key_slot(), "")?;
    let mut all = read_states(dir);
    all.retain(|s| s.id != kind);
    write_states(dir, &all)
}

/// Streams the answer's text through `on_event`; resolves with the whole answer.
pub async fn ask(dir: &Path, ask: Ask, cancel: Arc<Notify>, on_event: impl Fn(AiEvent)) -> Result<Answer, String> {
    let kind = ask.provider;
    let state = providers(dir)?
        .into_iter()
        .find(|s| s.id == kind)
        .ok_or_else(|| format!("Connect {} under Settings → AI assistant first.", kind.label()))?;
    let key = key_for(dir, kind)?;
    if kind.needs_key() && key.is_none() {
        return Err(format!("Add your {} API key under Settings → AI assistant first.", kind.label()));
    }
    if ask.model.trim().is_empty() {
        return Err("Choose a model under Settings → AI assistant first.".into());
    }
    match kind {
        Kind::Anthropic => anthropic::ask(&state.base_url, key.as_deref().unwrap_or(""), ask, cancel, on_event).await,
        Kind::Openai | Kind::Compatible => openai::ask(kind, &state.base_url, key.as_deref(), ask, cancel, on_event).await,
        Kind::Ollama | Kind::OllamaCloud => ollama::ask(kind, &state.base_url, key.as_deref(), ask, cancel, on_event).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bases_are_normalised() {
        assert_eq!(normalize_base("localhost:11434/").unwrap(), "http://localhost:11434");
        assert_eq!(normalize_base(" https://openrouter.ai/api/v1/ ").unwrap(), "https://openrouter.ai/api/v1");
        assert!(normalize_base("ftp://x").is_err());
        assert!(normalize_base("").is_err());
    }

    #[test]
    fn local_hosts() {
        assert!(is_local("http://localhost:11434"));
        assert!(is_local("http://127.0.0.1:1234/v1"));
        assert!(is_local("http://[::1]:8080"));
        assert!(!is_local("https://ollama.com"));
        assert!(!is_local("http://192.168.1.20:11434"));
    }

    #[test]
    fn kinds_round_trip_as_ids() {
        for k in Kind::ALL {
            let json = serde_json::to_string(&k).unwrap();
            assert_eq!(json, format!("\"{}\"", k.id()));
        }
    }

    #[test]
    fn error_bodies() {
        assert_eq!(body_message(r#"{"error":{"message":"bad key"}}"#), "bad key");
        assert_eq!(body_message(r#"{"error":"model \"x\" not found"}"#), "model \"x\" not found");
        assert_eq!(body_message("plain"), "plain");
    }

    #[tokio::test]
    async fn saved_keys_stay_with_their_address() {
        if cfg!(target_os = "macos") {
            return; // the file store only; macOS keeps secrets in the Keychain
        }
        let dir = std::env::temp_dir().join(format!("dispatch-ai-move-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        secrets::store_set(&dir, &Kind::Compatible.key_slot(), "sk-secret").unwrap();
        upsert(&dir, fresh_state(Kind::Compatible, "https://openrouter.ai/api/v1".into(), true)).unwrap();
        let (url, seen) = stream::testing::server("application/json", 200, r#"{"data":[{"id":"m"}]}"#.into());
        connect(&dir, Kind::Compatible, None, Some(url)).await.unwrap();
        assert!(!seen.recv().unwrap().to_lowercase().contains("sk-secret"), "the saved key must not follow a new address");
        assert_eq!(key_for(&dir, Kind::Compatible).unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrates_the_old_anthropic_key() {
        let dir = std::env::temp_dir().join(format!("dispatch-ai-{}", now_secs() ^ std::process::id() as u64));
        std::fs::create_dir_all(&dir).unwrap();
        // Only exercise the file store; on macOS secrets use the Keychain, so skip there.
        if cfg!(target_os = "macos") {
            return;
        }
        secrets::store_set(&dir, LEGACY_KEY_SLOT, "sk-ant-old").unwrap();
        let p = providers(&dir).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].id, Kind::Anthropic);
        assert!(p[0].has_key);
        assert_eq!(key_for(&dir, Kind::Anthropic).unwrap().as_deref(), Some("sk-ant-old"));
        assert_eq!(secrets::store_get(&dir, LEGACY_KEY_SLOT).unwrap().filter(|k| !k.is_empty()), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
