import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, selectEnv, menuItem } from '../engine/ui.mjs';

const tests = "```javascript\npm.test('Status is 200', () => pm.response.to.have.status(200));\n\npm.test('Transaction looks right', () => {\n  const tx = pm.response.json();\n  pm.expect(tx.id).to.match(/^TX-/);\n  pm.expect(tx.amount).to.be.a('number').and.above(0);\n  pm.expect(tx.currency).to.eql('NGN');\n  pm.expect(tx.status).to.be.oneOf(['pending', 'successful', 'failed']);\n});\n```";
const explain = 'This is a **successful** transaction lookup (200 OK).\n\n- `amount` is **250000** in kobo, so ₦2,500.\n- `status: "successful"` means the payment settled.\n- `createdAt` is in UTC.\n\nIt came back in about 150 ms, mostly waiting on the server.';

export default {
  title: 'The AI assistant',
  summary: 'Let Claude write tests from a real response, explain results, and draft requests from plain English.',
  intro: "Dispatch has an optional A I assistant, powered by Claude, using your own Anthropic key. It can write tests, explain responses, and draft requests for you.",
  outro: "Your assistant, ready when you need it. Next, importing and exporting your work.",
  doneTitle: 'A helping hand.',
  async setup(page) {
    await openApp(page, { init: () => { localStorage.setItem('dispatch:ai-key', '"1"'); } });
    await page.evaluate(([t, e]) => { globalThis.__mockAiAnswer = (req) => (req.schema ? null : /explain/i.test(JSON.stringify(req).slice(0, 4000)) && !/test/i.test(String(req.task || req.mode || '')) ? e : t); }, [tests, explain]);
    await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox');
    await openRequest(page, 'Payments API', 'Transactions', 'Get transaction');
    await page.locator('.send-btn').click(); await page.waitForTimeout(900);
  },
  steps: [
    {
      id: 'key', title: 'Add your Anthropic key',
      hint: '**Settings** › **AI assistant**. The key stays in your system keychain.',
      say: 'First, add your Anthropic A P I key under Settings, A I assistant. It is stored in your system keychain, never in the page.',
      async run(c, page) {
        await c.click('#sidebar button[title^="Settings"]', { label: 'Settings', at: 'settings', wait: 500 });
        const ai = page.locator('.modal, #workspace').getByText(/AI assistant/).first();
        await c.click(ai, { label: 'AI assistant', at: 'assistant', wait: 400 });
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); });
      },
    },
    {
      id: 'tests', title: 'Write tests from a response',
      hint: 'Response **⋯** › **Write tests with AI…**. Nothing changes until you accept.',
      say: 'Send a request, then choose Write tests with A I from the response menu. Claude reads the real response, and writes tests for it. Nothing changes until you accept.',
      zoom: false,
      async run(c, page) {
        await c.click('#workspace button[title="More"] >> nth=-1', { at: 'menu' });
        await c.click(menuItem(page, 'Write tests with AI'), { label: 'Write tests with AI…', at: 'write', wait: 500 });
        await c.click(page.locator('.modal').getByRole('button', { name: 'Continue' }), { label: 'First, it shows what will be sent', at: 'reads', wait: 2500 });
        await c.hold({ at: 'accept' });
      },
    },
    {
      id: 'explain', title: 'Explain a response',
      hint: '**Explain this response** for a plain-English summary, or why a send failed.',
      say: 'Not sure what a response means? Choose Explain this response, and get a plain English summary. It also explains failed sends.',
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); await page.evaluate((e) => { globalThis.__mockAiAnswer = () => e; }, explain); });
        await c.click('#workspace button[title="More"] >> nth=-1', { at: 'choose' });
        await c.click(menuItem(page, 'Explain this response'), { label: 'Explain this response', at: 'explain', wait: 500 });
        await c.quietly(async () => { const b = page.locator('.modal').getByRole('button', { name: 'Continue' }); if (await b.count()) await b.click(); await page.waitForTimeout(2500); });
        await c.hold({ at: 'summary' });
      },
    },
    {
      id: 'privacy', title: 'What gets sent',
      hint: 'The request as written: `{{variables}}` unfilled, credential headers redacted, and up to **30 KB** of the response.',
      say: "What does Claude see? The request as you wrote it, with variables unfilled and credential headers removed, plus up to thirty kilobytes of the response.",
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); });
        await c.click('#workspace button[title="More"] >> nth=-1', { at: 'claude' });
        await c.click(menuItem(page, 'Explain this response'), { at: 'request', wait: 500 });
        await c.look(page.locator('.modal').first(), { label: 'Variables unfilled, credentials redacted', at: 'variables' });
      },
    },
  ],
};
