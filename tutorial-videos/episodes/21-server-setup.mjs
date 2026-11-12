import { server, stop, ADMIN } from '../engine/server.mjs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const term = (html) => `<!doctype html><html><head><style>
body{margin:0;background:#0f1113;height:100vh;font:18px/1.6 "DejaVu Sans Mono",monospace;color:#d4dae0}
.bar{height:34px;background:#1d2024;display:flex;align-items:center;justify-content:center;color:#8d969f;font:600 13px sans-serif}
.b{padding:24px 30px;white-space:pre-wrap}.p{color:#7fd6a4}.dim{color:#7d8790}.h{color:#e6c07b}</style></head>
<body><div class="b">${html}</div></body></html>`;
const cmd = (c) => `<span class="p">$</span> ${esc(c)}\n`;

export default {
  title: 'Set up a Dispatch server for your team',
  summary: 'Run dispatch-server on your own machine, Docker, or Cloudflare, and claim it as admin.',
  intro: "Want your whole team in Dispatch, with its own accounts and access control? Run a Dispatch server. It's one small program, and it's entirely optional.",
  outro: "Your server is up, and you're its admin. Next, we'll connect Postman accounts and invite your team.",
  doneTitle: 'Server, claimed.',
  window: 'Dispatch server',
  async setup(page) { await page.setContent(term('')); },
  async teardown() { stop(); },
  steps: [
    {
      id: 'run', title: 'Run the server',
      hint: 'Download the binary from the release, or use Docker. It listens on port **8383**.',
      say: 'Download dispatch server from the releases page and run it, or use Docker, with a volume for its database. By default it listens on port eighty three, eighty three.',
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.setContent(term(`<span class="dim"># the prebuilt binary</span>\n${cmd('./dispatch-server-linux-x64')}\n<span class="dim"># or Docker</span>\n${cmd('docker build -t dispatch-server ./server')}${cmd('docker run -p 8383:8383 -v dispatch-data:/data dispatch-server')}`)); });
        await c.look('.b', { label: 'Binary or Docker', at: 'download' });
      },
    },
    {
      id: 'cloud', title: 'Or deploy to Cloudflare',
      hint: '**Deploy to Cloudflare** button in the README, or `npm run deploy:server`. Set a **SECRET_KEY**.',
      say: "Prefer the cloud? The Deploy to Cloudflare button sets it up on your own Cloudflare account, with its database. Set a secret key: it encrypts the Postman keys you add later.",
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.setContent(term(`<span class="dim"># from the repo, or use the Deploy to Cloudflare button</span>\n${cmd('npm run deploy:server')}${cmd('cd worker && npx wrangler secret put SECRET_KEY')}<span class="dim">? Enter a secret value: </span><span class="h">${'•'.repeat(32)}</span>\n<span class="dim"># openssl rand -hex 32 makes a good one</span>`)); });
        await c.look('.b', { label: 'Your own Cloudflare account', at: 'button' });
      },
    },
    {
      id: 'claim', title: 'Claim it straight away',
      hint: 'Open **/admin/**, choose **New server? Create the first account**. The first account becomes **admin**.',
      say: "Now, straight away, open slash admin, and create the first account. The first person to register becomes the admin, so do this before you share the address.",
      async run(c, page) {
        await c.quietly(async () => { await server(page); });
        await c.click('#register-toggle', { label: 'New server? Create the first account', at: 'create' });
        await c.type('#login-email', ADMIN.email, { at: 'first', frames: 3 });
        await c.type('#login-password', ADMIN.password, { at: 'admin', frames: 2 });
        await c.click('#login-submit', { label: 'Create account', at: 'before', wait: 900 });
      },
    },
    {
      id: 'reg', title: 'Close registration',
      hint: '**Settings**: turn off open registration. You add people yourself from now on.',
      say: "Registration is open by default. Once your team is in, or if you'd rather add people yourself, turn it off in Settings.",
      async run(c, page) {
        await c.click('[data-tab=settings]', { label: 'Settings', at: 'settings', wait: 400 });
        await c.click(page.locator('#allow-registration').locator('xpath=ancestor::label[1]').or(page.locator('#allow-registration')).first(), { label: 'Allow registration', at: 'turn', wait: 500 });
      },
    },
  ],
};
