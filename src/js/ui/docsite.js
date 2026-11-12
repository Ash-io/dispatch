// Published documentation for a collection: set up the site and its domain,
// generate on this device, review what the AI wrote and what was scrubbed,
// then publish a version to the Dispatch server. Only for server profiles.

import { h, icon, modal, toast, errText, confirmDialog } from './dom.js';
import * as S from '../store.js';
import { state } from '../store.js';
import { bridge } from '../bridge.js';
import { uuid } from '../model.js';
import { vaultValues } from '../vars.js';
import { loadVault } from '../vault.js';
import { parseStructured } from '../assist.js';
import { generateDocs, OMIT, BLANK } from '../docgen/index.js';
import { previewHtml } from '../docgen/build.js';
import { zip, toBase64 } from '../docgen/zip.js';

const api = (method, path, body) => bridge.postman(method, path, body);
const enc = encodeURIComponent;
const STATUS = { none: ['No domain', 'chip'], pending: ['Not verified yet', 'chip warn'], verified: ['Verified', 'chip ok'], failed: ['Verification failed', 'chip bad'] };
const rank = { viewer: 0, editor: 1, creator: 2, admin: 3 };

/** Remembered per site on this device: generation options and review edits. */
function prefs(siteId) {
  state.settings.docsSites = state.settings.docsSites || {};
  state.settings.docsSites[siteId] = state.settings.docsSites[siteId] || { baseUrl: '', description: '', accent: '#2f6f5e', useHistory: true, styleSample: '', edits: {} };
  return state.settings.docsSites[siteId];
}

/** Values that must never end up on a page: vault secrets and current values on this device. */
async function knownSecrets(entry) {
  const out = [];
  try { await loadVault(); out.push(...vaultValues()); } catch { /* vault locked or empty */ }
  const ws = state.ws;
  for (const env of ws?.environments || []) {
    for (const v of env.data?.values || []) if (v.type === 'secret' && v.value) out.push(String(v.value));
    out.push(...Object.values(env.overlay || {}).map(String));
  }
  out.push(...Object.values(ws?.globals?.overlay || {}).map(String));
  for (const v of ws?.globals?.values || []) if (v.type === 'secret' && v.value) out.push(String(v.value));
  out.push(...Object.values(ws?.colOverlays?.[entry.uid] || {}).map(String));
  for (const v of entry.data?.variable || []) if (v.type === 'secret' && v.value) out.push(String(v.value));
  return out.filter((v) => v && v.length >= 6);
}

export async function openDocsSite(entry) {
  await S.ensureCollection(entry);
  const body = h('div', { class: 'docsite' }, h('div', { class: 'loading-bar' }));
  const close = modal({ title: `Documentation · ${entry.name}`, wide: true, body });
  const ctx = { entry, body, close, role: 'viewer', site: null, versions: [] };
  try {
    const [me, list] = await Promise.all([api('GET', '/me'), api('GET', `/docs-sites?collection=${enc(entry.uid)}`)]);
    ctx.role = me?.user?.role || 'editor';
    ctx.site = list?.sites?.[0] || null;
    if (ctx.site) ctx.versions = (await api('GET', `/docs-sites/${enc(ctx.site.id)}/versions`))?.versions || [];
  } catch (e) {
    body.replaceChildren(h('div', { class: 'note err' }, icon('alert'), h('span', null, `${errText(e)} Published documentation needs a Dispatch server that's up to date.`)));
    return;
  }
  renderSite(ctx);
}

const isAdmin = (ctx) => ctx.role === 'admin';
const canPublish = (ctx) => (rank[ctx.role] ?? 0) >= rank.editor;

async function refresh(ctx) {
  const list = await api('GET', `/docs-sites?collection=${enc(ctx.entry.uid)}`);
  ctx.site = list?.sites?.[0] || null;
  ctx.versions = ctx.site ? (await api('GET', `/docs-sites/${enc(ctx.site.id)}/versions`))?.versions || [] : [];
  renderSite(ctx);
}

function section(title, ...children) {
  return h('div', { class: 'settings-section' }, h('h3', null, title), ...children);
}

function renderSite(ctx) {
  const { site, entry } = ctx;
  if (!site) {
    if (!isAdmin(ctx)) {
      ctx.body.replaceChildren(h('p', null, 'This collection has no documentation site yet. Ask an admin on your Dispatch server to create one: they open this same screen from the collection\'s menu.'));
      return;
    }
    const name = h('input', { class: 'input', value: entry.name });
    ctx.body.replaceChildren(
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'Dispatch builds documentation from this collection on your device: requests, saved examples, tests, request chains and, if you allow it, your history. AI writes short descriptions that must point to the evidence behind them, and you review everything before it\'s published to your Dispatch server. Each site needs its own domain or subdomain before anyone can read it.'),
      h('div', { class: 'form-grid' }, h('label', null, 'Site name'), name),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true;
        try { await api('POST', '/admin/docs-sites', { workspace_id: state.ws.id, collection_uid: entry.uid, name: name.value.trim() || entry.name }); await refresh(ctx); } catch (er) { toast(errText(er), { error: true }); e.target.disabled = false; }
      } }, 'Create documentation site')));
    return;
  }
  const [statusText, statusClass] = STATUS[site.domain_status] || STATUS.none;
  const head = h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', marginBottom: '6px' } },
    h('strong', null, site.name),
    h('span', { class: statusClass }, statusText),
    h('span', { class: site.live ? 'chip ok' : 'chip' }, site.live ? 'Live' : 'Not live'),
    site.current_version ? h('span', { class: 'chip' }, `Version ${site.current_version}`) : null,
    site.live && site.url ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); bridge.openUrl(site.url).catch(() => {}); } }, site.url) : null);
  ctx.body.replaceChildren(...[head, domainSection(ctx), canPublish(ctx) ? generateSection(ctx) : h('p', { class: 'hint' }, 'Viewers can read published documentation but not publish it.'), versionsSection(ctx)].filter(Boolean));
}

function domainSection(ctx) {
  const { site } = ctx;
  if (!isAdmin(ctx)) {
    return section('Domain', h('p', { class: 'hint' }, site.hostname ? `${site.hostname}: ${(STATUS[site.domain_status] || STATUS.none)[0].toLowerCase()}. An admin manages the domain.` : 'No domain yet. An admin adds one, and the site can\'t be reached until then.'));
  }
  const host = h('input', { class: 'input mono', value: site.hostname || '', placeholder: 'docs.example.com', spellcheck: 'false' });
  const serverHost = (() => { try { return new URL(S.activeProfile()?.url || '').host; } catch { return 'your server'; } })();
  const steps = site.hostname && site.domain_status !== 'verified' ? h('div', { class: 'hint docs-steps' },
    h('p', null, 'Prove the domain points at this server, one of two ways:'),
    h('ol', null,
      h('li', null, 'Create a DNS record so ', h('code', null, site.hostname), ' reaches ', h('code', null, serverHost), ' (usually a CNAME), and set up HTTPS for it. Railway\'s custom domains, Caddy and a Cloudflare proxy all handle HTTPS. Then press Verify.'),
      h('li', null, 'Or add a TXT record named ', h('code', null, `_dispatch-docs.${site.hostname.split(':')[0]}`), ' with the value ', h('code', null, site.verify_token || ''), '. On the Cloudflare Worker version of the server, use this one, and add the domain to the Worker as a Custom Domain.')),
    site.check_message ? h('p', { class: 'err-text' }, site.check_message) : null) : null;
  const online = h('input', { type: 'checkbox', checked: !!site.online, disabled: site.domain_status !== 'verified' || !site.current_version, onchange: async (e) => {
    try { await api('PATCH', `/admin/docs-sites/${enc(site.id)}`, { online: e.target.checked }); await refresh(ctx); toast(e.target.checked ? 'The site is live' : 'The site is offline'); } catch (er) { e.target.checked = !e.target.checked; toast(errText(er), { error: true }); }
  } });
  return section('Domain',
    h('div', { class: 'form-grid' },
      h('label', null, 'Domain'),
      h('div', { class: 'row' }, host, h('button', { class: 'btn sm', onclick: async () => {
        if (site.hostname && host.value.trim() !== site.hostname && !(await confirmDialog({ title: 'Change the domain?', message: 'The site goes offline until the new domain is verified.', confirm: 'Change' }))) return;
        try { await api('PATCH', `/admin/docs-sites/${enc(site.id)}`, { hostname: host.value.trim() || null }); await refresh(ctx); } catch (er) { toast(errText(er), { error: true }); }
      } }, 'Save'),
      site.hostname ? h('button', { class: 'btn sm', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'Checking…';
        try { const s = await api('POST', `/admin/docs-sites/${enc(site.id)}/verify`); toast(s.domain_status === 'verified' ? 'Domain verified' : 'Not verified yet', { error: s.domain_status !== 'verified' }); await refresh(ctx); } catch (er) { toast(errText(er), { error: true }); e.target.disabled = false; e.target.textContent = 'Verify'; }
      } }, 'Verify') : null),
      h('label', null, 'Live'),
      h('label', { class: 'row', style: { gap: '6px' } }, online, h('span', { class: 'hint', style: { margin: 0 } }, site.domain_status !== 'verified' ? 'Verify the domain first.' : !site.current_version ? 'Publish a version first.' : 'Serve the current version on the domain.'))),
    steps);
}

function generateSection(ctx) {
  const { site, entry } = ctx;
  const p = prefs(site.id);
  const save = () => S.saveSettings();
  const baseUrl = h('input', { class: 'input mono', value: p.baseUrl, placeholder: 'https://api.example.com', oninput: (e) => { p.baseUrl = e.target.value; save(); } });
  const desc = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Optional. Otherwise the AI writes a two-sentence introduction from the requests.', oninput: (e) => { p.description = e.target.value; save(); } }, p.description);
  const accent = h('input', { type: 'color', value: p.accent || '#2f6f5e', oninput: (e) => { p.accent = e.target.value; save(); } });
  const history = h('input', { type: 'checkbox', checked: p.useHistory !== false, onchange: (e) => { p.useHistory = e.target.checked; save(); } });
  const envs = state.ws?.environments || [];
  const env = h('select', { class: 'select' }, h('option', { value: '' }, 'Don\'t run requests'), envs.map((x) => h('option', { value: x.uid, selected: p.verifyEnv === x.uid }, `Run against ${x.name}`)));
  env.onchange = () => { p.verifyEnv = env.value || null; save(); };
  const writes = h('input', { type: 'checkbox', checked: !!p.verifyWrites, onchange: (e) => { p.verifyWrites = e.target.checked; save(); } });
  const useAi = h('input', { type: 'checkbox', checked: p.useAi !== false, onchange: (e) => { p.useAi = e.target.checked; save(); } });
  const style = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Optional. Paste a paragraph of documentation you like; the AI matches its tone, not its content.', oninput: (e) => { p.styleSample = e.target.value; save(); } }, p.styleSample);
  return section('Generate',
    h('div', { class: 'form-grid' },
      h('label', null, 'Public base URL'), baseUrl,
      h('label', null, 'Introduction'), desc,
      h('label', null, 'Accent colour'), h('div', null, accent),
      h('label', null, 'Evidence'), h('label', { class: 'row', style: { gap: '6px' } }, history, h('span', null, 'Use responses from my history on this device')),
      h('label', null, 'Verify examples'), h('div', null, env, h('label', { class: 'row', style: { gap: '6px', marginTop: '6px' } }, writes, h('span', null, 'Also run requests that change data (POST, PUT, PATCH, DELETE)'))),
      h('label', null, 'AI'), h('label', { class: 'row', style: { gap: '6px' } }, useAi, h('span', null, 'Write descriptions with AI (Settings → AI assistant → Documentation model)')),
      h('label', null, 'House style'), style),
    h('p', { class: 'hint' }, 'The base URL replaces the collection\'s host variable in code samples. Secrets and personal data in examples and history are replaced with realistic fakes before anything is written or sent to an AI provider.'),
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: () => runGeneration(ctx) }, icon('play'), 'Generate and review')));
}

function versionsSection(ctx) {
  const { site, versions } = ctx;
  if (!versions.length) return null;
  return section('Versions', h('table', { class: 'docs-versions' },
    h('tbody', null, versions.map((v) => h('tr', null,
      h('td', null, `Version ${v.version}`),
      h('td', { class: 'faint' }, `${String(v.published_at).slice(0, 16).replace('T', ' ')} · ${v.published_by || ''}`),
      h('td', { class: 'faint' }, `${v.file_count} files`),
      h('td', null, v.current ? h('span', { class: 'chip ok' }, 'Current') : canPublish(ctx) ? h('button', { class: 'btn sm ghost', onclick: async () => {
        try { await api('PATCH', `/docs-sites/${enc(site.id)}`, { current_version: v.version }); await refresh(ctx); toast(`Version ${v.version} is current`); } catch (er) { toast(errText(er), { error: true }); }
      } }, 'Make current') : null))))));
}

async function verifyRun(ctx) {
  const p = prefs(ctx.site.id);
  if (!p.verifyEnv) return {};
  const envEntry = (state.ws?.environments || []).find((x) => x.uid === p.verifyEnv);
  if (!envEntry) return {};
  const ids = new Set();
  const walk = (items) => { for (const it of items || []) { if (Array.isArray(it.item)) walk(it.item); else if (it.request && (p.verifyWrites || ['GET', 'HEAD', 'OPTIONS'].includes((it.request.method || 'GET').toUpperCase()))) ids.add(it.id); } };
  walk(ctx.entry.data?.item);
  if (!ids.size) return {};
  if (!(await confirmDialog({ title: `Run ${ids.size} request${ids.size === 1 ? '' : 's'} against ${envEntry.name}?`, message: p.verifyWrites ? 'This includes requests that create, change or delete data. Use a test environment.' : 'Only requests that read data are run.', confirm: 'Run them' }))) throw new Error('Cancelled.');
  const { runBatch } = await import('../runner.js');
  const run = await runBatch({ entry: ctx.entry, env: envEntry, recordHistory: false, saveExamples: 'none', only: ids });
  const date = new Date().toISOString().slice(0, 10);
  return Object.fromEntries(run.results.map((r) => [r.id, { env: envEntry.name, date, ok: !r.error && r.status && r.status < 400 && r.testsPassed === r.testsTotal }]));
}

async function runGeneration(ctx) {
  const { site, entry } = ctx;
  const p = prefs(site.id);
  const lines = h('ol', { class: 'docs-progress' });
  const step = (text) => { const li = h('li', null, text); lines.append(li); return li; };
  const back = h('button', { class: 'btn', onclick: () => renderSite(ctx) }, 'Back');
  ctx.body.replaceChildren(h('div', { class: 'loading-bar' }), lines, h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, back));
  try {
    let ask = null;
    if (p.useAi !== false) {
      const { ready } = await import('./assistview.js');
      const choice = await ready({ purpose: 'docs' });
      if (!choice) { renderSite(ctx); return; }
      step(`Writing with ${choice.model}`);
      ask = async (system, prompt, schema) => {
        const answer = await bridge.aiAsk({ provider: choice.provider, model: choice.model, system, prompt, schema }, `docs-${uuid()}`, () => {});
        return parseStructured(answer.text, schema);
      };
    }
    let verified = {};
    if (p.verifyEnv) { const li = step('Running requests to verify examples…'); verified = await verifyRun(ctx); li.textContent = `Ran ${Object.keys(verified).length} requests: ${Object.values(verified).filter((v) => v.ok).length} passed`; }
    let previous = null;
    if (site.current_version) {
      try { previous = { structure: await api('GET', `/docs-sites/${enc(site.id)}/versions/${site.current_version}/files/_dispatch/structure.json`), history: ctx.versions }; } catch { previous = { structure: null, history: ctx.versions }; }
    }
    const known = await knownSecrets(entry);
    let writing = null;
    const result = await generateDocs({
      collection: entry.data,
      collectionUid: entry.uid,
      history: state.history,
      useHistory: p.useHistory !== false,
      known,
      verified,
      ask,
      styleSample: p.styleSample,
      pinned: p.edits || {},
      site: { name: site.name, accent: p.accent },
      baseUrl: p.baseUrl,
      description: p.description,
      previous,
      version: (ctx.versions[0]?.version || 0) + 1,
      onProgress: (ev) => {
        if (ev.step === 'gather') step('Gathering requests, examples and history; replacing secrets');
        else if (ev.step === 'facts') step('Working out fields, errors and call order');
        else if (ev.step === 'write') { writing = writing || step(''); writing.textContent = ev.done < ev.total ? `Writing ${ev.job || ''} (${ev.done + 1} of ${ev.total})` : `Wrote ${ev.total} page${ev.total === 1 ? '' : 's'}`; }
        else if (ev.step === 'build') step('Building pages');
      },
    });
    renderReview(ctx, result);
  } catch (e) {
    ctx.body.replaceChildren(h('div', { class: 'note err' }, icon('alert'), h('span', null, errText(e))), h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, back));
  }
}

function renderReview(ctx, result) {
  const { site } = ctx;
  const p = prefs(site.id);
  const pages = result.previewFiles.filter((f) => f.path.endsWith('.html'));
  let current = 'index.html';
  const frame = h('iframe', { class: 'docs-frame', sandbox: '', title: 'Preview' });
  const show = (path) => { current = path; frame.srcdoc = previewHtml(result.previewFiles, path); list.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.path === path)); };
  const list = h('div', { class: 'docs-pages' }, pages.map((f) => h('button', { class: 'btn ghost sm', 'data-path': f.path, onclick: () => show(f.path) }, f.path === 'index.html' ? 'Home' : f.path.replace(/^r\//, '').replace(/\.html$/, ''))));

  const apply = (edits) => {
    p.edits = { ...(p.edits || {}), ...edits };
    S.saveSettings();
    const next = result.rebuild(edits);
    renderReview(ctx, next);
  };

  const gapRows = result.gaps.map((g) => {
    const input = h('input', { class: 'input', placeholder: 'Write a description' });
    return h('div', { class: 'docs-gap' },
      h('div', null, h('strong', null, g.label), h('div', { class: 'faint' }, g.reason)),
      h('div', { class: 'row' }, input,
        h('button', { class: 'btn sm', onclick: () => { if (input.value.trim()) apply({ [g.target]: input.value.trim() }); } }, 'Use'),
        h('button', { class: 'btn sm ghost', title: 'Keep the row, with no description', onclick: () => apply({ [g.target]: BLANK }) }, 'No description'),
        /\.(resp|body|param)\./.test(g.target) ? h('button', { class: 'btn sm ghost', title: 'Leave this field or parameter out of the documentation', onclick: () => apply({ [g.target]: OMIT }) }, 'Leave out') : null));
  });
  const aiRows = Object.entries(result.texts).filter(([, t]) => t.ai).map(([target, t]) => {
    const input = h('input', { class: 'input', value: t.text });
    return h('div', { class: 'docs-gap' },
      h('div', { class: 'faint', title: `Cites: ${t.factIds.join(', ')}` }, target),
      h('div', { class: 'row' }, input, h('button', { class: 'btn sm', onclick: () => { if (input.value.trim() && input.value.trim() !== t.text) apply({ [target]: input.value.trim() }); } }, 'Save edit')));
  });
  const scrubRows = result.scrubbed.map((s) => h('tr', null, h('td', null, s.kind), h('td', { class: 'mono' }, s.masked), h('td', { class: 'mono' }, s.fake.length > 60 ? `${s.fake.slice(0, 60)}…` : s.fake), h('td', { class: 'faint' }, s.where)));
  const hitRows = result.secretHits.map((x) => h('li', null, `${x.kind} in ${x.file}, line ${x.line} (${x.masked})`));

  const tab = (name, count, content) => ({ name, count, content });
  const tabs = [
    tab('Gaps', result.gaps.length, gapRows.length ? h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Where the evidence ran out, Dispatch leaves a gap rather than guessing. Fill each one, publish the row without a description, or leave it out.'),
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'btn sm ghost', onclick: () => apply(Object.fromEntries(result.gaps.map((g) => [g.target, BLANK]))) }, 'Publish all remaining rows without descriptions')), ...gapRows) : h('p', { class: 'hint' }, 'No gaps.')),
    tab('AI-written', aiRows.length, aiRows.length ? h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Highlighted in the preview. Every sentence passed the checks against its cited facts; edit any you want to change.'), ...aiRows) : h('p', { class: 'hint' }, 'Nothing was written by AI.')),
    tab('Replaced values', scrubRows.length, scrubRows.length ? h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Check that nothing personal or secret is left. Names and addresses can\'t be detected automatically, so look at the examples in the preview too.'), h('table', { class: 'docs-table' }, h('thead', null, h('tr', null, h('th', null, 'Kind'), h('th', null, 'Original'), h('th', null, 'Published as'), h('th', null, 'Where'))), h('tbody', null, scrubRows))) : h('p', { class: 'hint' }, 'Nothing needed replacing.')),
    tab('Changelog', result.changelog.length, result.changelog.length ? h('ul', null, result.changelog.map((l) => h('li', null, l))) : h('p', { class: 'hint' }, site.current_version ? 'No changes to requests or response fields since the current version.' : 'This is the first version.')),
  ];
  const tabBody = h('div', { class: 'docs-tabbody' });
  const tabBar = h('div', { class: 'docs-tabs' }, tabs.map((t, i) => h('button', { class: ['btn ghost sm', i === 0 && 'on'], onclick: (e) => { tabBar.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); tabBody.replaceChildren(t.content); } }, `${t.name} (${t.count})`)));
  tabBody.append(tabs[0].content);

  const blockers = [];
  if (result.secretHits.length) blockers.push(`${result.secretHits.length} possible secret${result.secretHits.length === 1 ? '' : 's'} found`);
  if (result.gaps.length) blockers.push(`${result.gaps.length} gap${result.gaps.length === 1 ? '' : 's'} to resolve`);
  const publish = h('button', { class: 'btn primary', disabled: blockers.length > 0, onclick: async (e) => {
    e.target.disabled = true; e.target.textContent = 'Publishing…';
    try {
      const out = await api('POST', `/docs-sites/${enc(site.id)}/versions`, { files: result.files, changelog: result.changelog.join('\n') });
      toast(`Published version ${out.version}`);
      await refresh(ctx);
      if (!out.site.live) toast(out.site.domain_status !== 'verified' ? 'Published. The site goes live once an admin verifies the domain and turns it on.' : 'Published. Turn on Live to serve it.');
    } catch (er) { toast(errText(er), { error: true }); e.target.disabled = false; e.target.textContent = 'Publish'; }
  } }, 'Publish');
  const download = h('button', { class: 'btn', onclick: async () => {
    const bytes = zip(result.files, site.name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'docs');
    try { const path = await bridge.saveBinaryFile(`${site.name.replace(/[^\w.-]+/g, '-')}-docs.zip`, toBase64(bytes)); if (path) toast(`Saved to ${path}`); } catch (er) { toast(errText(er), { error: true }); }
  } }, icon('download'), 'Download .zip');

  ctx.body.replaceChildren(...[
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
      h('span', { class: 'chip' }, `${result.stats.endpoints} requests`),
      h('span', { class: 'chip' }, `${result.stats.aiSentences} AI-written`),
      h('span', { class: result.gaps.length ? 'chip warn' : 'chip ok' }, `${result.gaps.length} gaps`),
      h('span', { class: 'chip' }, `${result.scrubbed.length} values replaced`),
      h('span', { class: result.secretHits.length ? 'chip bad' : 'chip ok' }, `${result.secretHits.length} possible secrets`)),
    result.secretHits.length ? h('div', { class: 'note err' }, icon('alert'), h('div', null, h('p', { style: { margin: 0 } }, 'These look like real credentials. Remove them from the collection\'s examples (or turn off history), then generate again.'), h('ul', null, hitRows))) : null,
    h('div', { class: 'docs-review' }, h('div', null, list, h('div', { class: 'docs-frame-wrap' }, frame)), h('div', null, tabBar, tabBody)),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px', marginTop: '12px' } },
      blockers.length ? h('span', { class: 'faint', style: { marginRight: 'auto' } }, `Can't publish yet: ${blockers.join(', ')}.`) : null,
      h('button', { class: 'btn ghost', onclick: () => renderSite(ctx) }, 'Back'), download, publish)].filter(Boolean));
  show(current);
}
