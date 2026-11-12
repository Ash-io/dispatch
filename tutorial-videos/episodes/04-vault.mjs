import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { openRequest, settle, subtab } from '../engine/ui.mjs';

const envTab = (page) => page.locator('#sidebar .side-tab', { hasText: 'Environments' });

export default {
  title: 'Keep secrets in the Vault',
  summary: 'API keys and passwords that never sync, never export, and never leak into scripts.',
  intro: "Some values should never leave your machine: live API keys, passwords, tokens. That is what the Vault is for.",
  outro: "Your secrets now live in your system's secure storage, and nowhere else. Next up: authorisation.",
  doneTitle: 'Secrets, sorted.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); },
  steps: [
    {
      id: 'open', title: 'Open the Vault',
      hint: '**Environments** tab, then **Vault**.',
      say: 'Go to the Environments tab, and click Vault. Values here are stored in your system keychain or secure storage.',
      async run(c, page) {
        await c.click(envTab(page), { at: 'environments' });
        await c.click(page.locator('#sidebar').getByText('Vault', { exact: true }), { label: 'Vault', at: 'vault' });
      },
    },
    {
      id: 'add', title: 'Add a secret',
      hint: 'Click **Add secret**, give it a name and a value.',
      say: 'Click Add secret. Give it a name, like paystack live key, paste the value, and save.',
      async run(c, page) {
        await c.click(page.getByRole('button', { name: 'Add secret' }), { label: 'Add secret', at: 'add' });
        await c.type('.modal input.mono >> nth=0', 'paystack_live_key', { at: 'name', frames: 3 });
        await c.type('.modal input.mono >> nth=1', 'sk_live_9f2c41d7a08e', { at: 'paste', frames: 2 });
        await c.click(page.locator('.modal').getByRole('button', { name: 'Save' }), { label: 'Save', at: 'save', wait: 500 });
      },
    },
    {
      id: 'env', title: 'Or import a .env file',
      hint: '**Import .env…** and paste. Many secrets at once.',
      say: 'Have a dot env file? Click Import dot env, paste it in, and every line becomes a secret.',
      async run(c, page) {
        await c.click(page.getByRole('button', { name: /Import \.env/ }), { label: 'Import .env…', at: 'import' });
        await c.fill('.modal textarea', 'SMTP_PASSWORD=Tr0ub4dor&3\nDB_URL=postgres://app:s3cret@db.internal/payments\nWEBHOOK_SECRET=whsec_51a9b0', { label: 'Paste your .env', at: 'paste' });
        await c.click(page.locator('.modal').getByRole('button', { name: 'Import' }), { label: 'Import', at: 'every', wait: 600 });
      },
    },
    {
      id: 'use', title: 'Use it with {{vault:name}}',
      hint: 'Write `{{vault:paystack_live_key}}` in a URL, header, body or auth field.',
      say: 'To use one, write vault, colon, and the name, inside double curly braces. It works anywhere: URL, headers, body, or auth.',
      async run(c, page) {
        await c.quietly(async () => { await page.locator('#sidebar .side-tab', { hasText: 'Collections' }).click(); await openRequest(page, 'Payments API', 'Transactions', 'Create transaction'); });
        await c.click(subtab(page, 'Authorization'), { at: 'anywhere' });
        await c.quietly(async () => {
          await page.locator('#workspace .form-grid select').first().selectOption('bearer');
          await page.waitForTimeout(200);
          await page.locator('#workspace .form-grid button[title="Show"]').first().click();
          await page.waitForTimeout(200);
        });
        await c.type('#workspace .form-grid input', '{{vault:paystack_live_key}}', { at: 'vault', frames: 3 });
      },
    },
    {
      id: 'safe', title: 'What the Vault protects',
      hint: 'Never synced, never exported. Scripts and code snippets only see the **placeholder**.',
      say: "Vault values never sync to Postman, and are never exported. Scripts can't read them, and code snippets and copied curl commands only show the placeholder.",
      zoom: false,
      async run(c, page) {
        await c.click('#workspace button[title^="Code snippet"]', { label: 'Code snippet', at: 'snippets', wait: 600 });
        await c.look(page.locator('.modal pre, .modal .cm-content, .modal').first(), { label: 'Only the placeholder', at: 'placeholder' });
      },
    },
  ],
};
