# Published documentation

A collection in a workspace on a Dispatch server can be published as a public documentation site. The desktop app builds the site on the device, and the server stores its versions and serves them on a domain you own. This needs a server profile. Local and Postman-only profiles don't have it.

## How it fits together

- **Desktop app** (`src/js/docgen/`, `src/js/ui/docsite.js`): opened from a collection's menu, **Documentation…**. It builds every file of the site.
- **Server** (`server/src/docs.rs`, and the same contract in `worker/src/index.js`): stores versions, checks domains and serves files. It never builds pages itself.
- **Admin panel**, **Documentation** tab: lists sites, their domains and status.

## Building a site

`generateDocs` in `src/js/docgen/index.js` runs these steps in order, all on the device:

1. **Gather** (`gather.js`): endpoints from the collection, and from request history if that option is on, plus a quickstart built from requests that chain variables.
2. **Scrub** (`scrub.js`): values that must never appear on a page are replaced with consistent fakes. These include vault secrets, the current values of variables on this device, and credential-looking or personal data.
3. **Facts** (`facts.js`): a structured fact sheet built from examples, history, tests and chains, after scrubbing. Response shapes are merged across samples.
4. **Write** (`write.js`): if AI writing is on, the configured AI provider writes the prose from the fact sheet only. Text that isn't grounded in the facts, or that uses banned or hedging phrases, is rejected. The step retries once and then leaves a gap for the author. With AI off, every piece of prose is a gap.
5. **Build** (`build.js`): static HTML, CSS and an OpenAPI file, with the site name, accent colour and logo, plus a changelog that compares this version's structure with the previous one.
6. **Final scan:** the built files are checked again for anything that looks like a real secret. If something is found, publishing is blocked.

Before publishing, the author can review what the AI wrote and what was scrubbed, edit or pin text, preview the site, or export it as a zip.

The AI provider receives the fact sheet, which has already been scrubbed. Nothing else leaves the device until the author publishes.

## Roles

| Action | Who |
|---|---|
| Create, rename or delete a site; set its domain; verify; take it online or offline | Admins |
| Publish a version, or switch the current version (roll back or forward) | Editors and above, with access to the site's workspace |
| See a site and preview its versions | Anyone with access to the site's workspace |

Each collection can have one site.

## Domains

A site is only served on its own verified hostname, such as `docs.example.com`. It is never served on the server's own address, and it can't be reached at all until it has a verified domain. When a request's `Host` matches a documentation domain, only that site's files are returned. The request never reaches the API or the admin panel, so public pages and the API never share an origin. Pages are served read-only (GET and HEAD) under a strict Content-Security-Policy that only allows the site's own files.

To verify a domain, do one of the following:

1. Point the domain at the server, usually with a CNAME, and set up HTTPS for it. Railway custom domains, Caddy and a Cloudflare proxy all handle HTTPS. The server then fetches `https://<domain>/.well-known/dispatch-docs/<token>` and expects the token back.
2. Add a TXT record named `_dispatch-docs.<domain>` with the token as its value. It's looked up through Cloudflare's DNS-over-HTTPS. On the Cloudflare Worker version of the server, use this method, and add the domain to the Worker as a Custom Domain. `run_worker_first` in `worker/wrangler.jsonc` makes sure the admin panel's files don't answer on documentation domains.

A site is live when it has a verified domain, a current version, and an admin has turned it online.

## Limits

- 1 MB per file, 20 MB per version, and 1,000 files per version.
- Only HTML, CSS, JavaScript, JSON, Markdown, plain text, SVG, YAML and XML files are accepted.

## Testing

`npm test` covers the pipeline: scrubbing, the final scan, facts, the writing lint and retries, the built site and its links, and zip export. `tests/server-contract.mjs` covers roles, publishing checks, serving on a verified domain only, and deleting a site, against both servers. Those tests need `DOCS_ALLOW_HTTP=true`, so that documentation domains can be plain http with a port on localhost (see `docs/server-testing.md`). Never set it in production.
