// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { parseUrl, setRawUrl, rawWithQuery, normaliseImport, forUpload, findItem, effectiveAuth, getScript, setScript, duplicateItem, findExample, exampleFromResponse, newExample, duplicateExample, previewLanguage } from '../src/js/model.js';
import { Scope, Resolver, DYNAMIC, localOnlyKeys, persistCurrent, resetCurrent } from '../src/js/vars.js';
import { runScript } from '../src/js/scripts.js';
import { buildOutgoing, execute } from '../src/js/send.js';
import { stripJsonComments, formatJsonc, jsonProblem } from '../src/js/jsonc.js';

const require = createRequire(import.meta.url);
const libs = {
  chai: require('../src/vendor/chai.min.js'),
  CryptoJS: require('../src/vendor/crypto-js.min.js'),
  lodash: require('../src/vendor/lodash.min.js'),
};

const scopes = (env = [], col = [], glob = []) => ({
  local: new Scope([], {}),
  environment: new Scope(env, {}),
  collection: new Scope(col, {}),
  globals: new Scope(glob, {}),
});

test('parseUrl keeps variables and splits query', () => {
  const u = parseUrl('{{baseUrl}}/users/:id?page=2&q=a#top');
  assert.deepEqual(u.host, ['{{baseUrl}}']);
  assert.deepEqual(u.path, ['users', ':id']);
  assert.deepEqual(u.query, [{ key: 'page', value: '2' }, { key: 'q', value: 'a' }]);
  assert.equal(u.hash, 'top');
  assert.deepEqual(u.variable, [{ key: 'id', value: '' }]);
  const v = parseUrl('https://api.example.com:8443/v1');
  assert.equal(v.protocol, 'https');
  assert.equal(v.port, '8443');
  assert.deepEqual(v.host, ['api', 'example', 'com']);
});

// ---------- dispatch server profiles ----------

import { serverBaseUrl } from '../src/js/model.js';

test('serverBaseUrl normalises base urls', () => {
  assert.equal(serverBaseUrl(' https://dispatch.example.com/ '), 'https://dispatch.example.com');
  assert.equal(serverBaseUrl('http://localhost:8080/api/'), 'http://localhost:8080/api');
  assert.equal(serverBaseUrl('https://host/after/'), 'https://host/after');
  assert.throws(() => serverBaseUrl('dispatch.example.com'), /must start with http/);
  assert.throws(() => serverBaseUrl('ftp://x'), /must start with http/);
  assert.throws(() => serverBaseUrl('https://'), /has no host/);
  assert.throws(() => serverBaseUrl(''), /must start with http/);
  assert.throws(() => serverBaseUrl(undefined), /must start with http/);
});

test('query with ? inside a variable is not split', () => {
  const u = parseUrl('{{host?x}}/a');
  assert.equal(u.query, undefined);
});

test('rawWithQuery and setRawUrl preserve disabled params and path var values', () => {
  assert.equal(rawWithQuery('http://x/a?old=1#h', [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }]), 'http://x/a?a=1#h');
  const req = { url: { raw: 'http://x/:id', path: [':id'], variable: [{ key: 'id', value: '42' }], query: [{ key: 'off', value: '1', disabled: true }] } };
  setRawUrl(req, 'http://x/:id?on=1');
  assert.equal(req.url.variable[0].value, '42');
  assert.equal(req.url.query.length, 2);
});

test('variable precedence: local > env > collection > globals; overlay wins over initial', () => {
  const s = scopes([{ key: 'a', value: 'env', enabled: true }, { key: 'off', value: 'x', enabled: false }], [{ key: 'a', value: 'col' }, { key: 'b', value: 'col' }], [{ key: 'c', value: 'g' }]);
  const r = new Resolver(s);
  assert.equal(r.replace('{{a}}-{{b}}-{{c}}-{{off}}'), 'env-col-g-{{off}}');
  s.environment.set('a', 'current');
  assert.equal(r.replace('{{a}}'), 'current');
  assert.equal(s.environment.values[0].value, 'env', 'initial value untouched');
  s.local.set('a', 'local');
  assert.equal(r.replace('{{a}}'), 'local');
  s.environment.unset('b');
  assert.equal(r.replace('{{ b }}'), 'col');
  assert.match(r.replace('{{$guid}}'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(r.unresolved('{{nope}} {{a}}'), ['nope']);
});

test('nested variables resolve', () => {
  const s = scopes([{ key: 'host', value: '{{proto}}://api' }, { key: 'proto', value: 'https' }]);
  assert.equal(new Resolver(s).replace('{{host}}/x'), 'https://api/x');
});

test('pre-request script: env set, header upsert, CryptoJS signing, url query', async () => {
  const s = scopes([{ key: 'secret', value: 'k' }]);
  const req = { method: 'POST', header: [{ key: 'X-Old', value: '1' }], url: parseUrl('http://x/a?z=1'), body: { mode: 'raw', raw: '{"a":1}' } };
  const code = `
    const sig = CryptoJS.MD5('ref;' + pm.environment.get('secret')).toString();
    pm.request.headers.upsert({ key: 'Signature', value: sig });
    pm.request.headers.upsert({ key: 'x-old', value: '2' });
    pm.environment.set('ts', 123);
    pm.request.url.query.add({ key: 'b', value: '2' });
    const h = require('crypto-js').HmacSHA256('m', 'k').toString(CryptoJS.enc.Hex);
    pm.variables.set('hmac', h);
    console.log('body', JSON.parse(pm.request.body.raw).a);
  `;
  const r = await runScript(code, { phase: 'prerequest', request: req, resolver: new Resolver(s), scopes: s, libs, send: async () => ({}) });
  assert.equal(r.error, null);
  assert.equal(req.header.find((h) => h.key === 'Signature').value, libs.CryptoJS.MD5('ref;k').toString());
  assert.equal(req.header.find((h) => h.key === 'X-Old').value, '2');
  assert.equal(s.environment.get('ts'), '123');
  assert.equal(req.url.raw, 'http://x/a?z=1&b=2');
  assert.equal(s.local.get('hmac').length, 64);
  assert.deepEqual(r.logs.map((l) => l.message), ['body 1']);
});

test('test script: pm.test, pm.expect, pm.response helpers, legacy tests', async () => {
  const s = scopes();
  const response = { status: 201, statusText: 'Created', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'set-cookie', value: 'sid=abc; Path=/' }], bodyText: '{"data":{"id":7,"tags":["a","b"]}}', timeMs: 12, size: 30 };
  const code = `
    pm.test('status', () => pm.response.to.have.status(201));
    pm.test('success', () => pm.response.to.be.success);
    pm.test('json', () => { const j = pm.response.json(); pm.expect(j.data.id).to.eql(7); pm.expect(j.data.tags).to.include('b'); });
    pm.test('header', () => pm.response.to.have.header('content-type'));
    pm.test('fails', () => pm.expect(pm.response.code).to.equal(200));
    pm.test('async', async () => { await new Promise(r => setTimeout(r, 5)); pm.expect(1).to.be.above(2); });
    pm.test('jsonBody', () => pm.response.to.have.jsonBody('data.id', 7));
    pm.collectionVariables.set('id', pm.response.json().data.id);
    tests['legacy'] = responseCode.code === 201;
    pm.expect(pm.cookies.get('sid')).to.equal('abc');
  `;
  const r = await runScript(code, { phase: 'test', request: { url: parseUrl('http://x'), header: [] }, response, resolver: new Resolver(s), scopes: s, libs, send: async () => ({}) });
  assert.equal(r.error, null);
  const byName = Object.fromEntries(r.tests.map((t) => [t.name, t]));
  assert.equal(byName.status.passed, true);
  assert.equal(byName.success.passed, true);
  assert.equal(byName.json.passed, true);
  assert.equal(byName.header.passed, true);
  assert.equal(byName.fails.passed, false);
  assert.match(byName.fails.error, /expected 201 to equal 200/);
  assert.equal(byName.async.passed, false);
  assert.equal(byName.jsonBody.passed, true);
  assert.equal(byName.legacy.passed, true);
  assert.equal(s.collection.get('id'), '7');
});

test('script syntax/runtime errors are reported, not thrown', async () => {
  const s = scopes();
  const r = await runScript('pm.environment.get(;', { phase: 'prerequest', request: { header: [], url: parseUrl('') }, resolver: new Resolver(s), scopes: s, libs, send: async () => ({}) });
  assert.ok(r.error);
});

test('pm.sendRequest works with callback and await', async () => {
  const s = scopes([{ key: 'host', value: 'http://h' }]);
  const calls = [];
  const send = async (o) => { calls.push(o); return { status: 200, statusText: 'OK', headers: [], bodyText: '{"token":"t1"}', timeMs: 1, size: 1 }; };
  const code = `
    pm.sendRequest({ url: '{{host}}/token', method: 'POST', header: { 'X-A': '1' }, body: { mode: 'raw', raw: { a: 1 } } }, (err, res) => {
      pm.environment.set('token', res.json().token);
    });
    const r2 = await pm.sendRequest('{{host}}/two');
    pm.variables.set('two', r2.code);
  `;
  const r = await runScript(code, { phase: 'prerequest', request: { header: [], url: parseUrl('') }, resolver: new Resolver(s), scopes: s, libs, send });
  assert.equal(r.error, null);
  assert.equal(s.environment.get('token'), 't1');
  assert.equal(s.local.get('two'), '200');
  assert.equal(calls[0].url, 'http://h/token');
  assert.equal(calls[0].body.content, '{"a":1}');
  assert.deepEqual(calls[0].headers, [{ key: 'X-A', value: '1' }]);
});

const sample = {
  info: { _postman_id: 'c1', name: 'Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', updatedAt: '2026-01-01', uid: 'u-c1' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [{ key: 'base', value: 'http://api.test' }],
  event: [{ listen: 'prerequest', script: { exec: ["pm.request.headers.add({key:'X-Col', value:'1'})"] } }],
  item: [{
    name: 'Users', id: 'f1', uid: 'u-f1',
    auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: 'abc' }, { key: 'in', value: 'header' }] },
    item: [
      { name: 'Get user', id: 'r1', uid: 'u-r1', request: { method: 'GET', header: [{ key: 'H', value: '{{hv}}' }, { key: 'Off', value: 'x', disabled: true }], url: { raw: '{{base}}/users/:id?x=1', host: ['{{base}}'], path: ['users', ':id'], query: [{ key: 'x', value: '1' }], variable: [{ key: 'id', value: '9' }] } }, response: [], customField: { keep: true } },
      { name: 'Create', id: 'r2', request: { method: 'POST', auth: { type: 'noauth' }, header: [], url: '{{base}}/users', body: { mode: 'raw', raw: '{"n":"{{name}}"}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'test', script: { exec: ["pm.test('ok', () => pm.response.to.be.ok)"] } }] },
    ],
  }],
};

test('import normalises string urls, keeps unknown fields; upload strips server fields', () => {
  const { kind, data } = normaliseImport({ collection: sample });
  assert.equal(kind, 'collection');
  const r2 = findItem(data, 'r2').item;
  assert.equal(typeof r2.request.url, 'object');
  assert.deepEqual(findItem(data, 'r1').item.customField, { keep: true });
  const up = forUpload(data);
  assert.equal(up.info.updatedAt, undefined);
  assert.equal(up.info.uid, undefined);
  assert.equal(up.item[0].uid, undefined);
  assert.equal(up.item[0].item[0].id, 'r1', 'ids kept so Postman updates in place');
});

test('auth inheritance: request > folder > collection; noauth stops it', () => {
  const c = normaliseImport(sample).data;
  const f = findItem(c, 'r1');
  assert.equal(effectiveAuth(f.item.request, f.parents, c).auth.type, 'apikey');
  const g = findItem(c, 'r2');
  assert.equal(effectiveAuth(g.item.request, g.parents, c).auth.type, 'noauth');
  const noFolderAuth = { ...f.parents[0], auth: undefined };
  assert.equal(effectiveAuth(f.item.request, [noFolderAuth], c).auth.type, 'bearer');
});

test('buildOutgoing: path vars, disabled headers, auth, json content type', () => {
  const c = normaliseImport(sample).data;
  const s = scopes([{ key: 'hv', value: 'hello' }, { key: 'name', value: 'Ada' }], c.variable);
  const r = new Resolver(s);
  const f = findItem(c, 'r1');
  const o = buildOutgoing(f.item.request, effectiveAuth(f.item.request, f.parents, c).auth, r, {});
  assert.equal(o.url, 'http://api.test/users/9?x=1');
  assert.deepEqual(o.headers.find((h) => h.key === 'H'), { key: 'H', value: 'hello' });
  assert.ok(!o.headers.some((h) => h.key === 'Off'));
  assert.deepEqual(o.headers.find((h) => h.key === 'X-Key'), { key: 'X-Key', value: 'abc' });
  const g = findItem(c, 'r2');
  const o2 = buildOutgoing(g.item.request, effectiveAuth(g.item.request, g.parents, c).auth, r, {});
  assert.equal(o2.body.content, '{"n":"Ada"}');
  assert.ok(o2.headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json'));
  assert.ok(!o2.headers.some((h) => h.key === 'Authorization'));
});

test('basic auth and apikey-in-query', () => {
  const r = new Resolver(scopes());
  const o = buildOutgoing({ method: 'GET', url: parseUrl('http://x/a'), header: [] }, { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }, r, {});
  assert.equal(o.headers.find((h) => h.key === 'Authorization').value, 'Basic ' + Buffer.from('u:p').toString('base64'));
  const q = buildOutgoing({ method: 'GET', url: parseUrl('http://x/a?b=1'), header: [] }, { type: 'apikey', apikey: [{ key: 'key', value: 'k' }, { key: 'value', value: 'v' }, { key: 'in', value: 'query' }] }, r, {});
  assert.equal(q.url, 'http://x/a?b=1&k=v');
});

test('execute runs collection + request scripts in order and records tests', async () => {
  const c = normaliseImport(sample).data;
  const s = scopes([{ key: 'name', value: 'Ada' }], c.variable);
  const g = findItem(c, 'r2');
  let sent;
  const send = async (o) => { sent = o; return { status: 200, statusText: 'OK', headers: [], bodyText: '{}', timeMs: 3, size: 2 }; };
  const out = await execute({ item: g.item, parents: g.parents, collection: c, scopes: s, settings: {}, send, libs });
  assert.equal(out.error, null);
  assert.ok(sent.headers.some((h) => h.key === 'X-Col'), 'collection pre-request ran');
  assert.deepEqual(out.tests.map((t) => [t.name, t.passed]), [['ok', true]]);
});

test('scripts helpers round-trip', () => {
  const it = {};
  setScript(it, 'test', 'a\nb');
  assert.equal(getScript(it, 'test'), 'a\nb');
  setScript(it, 'test', '  ');
  assert.equal(it.event, undefined);
});

test('duplicate gives fresh ids', () => {
  const c = normaliseImport(sample).data;
  const d = duplicateItem(c.item[0]);
  assert.notEqual(d.id, 'f1');
  assert.notEqual(d.item[0].id, 'r1');
  assert.equal(d.item[0].uid, undefined);
});

import { parseCurl } from '../src/js/curl.js';

test('parseCurl handles common shapes', () => {
  const a = parseCurl(`curl --location 'https://api.x.io/v1/pay?ref=1' \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer t0k" \\\n  --data-raw '{"amount":100,"note":"it'\\''s"}'`);
  assert.equal(a.method, 'POST');
  assert.equal(a.url.raw, 'https://api.x.io/v1/pay?ref=1');
  assert.deepEqual(a.header.map((h) => h.key), ['Content-Type', 'Authorization']);
  assert.equal(a.body.options.raw.language, 'json');
  assert.equal(JSON.parse(a.body.raw).amount, 100);
  assert.equal(JSON.parse(a.body.raw).note, "it's");

  const b = parseCurl(`curl -X PUT https://h/x -u ada:pw -d 'a=1&b=two%20words' -H 'Content-Type: application/x-www-form-urlencoded'`);
  assert.equal(b.method, 'PUT');
  assert.equal(b.auth.type, 'basic');
  assert.deepEqual(b.body.urlencoded, [{ key: 'a', value: '1' }, { key: 'b', value: 'two words' }]);

  const c = parseCurl(`curl https://h/up -F 'name=Ada' -F 'file=@/tmp/a.pdf'`);
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.body.formdata[1], { key: 'file', type: 'file', src: '/tmp/a.pdf' });

  assert.throws(() => parseCurl('wget x'));
});

test('forUpload strips fields Postman rejects on collection variables', () => {
  const up = forUpload({ info: { name: 'x', schema: 's' }, item: [], variable: [{ key: 'a', value: '1', id: 'v1', description: 'd', enabled: false }, { key: '', value: 'blank' }] });
  assert.deepEqual(up.variable, [{ key: 'a', value: '1', disabled: true }]);
});

test('setRawUrl keeps param descriptions and disabled params in place', () => {
  const req = { url: { raw: 'http://x/a?a=1&c=3', query: [{ key: 'a', value: '1', description: 'first' }, { key: 'b', value: '2', disabled: true }, { key: 'c', value: '3' }] } };
  setRawUrl(req, 'http://x/a?a=9&c=3&d=4');
  assert.deepEqual(req.url.query, [
    { key: 'a', value: '9', description: 'first' },
    { key: 'b', value: '2', disabled: true },
    { key: 'c', value: '3' },
    { key: 'd', value: '4' },
  ]);
});

test('duplicate gives examples new ids', () => {
  const d = duplicateItem({ id: 'r', name: 'R', request: {}, response: [{ id: 'ex1', name: 'ok' }] });
  assert.notEqual(d.response[0].id, 'ex1');
});

test('script-created variables show up as local-only, and persist turns them into shared ones', async () => {
  const col = [{ key: 'baseUrl', value: 'https://a.test' }];
  const colOverlay = {};
  const s = { local: new Scope([], {}), environment: new Scope([], {}), collection: new Scope(col, colOverlay), globals: new Scope([], {}) };
  const r = await runScript("pm.collectionVariables.set('lastStatus', 200); pm.collectionVariables.set('baseUrl', 'https://b.test'); pm.collectionVariables.unset('gone');", { phase: 'test', request: { method: 'GET', url: 'x', header: [] }, response: { status: 200, headers: [], bodyText: '' }, resolver: new Resolver(s), scopes: s, libs });
  assert.equal(r.error, null);
  assert.deepEqual(localOnlyKeys(col, colOverlay), ['lastStatus'], 'unset (null) and existing names are not local-only');

  assert.equal(persistCurrent(col, colOverlay, 'disabled'), 2);
  assert.deepEqual(col, [{ key: 'baseUrl', value: 'https://b.test' }, { key: 'lastStatus', value: '200', type: 'default' }]);
  assert.deepEqual(colOverlay, { gone: null }, 'persisted current values are cleared; unsets are kept');
  assert.equal(persistCurrent(col, colOverlay, 'disabled'), 0);

  const env = [{ key: 'a', value: '1', enabled: false }];
  const envOverlay = { a: '1', b: '2' };
  assert.equal(persistCurrent(env, envOverlay, 'enabled'), 1, 'an unchanged value does not count');
  assert.deepEqual(env[1], { key: 'b', value: '2', type: 'default', enabled: true });
  assert.equal(env[0].enabled, false, 'persist leaves enabled state alone');
  resetCurrent(envOverlay);
  assert.deepEqual(envOverlay, {});
});

test('resolver lists names by winning scope, masks secrets, and knows Postman dynamic variables', () => {
  const s = scopes([{ key: 'token', value: 'abc', type: 'secret', enabled: true }, { key: 'a', value: 'env', enabled: true }], [{ key: 'a', value: 'col' }, { key: 'b', value: 'col' }]);
  const r = new Resolver(s);
  const named = r.names().filter((n) => n.scope !== 'dynamic');
  assert.deepEqual(named.map((n) => [n.name, n.scope]), [['token', 'environment'], ['a', 'environment'], ['b', 'collection']]);
  assert.equal(named[0].secret, true);
  assert.equal(r.replace('Bearer {{token}}'), 'Bearer abc');
  assert.equal(r.replace('Bearer {{token}}', 0, { mask: true }), 'Bearer ••••••');
  assert.ok(r.names().some((n) => n.name === '$randomCity' && n.scope === 'dynamic'));

  for (const [name, fn] of Object.entries(DYNAMIC)) {
    const v = fn();
    assert.equal(typeof v, 'string', name);
    assert.ok(v.length > 0, name);
  }
  assert.ok(Object.keys(DYNAMIC).length > 90);
  assert.match(r.replace('{{$randomIP}}'), /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(r.replace('{{$randomHexColor}}'), /^#[0-9a-f]{6}$/);
});

test('JSON bodies: comments are stripped before sending, but never inside strings', () => {
  const raw = '{\n  "model": "kimi", // pick a model\n  /* block */ "url": "https://x.io//a", "q": "say \\"//hi\\"",\n  "n": {{n}}\n}';
  const r = new Resolver(scopes([{ key: 'n', value: '2' }]));
  const req = (language) => ({ method: 'POST', url: parseUrl('http://api.test'), header: [], body: { mode: 'raw', raw, options: { raw: { language } } } });
  const sent = buildOutgoing(req('json'), null, r, {}).body.content;
  assert.deepEqual(JSON.parse(sent), { model: 'kimi', url: 'https://x.io//a', q: 'say "//hi"', n: 2 });
  assert.equal(buildOutgoing(req('text'), null, r, {}).body.content, raw.replace('{{n}}', '2'), 'only JSON bodies are touched');
  assert.equal(stripJsonComments('// only a comment'), '');
});

test('Beautify keeps comments and {{variables}}, and points at real errors', () => {
  const src = '{"model":"kimi", // pick a model\n"messages":[{"role":"user","content":"hi"} ],"n":{{n}},"e":{},"l":[]}';
  const out = formatJsonc(src);
  assert.equal(out, [
    '{',
    '  "model": "kimi", // pick a model',
    '  "messages": [',
    '    {',
    '      "role": "user",',
    '      "content": "hi"',
    '    }',
    '  ],',
    '  "n": {{n}},',
    '  "e": {},',
    '  "l": []',
    '}',
  ].join('\n'));
  assert.equal(formatJsonc(out), out, 'formatting twice changes nothing');
  assert.equal(jsonProblem(src), null);
  assert.match(jsonProblem('{\n  "a": 1, // fine\n  "b": oops\n}'), /oops|line 3/);
});

// ---------- auth signing ----------

import { awsSigV4Sign, digestHeader, parseDigestChallenge, hawkHeader } from '../src/js/authsign.js';
import { flattenRequests, parseDataFile } from '../src/js/runner.js';

test('aws sigv4 signs a canned request deterministically', () => {
  const u = new Date('2026-10-23T12:00:00Z');
  const { headers } = awsSigV4Sign({
    method: 'GET',
    url: 'https://execute-api.us-east-1.amazonaws.com/test/mypath?Action=List&Paging=off',
    bodyContent: '',
    params: { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI', region: 'us-east-1', service: 'execute-api' },
    CryptoJS: libs.CryptoJS,
    now: u,
  });
  const auth = headers.find((h) => h.key === 'Authorization').value;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261023\/us-east-1\/execute-api\/aws4_request,/);
  assert.match(auth, /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
  assert.match(auth, /Signature=[0-9a-f]{64}$/);
  assert.equal(headers.find((h) => h.key === 'x-amz-date').value, '20261023T120000Z');
});

test('aws sigv4 supports unsigned payload for bodies JS cannot hash', () => {
  const { headers, note } = awsSigV4Sign({
    method: 'POST', url: 'https://s3.amazonaws.com/bucket/x', bodyContent: '',
    params: { accessKey: 'A', secretKey: 'B', region: 'us-east-1', service: 's3', unsignedPayload: true },
    CryptoJS: libs.CryptoJS, now: new Date(0),
  });
  assert.equal(headers.find((h) => h.key === 'x-amz-content-sha256').value, 'UNSIGNED-PAYLOAD');
  assert.equal(note, null);
});

test('aws sigv4 reports missing credentials', () => {
  const r = awsSigV4Sign({ method: 'GET', url: 'https://x.example.com/', params: { accessKey: '', secretKey: '' }, CryptoJS: libs.CryptoJS });
  assert.match(r.note, /needs an access key/);
});

test('digest challenge parses and signs', () => {
  const ch = parseDigestChallenge('Digest realm="api@x", nonce="8d1f", qop="auth", opaque="OP", algorithm=MD5');
  assert.equal(ch.realm, 'api@x');
  const h1 = digestHeader({ challenge: ch, method: 'GET', url: 'https://x.example.com/p?a=b', params: { username: 'u', password: 'p' }, CryptoJS: libs.CryptoJS, clientNonce: 'deadbeef' });
  assert.match(h1, /^Digest username="u", realm="api@x", nonce="8d1f", uri="\/p\?a=b", algorithm=MD5, qop=auth, nc=00000001, cnonce="deadbeef", response="[0-9a-f]{32}", opaque="OP"$/);
});

test('digest without qop takes the rfc2069 shape', () => {
  const ch = parseDigestChallenge('Digest realm="r", nonce="n1"');
  const h1 = digestHeader({ challenge: ch, method: 'POST', url: 'https://x.example.com/', params: { username: 'u', password: 'p' }, CryptoJS: libs.CryptoJS, clientNonce: 'c' });
  assert.match(h1, /response="[0-9a-f]{32}", opaque=$|response="[0-9a-f]{32}"$/);
  assert.ok(!h1.includes('qop='));
});

test('hawk signs the canonical request', () => {
  const { headers, note } = hawkHeader({
    method: 'GET', url: 'https://example.com:8080/ab?x=1',
    params: { authId: 'dh37fgj492je', authKey: '94H8fS7h9C', algorithm: 'sha256', includePayload: 'false', nonce: 'dead' },
    CryptoJS: libs.CryptoJS, now: new Date(1698000000000),
  });
  assert.equal(note, null);
  const auth = headers[0].value;
  assert.match(auth, /^Hawk id="dh37fgj492je", ts="\d+", nonce="dead", mac="[A-Za-z0-9+/=]+"$/);
});

test('runner flattens requests in depth-first order', () => {
  const col = { info: { name: 'c' }, item: [
    { name: 'first', request: { method: 'GET' } },
    { name: 'grp', item: [
      { name: 'inner', request: { method: 'POST' } },
      { name: 'deep', item: [{ name: 'deepest', request: { method: 'PUT' } }] },
    ] },
    { name: 'last', request: { method: 'DEL' } },
  ] };
  const flat = flattenRequests(col, null);
  assert.deepEqual(flat.map((f) => f.item.name), ['first', 'inner', 'deepest', 'last']);

  col.item[1].id = 'f1';
  const sub = flattenRequests(col, 'f1');
  assert.deepEqual(sub.map((f) => f.item.name), ['inner', 'deepest']);
  assert.equal(sub[0].parents.length, 1);
});

test('data files parse as json arrays or csv', () => {
  assert.deepEqual(parseDataFile('[{"a":1,"b":"x"}]'), [{ a: '1', b: 'x' }]);
  assert.deepEqual(parseDataFile('a,b\n1,x\n2,"y,z"'), [{ a: '1', b: 'x' }, { a: '2', b: 'y,z' }]);
  assert.equal(parseDataFile('just one line'), null);
  assert.deepEqual(parseDataFile(''), []);
});

// ---------- response diffing ----------

import { lineDiff, diffResponses } from '../src/js/jsondiff.js';

test('line diff with common edges', () => {
  const r = lineDiff(['x', 'y', 'z'], ['x', 'Y', 'z']);
  assert.deepEqual(r, [{ type: 'del', line: 1, text: 'y' }, { type: 'add', line: 1, text: 'Y' }]);
});

test('json value diff reports only real changes', () => {
  const r = diffResponses(JSON.stringify({ a: 1, b: [1, 2], c: { d: 'x' } }), JSON.stringify({ a: 2, b: [1, 2], c: { d: 'x' }, e: 'new' }), {});
  assert.deepEqual(r.rows.map((x) => [x.type, x.path]), [['change', 'a'], ['add', 'e']]);
  assert.equal(r.mode, 'json');
});

test('json array order can be ignored', () => {
  const r = diffResponses(JSON.stringify([1, 2, 3]), JSON.stringify([3, 1, 2]), { ignoreArrayOrder: true });
  assert.deepEqual(r.rows, []);
  const strict = diffResponses(JSON.stringify([1, 2, 3]), JSON.stringify([3, 1, 2]), { ignoreArrayOrder: false });
  assert.equal(strict.rows.length > 0, true);
});

test('non-json bodies fall back to line mode', () => {
  const r = diffResponses('<h1>one</h1>', '<h1>two</h1>');
  assert.equal(r.mode, 'lines');
  assert.ok(r.rows.length >= 2);
});

test('identical bodies report as such', () => {
  const r = diffResponses('same', 'same');
  assert.equal(r.stats.same, 'identical');
  assert.deepEqual(r.rows, []);
});

// ---------- runner options ----------

import { runBatch } from '../src/js/runner.js';

const mkCol = (data) => ({ uid: `c-${Date.now()}`, name: 'RunnerTest', updatedAt: null, data, dirty: false, pendingCreate: false });

test('runBatch runs requests sequentially with shared env and stops on demand', async () => {
  globalThis.chai = (await import('../src/vendor/chai.min.js')).default ?? (await import('../src/vendor/chai.min.js'));
  const entry = mkCol({ info: { name: 'R', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, variable: [], item: [
    { name: 'a', request: { method: 'GET', url: { raw: 'x://a' } }, event: [{ listen: 'test', script: { type: 'text/javascript', exec: "pm.test('ok', () => pm.expect(pm.response.code).to.eql(201));" } }] },
    { name: 'b', request: { method: 'GET', url: { raw: 'x://b' } } },
  ] });
  let lastProgress;
  const summary = await runBatch({ entry, iterations: 2, onProgress: (res) => { lastProgress = res; }, send: async () => ({ status: 201, statusText: 'Created', headers: [], bodyText: '{}', timeMs: 5, contentType: 'application/json' }) });
  assert.equal(summary.runs === undefined || summary.runs !== 0, true);
  assert.equal(summary.results.length, 4); // 2 iterations x 2 requests
  assert.equal(summary.passed, 4);
  assert.equal(summary.failed, 0);
  assert.equal(lastProgress.iteration, 2);
  assert.equal(lastProgress.name, 'b');
});

test('examples get stable ids and are found by id', () => {
  const item = { name: 'r', request: { method: 'GET', url: parseUrl('/a') }, response: [{ name: 'no id' }, { id: 'x', name: 'has id' }] };
  const first = findExample(item, item.response[0].id ?? 'missing');
  assert.equal(first, null);
  const id = item.response[0].id; // assigned by the lookup above
  assert.ok(id);
  assert.equal(findExample(item, id).index, 0);
  assert.equal(findExample(item, 'x').example.name, 'has id');
  assert.equal(findExample({}, 'x'), null);
});

test('exampleFromResponse copies the request and response in Postman shape', () => {
  const request = { method: 'POST', header: [], url: parseUrl('{{base}}/users') };
  const ex = exampleFromResponse(request, { status: 201, statusText: 'Created', contentType: 'application/json; charset=utf-8', headers: [{ key: 'X-A', value: '1', extra: true }], bodyText: '{"id":1}' });
  assert.equal(ex.name, '201 Created');
  assert.equal(ex.code, 201);
  assert.equal(ex.status, 'Created');
  assert.equal(ex._postman_previewlanguage, 'json');
  assert.deepEqual(ex.header, [{ key: 'X-A', value: '1' }]);
  assert.equal(ex.body, '{"id":1}');
  assert.ok(ex.id);
  request.method = 'GET';
  assert.equal(ex.originalRequest.method, 'POST', 'request is copied, not shared');
  assert.equal(exampleFromResponse(request, { status: 500, headers: [] }, 'Runner 1').name, 'Runner 1');
});

test('new and duplicated examples', () => {
  const ex = newExample({ method: 'GET', header: [], url: parseUrl('/x') });
  assert.equal(ex.code, 200);
  assert.equal(ex.originalRequest.url.raw, '/x');
  assert.equal(newExample(undefined).originalRequest.method, 'GET');
  const copy = duplicateExample({ ...ex, uid: 'u1' });
  assert.notEqual(copy.id, ex.id);
  assert.equal(copy.uid, undefined);
  assert.equal(copy.name, 'New Example Copy');
  assert.equal(previewLanguage('text/html'), 'html');
  assert.equal(previewLanguage('application/xml'), 'xml');
  assert.equal(previewLanguage(''), 'text');
});

// ---------- code generation ----------
import { LANGUAGES, generate } from '../src/js/codegen.js';

const outgoingSamples = {
  none: { method: 'GET', url: 'https://api.example.com/users?page=2', headers: [{ key: 'Accept', value: '*/*' }, { key: 'Authorization', value: "Bearer it's" }], body: { mode: 'none' } },
  json: { method: 'POST', url: 'https://api.example.com/users', headers: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', content: '{"name":"Ada","quote":"it\'s `fine`"}' } },
  form: { method: 'POST', url: 'https://api.example.com/login', headers: [], body: { mode: 'urlencoded', fields: [{ key: 'user', value: 'a b' }, { key: 'pass', value: 'p&q' }] } },
  multipart: { method: 'PUT', url: 'https://api.example.com/upload', headers: [{ key: 'Content-Type', value: 'multipart/form-data' }], body: { mode: 'formdata', fields: [{ key: 'note', kind: 'text', value: 'hi' }, { key: 'file', kind: 'file', src: '/tmp/a b.png' }] } },
  file: { method: 'POST', url: 'https://api.example.com/blob', headers: [], body: { mode: 'file', path: '/tmp/data.bin' } },
};

test('every language generates for every body kind', () => {
  for (const [lang] of LANGUAGES) {
    for (const [kind, o] of Object.entries(outgoingSamples)) {
      const out = generate(lang, o);
      assert.ok(out.includes('api.example.com'), `${lang}/${kind} mentions the host`);
      assert.ok(!out.includes('undefined'), `${lang}/${kind} has no undefined`);
    }
  }
  assert.throws(() => generate('cobol', outgoingSamples.none));
});

test('generated JavaScript parses', () => {
  for (const [kind, o] of Object.entries(outgoingSamples)) {
    for (const lang of ['fetch', 'axios']) {
      // eslint-disable-next-line no-new-func
      assert.doesNotThrow(() => new Function('require', 'fileInput', 'file', `return (async () => {\n${generate(lang, o)}\n});`), `${lang}/${kind}`);
    }
  }
});

test('code generation quotes values safely', () => {
  const curl = generate('curl', outgoingSamples.none);
  assert.match(curl, /--header 'Authorization: Bearer it'\\''s'/);
  assert.ok(!curl.includes('Accept: */*'), 'default Accept is left out');
  const py = generate('python', outgoingSamples.json);
  assert.match(py, /payload = "\{\\"name\\":\\"Ada\\"/);
  assert.match(generate('go', outgoingSamples.json), /strings\.NewReader\("/, 'backtick content falls back to a quoted Go string');
  assert.match(generate('fetch', outgoingSamples.json), /JSON\.stringify\(\{\n {4}"name": "Ada"/);
  assert.match(generate('http', outgoingSamples.form), /^POST \/login HTTP\/1\.1\nHost: api\.example\.com/);
  assert.match(generate('http', outgoingSamples.form), /user=a%20b&pass=p%26q$/);
  assert.ok(!generate('fetch', outgoingSamples.multipart).includes('multipart/form-data'), 'fetch lets FormData set the boundary');
});

// ---------- runner script parity ----------
const okSend = async (o) => ({ status: 200, statusText: 'OK', headers: [], bodyText: JSON.stringify({ url: o.url }), timeMs: 1, contentType: 'application/json' });
const scriptItem = (name, test, pre) => ({ name, request: { method: 'GET', url: { raw: `x://${name}` } }, event: [
  ...(pre ? [{ listen: 'prerequest', script: { exec: pre } }] : []),
  ...(test ? [{ listen: 'test', script: { exec: test } }] : []),
] });

test('scripts see iteration data and iteration numbers', async () => {
  const entry = mkCol({ info: { name: 'D' }, variable: [], item: [
    scriptItem('a', "pm.test('row ' + pm.info.iteration + '/' + pm.info.iterationCount + ' ' + pm.iterationData.get('user') + ' ' + data.user + ' ' + iteration + ' ' + pm.iterationData.has('nope'), () => {});"),
  ] });
  const s = { ...scopes(), data: new Scope([{ key: 'user', value: 'cy', enabled: true }], {}) };
  const r = await execute({ item: entry.data.item[0], parents: [], collection: entry.data, scopes: s, settings: {}, send: okSend, libs, run: { iteration: 2, iterationCount: 3 } });
  assert.deepEqual(r.tests.map((x) => x.name), ['row 2/3 cy cy 2 false']);
  const outside = await execute({ item: entry.data.item[0], parents: [], collection: entry.data, scopes: scopes(), settings: {}, send: okSend, libs });
  assert.deepEqual(outside.tests.map((x) => x.name), ['row 0/1 undefined undefined 0 false']);
});

test('setNextRequest jumps, loops with a guard, and null stops', async () => {
  // a -> c (skip b), c loops back to a twice via a collection variable, then stops.
  const entry = mkCol({ info: { name: 'N' }, variable: [], item: [
    scriptItem('a', "pm.execution.setNextRequest('c');"),
    scriptItem('b'),
    scriptItem('c', "const n = Number(pm.collectionVariables.get('n') || 0) + 1; pm.collectionVariables.set('n', n); postman.setNextRequest(n < 3 ? 'a' : null);"),
    scriptItem('d'),
  ] });
  const order = [];
  const summary = await runBatch({ entry, send: async (o) => { order.push(o.url.slice(4)); return okSend(o); } });
  assert.deepEqual(order, ['a', 'c', 'a', 'c', 'a', 'c']);
  assert.equal(summary.results.length, 6);

  const bad = mkCol({ info: { name: 'B' }, variable: [], item: [scriptItem('a', "pm.execution.setNextRequest('missing');"), scriptItem('b')] });
  const s2 = await runBatch({ entry: bad, send: okSend });
  assert.equal(s2.results.length, 1);
  assert.match(s2.results[0].notes.join(' '), /no request with that name/);
});

test('pm.visualizer.set is captured and clear wins when called last', async () => {
  const item = scriptItem('v', "pm.visualizer.set('<b>{{url}}</b>', pm.response.json());");
  const r = await execute({ item, parents: [], collection: null, scopes: scopes(), settings: {}, send: okSend, libs });
  assert.equal(r.visualizer.template, '<b>{{url}}</b>');
  assert.deepEqual(r.visualizer.data, { url: 'x://v' });
  const cleared = await execute({ item: scriptItem('v', "pm.visualizer.set('x', {}); pm.visualizer.clear();"), parents: [], collection: null, scopes: scopes(), settings: {}, send: okSend, libs });
  assert.equal(cleared.visualizer, null);
});

// ---------- JSONPath filter ----------
import { jsonPath } from '../src/js/jsonpath.js';

test('jsonPath covers the common selectors', () => {
  const doc = { store: { book: [
    { title: 'A', price: 8, tags: ['x'], author: { name: 'Ada' } },
    { title: 'B', price: 12 },
    { title: "C's", price: 5, tags: [] },
  ], 'odd key': 1, bicycle: { price: 20 } }, n: null };
  assert.deepEqual(jsonPath(doc, '$.store.book[*].title'), ['A', 'B', "C's"]);
  assert.deepEqual(jsonPath(doc, 'store.book[0].title'), ['A']);
  assert.deepEqual(jsonPath(doc, '$.store.book[-1].title'), ["C's"]);
  assert.deepEqual(jsonPath(doc, '$.store.book[0,2].price'), [8, 5]);
  assert.deepEqual(jsonPath(doc, '$.store.book[1:].title'), ['B', "C's"]);
  assert.deepEqual(jsonPath(doc, "$.store['odd key']"), [1]);
  assert.deepEqual(jsonPath(doc, '$..price'), [8, 12, 5, 20]);
  assert.deepEqual(jsonPath(doc, '$..author.name'), ['Ada']);
  assert.deepEqual(jsonPath(doc, '$.store.book[?(@.price < 10)].title'), ['A', "C's"]);
  assert.deepEqual(jsonPath(doc, '$.store.book[?(@.tags)].title'), ['A', "C's"]);
  assert.deepEqual(jsonPath(doc, "$.store.book[?(@.title == \"C's\" || @.price > 10)].title"), ['B', "C's"]);
  assert.deepEqual(jsonPath(doc, '$.store.book[?(@.tags.length > 0)].title'), ['A']);
  assert.deepEqual(jsonPath(doc, '$.store.book[?(@.title =~ /^[AB]$/)].price'), [8, 12]);
  assert.deepEqual(jsonPath(doc, '$..book[?(@.author.name == "Ada")].title'), ['A']);
  assert.deepEqual(jsonPath(doc, '$.store.book.length'), [3]);
  assert.deepEqual(jsonPath(doc, '$.n'), [null]);
  assert.deepEqual(jsonPath(doc, '$.missing.deeper'), []);
  assert.deepEqual(jsonPath(doc, '$'), [doc]);
  assert.throws(() => jsonPath(doc, '$.store.book[0'), /Missing \]/);
  assert.throws(() => jsonPath(doc, '$.store.book[?(@.price <)]'), /ended early/);
});

// ---------- importers ----------
import { convertImport } from '../src/js/importers.js';
const jsyaml = require('../src/vendor/js-yaml.min.js');

const flat = (items, out = []) => { for (const it of items) { if (it.item) flat(it.item, out); else out.push(it); } return out; };

test('OpenAPI 3 YAML becomes a collection with folders, params, bodies, auth and examples', () => {
  const spec = `
openapi: 3.0.3
info: { title: Pet Store, version: "1.2", description: Pets API }
servers:
  - url: https://{env}.example.com/v1/
    variables: { env: { default: api } }
security: [ { bearer: [] } ]
tags: [ { name: pets, description: All about pets } ]
paths:
  /pets/{petId}:
    parameters:
      - { name: petId, in: path, required: true, schema: { type: integer, example: 7 } }
    get:
      tags: [pets]
      summary: Get a pet
      parameters:
        - { name: fields, in: query, schema: { type: string } }
        - { name: verbose, in: query, required: true, schema: { type: boolean } }
        - { name: X-Trace, in: header, schema: { type: string, example: abc } }
      responses:
        "200":
          description: The pet
          content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } }
        "404": { description: Not found }
    put:
      tags: [pets]
      operationId: updatePet
      security: []
      requestBody:
        content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } }
      responses: { "204": { description: Updated } }
  /upload:
    post:
      summary: Upload
      requestBody:
        content:
          multipart/form-data:
            schema: { type: object, properties: { file: { type: string, format: binary }, note: { type: string, example: hi } } }
      responses: { "201": { description: Created } }
components:
  securitySchemes: { bearer: { type: http, scheme: bearer } }
  schemas:
    Pet:
      type: object
      properties:
        id: { type: integer, example: 1 }
        name: { type: string, example: Rex }
        tags: { type: array, items: { type: string } }
        parent: { $ref: '#/components/schemas/Pet' }
`;
  const r = convertImport(spec, { fileName: 'pets.yaml', yaml: jsyaml });
  assert.equal(r.format, 'OpenAPI');
  const c = r.data;
  assert.equal(c.info.name, 'Pet Store');
  assert.deepEqual(c.variable.find((v) => v.key === 'baseUrl').value, 'https://api.example.com/v1');
  assert.equal(c.auth.type, 'bearer');
  assert.ok(c.variable.some((v) => v.key === 'bearerToken'));
  const pets = c.item.find((x) => x.name === 'pets');
  assert.equal(pets.description, 'All about pets');
  const get = pets.item.find((x) => x.name === 'Get a pet');
  assert.equal(get.request.method, 'GET');
  assert.equal(get.request.url.raw, '{{baseUrl}}/pets/:petId?verbose=true');
  assert.deepEqual(get.request.url.variable, [{ key: 'petId', value: '7' }]);
  assert.deepEqual(get.request.url.query.map((q) => [q.key, !!q.disabled]), [['fields', true], ['verbose', false]]);
  assert.deepEqual(get.request.header, [{ key: 'X-Trace', value: 'abc' }]);
  assert.deepEqual(get.response.map((x) => x.code), [200, 404]);
  assert.deepEqual(JSON.parse(get.response[0].body).name, 'Rex', 'recursive schema resolves without looping');
  const put = pets.item.find((x) => x.name === 'updatePet');
  assert.equal(put.request.auth.type, 'noauth', 'security: [] turns auth off');
  assert.equal(JSON.parse(put.request.body.raw).id, 1);
  assert.ok(put.request.header.some((x) => x.key === 'Content-Type' && x.value === 'application/json'));
  const upload = c.item.find((x) => x.name === 'Upload');
  assert.deepEqual(upload.request.body.formdata.map((f) => [f.key, f.type]), [['file', 'file'], ['note', 'text']]);
});

test('Swagger 2 with body and form params', () => {
  const r = convertImport(JSON.stringify({
    swagger: '2.0', info: { title: 'Old API' }, host: 'old.example.com', basePath: '/api', schemes: ['http', 'https'],
    securityDefinitions: { key: { type: 'apiKey', name: 'X-Key', in: 'header' } }, security: [{ key: [] }],
    paths: {
      '/users': { post: { summary: 'Create', consumes: ['application/json'], parameters: [{ in: 'body', name: 'body', schema: { type: 'object', properties: { email: { type: 'string', format: 'email' } } } }], responses: { 201: { description: 'ok', schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } } } } },
      '/login': { post: { summary: 'Login', consumes: ['application/x-www-form-urlencoded'], parameters: [{ in: 'formData', name: 'user', type: 'string', 'x-example': 'ada' }] } },
    },
  }));
  assert.equal(r.format, 'Swagger');
  const c = r.data;
  assert.equal(c.variable[0].value, 'https://old.example.com/api');
  assert.equal(c.auth.type, 'apikey');
  const create = c.item.find((x) => x.name === 'Create');
  assert.deepEqual(JSON.parse(create.request.body.raw), { email: 'user@example.com' });
  assert.equal(JSON.parse(create.response[0].body).id, '00000000-0000-0000-0000-000000000000');
  const login = c.item.find((x) => x.name === 'Login');
  assert.deepEqual(login.request.body.urlencoded, [{ key: 'user', value: 'ada' }]);
});

test('Insomnia v4 export keeps folders, variables, auth and environments', () => {
  const r = convertImport(JSON.stringify({ _type: 'export', __export_format: 4, resources: [
    { _id: 'wrk_1', _type: 'workspace', name: 'Shop' },
    { _id: 'env_base', _type: 'environment', parentId: 'wrk_1', name: 'Base', data: { baseUrl: 'https://shop.test', nested: { a: 1 } } },
    { _id: 'env_prod', _type: 'environment', parentId: 'env_base', name: 'Prod', data: { baseUrl: 'https://shop.com' } },
    { _id: 'fld_1', _type: 'request_group', parentId: 'wrk_1', name: 'Orders', metaSortKey: 1 },
    { _id: 'req_2', _type: 'request', parentId: 'fld_1', name: 'List', method: 'GET', url: '{{ _.baseUrl }}/orders', metaSortKey: 2, parameters: [{ name: 'page', value: '1' }, { name: 'debug', value: 'y', disabled: true }], headers: [{ name: 'X-A', value: '{{ _.token }}' }], authentication: { type: 'bearer', token: '{{ _.token }}' } },
    { _id: 'req_1', _type: 'request', parentId: 'fld_1', name: 'Create', method: 'POST', url: '{{ _.baseUrl }}/orders', metaSortKey: 1, body: { mimeType: 'application/json', text: '{"q":1}' } },
  ] }));
  assert.equal(r.format, 'Insomnia');
  const c = r.data;
  assert.equal(c.info.name, 'Shop');
  assert.deepEqual(c.variable, [{ key: 'baseUrl', value: 'https://shop.test', type: 'string' }]);
  const orders = c.item[0];
  assert.deepEqual(orders.item.map((x) => x.name), ['Create', 'List'], 'sorted by metaSortKey');
  const list = orders.item[1];
  assert.equal(list.request.url.raw, '{{baseUrl}}/orders?page=1');
  assert.deepEqual(list.request.url.query.map((q) => [q.key, !!q.disabled]), [['page', false], ['debug', true]]);
  assert.equal(list.request.header[0].value, '{{token}}');
  assert.equal(list.request.auth.bearer[0].value, '{{token}}');
  const create = orders.item[0];
  assert.equal(create.request.body.raw, '{"q":1}');
  assert.ok(create.request.header.some((x) => x.key === 'Content-Type'));
  assert.deepEqual(r.environments, [{ name: 'Prod', values: [{ key: 'baseUrl', value: 'https://shop.com', type: 'default', enabled: true }] }]);
});

test('Insomnia v5 YAML', () => {
  const r = convertImport(`type: collection.insomnia.rest/5.0
name: Five
collection:
  - name: Group
    children:
      - name: Ping
        method: GET
        url: "{{ _.host }}/ping"
environments:
  name: Base
  data: { host: "http://localhost:3000" }
  subEnvironments:
    - name: Staging
      data: { host: "https://staging.test" }
`, { yaml: jsyaml });
  assert.equal(r.data.info.name, 'Five');
  assert.equal(r.data.item[0].item[0].request.url.raw, '{{host}}/ping');
  assert.equal(r.environments[0].name, 'Staging');
});

test('HAR entries become requests with examples, grouped by host', () => {
  const har = { log: { creator: { name: 'Chrome' }, entries: [
    { request: { method: 'POST', url: 'https://a.test/api/login?x=1', headers: [{ name: ':authority', value: 'a.test' }, { name: 'Content-Type', value: 'application/json' }, { name: 'Content-Length', value: '9' }], postData: { mimeType: 'application/json', text: '{"u":"a"}' } }, response: { status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: '{"ok":true}' } } },
    { request: { method: 'GET', url: 'https://b.test/img.png', headers: [] }, response: { status: 200, content: { mimeType: 'image/png', text: 'AAAA', encoding: 'base64' } } },
    { request: { method: 'GET', url: 'data:image/png;base64,AAAA', headers: [] } },
  ] } };
  const r = convertImport(JSON.stringify(har), { fileName: '/tmp/session.har' });
  assert.equal(r.format, 'HAR');
  const c = r.data;
  assert.equal(c.info.name, 'session');
  assert.deepEqual(c.item.map((f) => f.name), ['a.test', 'b.test']);
  const login = c.item[0].item[0];
  assert.equal(login.name, 'POST /api/login');
  assert.deepEqual(login.request.header, [{ key: 'Content-Type', value: 'application/json' }]);
  assert.equal(login.request.body.raw, '{"u":"a"}');
  assert.equal(login.response[0].body, '{"ok":true}');
  assert.equal(c.item[1].item[0].response[0].body, '', 'base64 bodies are left out');
  assert.equal(flat(c.item).length, 2);
});

test('convertImport still handles Postman files and reports bad input', () => {
  const pm = convertImport(JSON.stringify({ info: { name: 'P', schema: 'x' }, item: [{ name: 'r', request: 'https://x.test' }] }));
  assert.equal(pm.format, 'Postman');
  assert.equal(pm.data.item[0].request.url.raw, 'https://x.test');
  assert.equal(convertImport(JSON.stringify({ name: 'E', values: [] })).kind, 'environment');
  assert.throws(() => convertImport(''), /empty/);
  assert.throws(() => convertImport('{bad'), /valid JSON/);
  assert.throws(() => convertImport('a: [', { yaml: jsyaml }), /YAML/);
  assert.throws(() => convertImport(JSON.stringify({ hello: 1 })), /isn't a Postman collection/);
});

// ---------- command palette matching ----------
import { fuzzyScore, rank } from '../src/js/fuzzy.js';

test('fuzzy matching prefers direct, word-start and contiguous hits', () => {
  assert.equal(fuzzyScore('xyz', 'Get user'), -1);
  assert.ok(fuzzyScore('gu', 'Get user') > 0, 'subsequence');
  assert.ok(fuzzyScore('user', 'Get user') > fuzzyScore('gtusr', 'Get user'));
  assert.ok(fuzzyScore('user', 'user') > fuzzyScore('user', 'Get user'), 'exact beats contains');
  assert.ok(fuzzyScore('cre ord', 'Orders / Create order') > 0, 'words in any order');
  assert.equal(fuzzyScore('cre zzz', 'Orders / Create order'), -1);
  const items = [
    { id: 'a', fields: [['List users', 1], ['GET {{base}}/users', 0.6]] },
    { id: 'b', fields: [['Create user', 1]] },
    { id: 'c', fields: [['Settings', 1]], boost: 0 },
  ];
  assert.deepEqual(rank('user', items).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(rank('', items).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(rank('/users', items).map((x) => x.id), ['a'], 'URL field matches');
});

// ---------- vault ----------
import { setVault } from '../src/js/vars.js';
import { parseDotEnv } from '../src/js/vault.js';

test('vault secrets resolve for sending but not for scripts or snippets', async () => {
  setVault({ token: 's3cret' });
  try {
    const r = new Resolver(scopes());
    assert.equal(r.replace('Bearer {{vault:token}}'), 'Bearer s3cret');
    assert.equal(r.lookup('vault:token').secret, true);
    assert.equal(r.replace('{{vault:token}}', 0, { mask: true }), '••••••');
    assert.equal(r.withoutVault().replace('Bearer {{vault:token}}'), 'Bearer {{vault:token}}');
    assert.equal(r.replace('{{vault:missing}}'), '{{vault:missing}}');
    assert.ok(r.names().some((n) => n.name === 'vault:token' && n.scope === 'vault'));
    assert.ok(!r.withoutVault().names().some((n) => n.scope === 'vault'));
    // Scripts get the placeholder back, even through pm.variables.replaceIn.
    const s = scopes();
    const res = await runScript("pm.test(pm.variables.replaceIn('{{vault:token}}') + ' ' + String(pm.variables.get('vault:token')), () => {});", { phase: 'prerequest', request: { header: [], url: parseUrl('http://x') }, resolver: new Resolver(s), scopes: s, libs, send: async () => ({}) });
    assert.equal(res.tests[0].name, '{{vault:token}} undefined');
    // The request that goes out does carry the secret.
    const sent = [];
    const { execute } = await import('../src/js/send.js');
    await execute({ item: { name: 'v', request: { method: 'GET', url: parseUrl('https://x.test/a'), header: [{ key: 'Authorization', value: 'Bearer {{vault:token}}' }] } }, parents: [], collection: null, scopes: scopes(), settings: {}, send: async (o) => { sent.push(o); return { status: 200, headers: [], bodyText: '' }; }, libs });
    assert.equal(sent[0].headers.find((x) => x.key === 'Authorization').value, 'Bearer s3cret');
  } finally { setVault({}); }
});

test('.env parsing', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1\nexport B="two words"\nC=\'x=y\'\nD=plain # trailing\nbad line\nE="multi\\nline"\n'), { A: '1', B: 'two words', C: 'x=y', D: 'plain', E: 'multi\nline' });
});

// ---------- collections as folders ----------
import { toFiles, fromFiles, ownFiles, signature, slug } from '../src/js/gitfs.js';

test('collections round-trip through readable files', () => {
  const col = {
    info: { _postman_id: 'pid', name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Docs', updatedAt: 'x', uid: 'u' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] },
    variable: [{ key: 'base', value: 'https://x' }],
    item: [
      { id: 'f1', uid: 'U', name: 'Orders / Admin', description: 'Folder docs', item: [
        { id: 'r1', name: 'Create order', request: { method: 'POST', url: { raw: '{{base}}/o' } }, response: [{ id: 'e1', name: '201', code: 201, body: '{}' }] },
        { id: 'r2', name: 'Create order', request: { method: 'POST', url: { raw: '{{base}}/o2' } } },
      ] },
      { id: 'r3', name: 'Ping!', request: { method: 'GET', url: { raw: '{{base}}/ping' } } },
      { id: 'f2', name: 'Empty', item: [] },
    ],
  };
  const files = toFiles(col);
  assert.deepEqual(files.map((f) => f.path), ['collection.json', 'empty/folder.json', 'orders-admin/create-order-2.request.json', 'orders-admin/create-order.request.json', 'orders-admin/folder.json', 'ping.request.json']);
  const top = JSON.parse(files.find((f) => f.path === 'collection.json').content);
  assert.deepEqual(top.order, ['orders-admin', 'ping.request.json', 'empty']);
  assert.equal(top.info.updatedAt, undefined, 'server-managed fields are left out');
  assert.ok(files.every((f) => f.content.endsWith('\n') && f.content.includes('\n  ')), 'pretty-printed');
  assert.ok(!files.some((f) => f.content.includes('"uid"')));

  const back = fromFiles(files);
  assert.equal(back.info.name, 'Shop');
  assert.equal(back.auth.type, 'bearer');
  assert.deepEqual(back.item.map((x) => x.name), ['Orders / Admin', 'Ping!', 'Empty']);
  assert.deepEqual(back.item[0].item.map((x) => x.request.url.raw), ['{{base}}/o', '{{base}}/o2'], 'order kept');
  assert.equal(back.item[0].description, 'Folder docs');
  assert.equal(back.item[0].item[0].response[0].code, 201);
  assert.deepEqual(toFiles(back), files, 'stable: writing what was read changes nothing');

  // A teammate adds a request file by hand, and edits another.
  const added = [...files, { path: 'orders-admin/refund.request.json', content: JSON.stringify({ name: 'Refund', request: { method: 'POST', url: { raw: '/r' } } }) }];
  const withNew = fromFiles(added);
  assert.deepEqual(withNew.item[0].item.map((x) => x.name), ['Create order', 'Create order', 'Refund']);
  assert.ok(withNew.item[0].item[2].id, 'hand-written requests get an id');
  assert.notEqual(signature(ownFiles(added)), signature(ownFiles(files)));
  assert.equal(signature(ownFiles([...files, { path: 'README.md', content: 'x' }])), signature(ownFiles(files)), 'other files are ignored');

  assert.throws(() => fromFiles([{ path: 'x.json', content: '{}' }]), /no collection.json/);
  assert.throws(() => fromFiles([...files.filter((f) => f.path !== 'ping.request.json'), { path: 'ping.request.json', content: '{oops' }]), /ping.request.json isn't valid JSON/);
  assert.equal(slug('Café Créme  2!', 'x'), 'cafe-creme-2');
  assert.equal(slug('!!!', 'request'), 'request');
});

// ---------- mock server routes ----------
import { mockPath, routesFor } from '../src/js/mockserver.js';

test('mock routes come from examples', () => {
  assert.equal(mockPath('{{baseUrl}}/pets/:id?x=1#h'), '/pets/:id');
  assert.equal(mockPath('https://api.test:8080/v1/pets'), '/v1/pets');
  assert.equal(mockPath('api.example.com/pets'), '/pets');
  assert.equal(mockPath('localhost/pets'), '/pets');
  assert.equal(mockPath('{{host}}{{base}}/a//b'), '/a/b');
  assert.equal(mockPath('pets/1'), '/pets/1');
  assert.equal(mockPath(''), '/');
  const col = { item: [{ name: 'F', item: [
    { name: 'Get pet', request: { method: 'get', url: { raw: '{{baseUrl}}/pets/:id' } }, response: [
      { name: 'Found', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }], body: '{"id":1}' },
      { name: 'Missing', code: 404, originalRequest: { method: 'GET', url: { raw: '{{baseUrl}}/pets/:id?mode=strict&tok={{t}}', query: [{ key: 'mode', value: 'strict' }, { key: 'tok', value: '{{t}}' }] } }, body: '' },
    ] },
    { name: 'No examples', request: { method: 'POST', url: { raw: '/x' } } },
  ] }] };
  const r = routesFor(col, { delayMs: 50 });
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].method, r[0].path, r[0].name, r[0].code, r[0].delayMs, r[0].request], ['GET', '/pets/:id', 'Found', 200, 50, 'Get pet']);
  assert.deepEqual(r[0].headers, [['Content-Type', 'application/json']]);
  assert.deepEqual(r[1].query, [['mode', 'strict']], 'variable query values are not matched');
});

test('folder files keep their names across renames and hand-added files', async () => {
  const { pathsFromTree, pathsOf } = await import('../src/js/gitfs.js');
  const files = [
    { path: 'collection.json', content: JSON.stringify({ info: { name: 'C' }, order: ['api'] }) },
    { path: 'api/folder.json', content: JSON.stringify({ id: 'f1', name: 'API', order: ['refund.request.json'] }) },
    { path: 'api/refund.request.json', content: JSON.stringify({ name: 'Refund (from git)', request: { method: 'POST', url: { raw: '/r' } } }) },
  ];
  const col = fromFiles(files);
  const paths = pathsFromTree(col);
  assert.equal(paths.f1, 'api');
  assert.equal(paths[col.item[0].item[0].id], 'api/refund.request.json');
  assert.ok(!JSON.stringify(col).includes('refund.request.json'), 'source paths are not saved');
  col.item[0].item[0].name = 'Refund an order';
  col.item[0].name = 'Payments API';
  const out = toFiles(col, { paths });
  assert.deepEqual(out.map((f) => f.path), ['api/folder.json', 'api/refund.request.json', 'collection.json']);
  assert.equal(pathsOf(out)[col.item[0].item[0].id], 'api/refund.request.json');
  // A name that's taken (or moved to another folder) falls back to the slug.
  col.item.push({ id: 'n2', name: 'Other', request: { method: 'GET', url: { raw: '/' } } });
  assert.ok(toFiles(col, { paths: { ...paths, n2: 'api/refund.request.json' } }).some((f) => f.path === 'other.request.json'));
});

test('stopping a run keeps the results of requests that already ran', async () => {
  const entry = mkCol({ info: { name: 'S' }, variable: [], item: [scriptItem('a'), scriptItem('b'), scriptItem('c')] });
  let n = 0;
  const summary = await runBatch({ entry, send: okSend, recordHistory: false, onProgress: () => { n++; }, isStopped: () => n >= 2 });
  assert.equal(summary.cancelled, true);
  assert.deepEqual(summary.results.map((r) => r.name), ['a', 'b']);
  assert.equal(summary.results[0].tests.length, 0);
});

// ---------- CLI ----------
test('CLI arguments and JUnit output', async () => {
  const { parseArgs, junit } = await import('../bin/dispatch.mjs');
  const o = parseArgs(['run', 'c.json', '-e', 'env.json', '--env-var', 'a=b=c', '-n', '3', '--folder', 'Auth', '--folder', 'Pay', '-r', 'cli,junit', '--bail', '-k']);
  assert.deepEqual([o.cmd, o.target, o.environment, o.iterations, o.folders, o.reporters, o.bail, o.insecure], ['run', 'c.json', 'env.json', 3, ['Auth', 'Pay'], ['cli', 'junit'], true, true]);
  assert.deepEqual(o.envVars, [['a', 'b=c']]);
  assert.throws(() => parseArgs(['run', 'x', '--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['run', 'x', '-r', 'html']), /Unknown reporter/);
  assert.throws(() => parseArgs(['run', 'x', '--env-var', 'novalue']), /key=value/);
  const xml = junit({ collectionName: 'C & co', durationMs: 1500, results: [
    { name: 'Login', method: 'POST', iteration: 1, status: 200, timeMs: 12, tests: [{ name: 'ok <1>', passed: true }, { name: 'bad', passed: false, error: 'expected "x"' }] },
    { name: 'Down', method: 'GET', iteration: 1, status: null, error: 'Couldn\'t connect', timeMs: 0, tests: [] },
  ] });
  assert.match(xml, /<testsuites name="C &amp; co" time="1.5">/);
  assert.match(xml, /<testcase name="ok &lt;1&gt;"/);
  assert.match(xml, /<failure message="expected &quot;x&quot;"\/>/);
  assert.match(xml, /<testcase name="GET Down responds"[^>]*><failure message="Couldn&apos;t connect"\/>/);
  assert.equal((xml.match(/<testsuite /g) || []).length, 2);
});

// ---------- streaming ----------
import { sseParser, parseSse, parseNdjson } from '../src/js/sse.js';

test('SSE parsing, whole and incremental', () => {
  const text = ': heartbeat\nid: 1\nevent: delta\ndata: {"t":"Hel"}\n\ndata: line one\ndata: line two\n\nretry: 3000\ndata:no-space\r\n\r\ndata: trailing';
  const all = parseSse(text);
  assert.deepEqual(all.map((e) => [e.event, e.data, e.id]), [['delta', '{"t":"Hel"}', '1'], ['message', 'line one\nline two', '1'], ['message', 'no-space', '1'], ['message', 'trailing', '1']]);
  assert.equal(all[2].retry, 3000);
  const p = sseParser();
  const got = [];
  for (const piece of ['data: a', 'b\n', '\nevent: x\nda', 'ta: c\n\n']) got.push(...p.push(piece));
  assert.deepEqual(got.map((e) => e.data), ['ab', 'c']);
  assert.deepEqual(p.end(), []);
  assert.deepEqual(parseNdjson('{"a":1}\nnot json\n\n').map((x) => x.json ?? x.data), [{ a: 1 }, 'not json']);
});

// ---------- GraphQL ----------
import { buildSchema, validateQuery, completeAt, insertionFor } from '../src/js/graphql.js';

const gqlType = (kind, name, ofType) => (name ? { kind, name } : { kind, name: null, ofType });
const NN = (t) => gqlType('NON_NULL', null, t);
const LIST = (t) => gqlType('LIST', null, t);
const S = gqlType('SCALAR', 'String');
const ID = gqlType('SCALAR', 'ID');
const obj = (n) => gqlType('OBJECT', n);
const field = (name, type, args = []) => ({ name, type, args: args.map(([n, t]) => ({ name: n, type: t, defaultValue: null })), description: '', isDeprecated: false });
const schemaJson = { data: { __schema: {
  queryType: { name: 'Query' }, mutationType: null, subscriptionType: null,
  types: [
    { kind: 'OBJECT', name: 'Query', fields: [field('user', obj('User'), [['id', NN(ID)]]), field('users', NN(LIST(NN(obj('User'))))), field('version', S)] },
    { kind: 'OBJECT', name: 'User', fields: [field('id', NN(ID)), field('name', S), field('friends', LIST(obj('User')))] },
    { kind: 'SCALAR', name: 'String' }, { kind: 'SCALAR', name: 'ID' },
  ],
} } };

test('GraphQL schema, validation and completion', () => {
  const schema = buildSchema(schemaJson);
  assert.equal(schema.query, 'Query');
  assert.equal(schema.types.get('Query').fields.get('users').typeStr, '[User!]!');
  assert.deepEqual(validateQuery('query Q($id: ID!) { user(id: $id) { id name friends { name } } version }', schema), []);
  const errs = validateQuery('{\n  user { id nmae friends }\n  version { x }\n  users(limit: 3) { id }\n}', schema);
  assert.deepEqual(errs.map((e) => [e.message, e.line]), [
    ['Field "user" needs argument "id: ID!"', 2],
    ['Unknown field "nmae" on type "User"', 2],
    ['"friends" returns [User]; pick some of its fields in { }', 2],
    ['"version" is a String and can\'t have a selection', 3],
    ['Unknown argument "limit" on field "users"', 4],
  ]);
  assert.equal(errs[0].warn, true);
  assert.deepEqual(validateQuery('{ me: user(id: 1) { alias: name __typename ... on User { id } } }', schema), [], 'aliases, __typename and inline fragments');
  assert.deepEqual(validateQuery('fragment F on Nope { id }', schema).map((e) => e.message), ['Unknown type "Nope"']);
  assert.deepEqual(validateQuery('mutation { x }', schema).map((e) => e.message), ['This API has no mutation type']);
  assert.throws(() => buildSchema({ errors: [{ message: 'introspection disabled' }] }), /introspection disabled/);

  const q = '{ user(id: 1) { na } }';
  const c = completeAt(q, q.indexOf('na') + 2, schema);
  assert.equal(c.type, 'User');
  assert.deepEqual(c.items.map((i) => i.name), ['name']);
  assert.equal(c.from, q.indexOf('na'));
  const top = '{ us';
  assert.deepEqual(completeAt(top, top.length, schema).items.map((i) => i.name), ['user', 'users']);
  const nested = '{ users { friends {  } } }';
  assert.equal(completeAt(nested, nested.indexOf('{  }') + 2, schema).type, 'User');
  assert.equal(completeAt('{ user(id: ', 11, schema), null, 'no field names inside arguments');
  assert.deepEqual(completeAt('', 0, schema).items.map((i) => i.name), ['query', 'fragment']);
  assert.equal(insertionFor(schema.types.get('Query').fields.get('user'), schema), 'user(id: ) {\n  \n}');
  assert.equal(insertionFor(schema.types.get('User').fields.get('name'), schema), 'name');
});

// ---------- request chains ----------
import { analyzeChain } from '../src/js/chain.js';

test('request chain analysis', () => {
  const ev = (listen, code) => ({ listen, script: { exec: code.split('\n') } });
  const col = { event: [ev('prerequest', "pm.variables.set('ts', Date.now());")], item: [
    { id: 'a', name: 'Login', request: { method: 'POST', url: { raw: '{{baseUrl}}/login' }, body: { mode: 'raw', raw: '{"u":"{{user}}"}' } }, event: [ev('test', "const j = pm.response.json();\npm.environment.set('token', j.token);\npostman.setGlobalVariable(\"uid\", j.id);")] },
    { name: 'Orders', item: [
      { id: 'b', name: 'Create order', request: { method: 'POST', url: { raw: '{{baseUrl}}/orders' }, header: [{ key: 'Authorization', value: 'Bearer {{token}}' }, { key: 'X-Off', value: '{{nope}}', disabled: true }], auth: { type: 'apikey', apikey: [{ key: 'value', value: '{{vault:key}}' }] } }, event: [ev('test', "pm.collectionVariables.set(`orderId`, pm.response.json().id)")] },
      { id: 'c', name: 'Get order', request: { method: 'GET', url: { raw: '{{baseUrl}}/orders/{{orderId}}?u={{uid}}&t={{ts}}&r={{$randomInt}}' } }, event: [ev('prerequest', "if (!pm.environment.get('refund')) console.log(pm.variables.replaceIn('{{later}}'))")] },
    ] },
    { id: 'd', name: 'Refund', request: { method: 'POST', url: { raw: '{{baseUrl}}/refund/{{orderId}}' } }, event: [ev('test', "pm.environment.set('later', 1)")] },
  ] };
  const { steps, variables, problems } = analyzeChain(col, { defined: new Set(['baseUrl', 'user']) });
  assert.deepEqual(steps.map((s) => [s.name, s.path]), [['Login', ''], ['Create order', 'Orders'], ['Get order', 'Orders'], ['Refund', '']]);
  assert.deepEqual(steps[0].sets.map((s) => [s.name, s.scope, s.phase, s.inherited]), [['ts', 'local', 'prerequest', true], ['token', 'environment', 'test', false], ['uid', 'globals', 'test', false]]);
  const use = (i, n) => steps[i].uses.find((u) => u.name === n);
  assert.equal(use(1, 'token').from, 0, 'token comes from Login');
  assert.equal(use(1, 'nope'), undefined, 'disabled headers are ignored');
  assert.equal(use(1, 'vault:key').defined, true);
  assert.equal(use(2, 'orderId').from, 1);
  assert.equal(use(2, 'uid').from, 0);
  assert.equal(use(2, 'ts').from, 2, 'collection pre-request sets it for every request');
  assert.equal(use(2, '$randomInt'), undefined, 'dynamic variables are not tracked');
  assert.deepEqual(problems.map((p) => p.message), ['"refund" isn\'t set by any request or defined in the environment', '"later" is used before "Refund" sets it']);
  assert.deepEqual(variables.get('orderId'), { setBy: [1], usedBy: [2, 3] });
});

// ---------- AI assistant prompts ----------
import { describeExchange, extractCode, requestFromAi, createPrompt, REQUEST_SCHEMA, chooseModel, checkSchema, parseStructured, retryPrompt } from '../src/js/assist.js';

test('assistant prompts redact credentials and parse answers', () => {
  const item = { name: 'Me', request: { method: 'GET', url: parseUrl('{{baseUrl}}/me?token={{tok}}'), header: [{ key: 'Authorization', value: 'Bearer abc' }, { key: 'X-Trace', value: 't1' }, { key: 'X-Session-Id', value: 's' }, { key: 'Off', value: 'x', disabled: true }] }, event: [{ listen: 'test', script: { exec: ['pm.test("old")'] } }] };
  const text = describeExchange(item, { status: 200, statusText: 'OK', timeMs: 12, headers: [{ key: 'Set-Cookie', value: 'sid=1' }, { key: 'Content-Type', value: 'application/json' }], bodyText: 'x'.repeat(30_010) });
  assert.match(text, /GET \{\{baseUrl\}\}\/me\?token=\{\{tok\}\}/, 'variables stay unresolved');
  assert.match(text, /Authorization: \[redacted\]/);
  assert.match(text, /X-Session-Id: \[redacted\]/);
  assert.match(text, /X-Trace: t1/);
  assert.ok(!text.includes('Off:'));
  assert.match(text, /Set-Cookie: \[redacted\]/);
  assert.match(text, /10 more characters cut/);
  assert.match(text, /Existing post-response script:\npm\.test\("old"\)/);
  assert.equal(extractCode('Sure:\n```javascript\npm.test("a", () => {});\n```\nDone'), 'pm.test("a", () => {});');
  assert.equal(extractCode('pm.test(1)'), 'pm.test(1)');
  const r = requestFromAi({ name: 'Create', method: 'POST', url: '{{baseUrl}}/users?x=1', headers: [{ key: 'Content-Type', value: 'application/json' }], bodyMode: 'json', body: '{"a":1}', description: 'Makes a user' });
  assert.equal(r.request.url.raw, '{{baseUrl}}/users?x=1');
  assert.deepEqual(r.request.url.query, [{ key: 'x', value: '1' }]);
  assert.equal(r.request.body.options.raw.language, 'json');
  assert.equal(r.request.description, 'Makes a user');
  assert.deepEqual(requestFromAi({ method: 'POST', url: '/l', headers: [], bodyMode: 'urlencoded', body: 'u=a&p=b' }).request.body.urlencoded, [{ key: 'u', value: 'a' }, { key: 'p', value: 'b' }]);
  assert.match(createPrompt(' list users ', ['baseUrl']), /^list users\n\nVariables already defined: baseUrl$/);
});

// ---------- Postman sandbox libraries ----------
test('scripts can require Postman\'s bundled libraries', async () => {
  const { needsExtraLibs } = await import('../src/js/scripts.js');
  assert.equal(needsExtraLibs("const $ = require('cheerio');"), true);
  assert.equal(needsExtraLibs('require("node:buffer")'), true);
  assert.equal(needsExtraLibs('const x = xml2Json(responseBody);'), true);
  assert.equal(needsExtraLibs("require('lodash'); pm.test('a', () => {})"), false);
  let loads = 0;
  const withLoader = { ...libs, loadExtra: async () => { loads++; require('../src/vendor/postman-libs.min.js'); } };
  const s = scopes();
  const code = [
    "const cheerio = require('cheerio');",
    "const $ = cheerio.load('<form><input name=\"csrf\" value=\"tok-1\"></form>');",
    "pm.environment.set('csrf', $('input[name=csrf]').val());",
    "pm.environment.set('day', require('moment')('2024-02-28').add(1, 'day').format('YYYY-MM-DD'));",
    "require('xml2js').parseString('<a>1</a>', (e, r) => pm.environment.set('xml', r.a));",
    "pm.environment.set('b64', require('buffer').Buffer.from('hi').toString('base64'));",
    "pm.environment.set('legacy', xml2Json('<r><x>2</x></r>').r.x + ':' + tv4.validate(1, { type: 'number' }));",
  ].join('\n');
  const r = await runScript(code, { phase: 'prerequest', request: { header: [], url: parseUrl('http://x') }, resolver: new Resolver(s), scopes: s, libs: withLoader, send: async () => ({}) });
  assert.equal(r.error, null);
  assert.equal(loads, 1);
  assert.deepEqual(['csrf', 'day', 'xml', 'b64', 'legacy'].map((k) => s.environment.get(k)), ['tok-1', '2024-02-29', '1', 'aGk=', '2:true']);
  const missing = await runScript("require('left-pad')", { phase: 'prerequest', request: { header: [], url: parseUrl('http://x') }, resolver: new Resolver(s), scopes: s, libs: withLoader, send: async () => ({}) });
  assert.match(missing.error, /doesn't bundle "left-pad"\. Available: .*cheerio/);
});

test("scripts can use Sugar.js Number methods from Postman's old sandbox", async () => {
  const s = scopes();
  const r = await runScript("const min = 1, max = 9; const n = (Math.random() * (max - min) + min).round(); pm.variables.set('ok', String(Number.isInteger(n) && n >= min && n <= max)); pm.variables.set('p', String((3.14159).round(2))); pm.variables.set('pad', (7).pad(3));", { phase: 'prerequest', request: { header: [], url: parseUrl('http://x') }, resolver: new Resolver(s), scopes: s, libs });
  assert.equal(r.error, null);
  assert.equal(s.local.get('ok'), 'true');
  assert.equal(s.local.get('p'), '3.14');
  assert.equal(s.local.get('pad'), '007');
  assert.ok(!Object.keys(Number.prototype).includes('round'), 'shims are not enumerable');
});

test('errors thrown in sendRequest callbacks and timers are script errors, not stray rejections', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const s = scopes();
    const run = (code, send = async () => ({ status: 200, headers: [], bodyText: '{}' })) => runScript(code, { phase: 'prerequest', request: { header: [], url: parseUrl('http://x') }, resolver: new Resolver(s), scopes: s, libs, send });
    const a = await run("const min = 1, max = 9; pm.sendRequest('http://x/y', (err, res) => { const n = (Math.random() * (max - min) + min).roundTo(); });");
    assert.match(a.error, /^Error in the pm\.sendRequest callback: .*roundTo/);
    assert.ok(a.logs.some((l) => l.level === 'error'));
    const b = await run("setTimeout(() => { undefinedThing(); }, 1);");
    assert.match(b.error, /^Error in a setTimeout callback: .*undefinedThing/);
    const c = await run("pm.sendRequest('http://x', (err) => { pm.variables.set('e', String(!!err)); });", async () => { throw new Error('down'); });
    assert.equal(c.error, null, 'a failed send handled by the callback is fine');
    assert.equal(s.local.get('e'), 'true');
    const d = await run("try { await pm.sendRequest('http://x'); } catch (e) { pm.variables.set('awaited', e.message); }", async () => { throw new Error('down'); });
    assert.equal(d.error, null);
    assert.equal(s.local.get('awaited'), 'down', 'awaiting still rejects');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('the Worker ships the same admin panel as the server', () => {
  const dir = (d) => new URL(`../${d}/`, import.meta.url);
  const names = readdirSync(dir('server/admin')).sort();
  assert.deepEqual(readdirSync(dir('worker/admin')).sort(), names);
  for (const n of names) {
    assert.equal(readFileSync(new URL(n, dir('worker/admin')), 'utf8'), readFileSync(new URL(n, dir('server/admin')), 'utf8'), n);
  }
});

import { jsonIssues, bracketPairs, minifyJsonc, contextAt, collectKeys } from '../src/js/jsonc.js';

test('jsonIssues agrees with JSON.parse on plain JSON, including broken text', () => {
  const valid = ['{}', '[]', '1', '-0.5e3', '"x"', 'null', '{"a":[1,{"b":"\\u00e9\\n"}],"c":true}', ' [ 1 , 2 ] '];
  const broken = ['{', '[', '}', '{"a"}', '{"a":}', '{"a":1,}', '[1,]', '[1 2]', '{a:1}', "{'a':1}", '01', '1.', 'tru', '"x', '"\\q"', '"a\tb"', '{"a":1}}', '1 2', '{"a" 1}', '+1'];
  for (const s of valid) assert.deepEqual(jsonIssues(s), [], s);
  for (const s of broken) {
    assert.throws(() => JSON.parse(s), undefined, `fixture ${s} should be invalid`);
    assert.equal(jsonIssues(s).filter((i) => i.severity === 'error').length, 1, s);
  }
  // Every truncation and deleted character of a real document must get the same verdict as JSON.parse.
  const doc = '{"id": 12, "tags": ["a", "b\\n"], "ok": true, "n": {"x": null, "y": -1.5e2}}';
  const variants = [];
  for (let i = 1; i < doc.length; i++) variants.push(doc.slice(0, i), doc.slice(0, i) + doc.slice(i + 1)); // an empty body is fine here, unlike JSON.parse
  for (const s of variants) {
    let ok = true;
    try { JSON.parse(s); } catch { ok = false; }
    assert.equal(!jsonIssues(s).some((x) => x.severity === 'error'), ok, s);
  }
});

test('jsonIssues allows comments and variables and points at the problem', () => {
  assert.deepEqual(jsonIssues(''), []);
  assert.deepEqual(jsonIssues('// note\n{\n  "a": {{amount}}, /* x */\n  "b": "{{name}}",\n  "c": [{{one}}, 2]\n}'), []);
  const src = '{\n  "a": 1\n  "b": 2\n}';
  const [miss] = jsonIssues(src);
  assert.equal(src.slice(miss.from, miss.to), '"b"');
  assert.match(miss.message, /comma/);
  const trailing = '{"a": 1, }';
  assert.equal(jsonIssues(trailing)[0].from, trailing.indexOf(','));
  assert.match(jsonIssues(trailing)[0].message, /trailing comma/);
  const dup = jsonIssues('{"a": 1, "a": 2}');
  assert.deepEqual(dup.map((d) => d.severity), ['warning']);
  assert.equal(jsonIssues('['.repeat(200000)).length <= 1, true, 'absurd nesting must not throw');
});

test('bracketPairs ignores brackets in strings and comments', () => {
  const src = '{"a": "}", /* ] */ "b": [1]}';
  assert.deepEqual(bracketPairs(src), [[src.indexOf('[1'), src.indexOf(']}')], [0, src.length - 1]]);
  assert.deepEqual(bracketPairs('{]'), []);
});

test('minifyJsonc drops comments and keeps variables, and refuses invalid JSON', () => {
  assert.equal(minifyJsonc('{\n  // c\n  "a": {{x}},\n  "b": "{{y}} z"\n}'), '{"a":{{x}},"b":"{{y}} z"}');
  assert.throws(() => minifyJsonc('{"a":'));
});

test('contextAt finds the key or value position and its path', () => {
  const at = (marked) => { const pos = marked.indexOf('|'); return contextAt(marked.replace('|', ''), pos); };
  let c = at('{ "user": { "na|" } }');
  assert.equal(c.kind, 'key'); assert.deepEqual(c.path, ['user']); assert.equal(c.prefix, 'na'); assert.equal(c.quoted, true); assert.equal(c.closed, true);
  c = at('{\n  |\n}');
  assert.equal(c.kind, 'key'); assert.deepEqual(c.path, []); assert.equal(c.prefix, '');
  c = at('{ "a": 1, "b": 2, |, "c": 3 }');
  assert.equal(c.kind, 'key'); assert.deepEqual([...c.used].sort(), ['a', 'b', 'c']);
  c = at('{ "items": [ { "i|" } ] }');
  assert.equal(c.kind, 'key'); assert.deepEqual(c.path, ['items', '[]']);
  c = at('{ "ok": t| }');
  assert.equal(c.kind, 'value'); assert.equal(c.prefix, 't'); assert.deepEqual(c.path, ['ok']);
  assert.equal(at('{ "a": 1 |}').kind, null, 'after a value only a comma or close fits');
  assert.equal(at('{ "a" |: 1 }').kind, null);
  assert.equal(at('{ // no|te\n }').kind, null, 'nothing inside comments');
  c = at('{ "a": "{{x|}}" }');
  assert.equal(c.kind, 'value', 'a variable in a string is handled by the variable source, not here');
});

test('collectionJsonBodies gathers JSON request bodies, including saved examples', async () => {
  const { collectionJsonBodies } = await import('../src/js/model.js');
  const raw = (s, language = 'json') => ({ body: { mode: 'raw', raw: s, options: { raw: { language } } } });
  const col = { item: [
    { request: raw('{"a":1}'), response: [{ originalRequest: raw('{"ex":1}') }] },
    { item: [{ request: raw('<x/>', 'xml') }, { request: { body: { mode: 'graphql', graphql: { query: 'q', variables: '{"v":1}' } } } }] },
    { request: { body: { mode: 'raw', raw: '{"noLang":1}' } } },
  ] };
  assert.deepEqual(collectionJsonBodies(col), ['{"a":1}', '{"ex":1}', '{"v":1}', '{"noLang":1}']);
  assert.deepEqual(collectionJsonBodies(undefined), []);
});

test('collectKeys indexes names and types per path, never values', () => {
  const idx = collectKeys(['{"user": {"name": "s3cret", "age": 3}, "items": [{"id": 1}], "t": {{tok}}}', 'not json', '', '// c\n{"user": {"email": null}}']);
  assert.deepEqual([...idx.get('').keys()].sort(), ['items', 't', 'user']);
  assert.deepEqual(Object.fromEntries(idx.get('user')), { name: 'string', age: 'number', email: 'null' });
  assert.deepEqual([...idx.get('items/[]').keys()], ['id']);
  assert.ok(!JSON.stringify([...idx.values()].map((m) => [...m])).includes('s3cret'));
});

test('chooseModel keeps a valid choice and falls back to the first available model', () => {
  const providers = [
    { id: 'anthropic', models: [] },
    { id: 'ollama', models: [{ id: 'llama3.2:latest' }, { id: 'qwen3:14b' }] },
    { id: 'openai', models: [{ id: 'gpt-5' }] },
  ];
  assert.deepEqual(chooseModel({ provider: 'openai', model: 'gpt-5' }, providers), { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(chooseModel({ provider: 'openai', model: 'gone' }, providers), { provider: 'ollama', model: 'llama3.2:latest' }, 'a removed model falls back');
  assert.deepEqual(chooseModel({ provider: 'compatible', model: 'x' }, providers), { provider: 'ollama', model: 'llama3.2:latest' }, 'a disconnected provider falls back');
  assert.deepEqual(chooseModel(undefined, providers), { provider: 'ollama', model: 'llama3.2:latest' });
  assert.equal(chooseModel(undefined, [{ id: 'anthropic', models: [] }]), null);
  assert.equal(chooseModel(undefined, []), null);
});

test('checkSchema finds what a structured answer gets wrong', () => {
  const good = { name: 'List', method: 'GET', url: '/u', headers: [{ key: 'A', value: '1' }], bodyMode: 'none', body: '', description: '' };
  assert.deepEqual(checkSchema(good, REQUEST_SCHEMA), []);
  const bad = { ...good, method: 'FETCH', headers: [{ key: 'A' }], extra: 1 };
  delete bad.url;
  const errs = checkSchema(bad, REQUEST_SCHEMA);
  assert.ok(errs.includes('$.url is missing'), errs.join('\n'));
  assert.ok(errs.some((e) => e.startsWith('$.method should be one of')), errs.join('\n'));
  assert.ok(errs.includes('$.headers[0].value is missing'), errs.join('\n'));
  assert.ok(errs.includes("$.extra isn't allowed"), errs.join('\n'));
  assert.deepEqual(checkSchema('x', { type: 'object' }), ['$ should be object, not string']);
  assert.deepEqual(checkSchema(3, { type: 'number' }), [], 'integers are numbers');
});

test('parseStructured accepts fenced JSON and explains failures', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  assert.deepEqual(parseStructured('```json\n{"a":"x"}\n```', schema), { a: 'x' });
  assert.throws(() => parseStructured('Sure! Here it is', schema), /wasn't valid JSON/);
  assert.throws(() => parseStructured('{"b":1}', schema), /\$\.a is missing/);
  assert.match(retryPrompt('Make a request', 'The answer wasn\'t valid JSON.'), /^Make a request\n\nYour previous answer couldn't be used: The answer wasn't valid JSON\. Reply again/);
});

// ---------- documentation generator ----------
import { createScrubber, findSecrets } from '../src/js/docgen/scrub.js';
import { gatherEndpoints, splitUrl, testsFrom } from '../src/js/docgen/gather.js';
import { mergeShape, buildFacts, structure, diffStructure, displayPath } from '../src/js/docgen/facts.js';
import { lint, plan, writeAll, repeatedOpenings } from '../src/js/docgen/write.js';
import { buildSite, markdown, schemaFrom, previewHtml, highlightJson } from '../src/js/docgen/build.js';
import { PRESETS, DEFAULT_THEME, LAYOUTS, contrast, fixContrast, validateTheme, normalizeTheme, contrastFailures, contrastReport, withAccent, themeCss, toOklch, fromOklch } from '../src/js/docgen/theme.js';
import { generateDocs, OMIT } from '../src/js/docgen/index.js';
import { zip, crc32 } from '../src/js/docgen/zip.js';

const DOCS_COLLECTION = {
  info: { name: 'Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  item: [
    { name: 'Auth', item: [
      { id: 'login', name: 'Log in', request: { method: 'POST', auth: { type: 'noauth' }, url: { raw: '{{baseUrl}}/v1/login' }, header: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{"email":"ada@acme.io","password":"hunter2hunter2"}', options: { raw: { language: 'json' } } } },
        event: [{ listen: 'test', script: { exec: ["pm.test('logged in', () => pm.response.to.have.status(200));", "pm.environment.set('token', pm.response.json().token);"] } }],
        response: [{ name: 'OK', code: 200, status: 'OK', header: [{ key: 'Set-Cookie', value: 'sid=abcdef1234567890abcdef' }], body: '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJlc2lnbmF0dXJl","expires_in":3600}' }] },
    ] },
    { name: 'Orders', description: 'Orders placed by customers.', item: [
      { id: 'create', name: 'Create order', request: { method: 'POST', url: { raw: '{{baseUrl}}/v1/orders' }, header: [{ key: 'Idempotency-Key', value: '{{$guid}}' }], body: { mode: 'raw', raw: '{"amount": 2500, "currency": "NGN", "customer_email": "ada@acme.io"}', options: { raw: { language: 'json' } } } },
        event: [{ listen: 'test', script: { exec: ["pm.test('created', () => pm.response.to.have.status(201));", "pm.collectionVariables.set('orderId', pm.response.json().id);"] } }],
        response: [
          { name: 'Created', code: 201, status: 'Created', header: [], body: '{"id":"5f0c2b3e-1d2a-4c3b-9a8b-7c6d5e4f3a2b","status":"pending","amount":2500,"currency":"NGN","customer":{"email":"ada@acme.io","phone":"+234 803 123 4567"},"card":"5555 5555 5555 4444"}' },
          { name: 'Bad amount', code: 422, status: 'Unprocessable', header: [], body: '{"error":{"code":"invalid_amount","message":"amount must be positive"}}' },
        ] },
      { id: 'get', name: 'Get order', request: { method: 'GET', url: { raw: '{{baseUrl}}/v1/orders/:id', variable: [{ key: 'id', value: '{{orderId}}' }] } },
        response: [{ name: 'Found', code: 200, status: 'OK', header: [], body: '{"id":"5f0c2b3e-1d2a-4c3b-9a8b-7c6d5e4f3a2b","status":"paid","amount":2500,"currency":"NGN","paid_at":"2026-11-01T10:00:00Z","customer":{"email":"ada@acme.io","phone":null}}' }] },
    ] },
  ],
};
const DOCS_HISTORY = [{ ref: { col: 'col-1', item: 'get' }, status: 200, bodyText: '{"id":"aa0c2b3e-1d2a-4c3b-9a8b-7c6d5e4f3a2b","status":"refunded","amount":10,"currency":"NGN","paid_at":"2026-11-02T10:00:00Z","customer":{"email":"bo@acme.io","phone":null}}' }];

test('the scrubber swaps secrets and personal data for consistent fakes', () => {
  const s = createScrubber({ known: ['my-vault-secret-value'] });
  const out = s.body('{"email":"ada@acme.io","password":"hunter2hunter2","note":"key my-vault-secret-value","card":"4242 4242 4242 4242","ip":"81.2.69.160","api":"sk_live_abcdefghijklmnop1234"}', 'test');
  const v = JSON.parse(out);
  assert.equal(v.email, 'user1@example.com');
  assert.notEqual(v.password, 'hunter2hunter2');
  assert.equal(v.password.length, 'hunter2hunter2'.length);
  assert.ok(!out.includes('my-vault-secret-value'));
  assert.equal(v.ip, '203.0.113.' + v.ip.split('.')[3]);
  assert.match(v.api, /^sk_live_[A-Za-z0-9]{20}$/);
  assert.notEqual(v.api, 'sk_live_abcdefghijklmnop1234');
  assert.equal(s.text('mail ada@acme.io again'), 'mail user1@example.com again', 'the same value gets the same fake');
  assert.equal(s.text('{{vault:stripe}} and {{token}}'), '{{stripe}} and {{token}}', 'placeholders stay, vault prefix goes');
  const hs = s.headers([{ key: 'Authorization', value: 'Bearer abc123def456ghi789' }, { key: 'Authorization', value: 'Bearer {{token}}' }]);
  assert.match(hs[0].value, /^Bearer [a-z0-9]{18}$/);
  assert.notEqual(hs[0].value, 'Bearer abc123def456ghi789');
  assert.equal(hs[1].value, 'Bearer {{token}}');
  assert.ok(s.log.length >= 4 && s.log.every((l) => !l.masked.includes('hunter2hunter2')));
});

test('the final scan blocks real-looking secrets but not this run\'s fakes', () => {
  const s = createScrubber({ known: ['super-secret-1'] });
  const fakeJwt = s.text('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJlc2lnbmF0dXJl');
  const hits = findSecrets([{ path: 'a.html', body: `ok ${fakeJwt}\nleak super-secret-1\nAKIAABCDEFGHIJKLMNOP\nPMAK-0123456789abcdef01234567` }], s);
  assert.deepEqual(hits.map((h) => h.kind).sort(), ['AWS key', 'Postman key', 'saved secret']);
  assert.equal(hits.find((h) => h.kind === 'saved secret').line, 2);
});

test('mergeShape reads types, nullability, formats and repeated values across samples', () => {
  const f = Object.fromEntries(mergeShape([{ id: '5f0c2b3e-1d2a-4c3b-9a8b-7c6d5e4f3a2b', status: 'paid', n: 1, at: null, items: [{ q: 1 }] }, { id: 'aa0c2b3e-1d2a-4c3b-9a8b-7c6d5e4f3a2b', status: 'pending', n: 1.5, at: '2026-01-01T00:00:00Z', items: [] }]).map((x) => [x.path, x]));
  assert.deepEqual(f.id.formats, ['uuid']);
  assert.deepEqual(f.status.values.sort(), ['paid', 'pending']);
  assert.deepEqual(f.n.types, ['number']);
  assert.equal(f.at.nullable, true);
  assert.deepEqual(f.at.formats, ['date-time']);
  assert.equal(f['items[].q'].present, 1);
  assert.equal(displayPath('/v1/orders/:id/{{x}}'), '/v1/orders/{id}/{x}');
  assert.deepEqual(splitUrl('{{baseUrl}}/v1/orders?x=1'), { hostVar: 'baseUrl', host: '', path: '/v1/orders' });
  assert.deepEqual(testsFrom("pm.test('a', () => pm.response.to.have.status(201));"), { tests: ['a'], statuses: [201] });
});

test('facts come from examples, history, tests and chains, already scrubbed', () => {
  const scrub = createScrubber();
  const eps = gatherEndpoints(DOCS_COLLECTION, { scrub, history: DOCS_HISTORY, useHistory: true, collectionUid: 'col-1' });
  assert.equal(eps.length, 3);
  const all = JSON.stringify(eps);
  assert.ok(!all.includes("5555 5555 5555 4444"), "card"); assert.ok(!all.includes("+234 803 123 4567"), "phone");
  assert.ok(!all.includes('ada@acme.io'));
  assert.ok(!all.includes('hunter2hunter2'));
  const sheet = buildFacts(eps, { quickstart: [{ id: 'login', sets: ['token'], usedBy: ['create'] }] });
  assert.deepEqual(sheet.groups.map((g) => g.name), ['Auth', 'Orders']);
  const get = sheet.endpoints.find((e) => e.id === 'get');
  assert.equal(get.displayPath, '/v1/orders/{id}');
  const status = get.responses[0].fields.find((f) => f.path === 'status');
  assert.deepEqual(status.values.sort(), ['paid', 'refunded'], 'history adds what examples alone don\'t show');
  assert.equal(get.responses[0].fields.find((f) => f.path === 'customer.phone').nullable, true);
  assert.ok(sheet.errors.some((e) => e.code === 422));
  assert.ok(sheet.facts.get('err.422').text.includes('error.code'));
  assert.equal(sheet.quickstart.length, 1);
  assert.ok(sheet.facts.get('qs.0').text.includes('`token`'));
  const create = sheet.endpoints.find((e) => e.id === 'create');
  assert.ok(create.requestFields.some((f) => f.path === 'amount' && f.types[0] === 'integer'));
  assert.deepEqual(create.tests.map((t) => t.name), ['created']);
});

test('lint rejects ungrounded, banned and hedged writing', () => {
  const facts = new Map([['f1', { text: 'response 200 field `amount` (integer); values seen: 2500' }], ['f2', { text: 'returns 404' }]]);
  const ok = { text: 'Order total in the smallest currency unit, such as `amount` 2500.', factIds: ['f1'] };
  assert.deepEqual(lint(ok, { kind: 'field', facts, allowed: new Set(['f1', 'f2']) }), []);
  const bad = (text, ids = ['f1'], kind = 'field') => lint({ text, factIds: ids }, { kind, facts, allowed: new Set(['f1']) });
  assert.match(bad('This endpoint allows you to seamlessly fetch orders.').join(), /banned wording/);
  assert.match(bad('The total, which may include tax.').join(), /hedges/);
  assert.match(bad('Total of up to 9999 items.').join(), /mentions 9999/);
  assert.match(bad('Mirrors `total_due`.').join(), /total_due/);
  assert.match(bad('Mirrors customerId on the order.').join(), /customerId/);
  assert.match(bad('Total.', ['f2']).join(), /another page/);
  assert.match(bad('Total.', ['nope']).join(), /don't exist/);
  assert.match(bad('Total.', []).join(), /cites no facts/);
  assert.match(bad('One. Two.').join(), /one sentence/);
  assert.deepEqual(bad(''), ['left empty']);
  assert.deepEqual([...repeatedOpenings([{ target: 'a', text: 'Returns the order.' }, { target: 'b', text: 'Returns all.' }, { target: 'c', text: 'Returns the list.' }])], ['c']);
});

test('writing keeps what passes, retries once, then leaves gaps', async () => {
  const scrub = createScrubber();
  const sheet = buildFacts(gatherEndpoints(DOCS_COLLECTION, { scrub }), {});
  const calls = [];
  const ask = async (system, prompt) => {
    calls.push(prompt);
    const targets = [...prompt.matchAll(/^(\S+): /gm)].map((m) => m[1]).filter((t) => !t.includes('.route') && prompt.split('TARGETS')[1].includes(`${t}:`));
    return { items: targets.map((t) => {
      if (t.endsWith('.summary')) return { target: t, text: calls.length > 2 ? 'Fetches one order by its id.' : 'This endpoint easily fetches it.', factIds: [`ep.${t.split('.')[1]}.route`] };
      if (t.startsWith('ep.') && t.includes('.resp.') && t.endsWith('.amount')) return { target: t, text: 'Order total in minor units, such as 2500.', factIds: [t.replace(/^ep\.([^.]+)\.resp\.(\d+)\.amount$/, 'ep.$1.resp.$2.amount')] };
      return { target: t, text: '', factIds: [] };
    }) };
  };
  const { texts, gaps } = await writeAll(sheet, { ask, pinned: { 'ep.get-get-order.summary': 'Reads one order.' } });
  const getAmount = Object.keys(texts).find((k) => /^ep\.get-get-order\.resp\.200\.amount$/.test(k));
  assert.ok(getAmount, Object.keys(texts).join(', '));
  assert.ok(!('ep.get-get-order.summary' in texts) || texts['ep.get-get-order.summary'].ai === false, 'pinned text is never sent for writing');
  assert.ok(calls.every((c) => !c.includes('ep.get-get-order.summary:')));
  assert.ok(gaps.length > 0);
  assert.ok(gaps.every((g) => g.label && g.reason));
  assert.ok(calls.some((c) => c.includes('was rejected because')), 'failures are retried with the reasons');
});

test('the built site has every page, valid links, no inline script or style, and OpenAPI', async () => {
  const result = await generateDocs({
    collection: DOCS_COLLECTION, history: DOCS_HISTORY, useHistory: true, collectionUid: 'col-1', known: ['hunter2hunter2'],
    pinned: { overview: 'Orders and payments for the shop.', 'ep.get-get-order.resp.200.paid_at': OMIT },
    site: { name: 'Shop API', accent: '#123456' }, baseUrl: 'https://api.shop.test', version: 3,
    previous: { structure: { endpoints: [{ route: 'GET /v1/orders/{id}', name: 'Get order', statuses: [200], fields: { 200: { id: 'string', amount: 'string' } }, body: {} }] }, history: [{ version: 2, published_at: '2026-10-01T00:00:00Z', changelog: 'Older change' }] },
  });
  const paths = result.files.map((f) => f.path).sort();
  for (const p of ['index.html', 'r/auth.html', 'r/orders.html', 'changelog.html', 'openapi.json', 'llms.txt', 'md/orders.md', 'search.json', 'assets/site.css', 'assets/site.js', '_dispatch/structure.json']) assert.ok(paths.includes(p), p);
  const html = result.files.filter((f) => f.path.endsWith('.html'));
  for (const f of html) {
    assert.ok(!/<script>(?!<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/.test(f.body), `${f.path} has inline script`);
    assert.ok(!/\sstyle="/.test(f.body), `${f.path} has an inline style`);
    assert.ok(!/\son[a-z]+="/.test(f.body), `${f.path} has an inline handler`);
    for (const m of f.body.matchAll(/href="([^"#]+)/g)) {
      if (/^https?:/.test(m[1])) continue;
      const target = new URL(m[1], `http://x/${f.path}`).pathname.slice(1);
      assert.ok(paths.includes(target), `${f.path} links to missing ${target}`);
    }
  }
  const orders = result.files.find((f) => f.path === 'r/orders.html').body;
  assert.match(orders, /https:\/\/api\.shop\.test\/v1\/orders/, 'samples use the public base URL');
  assert.ok(!orders.includes('paid_at</code></td>'), 'an omitted field is left out');
  assert.ok(!orders.includes('class="ai"') && !orders.includes('class="gap"'), 'review marks stay out of published pages');
  assert.ok(result.previewFiles.find((f) => f.path === 'r/orders.html').body.includes('class="gap"'));
  const all = result.files.map((f) => f.body).join('\n');
  assert.ok(!all.includes('ada@acme.io') && !all.includes('hunter2hunter2'));
  assert.deepEqual(result.secretHits, []);
  assert.ok(result.changelog.some((l) => l.includes('Added `POST /v1/orders`')), result.changelog.join('\n'));
  assert.ok(result.changelog.some((l) => l.includes('`amount` changed from string to integer')), result.changelog.join('\n'));
  assert.match(result.files.find((f) => f.path === 'changelog.html').body, /Older change/);
  const api = JSON.parse(result.files.find((f) => f.path === 'openapi.json').body);
  assert.equal(api.openapi, '3.1.0');
  assert.deepEqual(api.servers, [{ url: 'https://api.shop.test' }]);
  assert.ok(api.paths['/v1/orders/{id}'].get.parameters.some((p) => p.name === 'id' && p.in === 'path' && p.required));
  assert.equal(api.paths['/v1/orders'].post.responses['201'].content['application/json'].schema.properties.status.type, 'string');
  assert.equal(api.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.match(result.files.find((f) => f.path === 'assets/site.css').body, /--accent: #123456/);
  assert.match(result.files.find((f) => f.path === 'llms.txt').body, /^# Shop API\n\n> Orders and payments for the shop\./);
  assert.ok(previewHtml(result.previewFiles, 'index.html').includes('<style>'));
});

test('markdown escapes HTML and only links http(s)', () => {
  assert.equal(markdown('<script>x</script> **b** [ok](https://a.io) [no](javascript:alert(1))'), '<p>&lt;script&gt;x&lt;/script&gt; <strong>b</strong> <a href="https://a.io" rel="noopener">ok</a> [no](javascript:alert(1))</p>');
  assert.deepEqual(schemaFrom([{ path: 'a.b', types: ['integer'], formats: [], values: [], nullable: true }, { path: 'list[].id', types: ['string'], formats: ['uuid'], values: [] }]), { type: 'object', properties: { a: { type: 'object', properties: { b: { type: ['integer', 'null'] } } }, list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } } } });
});

test('zip export writes a readable archive', () => {
  const bytes = zip([{ path: 'index.html', body: 'hi' }, { path: 'r/a.html', body: 'é' }], 'site');
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(crc32(new TextEncoder().encode('hi')), 0xd8932aac);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('site/index.html') && text.includes('site/r/a.html'));
});

// ---------------------------------------------------------------- documentation themes

test('contrast is measured the WCAG way, and fixes keep hue while reaching the minimum', () => {
  assert.equal(contrast('#ffffff', '#000000').toFixed(1), '21.0');
  assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54');
  assert.equal(fromOklch(toOklch('#2f6f5e')), '#2f6f5e');
  for (const [fg, bg] of [['#cccccc', '#ffffff'], ['#88ff88', '#fbfbf9'], ['#333333', '#111111'], ['#ff0000', '#ff3300'], ['#7fd6a4', '#ffffff']]) {
    const fixed = fixContrast(fg, bg, 4.5);
    assert.ok(contrast(fixed, bg) >= 4.5, `${fg} on ${bg} became ${fixed}`);
  }
  const hue = toOklch('#88ff88').h;
  assert.ok(Math.abs(toOklch(fixContrast('#88ff88', '#ffffff', 4.5)).h - hue) < 8, 'hue is kept');
});

test('every preset is a valid theme and passes every contrast check in every mode', () => {
  assert.equal(PRESETS[0].theme, DEFAULT_THEME);
  for (const p of PRESETS) {
    const v = validateTheme(p.theme);
    assert.deepEqual(v.errors, [], p.id);
    assert.deepEqual(contrastFailures(p.theme), [], p.id);
    assert.ok(contrastReport(p.theme).length > 20, p.id);
  }
  assert.deepEqual([...new Set(PRESETS.map((p) => p.theme.layout))].sort(), Object.keys(LAYOUTS).sort(), 'presets cover every layout');
});

test('theme validation refuses unknown values and fonts, and fills what is missing', () => {
  const { errors, theme } = validateTheme({ layout: 'grid', mode: 'auto', type: { display: 'comic-sans', body: 'rounded', baseSize: 40 }, colors: { light: { bg: 'red' } }, extraCss: 'body{}' });
  assert.ok(errors.some((e) => /layout must be one of/.test(e)));
  assert.ok(errors.some((e) => /comic-sans.*catalogue/.test(e)));
  assert.ok(errors.some((e) => /"rounded" can't be used as a body font/.test(e)));
  assert.ok(errors.some((e) => /baseSize/.test(e)));
  assert.ok(errors.some((e) => /colors.light.bg must be/.test(e)));
  assert.ok(errors.some((e) => /colors.dark is missing/.test(e)));
  assert.ok(errors.some((e) => /extraCss/.test(e)));
  assert.equal(theme.layout, 'reference');
  assert.equal(theme.type.display, DEFAULT_THEME.type.display);
  assert.equal(theme.extraCss, '');
  // A dark-only theme doesn't need a light palette.
  const dark = { ...DEFAULT_THEME, mode: 'dark', colors: { dark: DEFAULT_THEME.colors.dark } };
  assert.ok(!validateTheme(dark).errors.some((e) => /colors.light/.test(e)));
});

test('a bad palette is fixed before it is built, and a new accent stays readable', () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_THEME));
  bad.colors.light.muted = '#dddddd';
  bad.colors.dark.text = '#333333';
  bad.syntax.dark.string = '#202020';
  assert.ok(contrastFailures(bad).length >= 3);
  assert.deepEqual(contrastFailures(normalizeTheme(bad).theme), []);
  const yellow = withAccent(DEFAULT_THEME, '#ffe600');
  assert.deepEqual(contrastFailures(yellow), []);
  assert.ok(contrast(yellow.colors.light.accent, yellow.colors.light.bg) >= 4.5);
});

test('theme CSS follows the reader in auto mode, can be forced, and never forces one mode on auto themes', () => {
  const auto = themeCss(DEFAULT_THEME);
  assert.match(auto, /prefers-color-scheme: dark/);
  assert.match(auto, /:root\[data-mode="dark"\]/);
  const night = PRESETS.find((p) => p.theme.mode === 'dark').theme;
  const css = themeCss(night);
  assert.ok(!/prefers-color-scheme/.test(css));
  assert.match(css, /color-scheme: dark/);
  assert.ok(!/url\(|@import|expression\(/i.test(auto + css));
});

test('JSON in code blocks is coloured and still escaped', () => {
  const html = highlightJson(JSON.stringify({ note: '<script>alert(1)</script>', n: 2, ok: true, x: null }, null, 2));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<span class="sx-k">&quot;note&quot;<\/span>/);
  assert.match(html, /<span class="sx-s">&quot;&lt;script&gt;/);
  assert.match(html, /<span class="sx-n">2<\/span>/);
  assert.match(html, /<span class="sx-l">true<\/span>/);
  assert.equal(highlightJson('not <json>'), 'not &lt;json&gt;');
});

test('every preset builds a site with its layout, its theme file, and no inline style or script', async () => {
  for (const p of PRESETS) {
    const result = await generateDocs({ collection: DOCS_COLLECTION, history: DOCS_HISTORY, useHistory: true, collectionUid: 'col-1', known: [], site: { name: 'Shop API' }, theme: p.theme, baseUrl: 'https://api.shop.test', version: 1 });
    const file = (path) => result.files.find((f) => f.path === path);
    assert.deepEqual(JSON.parse(file('_dispatch/theme.json').body), normalizeTheme(p.theme).theme, p.id);
    const home = file('index.html').body;
    assert.match(home, new RegExp(`<body[^>]*class="[^"]*layout-${p.theme.layout}[^"]*page-home`), p.id);
    assert.match(file('r/orders.html').body, /class="[^"]*page-group/);
    if (p.theme.header === 'split') assert.match(home, /<aside class="hero-code"/, p.id);
    else assert.ok(!home.includes('hero-code'), p.id);
    for (const f of result.files.filter((x) => x.path.endsWith('.html'))) {
      assert.ok(!/\sstyle="/.test(f.body) && !/<style/.test(f.body), `${p.id} ${f.path} has inline style`);
      assert.ok(!/<script(?![^>]*\bsrc=)/.test(f.body), `${p.id} ${f.path} has inline script`);
    }
    assert.match(file('assets/site.css').body, new RegExp(`--accent: ${normalizeTheme(p.theme).theme.colors[p.theme.mode === 'dark' ? 'dark' : 'light'].accent}`));
    const retheme = result.retheme(DEFAULT_THEME);
    assert.match(retheme.files.find((f) => f.path === 'index.html').body, /layout-reference/);
  }
});

test('only a PNG data URL is published as the logo, and the preview can force a mode', async () => {
  const build = (logoDataUrl) => buildSite(buildFacts(gatherEndpoints(DOCS_COLLECTION, { scrub: createScrubber() }), {}), {}, { site: { name: 'S', logoDataUrl } });
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.ok(build(png).find((f) => f.path === 'index.html').body.includes(`<img src="${png}"`));
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://evil.test/x.png', 'javascript:alert(1)']) {
    assert.ok(!build(bad).find((f) => f.path === 'index.html').body.includes('<img'), bad);
  }
  const files = build('');
  assert.match(previewHtml(files, 'index.html', { mode: 'dark' }), /<html lang="en" data-mode="dark">/);
  assert.match(previewHtml(files, 'index.html'), /<html lang="en">/);
});
