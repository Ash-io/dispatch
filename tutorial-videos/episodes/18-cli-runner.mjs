import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, REPO } from '../engine/common.mjs';
import { paymentsCollection, sandboxEnv } from '../engine/demo.mjs';

// Real runs of bin/dispatch.mjs against a small local API, shown in a terminal.
const DIR = path.join(ROOT, 'build', 'cli');
function api() {
  return http.createServer((q, r) => {
    let b = ''; q.on('data', (d) => (b += d));
    q.on('end', () => setTimeout(() => {
      r.setHeader('content-type', 'application/json');
      if (q.url.includes('token') && b.includes('wrong')) { r.statusCode = 401; return r.end('{"error":"invalid_client"}'); }
      r.end(JSON.stringify(q.url.includes('token') ? { json: { client_id: 'tok_9f2' } } : { id: 'TX-1001', amount: 250000, currency: 'NGN', status: 'successful' }));
    }, 30 + (b.length % 7) * 9));
  }).listen(4321);
}
const run = (args) => new Promise((res) => {
  const ch = spawn('node', [path.join(REPO, 'bin/dispatch.mjs'), ...args], { cwd: DIR });
  let out = ''; ch.stdout.on('data', (d) => (out += d)); ch.stderr.on('data', (d) => (out += d));
  ch.on('close', (code) => res({ out, code }));
});
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const color = (s) => esc(s).replace(/✓/g, '<b class="ok">✓</b>').replace(/✗|✖/g, '<b class="bad">✗</b>').replace(/(\d+ failed)/g, (m) => (m.startsWith('0 ') ? m : `<b class="bad">${m}</b>`)).replace(/(\d+ passed)/g, '<b class="ok">$1</b>');
const term = (blocks, title = 'Terminal') => `<!doctype html><html><head><style>
body{margin:0;background:#0f1113;height:100vh;display:flex;flex-direction:column;font:17px/1.55 "DejaVu Sans Mono",monospace;color:#d4dae0}
.bar{height:34px;background:#1d2024;display:flex;align-items:center;justify-content:center;color:#8d969f;font:600 13px sans-serif}
.body{padding:22px 28px;white-space:pre-wrap}.p{color:#7fd6a4}.c{color:#fff}.ok{color:#7fd6a4;font-weight:normal}.bad{color:#ff7b72;font-weight:normal}.dim{color:#7d8790}
.yml{color:#e6c07b}</style></head><body><div class="body">${blocks}</div></body></html>`;
const cmd = (c) => `<span class="p">~/payments-api $</span> <span class="c">${esc(c)}</span>\n`;

let R = {};
export default {
  title: 'Run collections from the command line',
  summary: 'Run the same collections in a terminal or in CI, with reports and a proper exit code.',
  intro: "Your tests shouldn't only run when you click a button. The Dispatch command line runs your collections in a terminal, or in C I, on every push.",
  outro: "Now your API is checked on every push. Next, a shared Dispatch server for your whole team.",
  doneTitle: 'Automated.',
  window: 'Terminal',
  async setup(page) {
    fs.mkdirSync(DIR, { recursive: true });
    const coll = structuredClone(paymentsCollection); coll.variable[0].value = 'http://127.0.0.1:4321/v1';
    const env = structuredClone(sandboxEnv); env.values[0].value = 'http://127.0.0.1:4321/v1';
    fs.writeFileSync(path.join(DIR, 'payments.json'), JSON.stringify(coll, null, 2));
    fs.writeFileSync(path.join(DIR, 'sandbox.json'), JSON.stringify(env, null, 2));
    const srv = api();
    R.basic = await run(['run', 'payments.json', '-e', 'sandbox.json']);
    R.folder = await run(['run', 'payments.json', '-e', 'sandbox.json', '--folder', 'Transactions', '-n', '2']);
    R.fail = await run(['run', 'payments.json', '-e', 'sandbox.json', '--env-var', 'clientSecret=wrong', '--bail', '-r', 'cli,junit']);
    srv.close();
    await page.setViewportSize({ width: 1280, height: 800 });
  },
  steps: [
    {
      id: 'run', title: 'Run a collection',
      hint: '`dispatch run payments.json -e sandbox.json`. From the repo: `node bin/dispatch.mjs`, or `npm link` once.',
      say: 'Point the runner at a collection file and an environment. It uses the same runner and scripts as the app, so results match exactly.',
      zoom: false,
      async run(c, page) {
        const c1 = 'dispatch run payments.json -e sandbox.json';
        await c.quietly(async () => { await page.setContent(term(cmd(''))); });
        await c.hold({ at: 'point' });
        await c.quietly(async () => { await page.setContent(term(cmd(c1))); });
        await c.hold({ at: 'environment' });
        await c.quietly(async () => { await page.setContent(term(cmd(c1) + color(R.basic.out))); });
        await c.look('.body', { label: 'Every request and test', at: 'same' });
      },
    },
    {
      id: 'options', title: 'Pick folders, iterations and data',
      hint: '`--folder`, `-n`, `-d data.csv`, `--env-var key=value`. See `--help`.',
      say: 'Run just one folder, repeat it, feed it a data file, or override variables. Everything you can do in the app is here. Run with help to see every option.',
      zoom: false,
      async run(c, page) {
        const c2 = 'dispatch run payments.json -e sandbox.json --folder Transactions -n 2';
        await c.quietly(async () => { await page.setContent(term(cmd(c2) + color(R.folder.out))); });
        await c.look('.body', { label: 'One folder, twice', at: 'folder' });
      },
    },
    {
      id: 'fail', title: 'Failures fail the build',
      hint: 'Any failure exits with code **1**. `--bail` stops at the first one. `-r junit` writes a report.',
      say: "If anything fails, it exits with code one, so your C I build fails too. Bail stops at the first failure, and the J unit reporter writes a report your C I can show.",
      zoom: false,
      async run(c, page) {
        const c3 = 'dispatch run payments.json -e sandbox.json --bail -r cli,junit';
        await c.quietly(async () => { await page.setContent(term(cmd(c3) + color(R.fail.out) + cmd('echo $?') + R.fail.code + '\n')); });
        await c.look('.body', { label: `Exit code ${R.fail.code}`, at: 'exits' });
      },
    },
    {
      id: 'ci', title: 'Add it to CI',
      hint: 'Secrets come from CI variables with `--vault-from-env`. Works on folders saved with **Save to a folder (Git)**.',
      say: "In C I, add one step. Vault secrets can come from your C I's secret variables, and it runs folders saved from Dispatch straight from your repository.",
      zoom: false,
      async run(c, page) {
        const yml = `<span class="dim"># .github/workflows/api-tests.yml</span>
<span class="yml">jobs:
  api-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node dispatch/bin/dispatch.mjs run ./api-collection \\
            -e sandbox.json --vault-from-env -r cli,junit
        env:
          paystack_live_key: \${{ secrets.PAYSTACK_KEY }}</span>`;
        await c.quietly(async () => { await page.setContent(term(yml, 'api-tests.yml')); });
        await c.look('.body', { label: 'One step in your pipeline', at: 'step' });
      },
    },
  ],
};
