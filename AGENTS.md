# Dispatch: agent instructions

Dispatch is a native API client for REST, WebSocket, gRPC and GraphQL, built with Tauri v2. It works on its own with a local profile and no account, and can optionally sync with Postman or connect to a self-hosted `dispatch-server`.

## Layout

- `src/`: desktop UI in plain HTML, CSS and JS modules. There is no framework and no build step.
- `src-tauri/`: native shell in Rust.
- `server/`: `dispatch-server`, a standalone Rust crate outside the Tauri workspace. It holds one Postman key for many users, with roles.
- `worker/`: the same server API on Cloudflare Workers with D1.
- `site/`: landing page and `install.sh` / `install.ps1`, served at https://dispatch.ashlabs.xyz.
- `bin/dispatch.mjs`: CLI that runs collections from a terminal or CI, like Newman. It reuses the app's runner and script sandbox from `src/js/`, so changes there affect it.
- `tests/core.test.mjs`: JS test suite.
- `docs/release.md`: release runbook.

The README's "Project layout" section maps the individual modules.

## Commands

```sh
npm test                    # JS tests
cd src-tauri && cargo test  # desktop Rust tests
cd server && cargo build    # server has no tests yet, so check that it builds
npm run dev                 # run the desktop app
node bin/dispatch.mjs run <collection>  # run the CLI
```

For UI work without the native shell, open `src/index.html` in a browser. It runs against the demo account in `src/js/mock.js`.

## Testing

- Add JS tests to `tests/core.test.mjs`. Rust tests live beside the code in `src-tauri/src/`.
- `server/` and `worker/` have no automated tests, including for roles and redaction. Exercise those changes by hand, against both implementations.
- JS tests don't cover the UI. Check UI changes in a browser or the running app, and say so if you couldn't.
- Windows and macOS can't be tested from Linux. Report anything you couldn't run instead of assuming it works.

## Keep these in sync

- **Native calls:** `src/js/bridge.js` has a Tauri path and a mock path. When you add or change a native command, update `src/js/mock.js` too, so the browser build keeps working.
- **Server API:** `server/` and `worker/src/index.js` implement the same contract, roles, redaction and admin API. Change both. Both also serve the admin panel from `server/admin/`.
- **Database schema:** the same tables are defined in `server/src/db.rs`, `worker/schema.sql` and the migrations in `worker/src/index.js`. Keep all three identical.
- **Version:** bump `package.json`, `package-lock.json` (both top-level fields), `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` together. `npm ci` fails if they drift.

## Secrets

- Postman and Anthropic keys stay on the Rust side. The page only gets checks such as `has_api_key`, never the key itself.
- `{{vault:name}}` values do reach the page, because `src/js/vault.js` loads them to resolve requests. They must never sync or export, and scripts and code snippets must use `Resolver.withoutVault()` so they only see the placeholder.
- The AI assistant (`src/js/assist.js`) sends the request with variables unfilled and credential-looking headers redacted. Bodies and URLs are capped or sent as written, not redacted, so don't describe them as scrubbed.
- Viewer-role server users must not receive `currentValue`s. Stripping happens only on single-item GETs (`should_redact` / `shouldRedact`), so any new route that returns variable values needs its own check.
- The first account registered on a server becomes admin, and registration is open by default. Treat a newly deployed server as unclaimed until its admin account exists.
- Never commit `.dev.vars` or signing keys.

Secrets are stored in the Keychain on macOS and in 0600 files elsewhere. Don't describe this as "keychain on every OS".

## Git and releases

- `main` is protected. Work on a branch and open a PR.
- GitHub Actions is locked by a billing issue, so `.github/workflows/release.yml` never runs. Releases are built by hand: follow `docs/release.md`.
- Don't re-add `cdylib` to `crate-type` in `src-tauri/Cargo.toml`. It breaks the Windows mingw link with "export ordinal too large".
- Check a release's assets and `latest.json` before publishing. Installed apps update from `releases/latest/download/latest.json`, so it needs every platform.

## Landing page and copy

- Pushing to `main` deploys the site through Cloudflare, so landing page changes go live on merge.
- Keep only the site's `wrangler.toml` at the repo root. The server's config is `worker/wrangler.jsonc` (`npm run deploy:server`). A `wrangler.jsonc` at the root takes priority and deploys over the landing page.
- Describe Dispatch as a native API client, with Postman sync as a feature. Don't position it as "the API client that keeps your Postman account".
- Analytics: PostHog in `site/index.html` only initialises on `dispatch.ashlabs.xyz`, with no cookies or session recording. A delegated click listener classifies download, releases and source links, so keep new links in those URL shapes. PostHog filters headless browsers, so test with a normal user agent.
- Only make claims that can be verified. Benchmark numbers must come from a real measurement and name the version measured.
