import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, collMenu, menuItem, selectEnv } from '../engine/ui.mjs';

const openapi = `openapi: 3.0.3
info: { title: Wallet API, version: 1.0.0 }
servers: [{ url: https://api.example.com/v2 }]
tags: [{ name: Wallets }, { name: Payouts }]
paths:
  /wallets:
    get: { tags: [Wallets], summary: List wallets }
    post: { tags: [Wallets], summary: Create wallet }
  /wallets/{id}:
    get: { tags: [Wallets], summary: Get wallet, parameters: [{ name: id, in: path, required: true, schema: { type: string } }] }
  /payouts:
    post: { tags: [Payouts], summary: Send payout }
`;
const curl = `curl -X POST https://api.example.com/v1/transfers -H 'Content-Type: application/json' -H 'Idempotency-Key: 7f3c' -d '{"amount":50000,"currency":"NGN","recipient":"RCP_88x"}'`;

export default {
  title: 'Import, export, cURL and code',
  summary: 'Bring in Postman, OpenAPI, Insomnia or HAR files, paste cURL, and turn requests into code.',
  intro: "Coming from another tool, or from API docs? Dispatch imports almost anything, and turns your requests into code for any language.",
  outro: 'Bring work in, send it out, in whatever shape you need. Next: keeping collections in Git.',
  doneTitle: 'In and out, easily.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); },
  steps: [
    {
      id: 'import', title: 'Import a file or spec',
      hint: '**Import**: Postman v2.0/v2.1, **OpenAPI 3**, Swagger 2, Insomnia and HAR. File, paste or link.',
      say: 'Click Import. Choose a file, paste the text, or paste a link. Postman collections, Open A P I and Swagger, Insomnia and HAR files all work.',
      async run(c, page) {
        await c.click('#sidebar button[title^="Import"]', { label: 'Import', at: 'import' });
        await c.fill('.modal textarea', openapi, { label: 'Paste an OpenAPI spec', at: 'paste' });
        await c.click(page.locator('.modal').getByRole('button', { name: 'Import' }), { label: 'Import', at: 'link', wait: 800 });
      },
    },
    {
      id: 'result', title: 'Folders from tags',
      hint: 'OpenAPI tags become folders, with parameters, bodies and examples filled in.',
      say: "Here is the Open A P I spec, imported. Tags become folders, and parameters, example bodies and auth come along too.",
      async run(c, page) {
        await c.quietly(async () => { await settle(page); });
        await c.click(page.locator('#sidebar .tree-row', { hasText: 'Wallet API' }).first(), { at: 'tags', wait: 300 });
        await c.click(page.locator('#sidebar .tree-row', { hasText: 'Wallets' }).first(), { label: 'Wallets', at: 'folders', wait: 300 });
      },
    },
    {
      id: 'curl', title: 'Paste a cURL command',
      hint: 'Paste `curl …` into the URL bar. It becomes a full request.',
      say: 'Got a curl command from some docs? Paste it straight into the U R L bar. Method, headers and body are all filled in for you.',
      async run(c, page) {
        await c.click('#tabs button[title^="New request"]', { at: 'docs', wait: 300 });
        await c.fill('input[placeholder^="Enter a URL"]', curl, { label: 'Paste cURL', at: 'paste' });
        await c.quietly(async () => { await page.keyboard.press('Tab'); await page.waitForTimeout(400); await page.locator('#workspace .subtab', { hasText: 'Headers' }).first().click(); await page.waitForTimeout(300); });
        await c.look('#workspace .subtab:has-text("Headers") >> nth=0', { label: 'Headers filled in', at: 'headers' });
      },
    },
    {
      id: 'code', title: 'Generate code',
      hint: 'The **</>** button, or [⌥]+[⌘]+[C]: cURL, Python, Go, Java, Swift and more.',
      say: "To go the other way, click the code button. Pick a language: curl, Python, Go, Java, Swift, and many more, with your variables and auth filled in.",
      async run(c, page) {
        await c.quietly(async () => { await openRequest(page, 'Payments API', 'Transactions', 'Create transaction'); });
        await c.click('#workspace button[title^="Code snippet"]', { label: 'Code snippet', at: 'code', wait: 500 });
        await c.click('.modal select >> nth=0', { label: 'Pick a language', at: 'language', clickOpts: { trial: true } });
        await c.quietly(async () => { const s = page.locator('.modal select').first(); const opts = await s.locator('option').allTextContents(); const py = opts.find((o) => /python/i.test(o)); if (py) await s.selectOption({ label: py }); await page.waitForTimeout(400); });
        await c.hold({ at: 'python' });
      },
    },
    {
      id: 'export', title: 'Export a collection',
      hint: 'Collection **⋯** › **Export…** writes a standard Postman file.',
      say: "And to share a collection, use Export from its menu. It writes a standard Postman file that any tool can read.",
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); });
        await c.click(await collMenu(page, 'Payments API'), { at: 'share' });
        await c.click(menuItem(page, 'Export'), { label: 'Export…', at: 'export', wait: 500 });
      },
    },
  ],
};
