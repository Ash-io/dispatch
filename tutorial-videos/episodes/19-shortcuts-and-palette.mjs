import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, selectEnv } from '../engine/ui.mjs';

export default {
  title: 'Work faster: palette, history and cookies',
  summary: 'Jump anywhere with the command palette, reopen past sends, and manage cookies.',
  intro: "Let's speed things up. A few everyday tools will save you a lot of clicks: the command palette, history, and the cookie manager.",
  outro: "Those small tools add up to a lot of saved time. Next, we'll sync with Postman.",
  doneTitle: 'Faster already.',
  async setup(page) {
    await openApp(page); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox');
    for (const [f, r] of [['Transactions', 'List transactions'], ['Users', 'List users'], [null, 'Health check']]) { await openRequest(page, 'Payments API', f, r); await page.locator('.send-btn').click(); await page.waitForTimeout(700); }
  },
  steps: [
    {
      id: 'palette', title: 'Search everything',
      hint: 'Press [⌘]+[K]. Find any request, folder, environment or tab by name or URL.',
      say: 'Press Command K, or Control K, to open the command palette. Type part of a name or a U R L, and jump straight to it.',
      async run(c, page) {
        await c.press('ControlOrMeta+k', { show: '⌘+K', label: 'or Ctrl K', at: 'command' });
        await c.type(page.locator(':focus'), 'trans', { at: 'type', frames: 3, clear: false });
        await c.press('Enter', { show: '↵', at: 'jump' });
      },
    },
    {
      id: 'actions', title: 'Run actions',
      hint: 'Start with `>` to see actions only: new request, import, cookies, switch workspace.',
      say: 'Start with a greater than sign, to see actions only. New request, import, cookies, switching workspace, all from the keyboard.',
      async run(c, page) {
        await c.press('ControlOrMeta+k', { show: '⌘+K', at: 'start' });
        await c.type(page.locator(':focus'), '>', { at: 'greater', frames: 1, clear: false });
        await c.hold({ at: 'keyboard' });
      },
    },
    {
      id: 'history', title: 'Reopen past sends',
      hint: '**History** keeps your last **300** sends, grouped by day.',
      say: 'The History tab keeps your last three hundred sends, grouped by day. Click one to reopen it, exactly as it was sent.',
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); });
        await c.click(page.locator('#sidebar .side-tab', { hasText: 'History' }), { label: 'History', at: 'history', wait: 400 });
        await c.click(page.locator('#sidebar').getByText(/api.example.com/).nth(1), { label: 'Reopen it', at: 'click', wait: 500 });
      },
    },
    {
      id: 'cookies', title: 'Manage cookies',
      hint: 'Cookies are kept and sent back for you. Open the manager from **Settings**, the response menu, or [⌘]+[K].',
      say: "Cookies from responses are kept, and sent back automatically. Open the cookie manager to see them by domain, and add, edit or delete them.",
      async run(c, page) {
        await c.press('ControlOrMeta+k', { show: '⌘+K', at: 'open' });
        await c.type(page.locator(':focus'), 'cookies', { at: 'manager', frames: 2, clear: false });
        await c.press('Enter', { show: '↵', at: 'domain', wait: 600 });
      },
    },
    {
      id: 'keys', title: 'Shortcuts worth knowing',
      hint: '[⌘]+[↵] send · [⌘]+[S] save · [⌘]+[T] new tab · [⌘]+[W] close · [⌘]+[L] URL bar',
      say: 'And a few shortcuts worth learning: Command Enter to send, Command S to save, Command T for a new tab, and Command L to jump to the U R L bar.',
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); await page.keyboard.press('Escape'); });
        await c.press('ControlOrMeta+Enter', { show: '⌘+↵', label: 'Send', at: 'enter', wait: 800 });
        await c.press('ControlOrMeta+l', { show: '⌘+L', label: 'URL bar', at: 'jump' });
      },
    },
  ],
};
