import { server, stop, signUpAdmin, addKey } from '../engine/server.mjs';

const row = (page, text) => page.locator('#workspaces-body tr', { hasText: text }).first();

export default {
  title: 'Leave Postman: workspaces on your server',
  summary: 'Create workspaces stored on the Dispatch server itself, or copy your Postman workspaces over.',
  intro: "Moving your team off Postman completely? A Dispatch server can store workspaces itself. Create new ones, or copy your existing Postman workspaces across.",
  outro: "Your team's work now lives on your own server. Last video: connecting the desktop app to it, and reading the audit log.",
  doneTitle: 'Your server, your data.',
  window: 'Dispatch server',
  async setup(page) { await server(page); await signUpAdmin(page); await addKey(page); await page.click('[data-tab=workspaces]'); await page.waitForTimeout(800); },
  async teardown() { stop(); },
  steps: [
    {
      id: 'new', title: 'Create a workspace here',
      hint: '**Workspaces** › **New workspace**. It lives in the server\'s own database.',
      say: 'In Workspaces, click New workspace, and give it a name. It is stored in the server\'s own database. No Postman account needed.',
      async run(c, page) {
        await c.click('#workspace-new', { label: 'New workspace', at: 'new' });
        await c.type('#workspace-new-name', 'Checkout team', { at: 'name', frames: 3 });
        await c.click('#dialog-ok', { label: 'Create', at: 'stored', wait: 800 });
        await c.look(row(page, 'Checkout team'), { label: 'This server', at: 'postman' });
      },
    },
    {
      id: 'copy', title: 'Copy a Postman workspace over',
      hint: '**Copy to server** on any Postman workspace: collections, environments and globals.',
      say: "To bring existing work over, click Copy to server on a Postman workspace. Its collections, environments and global variables are copied in one go.",
      async run(c, page) {
        await c.click(row(page, 'Payments API').locator('button', { hasText: 'Copy to server' }), { label: 'Copy to server', at: 'copy', wait: 500 });
        await c.type('#workspace-import-name', 'Payments (on our server)', { at: 'collections', frames: 3 });
        await c.click('#dialog-ok', { label: 'Copy', at: 'globals', wait: 1500 });
      },
    },
    {
      id: 'result', title: 'A one-time copy',
      hint: 'Postman is left as it was. The two **don\'t sync** afterwards.',
      say: "It's a one-time copy. Postman is left as it was, and the two don't sync afterwards. Your team just switches over.",
      async run(c, page) {
        await c.look(row(page, 'Payments (on our server)'), { label: 'Stored here · 2 collections, 1 environment', at: 'copy' });
      },
    },
    {
      id: 'same', title: 'Same app, same rules',
      hint: 'Grant it like any workspace. Roles, redaction and the audit log apply the same way.',
      say: "Grant these workspaces like any other. Roles, hidden secrets and the audit log all work the same, and the desktop app uses them exactly like Postman ones.",
      async run(c, page) {
        await c.look(row(page, 'Checkout team').locator('button', { hasText: 'Manage access' }), { label: 'Manage access', at: 'grant' });
        await c.look(row(page, 'Checkout team').locator('button', { hasText: 'Rename' }), { label: 'Rename or delete', at: 'roles' });
      },
    },
    {
      id: 'backup', title: 'Back it up',
      hint: 'The data lives only in the server\'s database. Back up `DB_PATH`, or `wrangler d1 export`.',
      say: "One important thing: this data lives only in your server's database. So back it up regularly, like any other database.",
      zoom: false,
      async run(c, page) {
        await c.hold({ at: 'database' });
      },
    },
  ],
};
