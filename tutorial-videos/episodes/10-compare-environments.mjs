import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, menuItem, selectEnv } from '../engine/ui.mjs';

// Staging answers a little differently, so the diff has something to show.
const reply = (req, u) => u.hostname.startsWith('staging')
  ? { id: 'TX-1001', amount: 250000, currency: 'NGN', status: 'pending', narration: 'Invoice 2041', fees: { flat: 100 }, createdAt: '2026-11-09T09:58:12Z' }
  : { id: 'TX-1001', amount: 250000, currency: 'NGN', status: 'successful', narration: 'Invoice 2041', createdAt: '2026-11-09T09:58:12Z' };

export default {
  title: 'Compare a request across environments',
  summary: 'Send one request to staging and production at once, and see exactly what differs.',
  intro: "Works in sandbox, but not in production? Let's send the same request to both environments at once, and see exactly what is different.",
  outro: 'Now differences between environments are easy to spot. Next, a closer look at the response panel.',
  doneTitle: 'Spot the difference.',
  async setup(page) { await openApp(page, { reply }); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); await openRequest(page, 'Payments API', 'Transactions', 'Get transaction'); },
  steps: [
    {
      id: 'open', title: 'Open Compare',
      hint: 'Request **⋯** › **Compare across environments…**',
      say: "Open the request's menu, and choose Compare across environments.",
      async run(c, page) {
        await c.click('#workspace button[title="More"] >> nth=0', { at: 'menu' });
        await c.click(menuItem(page, 'Compare across'), { label: 'Compare across environments…', at: 'compare', wait: 500 });
      },
    },
    {
      id: 'pick', title: 'Pick two environments',
      hint: 'Choose the two to compare, say **Sandbox** and **Production**.',
      say: 'Pick the two environments to compare. Here, sandbox and production.',
      async run(c, page) {
        await c.look('.modal select >> nth=0', { label: 'Sandbox', at: 'sandbox' });
        await c.look('.modal select >> nth=1', { label: 'Production', at: 'production' });
      },
    },
    {
      id: 'send', title: 'Send to both',
      hint: '**Send to both**. Scripts run, but nothing they set is kept.',
      say: 'Click Send to both. Scripts still run, but nothing they set is kept, so your environments stay clean.',
      async run(c, page) {
        await c.click(page.locator('.modal').getByRole('button', { name: /Send to both/ }), { label: 'Send to both', at: 'send', wait: 1500 });
      },
    },
    {
      id: 'diff', title: 'Read the differences',
      hint: 'Status, timing, headers that differ, and a **value-by-value** body diff.',
      say: "Now you can see status and timing side by side, the headers that differ, and a value by value diff of the body. Here, the status field and a new fees object.",
      zoom: false,
      async run(c, page) {
        await c.hold({ at: 'status' });
        await c.quietly(async () => { await page.mouse.move(640, 500); await page.mouse.wheel(0, 400); await page.waitForTimeout(400); });
        await c.hold({ at: 'diff' });
      },
    },
  ],
};
