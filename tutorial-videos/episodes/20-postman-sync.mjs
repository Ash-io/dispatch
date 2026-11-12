import { openApp } from '../engine/common.mjs';
import { openRequest } from '../engine/ui.mjs';

export default {
  title: 'Two-way sync with Postman',
  summary: 'Work in the same workspaces as teammates who use Postman, in both directions.',
  intro: "Your team uses Postman? No problem. Dispatch syncs both ways with your Postman workspaces, so you can use Dispatch while they keep using Postman.",
  outro: "You and your Postman teammates now share the same work, both ways. Next, we'll set up a shared Dispatch server for your team.",
  doneTitle: 'In sync.',
  async setup(page) { await openApp(page, { local: false }); },
  steps: [
    {
      id: 'key', title: 'Create a Postman API key',
      hint: 'In Postman: avatar › **Settings** › **API keys** › **Generate API key**. It starts with `PMAK-`.',
      say: "In Postman, open your settings, then A P I keys, and generate a new key. Copy it. It starts with P M A K.",
      async run(c, page) {
        await c.look(page.getByText('How do I get an API key?').locator('xpath=..'), { label: 'Step by step, right here', at: 'settings' });
      },
    },
    {
      id: 'connect', title: 'Connect it',
      hint: 'Paste the key and click **Connect**. EU team? Tick the EU box first.',
      say: 'Back in Dispatch, paste the key and click Connect. If your team is on Postman\'s E U region, tick that box first.',
      async run(c, page) {
        await c.type('input[placeholder^="Paste your Postman API key"]', 'PMAK-6f1c0b8e2d7a4c1f9e3b5a7d-1a2b', { at: 'paste', frames: 3 });
        await c.click(page.getByRole('button', { name: 'Connect', exact: true }), { label: 'Connect', at: 'connect', wait: 1500 });
      },
    },
    {
      id: 'workspace', title: 'Pick a workspace',
      hint: 'Switch workspaces from the top of the sidebar. Collections and environments load in.',
      say: 'Choose a workspace from the top of the sidebar. Its collections and environments load in, just as they are in Postman.',
      async run(c, page) {
        await c.click('#sidebar .ws-select', { label: 'Workspace', at: 'workspace', wait: 500 });
        await c.quietly(async () => { const it = page.locator('.menu button', { hasText: 'Team Workspace' }); if (await it.count()) { await it.first().click(); await page.waitForTimeout(800); } else await page.keyboard.press('Escape'); });
        await c.hold({ at: 'collections' });
      },
    },
    {
      id: 'save', title: 'Save pushes to Postman',
      hint: 'Edit and press [⌘]+[S]. The change goes straight to Postman.',
      say: 'Now edit a request, and save it. The change goes straight back to Postman, where your teammates see it.',
      async run(c, page) {
        await c.quietly(async () => { await openRequest(page, 'Payments API', 'Transactions', 'List transactions'); });
        await c.type('input[placeholder^="Enter a URL"]', '{{baseUrl}}/get?page=1&limit=50', { at: 'edit', frames: 3 });
        await c.press('ControlOrMeta+s', { show: '⌘+S', label: 'Save', at: 'save', wait: 800 });
      },
    },
    {
      id: 'pull', title: 'Pull their changes',
      hint: 'Click **↻**, or just come back to the window. Teammates\' edits are pulled in.',
      say: "To get your teammates' changes, click the sync button. Dispatch also syncs on its own, whenever the window comes back into focus.",
      async run(c, page) {
        await c.click('#sidebar button[title^="Sync"], #sidebar .ws-select + button', { label: 'Sync', at: 'sync', wait: 900 });
      },
    },
    {
      id: 'conflict', title: 'Conflicts are caught',
      hint: 'If it changed in Postman since you synced, choose: **overwrite**, or **load theirs**.',
      say: 'And if someone changed the same collection since you last synced, Dispatch asks first. Keep your version, or load theirs. Your edits stay in your open tabs, so nothing is lost.',
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => {
          await page.evaluate(async () => { const m = await import('/js/mock.js'); await m.mockBridge._remoteEdit('1-demo-c1', (col) => { col.item[0].name = 'Authentication'; }); });
        });
        await c.type('input[placeholder^="Enter a URL"]', '{{baseUrl}}/get?page=2&limit=50', { at: 'someone', frames: 2 });
        await c.press('ControlOrMeta+s', { show: '⌘+S', at: 'asks', wait: 1200 });
        await c.hold({ at: 'theirs' });
      },
    },
  ],
};
