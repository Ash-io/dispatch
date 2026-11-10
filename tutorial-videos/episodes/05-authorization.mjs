import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, subtab, collMenu, menuItem, selectEnv } from '../engine/ui.mjs';

const authType = (page) => page.locator('#workspace .form-grid select').first();

export default {
  title: 'Authorization: tokens, keys and OAuth 2.0',
  summary: 'Set auth once for a whole collection, or override it on a single request.',
  intro: "Most APIs want to know who you are. Let's set up authorisation once, and let every request use it.",
  outro: 'Auth set once, used everywhere. Next, we will write scripts and tests that run around each request.',
  doneTitle: 'Signed in, everywhere.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); },
  steps: [
    {
      id: 'collection', title: 'Set auth on the collection',
      hint: 'Collection **⋯** › **Settings, auth & variables** › **Authorization**.',
      say: "The best place for auth is the collection. Open its settings, go to Authorisation, and choose the type. Here, it's a bearer token from a variable.",
      async run(c, page) {
        await c.click(await collMenu(page, 'Payments API'), { at: 'collection' });
        await c.click(menuItem(page, 'Settings, auth'), { at: 'settings', wait: 600 });
        await c.click(subtab(page, 'Authorization'), { label: 'Authorization', at: 'authorisation' });
        await c.look(authType(page), { label: 'Bearer Token', at: 'bearer' });
      },
    },
    {
      id: 'inherit', title: 'Requests inherit it',
      hint: 'A request set to **Inherit from parent** uses the collection\'s auth.',
      say: 'Now open any request inside. Its auth is set to inherit from parent, so it uses the collection token automatically.',
      async run(c, page) {
        await c.quietly(async () => { await openRequest(page, 'Payments API', 'Transactions', 'List transactions'); });
        await c.click(subtab(page, 'Authorization'), { at: 'auth' });
        await c.look(authType(page), { label: 'Inherit from parent', at: 'inherit' });
      },
    },
    {
      id: 'override', title: 'Override on one request',
      hint: 'Pick another type here: **API Key**, **Basic**, **Digest**, **AWS Signature**, **Hawk**…',
      say: "Need something different for one request? Pick another type. A P I key, basic, digest, A W S signature and Hawk are all here, computed just like Postman.",
      async run(c, page) {
        await c.click(authType(page), { at: 'pick', clickOpts: { trial: true } });
        await c.quietly(async () => { await authType(page).selectOption('apikey'); await page.waitForTimeout(300); });
        await c.look(page.locator('#workspace .form-grid'), { label: 'API Key: header or query', at: 'basic' });
      },
    },
    {
      id: 'oauth', title: 'OAuth 2.0',
      hint: 'Fill in the grant, then **Get new access token**. Authorization code opens a real sign-in window, with PKCE.',
      say: "For O Auth two, choose the grant type, fill in the U R Ls and client details, then click Get new access token. The authorisation code flow opens a real sign-in window.",
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await authType(page).selectOption('oauth2'); await page.waitForTimeout(400); });
        await c.look(page.locator('#workspace .form-grid'), { label: 'Grant type and details', at: 'grant' });
        await c.hover(page.getByRole('button', { name: /Get new access token/ }), { label: 'Get new access token', at: 'click' });
      },
    },
  ],
};
