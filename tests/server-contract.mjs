// Contract test for dispatch-server: run it against the Rust binary and the
// Worker, since both must behave the same. It plays Postman itself, with two
// accounts that share a workspace.
//
//   node tests/server-contract.mjs http://127.0.0.1:8383
//
// Start the server first with an empty database and POSTMAN_API_BASE set to
// http://127.0.0.1:8798 (see docs/server-testing.md). Not part of `npm test`,
// because it needs a running server.
import http from 'node:http';
import assert from 'node:assert/strict';

const BASE = process.argv[2];
if (!BASE) { console.error('usage: node tests/server-contract.mjs <server url>'); process.exit(2); }
const FAKE_PORT = 8798;

const KEY_A = 'PMAK-alpha-aaaa1111';
const KEY_B = 'PMAK-bravo-bbbb2222';

// What each key can see. "shared" is in both A and B, but A only has read access
// there, and A is tried first because it was added first.
const accounts = {
  [KEY_A]: { user: { id: 101, teamName: 'Acme' }, workspaces: ['shared', 'acme-only', 'my-a'], readOnly: ['shared'] },
  [KEY_B]: { user: { id: 202, fullName: 'Bola' }, workspaces: ['shared', 'bola-only', 'my-b'], readOnly: [] },
};
const workspaceInfo = {
  shared: { name: 'Shared API', type: 'team' },
  'acme-only': { name: 'Acme internal', type: 'team' },
  'bola-only': { name: 'Bola sandbox', type: 'personal' },
  'my-a': { name: 'My Workspace', type: 'personal' },
  'my-b': { name: 'My Workspace', type: 'personal' },
};
const collections = {
  shared: [{ uid: 'c-shared', id: 'c-shared', name: 'Shared collection' }],
  'acme-only': [{ uid: 'c-acme', id: 'c-acme', name: 'Acme collection' }],
  'bola-only': [{ uid: 'c-bola', id: 'c-bola', name: 'Bola collection' }],
  'my-a': [],
  'my-b': [],
};
const environments = {
  'acme-only': [{ uid: 'e-acme', id: 'e-acme', name: 'Acme env' }],
};
const revoked = new Set();
const upstreamLog = [];

function owning(uid) {
  return Object.keys(collections).find((ws) => collections[ws].some((c) => c.uid === uid));
}

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const send = (status, value) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const key = req.headers['x-api-key'];
    const account = accounts[key];
    const url = new URL(req.url, 'http://fake');
    upstreamLog.push({ key, method: req.method, path: url.pathname, search: url.search });
    if (!account || revoked.has(key)) return send(401, { error: { name: 'AuthenticationError' } });
    const can = (ws) => account.workspaces.includes(ws);
    const path = url.pathname;

    if (path === '/me') {
      return send(200, { user: account.user, operations: [{ name: 'api_usage', limit: 1000, usage: 42, overage: 0 }] });
    }
    if (path === '/workspaces' && req.method === 'GET') {
      return send(200, { workspaces: account.workspaces.map((id) => ({ id, ...workspaceInfo[id] })) });
    }
    const wsMatch = /^\/workspaces\/([^/]+)(\/.*)?$/.exec(path);
    if (wsMatch) {
      if (!can(wsMatch[1])) return send(404, { error: { name: 'instanceNotFoundError' } });
      if (wsMatch[2] === '/global-variables' && req.method === 'GET') {
        return send(200, { values: [{ key: 'region', value: 'eu', enabled: true, type: 'default' }] });
      }
      if (req.method !== 'GET' && account.readOnly.includes(wsMatch[1])) return send(403, { error: { name: 'forbiddenError' } });
      return send(200, { workspace: { id: wsMatch[1], ...workspaceInfo[wsMatch[1]] }, via: key });
    }
    if (path === '/collections' && req.method === 'GET') {
      const ws = url.searchParams.get('workspace');
      if (ws) {
        if (!can(ws)) return send(404, { error: { name: 'instanceNotFoundError' } });
        return send(200, { collections: collections[ws] });
      }
      return send(200, { collections: account.workspaces.flatMap((id) => collections[id]) });
    }
    if (path === '/collections' && req.method === 'POST') {
      const ws = url.searchParams.get('workspace');
      if (!can(ws)) return send(404, { error: { name: 'instanceNotFoundError' } });
      if (account.readOnly.includes(ws)) return send(403, { error: { name: 'forbiddenError' } });
      const made = { uid: `c-new-${collections[ws].length}`, id: 'n', name: 'Created' };
      collections[ws].push(made);
      return send(200, { collection: made });
    }
    const colMatch = /^\/collections\/([^/]+)$/.exec(path);
    if (colMatch) {
      const ws = owning(colMatch[1]);
      if (!ws || !can(ws)) return send(404, { error: { name: 'instanceNotFoundError' } });
      if (req.method !== 'GET' && account.readOnly.includes(ws)) return send(403, { error: { name: 'forbiddenError' } });
      if (req.method === 'PUT') return send(200, { collection: { uid: colMatch[1] }, via: key });
      return send(200, { collection: { uid: colMatch[1], info: { name: 'x' }, variable: [{ key: 'k', value: 'shared', currentValue: 'SECRET' }] }, via: key });
    }
    if (path === '/environments' && req.method === 'GET') {
      const ws = url.searchParams.get('workspace');
      if (ws && !can(ws)) return send(404, { error: { name: 'instanceNotFoundError' } });
      return send(200, { environments: ws ? environments[ws] || [] : [] });
    }
    const envMatch = /^\/environments\/([^/]+)$/.exec(path);
    if (envMatch && req.method === 'GET') {
      const ws = Object.keys(environments).find((id) => environments[id].some((e) => e.uid === envMatch[1]));
      if (!ws || !can(ws)) return send(404, { error: { name: 'instanceNotFoundError' } });
      return send(200, { environment: { id: envMatch[1], name: 'Acme env', values: [{ key: 'token', value: 'shared-token', currentValue: 'SECRET', enabled: true, type: 'secret' }] } });
    }
    if (path.startsWith('/scim') || path.startsWith('/apis') || path.startsWith('/integrations')) {
      return send(200, { reached: path, via: key });
    }
    return send(404, { error: { name: 'notFound' } });
  });
});
await new Promise((resolve) => fake.listen(FAKE_PORT, '127.0.0.1', resolve));

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text };
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
const login = async (email, password) => (await call('POST', '/auth/login', { body: { email, password } })).data.token;
const ids = (r) => r.data.workspaces.map((w) => w.id).sort();

const PW = 'correct-horse';
await call('POST', '/auth/register', { body: { email: 'admin@x.io', password: PW } });
const admin = await login('admin@x.io', PW);

await check('with no account connected, the proxy says so', async () => {
  const r = await call('GET', '/workspaces', { token: admin });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /Postman account/);
});

// Workspaces stored on the server itself, before any Postman account exists.
let solo = null;
await check('a Dispatch workspace works with no Postman account at all', async () => {
  const made = await call('POST', '/admin/dispatch-workspaces', { token: admin, body: { name: 'Team API' } });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.data.dispatch, true);
  solo = made.data.id;
  const list = await call('GET', '/workspaces', { token: admin });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.data.workspaces.map((w) => [w.id, w.name]), [[solo, 'Team API']]);
  upstreamLog.length = 0;
  const created = await call('POST', `/collections?workspace=${solo}`, { token: admin, body: { collection: { info: { name: 'Orders' }, item: [{ name: 'List', request: { method: 'GET', url: 'https://x.io' } }] } } });
  assert.equal(created.status, 200, created.text);
  const uid = created.data.collection.uid;
  assert.equal(created.data.collection.name, 'Orders');
  const one = await call('GET', `/collections/${uid}`, { token: admin });
  assert.equal(one.data.collection.info._postman_id, uid);
  assert.ok(one.data.collection.item[0].id, 'items get ids');
  const listed = await call('GET', `/collections?workspace=${solo}`, { token: admin });
  assert.deepEqual(listed.data.collections.map((c) => c.uid), [uid]);
  assert.equal(listed.data.collections[0].updatedAt, one.data.collection.info.updatedAt);
  assert.deepEqual(upstreamLog, [], 'nothing went to Postman');
});

await check('every save changes updatedAt, so the app can spot conflicts', async () => {
  const uid = (await call('GET', `/collections?workspace=${solo}`, { token: admin })).data.collections[0].uid;
  const stamps = [];
  for (const name of ['Orders 2', 'Orders 3']) {
    const put = await call('PUT', `/collections/${uid}`, { token: admin, body: { collection: { info: { name }, item: [] } } });
    assert.equal(put.status, 200, put.text);
    stamps.push((await call('GET', `/collections?workspace=${solo}`, { token: admin })).data.collections[0].updatedAt);
  }
  assert.ok(stamps[1] > stamps[0], `${stamps[1]} should be after ${stamps[0]}`);
  assert.equal((await call('GET', `/collections/${uid}`, { token: admin })).data.collection.info.name, 'Orders 3');
});

await check('environments and globals are stored too', async () => {
  const made = await call('POST', `/environments?workspace=${solo}`, { token: admin, body: { environment: { name: 'Dev', values: [{ key: 'host', value: 'dev.x.io', enabled: true, type: 'default' }] } } });
  assert.equal(made.status, 200, made.text);
  const uid = made.data.environment.uid;
  const one = await call('GET', `/environments/${uid}`, { token: admin });
  assert.equal(one.data.environment.values[0].value, 'dev.x.io');
  const put = await call('PUT', `/environments/${uid}`, { token: admin, body: { environment: { name: 'Dev', values: [] } } });
  assert.equal(put.status, 200, put.text);
  const globals = await call('PUT', `/workspaces/${solo}/global-variables`, { token: admin, body: { values: [{ key: 'g', value: '1', enabled: true, type: 'default' }] } });
  assert.equal(globals.status, 200, globals.text);
  assert.deepEqual((await call('GET', `/workspaces/${solo}/global-variables`, { token: admin })).data.values.map((v) => v.key), ['g']);
  const ws = await call('GET', `/workspaces/${solo}`, { token: admin });
  assert.equal(ws.data.workspace.collections.length, 1);
  assert.equal(ws.data.workspace.environments.length, 1);
});

await check('bad bodies are refused', async () => {
  assert.equal((await call('POST', `/collections?workspace=${solo}`, { token: admin, body: { collection: { info: {} } } })).status, 400);
  assert.equal((await call('POST', `/environments?workspace=${solo}`, { token: admin, body: {} })).status, 400);
});

await check('deleting the last Dispatch workspace brings the 503 back', async () => {
  assert.equal((await call('DELETE', `/admin/dispatch-workspaces/${solo}`, { token: admin })).status, 204);
  assert.equal((await call('GET', '/workspaces', { token: admin })).status, 503);
  assert.equal((await call('DELETE', `/admin/dispatch-workspaces/${solo}`, { token: admin })).status, 404);
});

await check('a key Postman rejects is refused and not stored', async () => {
  const r = await call('POST', '/admin/postman-accounts', { token: admin, body: { api_key: 'PMAK-wrong' } });
  assert.equal(r.status, 400);
  const list = await call('GET', '/admin/postman-accounts', { token: admin });
  assert.deepEqual(list.data.accounts, []);
});

let accountA; let accountB;
await check('an admin can add a key, and its name comes from Postman', async () => {
  const r = await call('POST', '/admin/postman-accounts', { token: admin, body: { api_key: KEY_A } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.label, 'Acme');
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.workspace_count, 3);
  accountA = r.data.id;
});

await check('more than one key can be added', async () => {
  const r = await call('POST', '/admin/postman-accounts', { token: admin, body: { api_key: KEY_B, label: 'Bola personal' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.label, 'Bola personal');
  accountB = r.data.id;
  assert.notEqual(accountA, accountB);
});

await check('the same Postman user can\'t be added twice', async () => {
  const r = await call('POST', '/admin/postman-accounts', { token: admin, body: { api_key: KEY_A } });
  assert.equal(r.status, 409);
});

await check('no endpoint ever returns a key', async () => {
  for (const path of ['/admin/postman-accounts', '/admin/workspaces', '/admin/audit?limit=100', '/admin/settings', '/admin/users']) {
    const r = await call('GET', path, { token: admin });
    for (const key of [KEY_A, KEY_B]) assert.ok(!r.text.includes(key), `${path} leaked a key`);
  }
  const list = await call('GET', '/admin/postman-accounts', { token: admin });
  assert.equal(list.data.accounts.find((a) => a.id === accountA).key_hint, '…1111');
  assert.ok(!('key_ciphertext' in list.data.accounts[0]));
  assert.deepEqual(list.data.accounts.find((a) => a.id === accountA).usage, { used: 42, limit: 1000 });
});

await check('adding and removing accounts is audited', async () => {
  const r = await call('GET', '/admin/audit?limit=100', { token: admin });
  assert.ok(r.data.some((row) => row.action === 'account_add' && row.status === 201));
});

await check('workspaces merge across accounts, shared ones once', async () => {
  const r = await call('GET', '/workspaces', { token: admin });
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), ['acme-only', 'bola-only', 'my-a', 'my-b', 'shared']);
});

await check('different workspaces with one name are told apart', async () => {
  const r = await call('GET', '/workspaces', { token: admin });
  const names = r.data.workspaces.filter((w) => w.id.startsWith('my-')).map((w) => w.name).sort();
  assert.deepEqual(names, ['My Workspace (Acme)', 'My Workspace (Bola personal)']);
  assert.equal(r.data.workspaces.find((w) => w.id === 'shared').name, 'Shared API');
});

await check('the admin workspace list says which accounts reach each', async () => {
  const r = await call('GET', '/admin/workspaces', { token: admin });
  const shared = r.data.workspaces.find((w) => w.id === 'shared');
  assert.deepEqual(shared.accounts.map((a) => a.id).sort(), [accountA, accountB].sort());
  assert.deepEqual(r.data.workspaces.find((w) => w.id === 'bola-only').accounts.map((a) => a.id), [accountB]);
});

await check('a call goes out with the key that reaches that workspace', async () => {
  upstreamLog.length = 0;
  const r = await call('GET', '/collections?workspace=bola-only', { token: admin });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.collections.map((c) => c.uid), ['c-bola']);
  assert.deepEqual(upstreamLog.filter((u) => u.path === '/collections').map((u) => u.key), [KEY_B]);
});

await check('one collection is fetched through the right account', async () => {
  const r = await call('GET', '/collections/c-bola', { token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.via, KEY_B);
});

await check('a collection never listed is still found by someone with all access', async () => {
  const r = await call('GET', '/collections/c-acme', { token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.via, KEY_A);
});

await check('a list naming no workspace covers every account, each item once', async () => {
  const r = await call('GET', '/collections', { token: admin });
  assert.equal(r.status, 200);
  const uids = r.data.collections.map((c) => c.uid).sort();
  assert.deepEqual(uids, ['c-acme', 'c-bola', 'c-shared']);
});

// People with limited access.
const mk = async (email, role, grants) => {
  const body = { email, password: PW, role };
  if (grants !== undefined) body.workspace_grants = grants;
  const r = await call('POST', '/admin/users', { token: admin, body });
  assert.equal(r.status, 201, r.text);
  return { id: r.data.id, token: await login(email, PW), body: r.data };
};
const editor = await mk('editor@x.io', 'editor', ['bola-only']);
const viewer = await mk('viewer@x.io', 'viewer', ['shared']);
const none = await mk('none@x.io', 'editor');
const creatorAll = await mk('all@x.io', 'creator', null);

await check('a user made without grants has no access', async () => {
  assert.deepEqual(none.body.workspace_grants, []);
  const r = await call('GET', '/workspaces', { token: none.token });
  assert.deepEqual(r.data.workspaces, []);
});

await check('someone who registers has no access until granted', async () => {
  const made = await call('POST', '/auth/register', { body: { email: 'new@x.io', password: PW } });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.data.user.role, 'viewer');
  const token = await login('new@x.io', PW);
  const me = await call('GET', '/me', { token });
  assert.deepEqual(me.data.user.workspace_grants, []);
  const r = await call('GET', '/workspaces', { token });
  assert.deepEqual(r.data.workspaces, []);
  const c = await call('GET', '/collections?workspace=shared', { token });
  assert.deepEqual(c.data.collections, []);
  assert.equal((await call('GET', '/workspaces/shared', { token })).status, 403);
  assert.equal((await call('GET', '/collections/c-shared', { token })).status, 403);
});

await check('a granted user sees only their workspace, across accounts', async () => {
  const r = await call('GET', '/workspaces', { token: editor.token });
  assert.deepEqual(ids(r), ['bola-only']);
});

await check('a granted user can\'t read another account\'s workspace', async () => {
  assert.equal((await call('GET', '/collections?workspace=acme-only', { token: editor.token })).status, 403);
  assert.equal((await call('GET', '/workspaces/acme-only', { token: editor.token })).status, 403);
});

await check('a granted user can\'t reach a collection outside their grant', async () => {
  await call('GET', '/collections?workspace=acme-only', { token: admin });
  assert.equal((await call('GET', '/collections/c-acme', { token: editor.token })).status, 403);
  assert.equal((await call('PUT', '/collections/c-acme', { token: editor.token, body: { collection: {} } })).status, 403);
});

await check('a granted user works in their workspace as usual', async () => {
  const list = await call('GET', '/collections?workspace=bola-only', { token: editor.token });
  assert.deepEqual(list.data.collections.map((c) => c.uid).includes('c-bola'), true);
  const one = await call('PUT', '/collections/c-bola', { token: editor.token, body: { collection: {} } });
  assert.equal(one.status, 200, one.text);
  assert.equal(one.data.via, KEY_B);
});

await check('viewers can read but not write, and lose current values', async () => {
  await call('GET', '/collections?workspace=shared', { token: viewer.token });
  const read = await call('GET', '/collections/c-shared', { token: viewer.token });
  assert.equal(read.status, 200, read.text);
  assert.ok(!read.text.includes('SECRET'));
  assert.ok(read.text.includes('"shared"'));
  assert.equal((await call('PUT', '/collections/c-shared', { token: viewer.token, body: {} })).status, 403);
});

await check('whole-account endpoints are closed to limited users', async () => {
  assert.equal((await call('GET', '/apis', { token: editor.token })).status, 403);
  const monitors = await call('POST', '/monitors', { token: creatorAll.token, body: {} });
  assert.notEqual(monitors.status, 403);
});

await check('SCIM and integrations are admin-only', async () => {
  for (const token of [viewer.token, editor.token, creatorAll.token]) {
    assert.equal((await call('GET', '/scim/v2/Users', { token })).status, 403);
    assert.equal((await call('GET', '/integrations', { token })).status, 403);
  }
  assert.equal((await call('GET', '/scim/v2/Users', { token: admin })).status, 200);
});

await check('only admins can delete a workspace', async () => {
  assert.equal((await call('DELETE', '/workspaces/bola-only', { token: editor.token })).status, 403);
  assert.equal((await call('DELETE', '/workspaces/bola-only', { token: creatorAll.token })).status, 403);
});

await check('limited users can\'t create a workspace they couldn\'t then see', async () => {
  const limited = await mk('limited-creator@x.io', 'creator', ['bola-only']);
  assert.equal((await call('POST', '/workspaces', { token: limited.token, body: {} })).status, 403);
  assert.equal((await call('POST', '/workspaces', { token: editor.token, body: {} })).status, 403);
});

await check('a key that can only read doesn\'t block a key that can write', async () => {
  upstreamLog.length = 0;
  const r = await call('PUT', '/collections/c-shared', { token: admin, body: { collection: {} } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.via, KEY_B);
  assert.deepEqual(upstreamLog.filter((u) => u.method === 'PUT').map((u) => u.key), [KEY_A, KEY_B]);
  const made = await call('POST', '/collections?workspace=shared', { token: admin, body: { collection: {} } });
  assert.equal(made.status, 200, made.text);
});

await check('a key can be renamed', async () => {
  const r = await call('PATCH', `/admin/postman-accounts/${accountB}`, { token: admin, body: { label: 'Bola' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.label, 'Bola');
});

await check('a revoked key shows as invalid and doesn\'t hide other accounts', async () => {
  revoked.add(KEY_B);
  const list = await call('GET', '/admin/postman-accounts', { token: admin });
  assert.equal(list.data.accounts.find((a) => a.id === accountB).status, 'invalid');
  assert.equal(list.data.accounts.find((a) => a.id === accountA).status, 'ok');
  const r = await call('GET', '/workspaces', { token: admin });
  assert.equal(r.status, 200);
  assert.ok(ids(r).includes('acme-only'));
  assert.equal((await call('GET', '/collections/c-shared', { token: admin })).status, 200);
});

await check('replacing a key brings the account back', async () => {
  revoked.delete(KEY_B);
  accounts['PMAK-bravo-new-9999'] = accounts[KEY_B];
  const bad = await call('PATCH', `/admin/postman-accounts/${accountB}`, { token: admin, body: { api_key: 'PMAK-nope' } });
  assert.equal(bad.status, 400);
  const r = await call('PATCH', `/admin/postman-accounts/${accountB}`, { token: admin, body: { api_key: 'PMAK-bravo-new-9999' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.key_hint, '…9999');
  assert.equal(r.data.status, 'ok');
});

await check('removing an account ends access through it', async () => {
  assert.equal((await call('DELETE', `/admin/postman-accounts/${accountB}`, { token: admin })).status, 204);
  const r = await call('GET', '/workspaces', { token: admin });
  assert.ok(!ids(r).includes('bola-only'));
  assert.ok(ids(r).includes('shared'));
  const limited = await call('GET', '/workspaces/bola-only', { token: editor.token });
  assert.equal(limited.status, 404);
  const audit = await call('GET', '/admin/audit?limit=100', { token: admin });
  assert.ok(audit.data.some((row) => row.action === 'account_remove'));
});

await check('removing a missing account is a 404', async () => {
  assert.equal((await call('DELETE', '/admin/postman-accounts/9999', { token: admin })).status, 404);
});

await check('only admins can touch accounts', async () => {
  for (const token of [viewer.token, editor.token, creatorAll.token]) {
    assert.equal((await call('GET', '/admin/postman-accounts', { token })).status, 403);
    assert.equal((await call('POST', '/admin/postman-accounts', { token, body: { api_key: KEY_A } })).status, 403);
    assert.equal((await call('GET', '/admin/workspaces', { token })).status, 403);
    assert.equal((await call('DELETE', `/admin/postman-accounts/${accountA}`, { token })).status, 403);
  }
  assert.equal((await call('GET', '/admin/postman-accounts')).status, 401);
});

// Dispatch workspaces next to Postman ones.
let mixed = null;
await check('Dispatch and Postman workspaces are listed together', async () => {
  const made = await call('POST', '/admin/dispatch-workspaces', { token: admin, body: { name: 'In-house' } });
  assert.equal(made.status, 201, made.text);
  mixed = made.data.id;
  await call('POST', `/collections?workspace=${mixed}`, { token: admin, body: { collection: { info: { name: 'House' }, item: [] } } });
  const r = await call('GET', '/workspaces', { token: admin });
  assert.ok(ids(r).includes(mixed));
  assert.ok(ids(r).includes('acme-only'));
  const all = await call('GET', '/collections', { token: admin });
  const names = all.data.collections.map((c) => c.name);
  assert.ok(names.includes('House'), names.join());
  assert.ok(all.data.collections.some((c) => c.uid === 'c-acme'));
  const admins = await call('GET', '/admin/workspaces', { token: admin });
  const entry = admins.data.workspaces.find((w) => w.id === mixed);
  assert.equal(entry.dispatch, true);
  assert.equal(entry.collections, 1);
});

await check('grants and roles apply to Dispatch workspaces', async () => {
  const before = await call('GET', '/workspaces', { token: viewer.token });
  assert.ok(!ids(before).includes(mixed));
  assert.equal((await call('GET', `/collections?workspace=${mixed}`, { token: viewer.token })).status, 403);
  const uid = (await call('GET', `/collections?workspace=${mixed}`, { token: admin })).data.collections[0].uid;
  assert.equal((await call('GET', `/collections/${uid}`, { token: viewer.token })).status, 403);
  assert.equal((await call('PATCH', `/admin/users/${viewer.id}`, { token: admin, body: { workspace_grants: ['shared', mixed] } })).status, 200);
  const after = await call('GET', '/workspaces', { token: viewer.token });
  assert.deepEqual(ids(after), [mixed, 'shared'].sort());
  assert.equal((await call('GET', `/collections/${uid}`, { token: viewer.token })).status, 200);
  const write = await call('PUT', `/collections/${uid}`, { token: viewer.token, body: { collection: { info: { name: 'x' } } } });
  assert.equal(write.status, 403);
  const listed = await call('GET', '/collections', { token: viewer.token });
  assert.ok(listed.data.collections.some((c) => c.uid === uid));
  assert.equal((await call('DELETE', `/collections/${uid}`, { token: creatorAll.token })).status, 403);
});

await check('a Postman workspace can be copied onto the server', async () => {
  upstreamLog.length = 0;
  const r = await call('POST', '/admin/dispatch-workspaces/import', { token: admin, body: { workspace_id: 'acme-only' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.name, 'Acme internal');
  assert.equal(r.data.collections, 1);
  assert.equal(r.data.environments, 1);
  assert.ok(upstreamLog.every((u) => u.method === 'GET'), 'the import only reads from Postman');
  const copy = r.data.id;
  const cols = await call('GET', `/collections?workspace=${copy}`, { token: admin });
  assert.notEqual(cols.data.collections[0].uid, 'c-acme');
  const envs = await call('GET', `/environments?workspace=${copy}`, { token: admin });
  assert.equal(envs.data.environments[0].name, 'Acme env');
  assert.deepEqual((await call('GET', `/workspaces/${copy}/global-variables`, { token: admin })).data.values.map((v) => v.key), ['region']);
  assert.equal((await call('PATCH', `/admin/users/${viewer.id}`, { token: admin, body: { workspace_grants: [copy] } })).status, 200);
  const env = await call('GET', `/environments/${envs.data.environments[0].uid}`, { token: viewer.token });
  assert.equal(env.status, 200, env.text);
  assert.ok(!env.text.includes('SECRET'), 'viewers lose current values here too');
  assert.ok(env.text.includes('shared-token'));
  const audit = await call('GET', '/admin/audit?limit=100', { token: admin });
  assert.ok(audit.data.some((row) => row.action === 'workspace_import' && row.status === 201));
});

await check('only admins manage Dispatch workspaces', async () => {
  for (const token of [viewer.token, editor.token, creatorAll.token]) {
    assert.equal((await call('POST', '/admin/dispatch-workspaces', { token, body: { name: 'x' } })).status, 403);
    assert.equal((await call('PATCH', `/admin/dispatch-workspaces/${mixed}`, { token, body: { name: 'x' } })).status, 403);
    assert.equal((await call('DELETE', `/admin/dispatch-workspaces/${mixed}`, { token })).status, 403);
  }
  const renamed = await call('PATCH', `/admin/dispatch-workspaces/${mixed}`, { token: admin, body: { name: 'Renamed' } });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.data.name, 'Renamed');
});

await check('the admin panel is still served', async () => {
  const r = await fetch(`${BASE}/admin/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Dispatch Admin/);
});

fake.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
