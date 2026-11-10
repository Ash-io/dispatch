import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, row } from '../engine/ui.mjs';

const envTab = (page) => page.locator('#sidebar .side-tab', { hasText: 'Environments' });

export default {
  title: 'Environments and variables',
  summary: 'Write a request once, then point it at sandbox or production with one switch.',
  intro: "Hard-coding addresses and keys gets messy fast. With environments and variables, you write a request once and run it anywhere.",
  outro: 'Now one request works in every environment. Next, we will keep your real secrets safe in the Vault.',
  doneTitle: 'One request, every environment.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); },
  steps: [
    {
      id: 'env', title: 'Open an environment',
      hint: '**Environments** tab, then pick one. Each variable has a **shared** and a **current** value.',
      say: 'Go to the Environments tab and open Sandbox. Every variable has a shared value, which syncs with your team, and a current value, which stays on your computer.',
      async run(c, page) {
        await c.click(envTab(page), { label: 'Environments', at: 'environments' });
        await c.click(page.locator('#sidebar').getByText('Sandbox', { exact: true }), { at: 'sandbox' });
        await c.look(page.locator('#workspace input.cell').nth(1), { label: 'Shared value', at: 'shared' });
        await c.look(page.locator('#workspace input.cell').nth(2), { label: 'Current value', at: 'current' });
      },
    },
    {
      id: 'secret', title: 'Mark secrets as secret',
      hint: 'Set the type to **secret** and the value is masked on screen.',
      say: 'For anything sensitive, set the type to secret. The value gets masked, so nobody sees it over your shoulder.',
      async run(c, page) {
        await c.look(page.locator('#workspace select.cell').nth(2), { label: 'Type: secret', at: 'secret' });
        await c.look(page.locator('#workspace input.cell').nth(7), { label: 'Masked', at: 'masked' });
      },
    },
    {
      id: 'activate', title: 'Choose the active environment',
      hint: 'Use the menu at the top right. Every request now uses its values.',
      say: 'Now choose the active environment from the menu at the top right. Every request will use its values.',
      async run(c, page) {
        await c.click('select.env-select', { label: 'Active environment', at: 'choose', clickOpts: { trial: true } });
        await c.quietly(async () => { await page.locator('select.env-select').selectOption({ label: 'Sandbox' }); await page.waitForTimeout(300); });
        await c.look('select.env-select', { label: 'Sandbox', at: 'every' });
      },
    },
    {
      id: 'use', title: 'Use {{variables}}',
      hint: 'Write `{{name}}` anywhere. **Green** means defined, **red** means missing.',
      say: 'Write a variable name in double curly braces, in the URL, headers, body or auth. Green means it has a value. Red means it is not defined yet.',
      zoom: { x: 290, y: 30, w: 990, h: 160 },
      async run(c, page) {
        await c.quietly(async () => { await page.locator('#sidebar .side-tab', { hasText: 'Collections' }).click(); await openRequest(page, 'Payments API', 'Transactions', 'List transactions'); });
        await c.look('#workspace .url-wrap, #workspace input[placeholder^="Enter a URL"]', { label: '{{baseUrl}} is defined', at: 'green' });
        await c.type('#workspace input[placeholder^="Enter a URL"]', '{{baseUrl}}/transactions?page=1&region={{region}}', { at: 'red', frames: 3 });
        await c.look('#workspace input[placeholder^="Enter a URL"]', { label: '{{region}} is missing', at: 'defined' });
      },
    },
    {
      id: 'look', title: 'Quick look',
      hint: 'The **eye** button shows every variable in play, and where it comes from.',
      say: 'To check what is set, click the eye button. It shows every variable in play right now, with its value.',
      async run(c, page) {
        await c.click('button[title="Quick look at variables"]', { label: 'Quick look', at: 'eye', wait: 500 });
        await c.hold({ at: 'every' });
      },
    },
    {
      id: 'dynamic', title: 'Dynamic variables',
      hint: '`{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}` give a fresh value every send.',
      say: 'There are also dynamic variables. Dollar G U I D, dollar timestamp, and dollar random email give you a fresh value every time you send.',
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); });
        await c.click(page.locator('#workspace .subtab', { hasText: 'Headers' }).first(), { label: 'Headers', at: 'dynamic' });
        await c.type('#workspace input[placeholder="Add header"]', 'X-Request-Id', { at: 'dollar', frames: 2, clear: false });
        await c.quietly(async () => { await page.keyboard.press('Tab'); await page.waitForTimeout(150); });
        await c.type(page.locator(':focus'), '{{$guid}}', { at: 'guid', frames: 2, clear: false });
        await c.click('.send-btn', { label: 'Send', at: 'fresh', wait: 900 });
      },
    },
  ],
};
