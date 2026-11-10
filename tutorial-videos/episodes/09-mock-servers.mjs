import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, collMenu, menuItem, row } from '../engine/ui.mjs';

export default {
  title: 'Examples and mock servers',
  summary: 'Save responses as examples, then serve them from a local mock server.',
  intro: "Building a front end before the back end is ready? Save example responses, and Dispatch will serve them from a mock server on your computer.",
  outro: "Your front end can now work against the mock, until the real API is ready. Next, we will compare two environments side by side.",
  doneTitle: 'Mocked and ready.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); },
  steps: [
    {
      id: 'examples', title: 'Saved examples',
      hint: 'Examples sit under their request. Save one from any response with **Save as example**.',
      say: 'Examples are saved responses. They sit under their request in the sidebar. You can save any response as an example from its menu.',
      async run(c, page) {
        await c.quietly(async () => { await openRequest(page, 'Payments API', 'Transactions', 'Get transaction'); await row(page, 'Get transaction').locator('svg.chev').click().catch(() => {}); await page.waitForTimeout(300); });
        await c.look(row(page, 'Successful'), { label: 'Example', at: 'examples' });
        await c.click(row(page, 'Not found'), { at: 'save', wait: 500 });
      },
    },
    {
      id: 'edit', title: 'Edit an example',
      hint: 'Change its status, headers and body. Add, rename or duplicate examples.',
      say: 'Open one to edit it. Set the status code, headers and body to whatever the real API will return.',
      async run(c, page) {
        await c.look(page.locator('#workspace').first(), { label: 'Status, headers, body', at: 'status' });
      },
    },
    {
      id: 'start', title: 'Start the mock server',
      hint: 'Collection **⋯** › **Mock server…** › **Start**.',
      say: 'Now open the collection menu, choose Mock server, and press Start. Every example becomes a route.',
      async run(c, page) {
        await c.click(await collMenu(page, 'Payments API'), { at: 'collection' });
        await c.click(menuItem(page, 'Mock server'), { label: 'Mock server…', at: 'mock', wait: 600 });
        await c.quietly(async () => { await page.evaluate(() => { const set = Map.prototype.set; Map.prototype.set = function (k, v) { if (v && v.routes && v.onLog) globalThis.__lastMockId = k; return set.call(this, k, v); }; }); });
        await c.click(page.getByRole('button', { name: 'Start' }), { label: 'Start', at: 'start', wait: 300 });
        await c.quietly(async () => { await page.evaluate(() => { document.activeElement?.blur(); window.dispatchEvent(new Event('focus')); }); await page.locator('#tabs').getByText('Not found', { exact: true }).click(); await page.waitForTimeout(300); await page.locator('#tabs').getByText('Mock: Payments API').click(); await page.waitForTimeout(400); await page.evaluate(() => document.activeElement?.blur()); });
        await c.look('#workspace table, #workspace .routes', { label: 'Routes from examples', at: 'route' });
      },
    },
    {
      id: 'hit', title: 'Call it',
      hint: 'Calls to `localhost:4010` appear in the log. Pick an example with `x-mock-response-code`.',
      say: 'Point your app at localhost. Each request shows up in the log. To get the error example, send the header x mock response code.',
      async run(c, page) {
        await c.quietly(async () => {
          await page.evaluate(() => {
            for (const p of ['/transactions/TX-1001', '/transactions/TX-0000', '/transactions/TX-1001']) globalThis.__mockServe?.(globalThis.__lastMockId, 'GET', p);
          });
          await page.waitForTimeout(400);
        });
        await c.look('#workspace', { label: 'Live request log', at: 'log' });
      },
    },
    {
      id: 'env', title: 'Point {{baseUrl}} at it',
      hint: 'One click makes an environment where `{{baseUrl}}` is the mock.',
      say: 'And with one click, Dispatch makes an environment where base U R L points at the mock. Switch to it, and your requests hit the mock instead.',
      zoom: false,
      async run(c, page) {
        await c.click(page.locator('#workspace button', { hasText: 'Use in an environment' }).first(), { label: 'Use in an environment', at: 'click', wait: 600 });
        await c.look('select.env-select', { label: '{{baseUrl}} → the mock', at: 'switch' });
      },
    },
  ],
};
