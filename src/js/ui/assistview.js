// AI assistant UI: write tests, explain a response, create a request from a
// description. Answers stream in; nothing is changed until you accept it.

import { h, icon, modal, toast, errText } from './dom.js';
import { codeArea } from './components.js';
import { markdownView } from './docs.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { state } from '../store.js';
import { bridge } from '../bridge.js';
import { getScript, setScript, uuid } from '../model.js';
import { TESTS_SYSTEM, EXPLAIN_SYSTEM, CREATE_SYSTEM, REQUEST_SCHEMA, PROVIDERS, testsPrompt, explainPrompt, createPrompt, extractCode, requestFromAi, chooseModel, providerLabel, parseStructured, retryPrompt } from '../assist.js';

/** Settings: the model the assistant uses, and the providers it can use. */
export function aiSettings() {
  const wrap = h('div', { class: 'ai-settings' });
  let refreshing = new Set();
  const render = async () => {
    let providers = await bridge.aiProviders().catch(() => []);
    // Connected before this version, or the list was never fetched: fetch it once.
    for (const p of providers) {
      if (p.models?.length || refreshing.has(p.id)) continue;
      refreshing.add(p.id);
      bridge.aiRefreshModels(p.id).then(render, (e) => toast(errText(e), { error: true }));
    }
    const choice = chooseModel(state.settings.aiModel, providers);
    const picker = providers.some((p) => p.models?.length)
      ? h('select', { class: 'select', onchange: (e) => { const [provider, ...rest] = e.target.value.split('\n'); state.settings.aiModel = { provider, model: rest.join('\n') }; S.saveSettings(); } },
        providers.filter((p) => p.models?.length).map((p) => h('optgroup', { label: p.local ? `${p.label} · on this machine` : p.label },
          p.models.map((m) => h('option', { value: `${p.id}\n${m.id}`, selected: choice?.provider === p.id && choice?.model === m.id }, [m.name || m.id, m.detail && `  (${m.detail})`].filter(Boolean).join(''))))))
      : h('span', { class: 'faint' }, 'Connect a provider below to choose a model.');
    const rows = PROVIDERS.map((meta) => {
      const p = providers.find((x) => x.id === meta.id);
      const count = p?.models?.length || 0;
      return h('div', { class: 'ai-provider' },
        h('div', { class: 'ai-provider-name' }, h('strong', null, meta.label),
          p ? h('span', { class: 'faint', title: p.fetchedAt ? `Model list fetched ${new Date(p.fetchedAt * 1000).toLocaleString()}` : '' }, p.baseUrl && meta.key !== 'required' ? ` · ${p.baseUrl}` : '') : null),
        h('span', { class: p ? 'chip ok' : 'chip' }, p ? (count ? `${count} model${count === 1 ? '' : 's'}` : 'Connected') : 'Not connected'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => connectDialog(meta, p, render) }, p ? 'Change…' : 'Connect…'),
          p ? h('button', { class: 'btn ghost sm', onclick: async (e) => {
            e.target.disabled = true;
            try { const s = await bridge.aiRefreshModels(meta.id); toast(`${meta.label}: ${s.models.length} model${s.models.length === 1 ? '' : 's'}`); } catch (err) { toast(errText(err), { error: true }); }
            render();
          } }, 'Refresh models') : null,
          p ? h('button', { class: 'btn ghost sm', onclick: async () => { await bridge.aiDisconnect(meta.id); toast(`${meta.label} disconnected`); render(); } }, 'Disconnect') : null));
    });
    wrap.replaceChildren(
      h('div', { class: 'form-grid' }, h('label', null, 'Model'), picker),
      h('div', { class: 'ai-providers' }, rows));
  };
  render();
  return wrap;
}

function connectDialog(meta, current, done) {
  const key = meta.key === 'none' ? null : h('input', { class: 'input mono', type: 'password', placeholder: current?.hasKey ? (meta.base !== undefined ? 'Leave empty to keep the saved key (same address only)' : 'Leave empty to keep the saved key') : (meta.keyHint || (meta.key === 'optional' ? 'Optional' : 'API key')), autocomplete: 'off', spellcheck: 'false' });
  const base = 'base' in meta ? h('input', { class: 'input mono', value: current?.baseUrl || meta.base, placeholder: meta.basePlaceholder || meta.base, spellcheck: 'false' }) : null;
  const err = h('p', { class: 'hint', style: { color: 'var(--err)', minHeight: '16px' } });
  const keyLink = meta.keyUrl ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); bridge.openUrl?.(meta.keyUrl).catch(() => {}); } }, 'Get a key') : null;
  modal({
    title: `Connect ${meta.label}`,
    body: h('div', null,
      h('p', { class: 'hint', style: { marginTop: 0 } }, meta.blurb || `Uses your own ${meta.label} key. `, keyLink, keyLink ? '.' : null,
        meta.key !== 'none' ? ' The key is stored like your other secrets (Keychain on macOS, a private file elsewhere) and only used for requests you start.' : ''),
      h('div', { class: 'form-grid' },
        base ? h('label', null, 'Address') : null, base,
        key ? h('label', null, meta.key === 'optional' ? 'API key (optional)' : 'API key') : null, key),
      h('p', { class: 'hint' }, 'Dispatch checks the connection by fetching the list of models, so you can pick one afterwards.'),
      err),
    actions: [{ label: 'Cancel' }, { label: current ? 'Save' : 'Connect', primary: true, onClick: async () => {
      err.textContent = 'Fetching models…';
      try {
        const s = await bridge.aiConnect(meta.id, key?.value.trim() || null, base?.value.trim() || null);
        // First provider, or this provider's chosen model is gone: start on its first model.
        const cur = state.settings.aiModel;
        const stale = cur?.provider === meta.id && !s.models.some((m) => m.id === cur.model);
        if ((!cur?.provider || stale) && s.models[0]) { state.settings.aiModel = { provider: meta.id, model: s.models[0].id }; S.saveSettings(); }
        toast(`${meta.label} connected: ${s.models.length} model${s.models.length === 1 ? '' : 's'}`);
        done?.();
        return true;
      } catch (e) { err.textContent = errText(e); return false; }
    } }],
  });
}

/** Settings shown in a dialog, for when an AI feature is used before setup. */
function setupDialog() {
  modal({ title: 'Set up the AI assistant', wide: true, body: h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Connect a provider and pick a model. You can change both later in Settings → AI assistant.'), aiSettings()), actions: [{ label: 'Done', primary: true }] });
}

const consented = (id) => state.settings.aiConsent === true ? id === 'anthropic' : !!state.settings.aiConsent?.[id];

/** The provider and model to use, once set up and agreed to; null to stop. */
async function ready() {
  let providers = await bridge.aiProviders().catch(() => []);
  for (const p of providers) if (!p.models?.length) { try { Object.assign(p, await bridge.aiRefreshModels(p.id)); } catch { /* shown in Settings */ } }
  const choice = chooseModel(state.settings.aiModel, providers);
  if (!choice) { setupDialog(); return null; }
  if (state.settings.aiModel?.provider !== choice.provider || state.settings.aiModel?.model !== choice.model) { state.settings.aiModel = choice; S.saveSettings(); }
  const p = providers.find((x) => x.id === choice.provider);
  if (p.local || consented(p.id)) return choice;
  return new Promise((resolve) => {
    modal({
      title: 'Before the assistant runs',
      body: h('div', null, h('p', null, `Requests you ask about are sent to ${p.label} (${p.baseUrl}): method, URL and headers as written ({{variables}} are not filled in, and credential headers are redacted), the body, and for responses the status, headers and up to 30 KB of body.`),
        h('p', { class: 'hint' }, 'Avoid it for responses that contain data you\'re not allowed to share, or use a model that runs on this machine.')),
      onClose: () => resolve(null),
      actions: [{ label: 'Cancel', onClick: () => { resolve(null); } }, { label: 'Continue', primary: true, onClick: () => {
        const prev = state.settings.aiConsent === true ? { anthropic: true } : state.settings.aiConsent || {};
        state.settings.aiConsent = { ...prev, [p.id]: true };
        S.saveSettings();
        resolve(choice);
      } }],
    });
  });
}

/**
 * Streams an answer into a modal; `finish(text, el, close, value)` renders the
 * result and returns modal actions. With a schema, the answer is checked and
 * asked for once more if it doesn't fit; `value` is the parsed object.
 */
function askModal({ title, choice, request, finish }) {
  const live = h('pre', { class: 'ai-live' });
  const out = h('div', { class: 'ai-out' }, h('div', { class: 'loading-bar' }), live);
  let id = `ai-${uuid()}`;
  const foot = h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => bridge.stopRequest?.(id) }, icon('stop'), 'Stop'));
  const close = modal({ title, wide: true, body: h('div', null, out, foot), onClose: () => bridge.stopRequest?.(id).catch(() => {}) });
  const fail = (e) => {
    out.replaceChildren(h('div', { class: 'note err' }, icon('alert'), h('span', null, errText(e))));
    foot.replaceChildren(h('button', { class: 'btn', onclick: close }, 'Close'));
  };
  const run = (req, tries) => bridge.aiAsk({ ...req, provider: choice.provider, model: choice.model }, id, (ev) => { if (ev.type === 'text') { live.textContent += ev.text; live.scrollTop = live.scrollHeight; } })
    .then((answer) => {
      let value;
      if (req.schema) {
        try { value = parseStructured(answer.text, req.schema); } catch (e) {
          if (tries > 0) return fail(`${e.message} Try again, or pick a larger model in Settings → AI assistant.`);
          live.textContent = '';
          id = `ai-${uuid()}`;
          return run({ ...req, prompt: retryPrompt(request.prompt, e.message) }, tries + 1);
        }
      }
      const actions = finish(answer.text, out, close, value) || [];
      foot.replaceChildren(h('span', { class: 'faint', style: { fontSize: '11.5px', marginRight: 'auto' } }, `${providerLabel(choice.provider)} · ${answer.model} · ${answer.inputTokens + answer.outputTokens} tokens`), ...actions);
    }, fail);
  run(request, 0);
}

export async function writeTests(t) {
  const res = t.response?.response;
  if (!res) return toast('Send the request first, so the tests can be based on a real response.', { error: true });
  const choice = await ready();
  if (!choice) return;
  askModal({
    choice,
    title: `Tests for "${t.draft.name}"`,
    request: { system: TESTS_SYSTEM, prompt: testsPrompt(t.draft, res) },
    finish: (text, out, close) => {
      const code = extractCode(text);
      const ta = codeArea({ value: code, lang: 'javascript', minHeight: 240 });
      out.replaceChildren(h('p', { class: 'hint', style: { marginTop: 0 } }, 'Review and edit, then add it to the post-response script. Send again to run the tests.'), h('div', { class: 'code-wrap' }, ta.el));
      return [
        h('button', { class: 'btn', onclick: close }, 'Discard'),
        h('button', { class: 'btn primary', onclick: () => {
          const cur = getScript(t.draft, 'test');
          setScript(t.draft, 'test', cur ? `${cur.replace(/\s*$/, '')}\n\n${ta.value.trim()}\n` : `${ta.value.trim()}\n`);
          C.markDirty(t);
          t.sub = 'scripts';
          t.scriptTab = 'test';
          close();
          C.emitAll();
          toast('Added to the post-response script');
        } }, icon('check'), 'Add to script'),
      ];
    },
  });
}

export async function explainResponse(t) {
  const r = t.response;
  if (!r) return toast('Send the request first.', { error: true });
  const choice = await ready();
  if (!choice) return;
  askModal({
    choice,
    title: `Explain "${t.draft.name}"`,
    request: { system: EXPLAIN_SYSTEM, prompt: explainPrompt(t.draft, r.response, r.error) },
    finish: (text, out, close) => { out.replaceChildren(markdownView(text)); return [h('button', { class: 'btn', onclick: close }, 'Close')]; },
  });
}

export async function createRequestDialog() {
  const choice = await ready();
  if (!choice) return;
  const ta = h('textarea', { class: 'textarea', rows: 4, placeholder: 'e.g. Create a Stripe customer with an email and name, using my secret key' });
  modal({
    title: 'New request from a description',
    body: h('div', null, ta, h('p', { class: 'hint' }, 'The assistant drafts the method, URL, headers and body; you review it in a new tab before sending.')),
    actions: [{ label: 'Cancel' }, { label: 'Draft request', primary: true, onClick: () => {
      if (!ta.value.trim()) return false;
      const t = C.activeTab();
      const names = (t ? C.resolverFor(t) : C.resolverFor({ ref: null })).names().filter((n) => n.scope !== 'dynamic').map((n) => n.name);
      askModal({
        choice,
        title: 'Drafting request…',
        request: { system: CREATE_SYSTEM, prompt: createPrompt(ta.value, names), schema: REQUEST_SCHEMA },
        finish: (text, out, close, value) => {
          let item;
          try { item = requestFromAi(value ?? text); } catch (e) { out.replaceChildren(h('div', { class: 'note err' }, icon('alert'), h('span', null, `Couldn't read the answer: ${errText(e)}`))); return [h('button', { class: 'btn', onclick: close }, 'Close')]; }
          close();
          C.openDraft(item);
          toast('Drafted — review it, then Send or Save');
          return [];
        },
      });
      return true;
    } }],
  });
}
