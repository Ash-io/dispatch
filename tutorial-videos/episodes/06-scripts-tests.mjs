import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, subtab, selectEnv } from '../engine/ui.mjs';

const editor = (page) => page.locator('#workspace textarea.code').first();

export default {
  title: 'Scripts and tests',
  summary: "Chain tokens between requests and check every response, with Postman's pm API.",
  intro: "Scripts let a request do more: save a token for the next call, sign a request, or check the response is right. If you know Postman's p m A P I, you already know this.",
  outro: 'Now your requests test themselves. Next, we will run a whole collection in one go.',
  doneTitle: 'Tested and chained.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); },
  steps: [
    {
      id: 'open', title: 'Open the Scripts tab',
      hint: '**Pre-request** runs before sending. **Post-response** runs after.',
      say: 'Open a request, and go to Scripts. Pre-request runs before it is sent. Post-response runs when the reply comes back.',
      async run(c, page) {
        await c.quietly(async () => { await openRequest(page, 'Payments API', 'Auth', 'Get token'); });
        await c.click(subtab(page, 'Scripts'), { label: 'Scripts', at: 'scripts' });
        await c.click(page.locator('#workspace button', { hasText: 'Post-response' }).first(), { label: 'Post-response', at: 'post' });
      },
    },
    {
      id: 'chain', title: 'Save a value for later',
      hint: '`pm.environment.set()` stores the token. Other requests use `{{token}}`.',
      say: "This script reads the token from the response, and saves it into the environment. Every other request can then use it, with token in curly braces.",
      async run(c, page) {
        await c.look(editor(page), { label: 'pm.environment.set(...)', at: 'saves' });
      },
    },
    {
      id: 'test', title: 'Write a test',
      hint: '`pm.test()` with `pm.expect()`. Real **chai**, **lodash** and **crypto-js** are built in.',
      say: 'Tests use p m dot test, with p m dot expect. Let us also check the response is quick. Chai, lodash and crypto J S are all built in.',
      async run(c, page) {
        await c.fill(editor(page), "pm.test('Status is 200', () => pm.response.to.have.status(200));\npm.test('Fast enough', () => pm.expect(pm.response.responseTime).to.be.below(500));\npm.environment.set('token', pm.response.json().json.client_id);", { label: 'Add a test', at: 'quick' });
      },
    },
    {
      id: 'snippets', title: 'Or use a snippet',
      hint: '**Snippets** inserts ready-made recipes: token chaining, HMAC signing, conditional skips.',
      say: 'Not sure what to write? Click Snippets, for ready-made recipes like token chaining and H MAC signing.',
      async run(c, page) {
        await c.click(page.locator('#workspace button', { hasText: 'Snippets' }).first(), { label: 'Snippets', at: 'snippets', wait: 400 });
        await c.hold({ at: 'recipes' });
      },
    },
    {
      id: 'run', title: 'Send and see results',
      hint: 'The **Tests** tab shows pass or fail. **Console** shows `console.log` output.',
      say: "Now send it. The Tests tab shows each test passing or failing, and the console shows anything you logged.",
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); });
        await c.click('.send-btn', { label: 'Send', at: 'send', wait: 900 });
        await c.click(page.locator('#workspace .subtab', { hasText: 'Tests' }).last(), { label: 'Tests', at: 'tests', wait: 400 });
      },
    },
  ],
};
