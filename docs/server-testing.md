# Testing dispatch-server

`tests/server-contract.mjs` checks the behaviour both servers must share: connected accounts, routing calls to the right key, roles, grants and redaction. It plays Postman itself on port 8798 with made-up keys, so it never touches a real account. Each run needs an empty database.

Rust server:

```sh
cd server && cargo build --release
POSTMAN_API_BASE=http://127.0.0.1:8798 DB_PATH=/tmp/contract.db ./target/release/dispatch-server &
cd .. && node tests/server-contract.mjs http://127.0.0.1:8383
```

Worker:

```sh
cd worker && npx wrangler dev --port 8799 --persist-to /tmp/contract-state \
  --var POSTMAN_API_BASE:http://127.0.0.1:8798 --var SECRET_KEY:a-test-secret-of-at-least-32-characters &
cd .. && node tests/server-contract.mjs http://127.0.0.1:8799
```

Delete the database (and `/tmp/contract.db.secret`) or `/tmp/contract-state` before running again. Stop the servers when you're done.
