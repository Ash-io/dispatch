import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(ROOT, '..');
export const VIEW = { width: 1280, height: 800 };

export async function episodes() {
  const dir = path.join(ROOT, 'episodes');
  const files = fs.readdirSync(dir).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const m = (await import(pathToFileURL(path.join(dir, f)))).default;
    out.push({ n: Number(f.slice(0, 2)), slug: f.slice(0, -4), ...m });
  }
  return out;
}

// ---------- desktop app (browser build of src/) ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
let appServer;
export function serveApp(port = 8812) {
  if (appServer) return `http://127.0.0.1:${port}`;
  const base = path.join(REPO, 'src');
  appServer = http.createServer((q, r) => {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const f = path.join(base, p);
    if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end(); }
    r.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(r);
  }).listen(port, '127.0.0.1');
  appServer.unref();
  return `http://127.0.0.1:${port}`;
}

// Opens the app with a clean local profile. opts.postman = true signs a Postman profile in.
export async function openApp(page, opts = {}) {
  const url = serveApp();
  // Sends to example hosts get a canned answer instead of hitting the network.
  await page.route(/^https:\/\/(httpbin\.org|api\.example\.com|staging\.example\.com)\//, async (route) => {
    await new Promise((r) => setTimeout(r, opts.latency ?? 140));
    const req = route.request();
    const u = new URL(req.url());
    let body; let status = 200;
    if (u.pathname.startsWith('/status/')) { status = Number(u.pathname.split('/')[2]) || 200; body = ''; }
    else body = JSON.stringify(opts.reply?.(req, u) ?? defaultReply(req, u), null, 2);
    route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'x-request-id': 'b7f0c2', date: 'Mon, 09 Nov 2026 10:00:00 GMT' }, body });
  });
  await page.goto(url + '/index.html');
  await page.evaluate(() => localStorage.clear());
  if (opts.init) await page.evaluate(opts.init);
  await page.reload();
  await page.waitForTimeout(900);
  if (opts.local !== false && !opts.postman) {
    const start = page.getByRole('button', { name: /Start on this device/ });
    if (await start.isVisible().catch(() => false)) { await start.click(); await page.waitForTimeout(500); }
  }
  return url;
}

function defaultReply(req, u) {
  let json = null; try { json = JSON.parse(req.postData() || 'null'); } catch {}
  if (u.pathname.includes('/users')) return { page: 1, per_page: 3, total: 12, data: [
    { id: 7, name: 'Adaeze Okafor', email: 'adaeze@example.com', role: 'admin' },
    { id: 8, name: 'Tunde Bakare', email: 'tunde@example.com', role: 'editor' },
    { id: 9, name: 'Ngozi Eze', email: 'ngozi@example.com', role: 'viewer' }] };
  if (u.pathname.includes('/transactions') && req.method() === 'GET') return { id: 'TX-1001', amount: 250000, currency: 'NGN', status: 'successful', narration: 'Invoice 2041', createdAt: '2026-11-09T09:58:12Z' };
  if (u.pathname.includes('/transactions')) return { id: 'TX-1002', status: 'pending', ...(json || {}) };
  return { args: Object.fromEntries(u.searchParams), headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^sec-|user-agent|accept-/.test(k))), json, method: req.method(), url: req.url() };
}


// ---------- dispatch-server (Worker via wrangler dev) + fake Postman ----------
export async function startServer({ port = 8799, fakePort = 8798, postman } = {}) {
  const state = path.join(ROOT, 'build', '.server-state');
  fs.rmSync(state, { recursive: true, force: true });
  const fake = http.createServer((q, r) => fakePostman(q, r, postman)).listen(fakePort, '127.0.0.1');
  const proc = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--persist-to', state,
    '--var', `POSTMAN_API_BASE:http://127.0.0.1:${fakePort}`, '--var', 'SECRET_KEY:tutorial-video-secret-of-at-least-32-chars'],
  { cwd: path.join(REPO, 'worker'), stdio: 'ignore', detached: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/admin/'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { base, stop: () => { try { process.kill(-proc.pid); } catch {} fake.close(); } };
}

const acme = {
  user: { id: 1, username: 'acme-ops', fullName: 'Acme Ops', teamName: 'Acme Payments' },
  ws: [{ id: 'w1', name: 'Payments API', type: 'team' }, { id: 'w2', name: 'Mobile backend', type: 'team' }, { id: 'w3', name: 'Partner integrations', type: 'team' }],
};
const pmColl = (name, items) => ({ info: { name, _postman_id: name.toLowerCase().replace(/\W+/g, '-'), schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: items.map(([m, n, u]) => ({ name: n, request: { method: m, url: u } })) });
const pmData = {
  colls: { w1: [['c1', pmColl('Charges', [['POST', 'Create charge', '{{baseUrl}}/charges'], ['GET', 'Get charge', '{{baseUrl}}/charges/:id']])], ['c2', pmColl('Refunds', [['POST', 'Refund', '{{baseUrl}}/refunds']])]], w2: [['c3', pmColl('Mobile auth', [['POST', 'Sign in', '{{baseUrl}}/auth']])]], w3: [] },
  envs: { w1: [['e1', { name: 'Production', values: [{ key: 'baseUrl', value: 'https://api.acme.test', enabled: true }] }]], w2: [], w3: [] },
};
function fakePostman(q, r) {
  const send = (v, s = 200) => { r.statusCode = s; r.setHeader('content-type', 'application/json'); r.setHeader('x-ratelimit-remaining-month', '9874'); r.end(JSON.stringify(v)); };
  if (!String(q.headers['x-api-key'] || '').startsWith('PMAK-')) return send({ error: { name: 'AuthenticationError' } }, 401);
  const u = new URL(q.url, 'http://f'); const p = u.pathname; const ws = u.searchParams.get('workspace');
  let m;
  if (p === '/me') return send({ user: acme.user, operations: [{ name: 'api_usage', limit: 1000, usage: 126 }] });
  if (p === '/workspaces') return send({ workspaces: acme.ws });
  if ((m = p.match(/^\/workspaces\/(\w+)$/))) return send({ workspace: { ...acme.ws.find((w) => w.id === m[1]), collections: [], environments: [] } });
  if (/global-variables$/.test(p)) return send({ values: [{ key: 'region', value: 'eu-west', enabled: true, type: 'default' }] });
  if (p === '/collections') return send({ collections: Object.entries(pmData.colls).filter(([w]) => !ws || w === ws).flatMap(([, l]) => l.map(([id, c]) => ({ id, uid: id, name: c.info.name, updatedAt: '2026-11-01T10:00:00.000Z' }))) });
  if ((m = p.match(/^\/collections\/(\w+)$/))) { const c = Object.values(pmData.colls).flat().find(([id]) => id === m[1]); return c ? send({ collection: c[1] }) : send({ error: { name: 'notFound' } }, 404); }
  if (p === '/environments') return send({ environments: Object.entries(pmData.envs).filter(([w]) => !ws || w === ws).flatMap(([, l]) => l.map(([id, e]) => ({ id, uid: id, name: e.name, updatedAt: '2026-11-01T10:00:00.000Z' }))) });
  if ((m = p.match(/^\/environments\/(\w+)$/))) { const e = Object.values(pmData.envs).flat().find(([id]) => id === m[1]); return e ? send({ environment: { id: m[1], ...e[1] } }) : send({ error: { name: 'notFound' } }, 404); }
  send({ error: { name: 'notFound' } }, 404);
}
