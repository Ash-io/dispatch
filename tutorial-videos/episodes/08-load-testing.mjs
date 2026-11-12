import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, menuItem, selectEnv } from '../engine/ui.mjs';

export default {
  title: 'Load test an endpoint',
  summary: 'Throw up to 500 virtual users at a request and watch latency, throughput and errors live.',
  intro: "Will your endpoint hold up when everyone hits it at once? Let's find out with a load test. Remember: only test servers you own, or have permission to test.",
  outro: "Now you know how your endpoint behaves under pressure. Next: mock servers, for when the real API isn't ready yet.",
  doneTitle: 'Stress, tested.',
  async setup(page) { await openApp(page, { latency: 90 }); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); await openRequest(page, 'Payments API', 'Transactions', 'List transactions'); },
  steps: [
    {
      id: 'open', title: 'Open Load test',
      hint: 'Request **⋯** › **Load test…**',
      say: "Open the request's menu, and choose Load test.",
      async run(c, page) {
        await c.click('#workspace button[title="More"] >> nth=0', { at: 'menu' });
        await c.click(menuItem(page, 'Load test'), { label: 'Load test…', at: 'load', wait: 600 });
      },
    },
    {
      id: 'set', title: 'Set the load',
      hint: 'Virtual users (up to **500**), a duration or request count, ramp-up, and a rate cap.',
      say: 'Set the number of virtual users, up to five hundred. Run for a number of seconds or requests, with an optional ramp up, and a cap on requests per second.',
      async run(c, page) {
        await c.type('#workspace input >> nth=0', '20', { label: 'Virtual users', at: 'virtual', frames: 1 });
        await c.type('#workspace input >> nth=1', '8', { label: 'Seconds', at: 'seconds', frames: 1 });
        await c.look('#workspace input >> nth=2', { label: 'Ramp-up', at: 'ramp' });
      },
    },
    {
      id: 'start', title: 'Start and watch it live',
      hint: 'Throughput, **p50 / p95 / p99** latency, error rate and status codes, updating live.',
      say: 'Press Start. Throughput, latency percentiles, errors and status codes update live, with a chart for every second.',
      zoom: false,
      async run(c, page) {
        await c.click(page.getByRole('button', { name: 'Start' }), { label: 'Start', at: 'start', wait: 3000 });
        await c.hold({ at: 'latency' });
        await c.hold({ wait: 3000, at: 'chart' });
      },
    },
    {
      id: 'done', title: 'Read the summary',
      hint: 'When it ends, the numbers stay. Look at **p95** and the **error rate** first.',
      say: 'When it finishes, the summary stays on screen. Look at the ninety-fifth percentile and the error rate first. They tell you the most.',
      zoom: false,
      async run(c, page) {
        await c.hold({ wait: 3500, at: 'summary' });
        await c.quietly(async () => { await page.mouse.wheel(0, 200); await page.waitForTimeout(300); });
        await c.hold({ at: 'error' });
      },
    },
  ],
};
