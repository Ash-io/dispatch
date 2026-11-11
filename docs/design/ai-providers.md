# AI providers

Status: proposed. Needed before [published documentation](published-docs.md), which runs its AI work on the user's device.

Today the AI assistant talks to one provider. `src-tauri/src/ai.rs` calls Anthropic with a fixed model (`claude-opus-5`), the key lives in one secrets slot (`anthropic-api-key`), and the page reaches it through `ai_set_key`, `ai_has_key`, `ai_delete_key` and `ai_ask`. This spec opens that up to several providers and has Dispatch fetch each provider's models, so nobody has to type a model name.

## Providers

| Provider | Auth | Base URL | Model list | Chat |
|---|---|---|---|---|
| Anthropic | API key | `https://api.anthropic.com/v1` | `GET /models` (paginated) | `POST /messages`, SSE |
| OpenAI | API key | `https://api.openai.com/v1` | `GET /models` | `POST /chat/completions`, SSE |
| Ollama (local) | none | `http://localhost:11434`, editable | `GET /api/tags` | `POST /api/chat`, NDJSON stream |
| Ollama Cloud | API key from ollama.com/settings/keys | `https://ollama.com` | `GET /api/tags` with `Authorization: Bearer` | `POST /api/chat`, NDJSON stream |
| OpenAI-compatible | optional API key | user-supplied | `GET {base}/models` | `POST {base}/chat/completions`, SSE |

The OpenAI-compatible entry covers OpenRouter, Groq, LM Studio, vLLM and similar servers. It ships with presets that only fill in the base URL. Each preset gets tested against the real service before it's listed, and any that can't be tested stay out.

Confirm each endpoint against the provider's current docs while building. The Ollama Cloud rows come from https://docs.ollama.com/cloud.

## Connecting and fetching models

Settings → AI gains a provider list. Connecting a provider works like the current key flow:

1. The user picks a provider and pastes a key, or a base URL for local Ollama and compatible servers.
2. Rust calls the provider's model list with those credentials. A successful call is the key check, replacing today's `verify_key`, and its result is the model list.
3. The key is saved only if that call succeeds. Its secrets slot is `ai-key:<provider-id>`. On first launch the existing `anthropic-api-key` slot moves to `ai-key:anthropic`.
4. The model list is cached, with the time it was fetched, in settings (model IDs and display names only). It refreshes when the key changes, when the user presses Refresh, and when a request fails because a model no longer exists.

Some lists include models that can't chat. OpenAI's includes embedding, audio, image and moderation models, so Rust filters by ID pattern and keeps the filter in one tested function. Ollama reports each model's size and quantisation; show those next to the name, since a 3B model and a 70B model write very differently.

If a compatible server has no `/models` route but answers chat, and only then, the user may type a model name. The field says why it appeared.

## Choosing models

- One default provider and model, used by every AI feature.
- An optional override for documentation generation, the heaviest task. A team might use a local Ollama model for quick test-writing and a larger hosted model for documentation.
- The picker groups models by provider and marks the ones that run on this machine.

## Rust shape

`ai.rs` becomes a small module tree:

- `ai/mod.rs`: `Ask`, `Answer`, `AiEvent`, the provider enum, and dispatch to the right client.
- `ai/anthropic.rs`: today's code. The fallback beta header and `output_config` stay here.
- `ai/openai.rs`: OpenAI and OpenAI-compatible, one client with a base URL.
- `ai/ollama.rs`: local Ollama and Ollama Cloud, one client with a base URL and an optional key.

New commands:

- `ai_connect(provider, key?, base_url?)` → `{ models }`
- `ai_models(provider, refresh)` → `{ models, fetchedAt }`
- `ai_disconnect(provider)`
- `ai_providers()` → which providers are connected (never the keys)

`ai_ask` gains `provider` and `model` fields and keeps the same streaming events, so `assist.js` and `assistview.js` only change where they choose the model.

## Structured output

The assistant asks for JSON with a schema (`REQUEST_SCHEMA` in `assist.js`), and documentation generation depends on it heavily.

- **Anthropic:** `output_config.format`, as today.
- **OpenAI:** `response_format: { type: "json_schema", strict: true }`.
- **Ollama:** the `format` field accepts a JSON schema.
- **OpenAI-compatible:** try `json_schema`. If the server rejects it, put the schema in the prompt.

Whatever the provider, the page validates the JSON against the schema. If validation fails, it retries once with the validation errors included in the prompt. If the retry fails too, the feature reports the failure and doesn't guess.

## Privacy and secrets

- Keys stay on the Rust side, as AGENTS.md requires. The page sees provider IDs, model names and connection state.
- Local Ollama sends nothing off the machine. The settings screen and the documentation generator say so when a local model is selected, and say where data goes when a hosted model is selected.
- The existing redaction in `assist.js` (unfilled variables, credential-looking headers) applies to every provider.

## Browser build

`src/js/mock.js` gets a mock for each command. It returns a fixed model list per provider and streams canned answers, so the UI keeps working in `src/index.html`.

## Tests

- Rust, next to each client: build the request body, parse the stream from a local SSE or NDJSON server (the pattern already in `ai.rs` tests), and map errors (401, 404 model, 429).
- Rust: the model-list filter, using real list responses saved as fixtures.
- Rust: moving the old `anthropic-api-key` slot to `ai-key:anthropic`.
- JS: schema validation and the single retry.
- By hand on macOS, Windows and Linux: connect each provider, check that the models appear, and run each AI feature once. Note any platform that couldn't be checked.
