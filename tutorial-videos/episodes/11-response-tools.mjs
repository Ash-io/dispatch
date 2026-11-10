import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, subtab, selectEnv, menuItem } from '../engine/ui.mjs';

let n = 0;
const reply = (req, u) => {
  if (u.pathname.includes('/users')) {
    n++;
    return { page: 1, total: 12, data: [
      { id: 7, name: 'Adaeze Okafor', email: 'adaeze@example.com', role: 'admin', active: true },
      { id: 8, name: 'Tunde Bakare', email: 'tunde@example.com', role: n > 1 ? 'admin' : 'editor', active: true },
      { id: 9, name: 'Ngozi Eze', email: 'ngozi@example.com', role: 'viewer', active: n === 1 },
    ] };
  }
  return null;
};

export default {
  title: 'Find, filter and diff responses',
  summary: 'Search a body, filter JSON with JSONPath, save examples, and diff against earlier responses.',
  intro: "Big responses can be hard to read. Let's look at the tools that help: search, JSON path filters, and diffs.",
  outro: "Now no response is too big to read. Next, we'll connect to a live WebSocket.",
  doneTitle: 'Every response, readable.',
  async setup(page) { await openApp(page, { reply }); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); await openRequest(page, 'Payments API', 'Users', 'List users'); await page.locator('.send-btn').click(); await page.waitForTimeout(900); },
  steps: [
    {
      id: 'find', title: 'Search the body',
      hint: 'Press [⌘]+[F] to find text. Every match is highlighted.',
      say: 'Press Command F to search the response body. Every match is highlighted.',
      async run(c, page) {
        await c.click('#workspace button[title="Find (⌘F)"]', { label: 'Find', at: 'search' });
        await c.type(page.locator(':focus'), 'admin', { at: 'every', frames: 2, clear: false });
      },
    },
    {
      id: 'jsonpath', title: 'Filter with JSONPath',
      hint: 'Try `$.data[*].email` or `$..name`. Only the matches stay.',
      say: 'For JSON, click the filter button and type a JSON path. For example, dollar dot data, star, dot email, gives just the emails.',
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); });
        await c.click('#workspace button[title="Filter with JSONPath"]', { label: 'JSONPath filter', at: 'filter' });
        await c.type(page.locator(':focus'), '$.data[*].email', { at: 'dollar', frames: 4, clear: false });
      },
    },
    {
      id: 'example', title: 'Save as an example',
      hint: 'Response **⋯** › **Save as example**. Great for docs and mocks.',
      say: "Like this response? Save it as an example, from the response menu. Examples are great for docs and mock servers.",
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.locator('#workspace button[title="Filter with JSONPath"]').click().catch(() => {}); await page.waitForTimeout(300); });
        await c.click('#workspace button[title="More"] >> nth=-1', { at: 'menu' });
        await c.click(menuItem(page, 'Save as example'), { label: 'Save as example', at: 'save', wait: 500 });
        await c.quietly(async () => { const ok = page.locator('.modal button.primary'); if (await ok.count()) { await ok.last().click(); await page.waitForTimeout(400); } });
        await c.hold({ at: 'docs' });
        await c.quietly(async () => { await page.locator('#tabs').getByText('List users').click(); await page.waitForTimeout(400); });
      },
    },
    {
      id: 'diff', title: 'Diff against before',
      hint: 'The **Diff** tab compares with an example, your history, or another tab.',
      say: 'Send it again, then open the Diff tab. Compare against an example, your history, or another open tab, and see exactly which values changed.',
      zoom: false,
      async run(c, page) {
        await c.click('.send-btn', { label: 'Send again', at: 'send', wait: 900 });
        await c.click(page.locator('#workspace .subtab', { hasText: 'Diff' }).last(), { label: 'Diff', at: 'diff', wait: 600 });
        await c.hold({ at: 'changed' });
      },
    },
    {
      id: 'more', title: 'Copy, save, preview',
      hint: 'Copy or save the body. HTML and images get a **preview**.',
      say: 'From the same menu, you can copy the body or save it to a file. And HTML and image responses get a proper preview.',
      async run(c, page) {
        await c.click('#workspace button[title="More"] >> nth=-1', { at: 'copy', wait: 400 });
        await c.look('.menu', { label: 'Copy or save the body', at: 'file' });
      },
    },
  ],
};
