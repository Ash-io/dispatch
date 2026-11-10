import { openApp, REPO } from '../engine/common.mjs';

const URL_IN = 'https://api.example.com/v1/users?page=1';

export default {
  title: 'Install Dispatch and send your first request',
  summary: 'Download the app, skip the sign-up, and get a real response back in under a minute.',
  intro: "Hello! Let's get you started with Dispatch. In this video, we'll install it, then send our very first request. No account needed.",
  outro: "And that's your first request, sent and saved. Easy, right? In the next video, we'll organise requests into collections.",
  doneTitle: 'First request: done.',
  window: 'Dispatch',
  async setup(page) {
    await page.goto('file://' + REPO + '/site/index.html');
    await page.waitForTimeout(1200);
  },
  steps: [
    {
      id: 'install', title: 'Download Dispatch',
      hint: 'Go to **dispatch.ashlabs.xyz** and click **Download**, or run the one-line installer.',
      say: 'First, go to dispatch dot ash labs dot x y z. Click Download for your system, or copy the one-line installer into your terminal.',
      zoom: false,
      async run(c, page) {
        await c.look('#dlHero', { label: 'Download for your system', at: 'download' });
        await c.look('#oneLiner', { label: 'Or use the one-liner', at: 'installer' });
      },
    },
    {
      id: 'start', title: 'Start without an account',
      hint: 'Choose **Start on this device**. Everything stays on your computer.',
      say: 'Open Dispatch. You can connect Postman later, but for now, click Start on this device. Your work stays right here on your computer.',
      async run(c, page) {
        await c.quietly(async () => { await openApp(page, { local: false }); });
        await c.click(page.getByRole('button', { name: /Start on this device/ }), { label: 'Start on this device', at: 'click' });
      },
    },
    {
      id: 'new', title: 'Open a new request',
      hint: 'Click **New request**, or press [⌘]+[T].',
      say: 'Now click New request. You can also press Command T, or Control T on Windows.',
      async run(c, page) {
        await c.click('#workspace .btn.primary:has-text("New request")', { label: 'New request', at: 'new' });
      },
    },
    {
      id: 'url', title: 'Enter the URL',
      hint: 'Paste or type the address. Query params fill in by themselves.',
      say: 'Type the address of the API you want to call. See how the query parameters fill in by themselves, below.',
      zoom: { x: 290, y: 70, w: 990, h: 240 },
      async run(c, page) {
        await c.type('input[placeholder^="Enter a URL"]', URL_IN, { at: 'type', frames: 6 });
        await c.look('.kv, table', { label: 'Params, filled in', at: 'query' }).catch(() => c.hold());
      },
    },
    {
      id: 'send', title: 'Send it',
      hint: 'Click **Send**, or press [⌘]+[↵].',
      say: 'Click Send. And there it is: status two hundred, how long it took, and the size of the response.',
      async run(c, page) {
        await c.click('.send-btn', { label: 'Send', at: 'send', wait: 900 });
        await c.look(page.locator('.meta-btn').locator('xpath=..'), { label: 'Status, time and size', at: 'status' });
      },
    },
    {
      id: 'read', title: 'Read the response',
      hint: 'The body is pretty-printed. Click the **time** to see where it went.',
      say: 'The body is nicely formatted for you. Click the time to see where it went: lookup, connection, waiting, and download.',
      async run(c, page) {
        await c.look('.cm-content', { label: 'Formatted JSON', at: 'body' });
        await c.click('.meta-btn', { label: 'Where the time went', at: 'click', wait: 500 });
      },
    },
    {
      id: 'save', title: 'Save it to a collection',
      hint: 'Press [⌘]+[S], name it, pick or create a collection.',
      say: "Finally, save it. Press Command S, give it a name, and create a collection to keep it in. Click Save, and it's ready for next time.",
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); });
        await c.click(page.getByRole('button', { name: 'Save to collection' }), { label: 'Save', show: '⌘S', at: 'save' });
        await c.type('dialog[open] input.input, .modal input.input', 'List users', { at: 'name', frames: 3 });
        await c.click(page.locator('dialog[open], .modal').getByRole('button', { name: 'New collection' }), { label: 'New collection', at: 'create' });
        await c.quietly(async () => {
          const inp = page.locator('dialog[open] input, .modal input').last();
          await inp.fill('My first API').catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
          await page.waitForTimeout(400);
        });
        await c.click(page.locator('dialog[open], .modal').getByRole('button', { name: 'Save', exact: true }), { label: 'Save', at: 'click', wait: 700 });
      },
    },
  ],
};
