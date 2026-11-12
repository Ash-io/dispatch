// Collects the evidence for documentation from a collection: requests, saved
// examples, optional local history, tests and request chains. Everything that
// can carry data goes through the scrubber before anything else sees it.

import { isFolder, urlObject, effectiveAuth, getScript } from '../model.js';
import { analyzeChain } from '../chain.js';

export const descriptionText = (d) => (typeof d === 'string' ? d : d?.content || '');

export function slugify(text, taken = new Set()) {
  const base = String(text || 'section').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'section';
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  taken.add(slug);
  return slug;
}

/** `{{baseUrl}}/v1/orders/:id?x=1` → { hostVar: 'baseUrl', host: '', path: '/v1/orders/:id' } */
export function splitUrl(raw = '') {
  const noQuery = raw.split('?')[0].split('#')[0];
  let m = /^\{\{([^}]+)\}\}(.*)$/.exec(noQuery);
  if (m) return { hostVar: m[1], host: '', path: m[2] || '/' };
  m = /^(https?:\/\/[^/]+)(.*)$/i.exec(noQuery);
  if (m) return { hostVar: null, host: m[1], path: m[2] || '/' };
  return { hostVar: null, host: '', path: noQuery.startsWith('/') ? noQuery : `/${noQuery}` };
}

/** Test names and status expectations from a post-response script. */
export function testsFrom(code = '') {
  const tests = [];
  for (const m of code.matchAll(/pm\.test\(\s*(['"`])((?:(?!\1).)+)\1/g)) tests.push(m[2]);
  const statuses = [...code.matchAll(/to\.have\.status\(\s*(\d{3})\s*\)|response\.code\)\.to\.(?:equal|eql)\(\s*(\d{3})\s*\)/g)].map((m) => Number(m[1] || m[2]));
  return { tests, statuses: [...new Set(statuses)] };
}

/**
 * Walks the collection and returns one entry per request, scrubbed.
 * `history` is the app's history list; only entries whose ref points into this
 * collection are used, and only when `useHistory` is on.
 */
export function gatherEndpoints(collection, { scrub, history = [], useHistory = false, collectionUid = null } = {}) {
  const endpoints = [];
  const walk = (items, parents, folders) => {
    for (const it of items || []) {
      if (isFolder(it)) { walk(it.item, [...parents, it], [...folders, { id: it.id, name: it.name, description: descriptionText(it.description) }]); continue; }
      if (!it.request) continue;
      const req = it.request;
      const u = urlObject(req.url);
      const where = it.name || 'request';
      const raw = scrub.text(u.raw || '', where);
      const { auth } = effectiveAuth(req, parents, collection);
      const body = req.body || {};
      const examples = (it.response || []).map((ex) => ({
        name: ex.name || '',
        code: Number(ex.code) || null,
        status: ex.status || '',
        headers: scrub.headers((ex.header || []).filter((x) => x.key), `${where} → ${ex.name}`),
        body: scrub.body(typeof ex.body === 'string' ? ex.body : '', `${where} → ${ex.name}`),
        requestBody: ex.originalRequest?.body?.mode === 'raw' ? scrub.body(ex.originalRequest.body.raw || '', `${where} → ${ex.name}`) : null,
      }));
      const seen = useHistory
        ? history.filter((h) => h.ref?.item === it.id && (!collectionUid || h.ref?.col === collectionUid) && h.status && typeof h.bodyText === 'string')
          .slice(0, 20).map((h) => ({ code: h.status, body: scrub.body(h.bodyText, `${where} (history)`) }))
        : [];
      const tests = testsFrom(getScript(it, 'test'));
      endpoints.push({
        id: it.id,
        name: it.name || 'Untitled request',
        folders,
        method: (req.method || 'GET').toUpperCase(),
        url: raw,
        ...splitUrl(raw),
        description: descriptionText(req.description) || descriptionText(it.description),
        query: (u.query || []).filter((q) => q.key && !q.disabled).map((q) => ({ key: q.key, value: scrub.text(String(q.value ?? ''), where), description: descriptionText(q.description) })),
        pathVars: (u.variable || []).filter((v) => v.key).map((v) => ({ key: v.key, value: scrub.text(String(v.value ?? ''), where), description: descriptionText(v.description) })),
        headers: scrub.headers((req.header || []).filter((h) => h.key && !h.disabled).map((h) => ({ key: h.key, value: String(h.value ?? ''), description: descriptionText(h.description) })), where),
        auth: auth ? { type: auth.type, ...(auth.type === 'apikey' ? apiKeyPlacement(auth) : {}) } : null,
        authObject: auth,
        body: {
          mode: body.mode || 'none',
          language: body.options?.raw?.language || null,
          raw: body.mode === 'raw' ? scrub.body(body.raw || '', where) : null,
          fields: ['urlencoded', 'formdata'].includes(body.mode) ? (body[body.mode] || []).filter((f) => f.key && !f.disabled).map((f) => ({ key: f.key, type: f.type || 'text', value: f.type === 'file' ? '' : scrub.text(String(f.value ?? ''), where), description: descriptionText(f.description) })) : [],
          graphql: body.mode === 'graphql' ? { query: body.graphql?.query || '', variables: scrub.body(body.graphql?.variables || '', where) } : null,
        },
        examples,
        history: seen,
        tests,
      });
    }
  };
  walk(collection?.item, [collection], []);
  return endpoints;
}

function apiKeyPlacement(auth) {
  const get = (k) => (Array.isArray(auth.apikey) ? auth.apikey.find((x) => x.key === k)?.value : auth.apikey?.[k]);
  return { in: get('in') || 'header', name: get('key') || 'X-API-Key' };
}

/** Which requests set variables that later requests need: the basis of the quickstart. */
export function chainSteps(collection) {
  let chain;
  try { chain = analyzeChain(collection); } catch { return []; }
  const steps = chain.steps || [];
  const out = [];
  steps.forEach((st, i) => {
    const feeds = st.sets.filter((s) => steps.some((later, j) => j > i && later.uses?.some((u) => u.name === s.name && u.from === i)));
    if (feeds.length) {
      const users = steps.map((later, j) => ({ later, j })).filter(({ later, j }) => j > i && later.uses?.some((u) => feeds.some((f) => f.name === u.name) && u.from === i));
      out.push({ id: st.id, sets: feeds.map((f) => f.name), usedBy: users.map(({ later }) => later.id) });
    }
  });
  return out;
}
