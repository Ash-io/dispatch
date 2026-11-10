import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { settle, collMenu, menuItem, selectEnv } from '../engine/ui.mjs';

export default {
  title: 'Run a whole collection',
  summary: 'Run every request in order, repeat it with data files, and see a pass or fail matrix.',
  intro: "Clicking Send on every request gets old quickly. The collection runner sends them all, in order, and checks every test.",
  outro: 'One click, every request tested. Next, we will put an endpoint under load.',
  doneTitle: 'All green.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); },
  steps: [
    {
      id: 'open', title: 'Open the runner',
      hint: 'Collection or folder **⋯** › **Run collection**.',
      say: 'Open the collection menu, and click Run collection. You can run a single folder the same way.',
      async run(c, page) {
        await c.click(await collMenu(page, 'Payments API'), { at: 'menu' });
        await c.click(menuItem(page, 'Run collection'), { label: 'Run collection', at: 'run', wait: 600 });
      },
    },
    {
      id: 'config', title: 'Set iterations and environment',
      hint: 'Iterations, a delay between them, and which environment to use.',
      say: 'Choose how many times to run it, an optional delay between iterations, and which environment to use.',
      async run(c, page) {
        await c.type('#workspace input.input >> nth=0', '3', { label: 'Iterations', at: 'how', frames: 1 });
        await c.look('#workspace select.select >> nth=0', { label: 'Environment', at: 'environment' });
      },
    },
    {
      id: 'data', title: 'Feed it a data file',
      hint: '**Data file…**: CSV or JSON. Each row is one iteration, as `{{data}}` variables.',
      say: "Want different inputs each time? Add a data file, C S V or JSON. Each row becomes one iteration, and its columns become variables.",
      async run(c, page) {
        await c.look(page.locator('#workspace button', { hasText: 'Data file' }).first(), { label: 'Data file: CSV or JSON', at: 'data' });
        await c.quietly(async () => {
          await page.locator('#workspace button', { hasText: 'Data file' }).first().click().catch(() => {});
          await page.waitForTimeout(500);
          const ta = page.locator('.modal textarea');
          if (await ta.count()) { await ta.fill('amount,currency\n250000,NGN\n1200,USD\n98000,GHS'); await page.locator('.modal button.primary').last().click(); await page.waitForTimeout(400); }
        });
        await c.hold({ at: 'columns' });
      },
    },
    {
      id: 'go', title: 'Run it',
      hint: 'Press **Run**. **Stop** halts it mid-run.',
      say: 'Press Run, and watch each request go through. You can stop it at any time.',
      async run(c, page) {
        await c.click('#workspace button.primary:has-text("Run")', { label: 'Run', at: 'run', wait: 3500 });
      },
    },
    {
      id: 'results', title: 'Read the matrix',
      hint: 'Every request, every iteration, every test. Click a cell for details.',
      say: "The results show every request across every iteration, with each test's result. Your past runs are kept in history too.",
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => {
          for (let i = 0; i < 60; i++) { if (!(await page.locator('#workspace').innerText()).includes('No runs yet')) break; await page.waitForTimeout(500); }
          await page.waitForTimeout(800);
        });
        await c.hold({ at: 'results' });
        await c.quietly(async () => { await page.mouse.move(700, 600); await page.mouse.wheel(0, 350); await page.waitForTimeout(400); });
        await c.hold({ at: 'history' });
      },
    },
  ],
};
