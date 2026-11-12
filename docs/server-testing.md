# Testing dispatch-server

`tests/server-contract.mjs` checks the behaviour both servers must share: connected accounts, routing calls to the right key, roles, grants, redaction, and workspaces stored on the server (including copying one from Postman). It also covers published documentation: it serves a site on `localhost:<port>` while the API stays on `127.0.0.1:<port>`, which is why `DOCS_ALLOW_HTTP` is on. Never set it in production. It plays Postman itself on port 8798 with made-up keys, so it never touches a real account. Each run needs an empty database.

Rust server:

```sh
cd server && cargo build --release
POSTMAN_API_BASE=http://127.0.0.1:8798 DOCS_ALLOW_HTTP=true DB_PATH=/tmp/contract.db ./target/release/dispatch-server &
cd .. && node tests/server-contract.mjs http://127.0.0.1:8383
```

Worker:

```sh
cd worker && npx wrangler dev --port 8799 --persist-to /tmp/contract-state \
  --var POSTMAN_API_BASE:http://127.0.0.1:8798 --var DOCS_ALLOW_HTTP:true --var SECRET_KEY:a-test-secret-of-at-least-32-characters &
cd .. && node tests/server-contract.mjs http://127.0.0.1:8799
```

Delete the database (and `/tmp/contract.db.secret`) or `/tmp/contract-state` before running again. Stop the servers when you're done.
