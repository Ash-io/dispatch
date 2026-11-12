import { server, stop, signUpAdmin } from '../engine/server.mjs';

const row = (page, text) => page.locator('#workspaces-body tr', { hasText: text }).first();

export default {
  title: 'Connect Postman and give your team access',
  summary: 'Add Postman API keys, invite people with roles, and decide who reaches which workspace.',
  intro: "With the server running, let's connect a Postman account, invite the team, and decide who can see and change what.",
  outro: "Your team now works in the right workspaces, with the right permissions, and no Postman accounts of their own. Next: workspaces stored on the server itself.",
  doneTitle: 'Everyone in the right place.',
  window: 'Dispatch server',
  async setup(page) { await server(page); await signUpAdmin(page); },
  async teardown() { stop(); },
  steps: [
    {
      id: 'key', title: 'Add a Postman API key',
      hint: '**Postman accounts** › **Add**. The key is checked, encrypted, and never shown again.',
      say: 'In Postman accounts, click Add, and paste a Postman A P I key. The server checks it with Postman, encrypts it, and never shows it again. Only the last four characters.',
      async run(c, page) {
        await c.click('#account-add-empty', { label: 'Add a Postman account', at: 'add' });
        await c.type('#account-key', 'PMAK-acme-7f3c19d0a4b2', { at: 'paste', frames: 3 });
        await c.click('#dialog-ok', { label: 'Add', at: 'checks', wait: 1200 });
        await c.look('#accounts-body tr >> nth=0', { label: 'Status, workspaces, API usage', at: 'last' });
      },
    },
    {
      id: 'ws', title: 'See every workspace',
      hint: '**Workspaces** lists everything your keys reach. Add more keys for more workspaces.',
      say: 'The Workspaces tab lists every workspace your keys can reach. You can connect more than one Postman account, and each workspace is listed once.',
      async run(c, page) {
        await c.click('[data-tab=workspaces]', { label: 'Workspaces', at: 'workspaces', wait: 600 });
        await c.look('#workspaces-body', { label: 'From your Postman accounts', at: 'reach' });
      },
    },
    {
      id: 'roles', title: 'Add people with a role',
      hint: '**Viewer** reads · **Editor** changes · **Creator** adds collections · **Admin** does everything.',
      say: "Now add a teammate. Pick a role. Viewers can only read, editors can change things, creators can also add collections, and admins can do everything, including deletes.",
      async run(c, page) {
        await c.click('[data-tab=users]', { at: 'teammate', wait: 300 });
        await c.click('#add-user-open', { label: 'Add user', at: 'add' });
        await c.type('#new-email', 'tunde@acme.ng', { at: 'pick', frames: 3 });
        await c.quietly(async () => { await page.fill('#new-password', 'correct-horse-battery'); await page.selectOption('#new-role', 'editor'); });
        await c.look('#new-role', { label: 'Role: editor', at: 'editors' });
        await c.click('#add-user-submit', { label: 'Add', at: 'admins', wait: 600 });
      },
    },
    {
      id: 'grant', title: 'Choose their workspaces',
      hint: 'New people start with **no** workspaces. Tick the ones they need.',
      say: "New people start with no workspaces at all, so nothing leaks by accident. Tick just the ones they need, and save.",
      async run(c, page) {
        await c.click(page.locator('#dialog label:has-text("Payments API") input'), { label: 'Payments API', at: 'tick' });
        await c.click('#dialog-ok', { label: 'Save', at: 'save', wait: 700 });
        await c.look('#users-body tr:has-text("tunde")', { label: 'Editor · Payments API', at: 'save' });
      },
    },
    {
      id: 'manage', title: 'Or grant from a workspace',
      hint: 'On any workspace: **Manage access**, then tick people.',
      say: 'You can also work the other way round. Open a workspace, click Manage access, and tick who should have it.',
      async run(c, page) {
        await c.click('[data-tab=workspaces]', { at: 'workspace', wait: 500 });
        await c.click(row(page, 'Mobile backend').locator('button', { hasText: 'Manage access' }), { label: 'Manage access', at: 'manage', wait: 500 });
        await c.click(page.locator('#dialog label:has-text("tunde") input'), { label: 'tunde@acme.ng', at: 'tick' });
        await c.click('#dialog-ok', { at: 'should', wait: 600 });
      },
    },
    {
      id: 'safe', title: 'What the server enforces',
      hint: 'Viewers never get secret **current values**. Deletes are admin-only. Every call is audited.',
      say: "Behind the scenes, the server enforces it all. Viewers never receive secret values, only admins can delete, and every call is written to the audit log.",
      zoom: false,
      async run(c, page) {
        await c.click('[data-tab=audit]', { label: 'Audit log', at: 'audit', wait: 600 });
      },
    },
  ],
};
