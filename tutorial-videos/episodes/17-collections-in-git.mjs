import { openApp } from '../engine/common.mjs';
import { seedAll } from '../engine/demo.mjs';
import { settle, collMenu, menuItem } from '../engine/ui.mjs';

// A file tree of what Dispatch wrote, drawn like an editor sidebar.
const tree = (files) => `<!doctype html><html><head><style>
body{margin:0;background:#16181b;color:#d6dbe0;font:15px/1.5 "DejaVu Sans Mono",monospace;display:flex;height:100vh}
.side{width:420px;background:#111315;padding:22px 18px;border-right:1px solid #24272b}
.h{color:#7f8992;font:600 12px/1 sans-serif;letter-spacing:.12em;text-transform:uppercase;margin-bottom:16px}
.f{padding:3px 0;white-space:nowrap}.d{color:#8fb7ff}.j{color:#e6c07b}.n{color:#7fd6a4}
.main{flex:1;padding:22px 28px}pre{margin:0;color:#c9d1d9}.k{color:#e06c75}.s{color:#98c379}
.term{margin-top:30px;background:#0b0c0e;border-radius:10px;padding:16px 18px;color:#c9d1d9}.p{color:#7fd6a4}
</style></head><body><div class="side"><div class="h">api-collection</div>${files}</div>
<div class="main"><div class="h">Transactions/create-transaction.request.json</div><pre>{
  <span class="k">"name"</span>: <span class="s">"Create transaction"</span>,
  <span class="k">"request"</span>: {
    <span class="k">"method"</span>: <span class="s">"POST"</span>,
    <span class="k">"url"</span>: <span class="s">"{{baseUrl}}/transactions"</span>,
    <span class="k">"body"</span>: { <span class="k">"mode"</span>: <span class="s">"raw"</span>, ... }
  }
}</pre>
<div class="term"><span class="p">~/repo/api-collection $</span> git status --short<br>&nbsp;M Transactions/create-transaction.request.json<br>?? Transactions/refund-transaction.request.json<br><br><span class="p">~/repo/api-collection $</span> git commit -am "Add refunds" &amp;&amp; git push</div></div></body></html>`;
const files = [
  ['collection.json', 'j', 0], ['Auth/', 'd', 0], ['folder.json', 'j', 1], ['get-token.request.json', 'n', 1],
  ['Transactions/', 'd', 0], ['folder.json', 'j', 1], ['list-transactions.request.json', 'n', 1], ['create-transaction.request.json', 'n', 1], ['get-transaction.request.json', 'n', 1],
  ['Users/', 'd', 0], ['folder.json', 'j', 1], ['list-users.request.json', 'n', 1], ['health-check.request.json', 'n', 0],
].map(([n, k, d]) => `<div class="f ${k}" style="padding-left:${d * 22}px">${n}</div>`).join('');

export default {
  title: 'Keep collections in Git',
  summary: 'Save a collection as readable files, commit it with your code, and review changes in pull requests.',
  intro: "Want your API requests reviewed in pull requests, right next to your code? Save the collection to a folder, and keep it in Git.",
  outro: "Your collection now lives in Git, versioned with your code. Next, we'll run it from the command line, and in C I.",
  doneTitle: 'Versioned.',
  async setup(page) { await openApp(page); await seedAll(page); await settle(page); },
  steps: [
    {
      id: 'save', title: 'Save to a folder',
      hint: 'Collection **⋯** › **Save to a folder (Git)…**, then pick a folder in your repo.',
      say: 'Open the collection menu, and choose Save to a folder. Pick a folder inside your repository.',
      async run(c, page) {
        await c.click(await collMenu(page, 'Payments API'), { at: 'menu' });
        await c.click(menuItem(page, 'Save to a folder'), { label: 'Save to a folder (Git)…', at: 'save', wait: 800 });
        await c.quietly(async () => { const ok = page.locator('.modal button.primary'); if (await ok.count()) { await ok.last().click(); await page.waitForTimeout(600); } });
        await c.hold({ at: 'repository' });
      },
    },
    {
      id: 'files', title: 'Readable files',
      hint: '`collection.json`, a `folder.json` per folder, one `.request.json` per request.',
      say: "Dispatch writes plain, readable files. One for the collection, one per folder, and one per request, with its examples. File names stay stable, even when you rename things.",
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.setContent(tree(files)); await page.waitForTimeout(300); });
        await c.look('.side', { label: 'One file per request', at: 'one' });
        await c.look('.main pre', { label: 'Easy to review', at: 'stable' });
      },
    },
    {
      id: 'git', title: 'Commit and push',
      hint: 'Every save updates the files. Commit them like any other code.',
      say: 'Every time you save in Dispatch, the files update. Commit and push them like any other code, and review changes in pull requests.',
      zoom: false,
      async run(c, page) {
        await c.look('.term', { label: 'Plain git', at: 'commit' });
      },
    },
    {
      id: 'open', title: "Open a teammate's collection",
      hint: '**+** › **Open collection from folder…**. Pulled changes load when Dispatch regains focus.',
      say: "Teammates use Open collection from folder, on a cloned repo. After a git pull, changes load as soon as Dispatch comes back into focus.",
      async run(c, page) {
        await c.quietly(async () => { await page.goBack().catch(() => {}); await page.waitForTimeout(400); if (!(await page.locator('#sidebar').count())) { await openApp(page); await seedAll(page); await settle(page); } });
        await c.click('#sidebar button[title="New"]', { at: 'teammates' });
        await c.look(menuItem(page, 'Open collection from folder'), { label: 'Open collection from folder…', at: 'open' });
      },
    },
  ],
};
