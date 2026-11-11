# Published documentation

Status: proposed. Depends on [AI providers](ai-providers.md).

Dispatch generates API documentation from a collection and publishes it through a `dispatch-server`. Each public site lives on its own domain or subdomain, and a site with no domain can't be reached at all. Only profiles connected to a server get the feature, because the server hosts the site, holds its versions and enforces who may publish.

## What makes it better than generated reference docs

Postman builds its documentation from the saved requests and whatever descriptions people typed. Dispatch also holds the evidence of how the API actually behaves, and the documentation is built from that:

| Evidence | Where it comes from | What it gives the documentation |
|---|---|---|
| Real responses | Saved examples; local history, if the author opts in | Field types, which fields can be null, values seen for low-variety fields, formats (UUIDs, ISO dates, amounts in minor units) |
| Request chains | `src/js/chain.js` | The order a real integration calls things in, which becomes the quickstart |
| Tests | Request scripts | Behaviour the API is checked against, stated as fact |
| Error responses seen | Examples, history | An error table with the status, the body shape and the fix |
| Shape changes | `src/js/jsondiff.js` between published versions | A changelog written from real differences |
| Runs | `src/js/runner.js` | "Verified against Staging on 11 Nov 2026" on each example that passed |

## Writing rules

Generic AI documentation happens when a model is given a request and asked to describe it: it fills gaps with filler and invents behaviour. Dispatch limits what the model writes and checks everything it does write.

1. **Code builds most of the page.** Endpoints, parameters, field tables, examples, error tables and code samples (`src/js/codegen.js`) come from the evidence through templates. The model never writes them.
2. **The model writes short pieces only:** a summary per resource of at most two sentences, one line per field, a fix per error, and the connecting sentences of the quickstart.
3. **Every sentence cites facts.** Extraction gives each fact an ID. The model returns `{ sentences: [{ text, factIds }] }` through structured output. A sentence that cites no fact, or a fact that doesn't exist, is rejected.
4. **Lint before review.** Rejection rules:
   - any number, status code, field name or enum value in the text that isn't in its cited facts;
   - banned phrases ("allows you to", "seamlessly", "robust", "leverage", "comprehensive", "powerful", "easily", "simply", "This endpoint");
   - more than one sentence starting with the same words within a section;
   - a field description longer than about 25 words.

   A rejected sentence gets one retry with the lint errors included. If it fails again, the page shows a marked gap instead.
5. **Gaps are shown, not filled.** "Not enough examples to describe `flags`" goes to the reviewer and never reaches the published page. Publishing is blocked until each gap is filled by hand, or the field is marked internal and left out.
6. **People's writing wins.** A description someone wrote in the collection is used as written. The model only fills fields with no description. Edits made in review are pinned, so regenerating keeps them.
7. **House style.** The author can paste a sample of documentation they like. The model uses it for tone, and the collection's own terms ("workspace", not "project") come from the names already in it.

Use the lint and the fact checks with any provider. They matter most for small local models.

## The generation pipeline

Everything below runs in the desktop app. Nothing is sent to the server until the author publishes.

1. **Gather.** Fetch the collection from the server. Add saved examples and, if the author opts in, local history for those requests. Add test scripts, chains, and environment variable names (names only).
2. **Scrub.** Vault values and current values are never read into the pipeline. Example bodies, headers and URLs go through a scrubber:
   - credentials (reusing the patterns in `assist.js`), emails, phone numbers, card-like numbers, IP addresses and long random tokens are replaced with realistic fakes in the same format, so `tok_9f…` stays `tok_…`;
   - replacement is consistent, so the same customer ID becomes the same fake ID on every page.
3. **Extract facts.** Plain JS, no AI. This step produces:
   - each endpoint's method, path, parameters and auth;
   - a response schema merged across samples (types, nullability, formats, observed values for fields with few values);
   - status codes seen, test assertions, and chain order.
   
   Each fact records its sources.
4. **Verify.** Optional. Run the requests in a chosen environment with the runner, and mark each example verified or failed. A failed example can still be published, but never as verified.
5. **Write.** Send one page's facts per call to the model chosen for documentation, then lint the result as described above.
6. **Review.** Show the page next to the last published version:
   - AI-written sentences are highlighted;
   - gaps are listed;
   - every scrubbed value is listed, so the author can check nothing slipped through.
7. **Publish.**
   - A final secret scan runs over the built bundle, and any hit blocks publishing with the location named.
   - The bundle uploads to the server as a new version.

## What gets published

The desktop app builds the whole site, so the server only stores and serves files. That keeps `server/` and `worker/` simple to keep identical.

- **HTML pages:** three columns (navigation, explanation, examples), with language tabs for code samples, a search index, and "last verified" per page. One small script runs the search and the tabs. Nothing else runs on the page.
- **`openapi.json`:** OpenAPI 3.1, built from the extracted facts.
- **`llms.txt` and a Markdown copy of each page,** for AI agents.
- **A zip of the same files,** for teams that want to host it elsewhere. It's exported from the app and doesn't need a domain.

Branding: site name, logo, accent colour and footer links. The default theme follows Dispatch's own style.

## Domains

A public site needs a domain or subdomain, such as `docs.example.com`. The server serves documentation only on verified domains. It never serves it under its own address, so the API and the admin panel are never on the same host as public pages.

**Adding a domain:**

1. An admin enters the hostname for the site.
2. The server creates a verification token and shows the steps for its platform (below).
3. The admin points DNS at the server and sets up HTTPS.
4. The admin presses Verify. The server fetches `https://<hostname>/.well-known/dispatch-docs/<token>` and expects its own token back. That one check proves DNS reaches this server and HTTPS works.
5. The site goes live once verified. The server repeats the check daily. After three failures in a row, it marks the domain unverified, stops serving, and notes this in the admin panel and the audit log.

**How the server routes requests:**
- When a request's `Host` matches a verified site, the server serves that site's files and nothing else. API routes, `/admin` and `/auth` return 404 on that host.
- Before verification, the hostname answers only the `.well-known` path.
- Pages get a strict Content Security Policy, `X-Content-Type-Options: nosniff`, and no cookies.

**HTTPS, by platform:**
- **Self-hosted `server/`:** HTTPS is handled in front of the server: Railway's custom domains, Caddy, nginx with Let's Encrypt, or a Cloudflare proxy. The admin panel shows the DNS record to create and links to `docs/deploy-railway.md`. Built-in certificates (ACME) are out of scope for the first release.
- **Cloudflare Worker:**
  - Add the hostname to the Worker as a Custom Domain in the Cloudflare dashboard. The zone must be on Cloudflare.
  - The admin panel shows those steps.
  - Domains outside Cloudflare would need Cloudflare for SaaS. Leave that for later.

## Roles and access

- **Admin:** creates sites, adds and removes domains, takes sites offline, deletes versions.
- **Creator and editor:** generate and publish new versions of a site, if their workspace grants include its workspace.
- **Viewer:** can preview sites in the app but can't publish.

Every create, publish, domain change and takedown goes in the audit log, under the same rules as other entries: no secrets, and no page contents.

Taking a site offline stops serving it immediately and keeps its versions. Rolling back makes an earlier version current.

## Server API

These are the same in `server/` and `worker/src/index.js`, and both need entries in `tests/server-contract.mjs`.

- `GET /docs-sites` lists sites the caller can see, with domain status and current version.
- `POST /admin/docs-sites` creates a site from `{ workspaceId, collectionUid, name }`.
- `PATCH /admin/docs-sites/{id}` updates `{ name, hostname, online, branding }`.
- `POST /admin/docs-sites/{id}/verify` runs the domain check now.
- `POST /docs-sites/{id}/versions` takes a bundle, available to editors and above with a grant. It returns the version number.
- `PATCH /docs-sites/{id}` takes `{ currentVersion }` to roll back.
- `GET /docs-sites/{id}/versions/{n}/{path}` lets signed-in users preview any version through the API host.

Bundles upload as a list of `{ path, contentType, body }` with a size cap per file and per version. The cap is set to fit inside D1's limits.

## Schema

`collection_uid` is unique: a collection has at most one site.

The same tables go in `server/src/db.rs`, `worker/schema.sql` and the migrations in `worker/src/index.js`:

```sql
CREATE TABLE IF NOT EXISTS docs_sites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    collection_uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    hostname TEXT UNIQUE,
    domain_status TEXT NOT NULL DEFAULT 'none',  -- none | pending | verified | failing
    verify_token TEXT,
    verified_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    online INTEGER NOT NULL DEFAULT 0,
    current_version INTEGER,
    branding TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs_versions (
    site_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    published_by TEXT,
    published_at TEXT NOT NULL,
    changelog TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (site_id, version)
);
CREATE TABLE IF NOT EXISTS docs_files (
    site_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    content_type TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (site_id, version, path)
);
```

Each file is its own row, so no single row holds a whole site.

## Code layout

- `src/js/docgen/`: `gather.js`, `scrub.js`, `facts.js`, `write.js` (prompts, the sentence schema and lint), `build.js` (HTML, OpenAPI, llms.txt). Everything except the model call runs in Node and is tested in `tests/core.test.mjs`.
- `src/js/ui/docsite.js`: the generate, review and publish screens.
- `bridge.js` and `mock.js`: the new server calls, with the mock serving a demo site.
- `server/src/docs.rs` and its twin in `worker/src/index.js`: the API, host routing and domain checks.
- Admin panel, both copies: sites, domains and status.
- AGENTS.md: add published documentation to "Keep these in sync" (the schema, both servers and both admin panels) and the scrubbing rule to "Secrets".

## Release plan

1. **Reference documentation.** Gather from collections and examples, scrub, extract facts, write and lint, review, build the HTML, publish to the server with domain verification, and the admin panel.
2. **Proof.** Verified examples using the runner, the error table from history, `openapi.json`, and zip export.
3. **Guides and change.** A quickstart from request chains, a changelog between versions, `llms.txt`, and branding.

## Decided

- One site per collection.

## Open questions

- Should verified examples run on a schedule from the CLI (`bin/dispatch.mjs`) in CI, so "last verified" stays current without someone opening the app?
