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
import { PRESETS, DEFAULT_THEME, LAYOUTS, FONTS, MODES, HEADERS, NAVS, DENSITIES, validateTheme, normalizeTheme, contrastFailures, withAccent, isHex } from '../docgen/theme.js';
import { zip, toBase64 } from '../docgen/zip.js';
import { loadFonts } from './fontcache.js';

const api = (method, path, body) => bridge.postman(method, path, body);
const enc = encodeURIComponent;
const STATUS = { none: ['No domain', 'chip'], pending: ['Not verified yet', 'chip warn'], verified: ['Verified', 'chip ok'], failed: ['Verification failed', 'chip bad'] };
const rank = { viewer: 0, editor: 1, creator: 2, admin: 3 };

/** Remembered per site on this device: generation options and review edits. */
function prefs(siteId) {
  state.settings.docsSites = state.settings.docsSites || {};
  state.settings.docsSites[siteId] = state.settings.docsSites[siteId] || { baseUrl: '', description: '', useHistory: true, styleSample: '', edits: {} };
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
  const logoPreview = h('span', { class: 'docs-logo' }, p.logo ? h('img', { src: p.logo, alt: '' }) : h('span', { class: 'faint' }, 'No logo'));
  const logoInput = h('input', { type: 'file', accept: 'image/png,image/svg+xml,image/jpeg,image/webp', hidden: true, onchange: async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try { p.logo = await logoToPng(file); save(); logoPreview.replaceChildren(h('img', { src: p.logo, alt: '' })); } catch (er) { toast(errText(er), { error: true }); }
  } });
  const logo = h('div', { class: 'row', style: { gap: '8px' } }, logoPreview,
    h('button', { class: 'btn sm', onclick: () => logoInput.click() }, p.logo ? 'Change' : 'Choose…'),
    h('button', { class: 'btn sm ghost', hidden: !p.logo, onclick: (e) => { p.logo = ''; save(); logoPreview.replaceChildren(h('span', { class: 'faint' }, 'No logo')); e.currentTarget.hidden = true; } }, 'Remove'), logoInput);
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
      h('label', null, 'Logo'), logo,
      h('label', null, 'Evidence'), h('label', { class: 'row', style: { gap: '6px' } }, history, h('span', null, 'Use responses from my history on this device')),
      h('label', null, 'Verify examples'), h('div', null, env, h('label', { class: 'row', style: { gap: '6px', marginTop: '6px' } }, writes, h('span', null, 'Also run requests that change data (POST, PUT, PATCH, DELETE)'))),
      h('label', null, 'AI'), h('label', { class: 'row', style: { gap: '6px' } }, useAi, h('span', null, 'Write descriptions with AI (Settings → AI assistant → Documentation model)')),
      h('label', null, 'House style'), style),
    h('p', { class: 'hint' }, 'You choose the design (layout, colours and fonts) on the next screen, next to the preview. The base URL replaces the collection\'s host variable in code samples. Secrets and personal data in examples and history are replaced with realistic fakes before anything is written or sent to an AI provider.'),
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
    const theme = await siteTheme(ctx, p);
    const fontStep = step('Getting the design\'s fonts');
    ctx.fonts = await loadFonts(theme);
    fontStep.textContent = ctx.fonts.missing.length ? `Couldn't download ${ctx.fonts.missing.map((m) => m.name).join(', ')}; using system fonts instead` : 'Fonts ready';
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
      site: { name: site.name, logoDataUrl: p.logo || '' },
      theme,
      fonts: ctx.fonts,
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

function renderReview(ctx, result, view = {}) {
  const { site } = ctx;
  const p = prefs(site.id);
  ctx.result = result;
  const pages = result.previewFiles.filter((f) => f.path.endsWith('.html'));
  let current = view.page || 'index.html';
  let mode = view.mode || 'auto';
  let width = view.width || 'desktop';
  const frame = h('iframe', { class: 'docs-frame', sandbox: '', title: 'Preview' });
  const wrap = h('div', { class: ['docs-frame-wrap', width === 'phone' && 'phone'] }, frame);
  // Desktop previews render at 1280 px and are scaled to fit, so they show the desktop layout.
  const fit = () => { frame.style.transform = width === 'phone' ? '' : `scale(${(wrap.clientWidth || 640) / 1280})`; frame.style.height = width === 'phone' ? '' : `${(wrap.clientHeight || 500) * (1280 / (wrap.clientWidth || 640))}px`; };
  new ResizeObserver(fit).observe(wrap);
  const show = (path) => { current = path; frame.srcdoc = previewHtml(ctx.result.previewFiles, path, { mode }); list.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.path === path)); };
  const list = h('div', { class: 'docs-pages' }, pages.map((f) => h('button', { class: 'btn ghost sm', 'data-path': f.path, onclick: () => show(f.path) }, f.path === 'index.html' ? 'Home' : f.path.replace(/^r\//, '').replace(/\.html$/, ''))));
  const seg = (options, value, set) => h('div', { class: 'docs-seg' }, options.map(([v, label]) => h('button', { class: ['btn ghost sm', v === value && 'on'], onclick: (e) => { set(v); e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, label)));
  const toolbar = h('div', { class: 'docs-toolbar' },
    seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], mode, (v) => { mode = v; show(current); }),
    seg([['desktop', 'Desktop'], ['phone', 'Phone']], width, (v) => { width = v; wrap.classList.toggle('phone', v === 'phone'); fit(); }));
  const viewState = () => ({ page: current, mode, width, tab: currentTab });

  const apply = (edits) => {
    p.edits = { ...(p.edits || {}), ...edits };
    S.saveSettings();
    const next = ctx.result.rebuild(edits);
    renderReview(ctx, next, viewState());
  };
  // A design change fetches any new fonts, rebuilds the pages and refreshes the preview, leaving the controls as they are.
  let latest = 0;
  const retheme = async (theme) => {
    const mine = ++latest;
    p.theme = theme;
    S.saveSettings();
    const fonts = await loadFonts(theme);
    if (mine !== latest) return null;
    ctx.fonts = fonts;
    ctx.result = ctx.result.retheme(theme, fonts);
    show(current);
    return fonts;
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
    tab('Design', null, designPanel(ctx, retheme)),
    tab('Gaps', result.gaps.length, gapRows.length ? h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Where the evidence ran out, Dispatch leaves a gap rather than guessing. Fill each one, publish the row without a description, or leave it out.'),
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'btn sm ghost', onclick: () => apply(Object.fromEntries(result.gaps.map((g) => [g.target, BLANK]))) }, 'Publish all remaining rows without descriptions')), ...gapRows) : h('p', { class: 'hint' }, 'No gaps.')),
    tab('AI-written', aiRows.length, aiRows.length ? h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Highlighted in the preview. Every sentence passed the checks against its cited facts; edit any you want to change.'), ...aiRows) : h('p', { class: 'hint' }, 'Nothing was written by AI.')),
    tab('Replaced values', scrubRows.length, scrubRows.length ? h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Check that nothing personal or secret is left. Names and addresses can\'t be detected automatically, so look at the examples in the preview too.'), h('table', { class: 'docs-table' }, h('thead', null, h('tr', null, h('th', null, 'Kind'), h('th', null, 'Original'), h('th', null, 'Published as'), h('th', null, 'Where'))), h('tbody', null, scrubRows))) : h('p', { class: 'hint' }, 'Nothing needed replacing.')),
    tab('Changelog', result.changelog.length, result.changelog.length ? h('ul', null, result.changelog.map((l) => h('li', null, l))) : h('p', { class: 'hint' }, site.current_version ? 'No changes to requests or response fields since the current version.' : 'This is the first version.')),
  ];
  const tabBody = h('div', { class: 'docs-tabbody' });
  const first = Math.max(0, tabs.findIndex((t) => t.name === (view.tab || (result.gaps.length ? 'Gaps' : 'Design'))));
  let currentTab = tabs[first].name;
  const tabBar = h('div', { class: 'docs-tabs' }, tabs.map((t, i) => h('button', { class: ['btn ghost sm', i === first && 'on'], onclick: (e) => { tabBar.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); currentTab = t.name; tabBody.replaceChildren(t.content); } }, t.count === null ? t.name : `${t.name} (${t.count})`)));
  tabBody.append(tabs[first].content);

  const blockers = [];
  if (result.secretHits.length) blockers.push(`${result.secretHits.length} possible secret${result.secretHits.length === 1 ? '' : 's'} found`);
  if (result.gaps.length) blockers.push(`${result.gaps.length} gap${result.gaps.length === 1 ? '' : 's'} to resolve`);
  const publish = h('button', { class: 'btn primary', disabled: blockers.length > 0, onclick: async (e) => {
    e.target.disabled = true; e.target.textContent = 'Publishing…';
    try {
      const out = await api('POST', `/docs-sites/${enc(site.id)}/versions`, { files: ctx.result.files, changelog: ctx.result.changelog.join('\n') });
      toast(`Published version ${out.version}`);
      delete p.theme; // now shared through the published version
      S.saveSettings();
      await refresh(ctx);
      if (!out.site.live) toast(out.site.domain_status !== 'verified' ? 'Published. The site goes live once an admin verifies the domain and turns it on.' : 'Published. Turn on Live to serve it.');
    } catch (er) { toast(errText(er), { error: true }); e.target.disabled = false; e.target.textContent = 'Publish'; }
  } }, 'Publish');
  const download = h('button', { class: 'btn', onclick: async () => {
    const bytes = zip(ctx.result.files, site.name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'docs');
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
    h('div', { class: 'docs-review' }, h('div', null, h('div', { class: 'docs-preview-head' }, list, toolbar), wrap), h('div', null, tabBar, tabBody)),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px', marginTop: '12px' } },
      blockers.length ? h('span', { class: 'faint', style: { marginRight: 'auto' } }, `Can't publish yet: ${blockers.join(', ')}.`) : null,
      h('button', { class: 'btn ghost', onclick: () => renderSite(ctx) }, 'Back'), download, publish)].filter(Boolean));
  show(current);
}

/**
 * The design to build with: an unpublished draft on this device first, then
 * the one published with the current version, so the whole team shares it.
 * Sites from before themes only had an accent colour.
 */
async function siteTheme(ctx, p) {
  if (p.theme) return p.theme;
  const { site } = ctx;
  if (site.current_version) {
    try {
      const published = await api('GET', `/docs-sites/${enc(site.id)}/versions/${site.current_version}/files/_dispatch/theme.json`);
      if (published && typeof published === 'object' && published.version) return published;
    } catch { /* published before themes existed */ }
  }
  return isHex(p.accent) ? withAccent(DEFAULT_THEME, p.accent) : DEFAULT_THEME;
}

/** Any image the webview can draw, as a PNG data URL at most 96 px tall. Drawing it also drops any script an SVG carried. */
async function logoToPng(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error('Choose an image under 2 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That image couldn\'t be read.'));
      el.src = url;
    });
    const w0 = img.naturalWidth || 300;
    const h0 = img.naturalHeight || 96;
    const scale = Math.min(96 / h0, 480 / w0, 4);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png');
    if (data.length > 300_000) throw new Error('That logo is too detailed to publish. Try a simpler or smaller image.');
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const same = (a, b) => JSON.stringify(normalizeTheme(a).theme) === JSON.stringify(normalizeTheme(b).theme);

/** The Design tab: presets, then direct controls. Every change goes through the theme checks before it's previewed. */
function designPanel(ctx, retheme) {
  let theme = normalizeTheme(ctx.result.theme || DEFAULT_THEME).theme;
  const body = h('div', { class: 'docs-design' });
  const note = h('p', { class: 'hint', style: { margin: '8px 0 0' } });
  const fontNote = h('p', { class: 'hint', style: { margin: '6px 0 0' } });
  const describeFonts = (fonts) => {
    fontNote.textContent = fonts?.missing?.length
      ? `Couldn't download ${fonts.missing.map((m) => `${m.name} (${m.reason})`).join(', ')}. The site uses a system font in its place until it can be downloaded.`
      : 'Web fonts are downloaded from jsDelivr the first time a design uses them, checked against their published checksums, and kept on this device. They\'re published inside the site with their licences, so readers\' browsers load nothing from anywhere else.';
    fontNote.classList.toggle('err-text', !!fonts?.missing?.length);
  };
  const describe = (fixes) => {
    note.textContent = fixes.length
      ? `Adjusted to keep text readable: ${fixes.slice(0, 3).join('; ')}${fixes.length > 3 ? `, and ${fixes.length - 3} more` : ''}.`
      : 'Every text colour meets WCAG AA contrast (4.5:1) in each mode it uses.';
  };
  const set = (next, redraw = false) => {
    const raw = validateTheme(next).theme;
    describe(contrastFailures(raw));
    theme = normalizeTheme(raw).theme;
    retheme(theme).then((fonts) => { if (fonts) describeFonts(fonts); }).catch((e) => toast(errText(e), { error: true }));
    if (redraw) draw();
    else body.querySelectorAll('.docs-preset').forEach((el) => el.classList.toggle('on', same(PRESETS.find((pr) => pr.id === el.dataset.id).theme, theme)));
  };
  const edit = (fn) => { const next = JSON.parse(JSON.stringify(theme)); fn(next); set(next); };

  const select = (value, options, onchange) => h('select', { class: 'select', onchange: (e) => onchange(e.target.value) }, options.map(([v, label, title]) => h('option', { value: String(v), selected: String(v) === String(value), title }, label)));
  const fontOptions = (role) => Object.entries(FONTS).filter(([, f]) => f.roles.includes(role)).map(([id, f]) => [id, f.name, f.voice]);
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  const draw = () => {
    const presets = h('div', { class: 'docs-presets' }, PRESETS.map((pr) => {
      const c = pr.theme.colors[pr.theme.mode === 'dark' ? 'dark' : 'light'];
      return h('button', { class: ['docs-preset', same(pr.theme, theme) && 'on'], 'data-id': pr.id, title: pr.note, onclick: () => set(pr.theme, true) },
        h('span', { class: 'docs-swatches' }, [c.bg, c.accent, c.codeBg].map((x) => h('i', { style: { background: x } }))),
        h('strong', null, pr.name),
        h('span', { class: 'faint' }, pr.note));
    }));
    const layoutHint = h('p', { class: 'hint', style: { margin: '2px 0 0' } }, LAYOUTS[theme.layout]);
    const accent = h('input', { type: 'color', value: theme.colors[theme.mode === 'dark' ? 'dark' : 'light'].accent, onchange: (e) => set(withAccent(theme, e.target.value)) });
    const range = (value, min, max, step, onchange, unit) => {
      const out = h('span', { class: 'faint' }, `${value}${unit}`);
      return h('div', { class: 'row', style: { gap: '8px' } }, h('input', { type: 'range', min, max, step, value, oninput: (e) => { out.textContent = `${e.target.value}${unit}`; }, onchange: (e) => onchange(Number(e.target.value)) }), out);
    };
    body.replaceChildren(
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'Start from a design, then adjust it. The preview updates as you go, and the design is published with the site.'),
      presets,
      h('div', { class: 'form-grid docs-design-grid' },
        h('label', null, 'Layout'), h('div', null, select(theme.layout, Object.keys(LAYOUTS).map((k) => [k, cap(k)]), (v) => { edit((t) => { t.layout = v; }); layoutHint.textContent = LAYOUTS[v]; }), layoutHint),
        h('label', null, 'Light or dark'), select(theme.mode, MODES.map((m) => [m, m === 'auto' ? 'Follow the reader\'s setting' : `Always ${m}`]), (v) => edit((t) => { t.mode = v; })),
        h('label', null, 'Accent'), h('div', null, accent),
        h('label', null, 'Heading font'), select(theme.type.display, fontOptions('display'), (v) => edit((t) => { t.type.display = v; })),
        h('label', null, 'Text font'), select(theme.type.body, fontOptions('body'), (v) => edit((t) => { t.type.body = v; })),
        h('label', null, 'Code font'), select(theme.type.mono, fontOptions('mono'), (v) => edit((t) => { t.type.mono = v; })),
        h('label', null, 'Text size'), range(theme.type.baseSize, 14, 19, 1, (v) => edit((t) => { t.type.baseSize = v; }), ' px'),
        h('label', null, 'Heading contrast'), select(theme.type.scale, [[1.125, 'Subtle'], [1.2, 'Moderate'], [1.25, 'Clear'], [1.333, 'Strong'], [1.414, 'Dramatic']], (v) => edit((t) => { t.type.scale = Number(v); })),
        h('label', null, 'Heading weight'), select(theme.type.headingWeight, [[400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [650, 'Bold'], [700, 'Bolder'], [800, 'Heavy']], (v) => edit((t) => { t.type.headingWeight = Number(v); })),
        h('label', null, 'Corners'), range(theme.shape.radius, 0, 18, 1, (v) => edit((t) => { t.shape.radius = v; }), ' px'),
        h('label', null, 'Spacing'), select(theme.shape.density, DENSITIES.map((d) => [d, cap(d)]), (v) => edit((t) => { t.shape.density = v; })),
        h('label', null, 'Lines'), select(theme.shape.borders, [['hairline', 'Hairline rules'], ['none', 'No rules']], (v) => edit((t) => { t.shape.borders = v; })),
        h('label', null, 'Overview header'), select(theme.header, HEADERS.map((x) => [x, { plain: 'Plain', banded: 'Band in the accent colour', split: 'Introduction beside a first request' }[x]]), (v) => edit((t) => { t.header = v; })),
        h('label', null, 'Menu highlight'), select(theme.nav, NAVS.map((x) => [x, x === 'quiet' ? 'Coloured text' : 'Filled']), (v) => edit((t) => { t.nav = v; }))),
      note,
      fontNote,
      h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } }, h('button', { class: 'btn sm ghost', onclick: () => set(DEFAULT_THEME, true) }, 'Reset to the default')));
  };
  describe(contrastFailures(validateTheme(ctx.result.theme || DEFAULT_THEME).theme));
  describeFonts(ctx.fonts);
  draw();
  return body;
}
