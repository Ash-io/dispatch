# dispatch-server

An optional, self-hostable backend for [Dispatch](../): it has its own users and roles, connects to **one or more Postman accounts**, and decides who reaches which workspace. One binary, SQLite, no external services. If you'd rather use your own Postman key per person, keep Dispatch standalone — the server is entirely optional.

> Prefer Cloudflare? [worker/](../worker/) deploys the same API to a Cloudflare Worker (D1 database, same admin panel) with `npm run deploy:server`.

## The idea

Postman stays the source of truth. Someone keeps working in Postman; you run `dispatch-server`, add a Postman API key that can reach their workspace, and grant that workspace to the people you choose. Those people point Dispatch at your server, sign in, and work in the same workspace without a Postman account or ever seeing a key. What they save appears in Postman, and what's saved in Postman appears in Dispatch on the next sync.

Add as many keys as you need. If two keys reach the same workspace it's listed once, and if one key can only read there, writes go through the other. You decide who can do what:

- **viewer** — read-only. Private ("current") variable values are stripped, so viewers never receive secrets.
- **editor** — read/write collections, environments, folders and requests in their workspaces.
- **creator** — everything an editor can do, plus **create** collections (and mocks, monitors, APIs, schemas).
- **admin** — everything, including **deleting** collections/environments and administering the server.

## Run it

```sh
cargo build --release
./target/release/dispatch-server
```

Prebuilt binaries (`dispatch-server-linux-x64`, `dispatch-server-macos-arm64/x64`, `dispatch-server-windows-x64.exe`) are attached to every [GitHub release](https://github.com/Ash-io/dispatch/releases) — download and run, then add keys at `/admin/`. The deploy buttons below build from source themselves; nothing there depends on the release.

The server listens on `127.0.0.1:8383` by default; users open Dispatch → Settings → Profiles → **Add profile** → *Dispatch server*, enter the URL and their email/password (or a pre-issued token), and everything else works like a Postman profile. The web admin panel is at `http://<host>:<port>/admin/`.

### Containers and clouds

The binary ships as a container (`server/Dockerfile`, context `./server`, SQLite volume at `/data`):

```sh
docker build -t dispatch-server ./server
docker run -p 8383:8383 -v dispatch-data:/data dispatch-server
```

Render: use the **Deploy to Render** button in the top-level README — [`render.yaml`](../render.yaml) defines the service with a 1 GB disk at `/data` and prompts for the Postman key (disks need a paid instance plan). Railway: same image, see [`docs/deploy-railway.md`](../docs/deploy-railway.md). On PaaS the server binds `0.0.0.0:$PORT` automatically when the platform sets `PORT`.

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | — | Encrypts the Postman keys stored in the database (32+ characters). If unset, a random one is created at `<DB_PATH>.secret`, readable only by the server's user. Back it up with the database: without it, stored keys must be re-entered. |
| `POSTMAN_API_KEY` | — | Optional. One more Postman key, set here instead of in the panel. Shows in the panel as managed by the server. |
| `POSTMAN_REGION` | `us` | The region of `POSTMAN_API_KEY`: `us` or `eu`. Keys added in the panel pick their own. |
| `POSTMAN_API_BASE` | — | Override the Postman base URL (useful for tests). |
| `LISTEN_ADDR` | `127.0.0.1:8383` | Address to bind. |
| `DB_PATH` | `./dispatch-server.db` | SQLite database (users, tokens, settings, encrypted Postman keys, audit log). |
| `REQUIRE_AUTH` | `true` | Enforce accounts (register/login). With `false` the proxy is open to anyone who can reach it — bind accordingly. |
| `ADMIN_PASSWORD` | — | Required in `REQUIRE_AUTH=false` mode to unlock the admin panel (`POST /auth/admin-login`); if unset, one is generated and printed at boot. |

## Auth modes

- **Enforced (default).** Registration is open until you turn it off in the admin panel. The **first registered user becomes admin**: open `/admin/` and choose **New server? Create the first account**. New accounts are viewers with no workspaces until an admin grants some. Users log in with email + password; the desktop client stores the session token.
- **Open (`REQUIRE_AUTH=false`).** Everything reachable is proxyable without an account, with editor-like access. Useful on a trusted LAN; the admin panel still needs `ADMIN_PASSWORD`.

## Admin panel

`/admin/` has these screens:

- **Postman accounts:** add keys (each is checked with Postman first), rename them, replace them, remove them, and see each key's status, workspaces and API usage. Keys are never shown again after they're added.
- **Workspaces:** every workspace any key reaches, which keys reach it, and who has access. Change access from here.
- **Users:** create people, change their role and workspaces, reset passwords, delete them.
- **Settings:** toggle registration.
- **Audit log:** every proxied call and every account change, with who made it.

## How enforcement works

Requests mirror Postman's API paths, so the desktop client uses the server URL in place of Postman's. The checked requests follow:

- Only documented Postman endpoints are reachable.
- Roles and workspace grants are checked before anything is forwarded; lists are filtered per grant.
- Each call goes out with a key that reaches that workspace. If Postman refuses it (401, 403, 404 or 429), the next key that reaches the workspace is tried.
- People limited to certain workspaces can't use whole-account endpoints (`/apis`, `/monitors`, `/mock-servers`, `/schemas`) unless they name a workspace they hold. `/scim` and `/integrations` are admin-only, and only admins can delete a workspace.
- Creation is pinned to one of the user's granted workspaces.
- Collection/environment deletions are admin-only.
- Viewers receive shared variable values only; private `currentValue`s are removed.
- Postman responses (successes and errors) and the `x-ratelimit-remaining-month` header are passed through unchanged, so the client renders them exactly as it does Postman.
- Every proxied call is recorded in the audit log — including who did what.

## Honest limits

- Access control is at workspace/collection/environment granularity, not per-request.
- A role applies across all of a user's workspaces; there are no per-workspace roles yet.
- "Current values" of variables are shared by all server users with editor+ in that workspace — that's inherent to working through one Postman key.
- Postman's API rate limits attach to each key; the server caches list reads for 60 seconds, but everyone going through a key shares its quota.
- A key can do everything its Postman user can. Whoever you grant a workspace acts as that user there, and in Postman their changes appear under that user's name; attribution lives in the server's audit log.
- A workspace only appears here if a connected key can reach it, so someone on Postman must first share it with the key's owner, under their own plan's rules.
- Serving a team through one Postman user isn't Postman's intended model — self-hosting and audit are the mitigations; evaluate your own terms.