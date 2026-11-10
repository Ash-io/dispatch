import { openApp } from '../engine/common.mjs';
import { server, stop, signUpAdmin, addKey, addUser, ADMIN } from '../engine/server.mjs';

let base;
export default {
  title: 'Connect the desktop app to your server',
  summary: 'Sign in to your Dispatch server from the app, then follow every change in the audit log.',
  intro: "Last step: point the desktop app at your server. Then we'll see how the audit log records who did what.",
  outro: "That's the whole team set up: one server, the right access for everyone, and a record of every change. Thanks for watching!",
  doneTitle: 'Team, connected.',
  async setup(page) {
    const s = await server(page); base = s.base;
    await signUpAdmin(page); await addKey(page); await addUser(page, 'tunde@acme.ng', 'editor', ['Payments API']);
    await openApp(page, { local: false });
  },
  async teardown() { stop(); },
  steps: [
    {
      id: 'profile', title: 'Add a server profile',
      hint: 'Welcome screen or **Settings** › **Profiles** › **Add profile** › **Dispatch server**.',
      say: 'In the app, add a new profile, and choose Dispatch server.',
      async run(c, page) {
        await c.click(page.getByRole('button', { name: 'Add another account' }), { label: 'Add another account', at: 'profile', wait: 500 });
        await c.click(page.locator('.modal button', { hasText: 'Dispatch server' }), { label: 'Dispatch server', at: 'server', wait: 400 });
      },
    },
    {
      id: 'signin', title: 'Sign in',
      hint: 'Enter the server URL, your email and password, then press [↵]. Or paste a token from your admin.',
      say: 'Enter the server address, and the email and password your admin gave you, then press Enter. Or paste a token instead.',
      async run(c, page) {
        await c.type('.modal input[placeholder="https://dispatch.example.com"]', 'https://dispatch.acme.ng', { at: 'address', frames: 3 });
        await c.type('.modal input[placeholder="you@company.com"]', 'tunde@acme.ng', { at: 'email', frames: 2 });
        await c.quietly(async () => { await page.locator('.modal input[type=password]').first().fill('correct-horse-battery'); });
        await c.press('Enter', { show: '↵', label: 'Sign in', target: '.modal input[type=password]', at: 'token', wait: 1800 });
      },
    },
    {
      id: 'work', title: 'Work as usual',
      hint: 'Your granted workspaces appear. Everything syncs through the server.',
      say: "And you're in. Your granted workspaces appear, and everything works just like before, only now it goes through your team's server.",
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(500); await page.click('#sidebar .ws-select'); await page.waitForTimeout(300); const it = page.locator('.menu button', { hasText: 'Team Workspace' }); if (await it.count()) await it.first().click(); await page.waitForTimeout(900); await page.locator('#sidebar .tree-row').first().click().catch(() => {}); await page.waitForTimeout(400); });
        await c.look('#sidebar .side-profile', { label: 'Signed in to your server', at: 'granted' });
        await c.hold({ at: 'server' });
      },
    },
    {
      id: 'audit', title: 'Read the audit log',
      hint: 'Admin panel › **Audit log**: who did what, and when. Search and filter it.',
      say: "Back in the admin panel, the Audit log shows every call and every account change: who did it, what it was, and when. Search it, or filter by status.",
      window: 'Dispatch server',
      async run(c, page) {
        await c.quietly(async () => {
          // A few real calls through the proxy, as the teammate would make.
          const t = await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'tunde@acme.ng', password: 'correct-horse-battery' }) })).json();
          const h = { authorization: `Bearer ${t.token}` };
          await fetch(base + '/workspaces', { headers: h }); await fetch(base + '/collections?workspace=w1', { headers: h }); await fetch(base + '/collections/c1', { headers: h });
          await fetch(base + '/collections/c1', { method: 'DELETE', headers: h });
          await page.goto(base + '/admin/');
          await page.waitForTimeout(800);
          if (!(await page.locator('#view-app').isVisible())) { await page.fill('#login-email', ADMIN.email); await page.fill('#login-password', ADMIN.password); await page.click('#login-submit'); }
          await page.waitForSelector('#view-app:visible'); await page.waitForTimeout(500);
        });
        await c.click('[data-tab=audit]', { label: 'Audit log', at: 'audit', wait: 800 });
        await c.look('#audit-body tr >> nth=0', { label: 'Who, what, when', at: 'who' });
        await c.type('#audit-search', 'tunde', { label: 'Search', at: 'search', frames: 2 });
      },
    },
  ],
};
