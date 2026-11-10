import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { collMenu, menuItem, settle, selectEnv } from '../engine/ui.mjs';

export default {
  title: 'Organise requests with collections and folders',
  summary: 'Group requests into collections and folders, share settings across them, and document them.',
  intro: "Once you have a few requests, you'll want to keep them tidy. Let's look at collections, folders, and the settings they share.",
  outro: 'Now your requests have a proper home. Next, we will make them work across environments with variables.',
  doneTitle: 'Nice and tidy.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); await selectEnv(page, 'Sandbox'); },
  steps: [
    {
      id: 'new', title: 'Create a collection',
      hint: 'Click **+** in the sidebar, then **New collection**.',
      say: 'Click the plus button in the sidebar, then New collection. Give it a name, and click Create.',
      async run(c, page) {
        await c.click('#sidebar button[title="New"]', { label: 'New', at: 'plus' });
        await c.click(menuItem(page, 'New collection'), { at: 'new' });
        await c.type('.modal input', 'Orders API', { at: 'name' });
        await c.click(page.locator('.modal').getByRole('button', { name: 'Create' }), { label: 'Create', at: 'create', wait: 600 });
      },
    },
    {
      id: 'folder', title: 'Add folders and requests',
      hint: 'Open a collection\'s **⋯** menu: **Add folder**, **Add request**.',
      say: "Every collection has a menu. Here you can add folders to group related requests, and add new requests straight into them.",
      async run(c, page) {
        await c.quietly(async () => { await page.locator('#sidebar').getByText('Orders API').hover(); });
        await c.click(await collMenu(page, 'Orders API'), { label: 'Collection menu', at: 'menu' });
        await c.click(menuItem(page, 'Add folder'), { at: 'folders' });
        await c.type('.modal input', 'Checkout', { at: 'group' });
        await c.click(page.locator('.modal').getByRole('button', { name: /Create|Add|Save/ }).last(), { at: 'related', wait: 600 });
      },
    },
    {
      id: 'drag', title: 'Drag to reorder',
      hint: 'Drag requests and folders to move them, in or between collections.',
      say: "To move things around, just drag them. Requests and folders can move within a collection, or into another one.",
      async run(c, page) {
        await c.quietly(async () => {
          await page.keyboard.press('Escape');
          const t = page.locator('#sidebar').getByText('Payments API', { exact: true });
          await t.click(); await page.waitForTimeout(300);
          await page.locator('#sidebar').getByText('Transactions', { exact: true }).click(); await page.waitForTimeout(300);
        });
        await c.look(page.locator('#sidebar .tree, #sidebar').first(), { label: 'Drag and drop', at: 'drag' });
      },
    },
    {
      id: 'settings', title: 'Shared auth and variables',
      hint: '**Settings, auth & variables**: set auth once, every request inherits it.',
      say: "Open the collection's settings. Authorisation set here is inherited by every request inside, and collection variables, like base U R L, work everywhere in it.",
      async run(c, page) {
        await c.quietly(async () => { await page.locator('#sidebar').getByText('Payments API', { exact: true }).hover(); });
        await c.click(await collMenu(page, 'Payments API'), { at: 'open' });
        await c.click(menuItem(page, 'Settings, auth'), { at: 'settings', wait: 600 });
        await c.click(page.locator('#workspace .subtab', { hasText: 'Authorization' }), { label: 'Authorization', at: 'authorisation' });
        await c.click(page.locator('#workspace .subtab', { hasText: 'Variables' }), { label: 'Variables', at: 'variables' });
      },
    },
    {
      id: 'docs', title: 'Write docs in Markdown',
      hint: 'The **Overview** tab takes Markdown, with a live preview.',
      say: 'The Overview tab is for documentation. Write in Markdown, and switch to Preview to see it formatted. It syncs with Postman too.',
      async run(c, page) {
        await c.click(page.locator('#workspace .subtab', { hasText: 'Overview' }), { at: 'overview' });
        await c.fill('#workspace textarea.code', '# Payments API\n\nCharges, refunds and transactions for the **Acme** checkout.\n\n- Use the `Sandbox` environment for testing\n- Tokens expire after **1 hour**\n- Amounts are in kobo, so `250000` is ₦2,500', { label: 'Markdown', at: 'markdown' });
        await c.click(page.locator('#workspace button', { hasText: 'Preview' }).first(), { label: 'Preview', at: 'preview', wait: 500 });
      },
    },
    {
      id: 'chain', title: 'See how requests connect',
      hint: '**Request chain** shows which request sets a variable, and which ones use it.',
      say: "Finally, Request chain. It shows your requests in run order, with arrows from the request that sets a variable to the ones that use it.",
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.locator('#sidebar').getByText('Payments API', { exact: true }).hover(); });
        await c.click(await collMenu(page, 'Payments API'), { at: 'request' });
        await c.click(menuItem(page, 'Request chain'), { at: 'chain', wait: 800 });
        await c.hold({ at: 'arrows' });
      },
    },
  ],
};
