// Turns gathered evidence into facts: plain statements, each with an id and
// its sources, that pages are built from and that every AI-written sentence
// must cite. No AI here.

import { slugify } from './gather.js';

const FORMATS = [
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i],
  ['date-time', /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/],
  ['date', /^\d{4}-\d{2}-\d{2}$/],
  ['email', /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i],
  ['uri', /^https?:\/\/\S+$/i],
];
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/**
 * Merges JSON samples into one shape: path → { types, present, nullable,
 * values, formats }. Paths use dots for keys and [] for array items.
 */
export function mergeShape(samples) {
  const fields = new Map();
  const total = samples.length;
  const visit = (v, path, counted) => {
    if (path) {
      if (!fields.has(path)) fields.set(path, { path, types: new Set(), present: 0, nulls: 0, values: new Set(), formats: new Set(), seen: 0 });
      const f = fields.get(path);
      f.seen += 1;
      if (!counted.has(path)) { f.present += 1; counted.add(path); }
      const t = typeOf(v);
      if (t === 'null') f.nulls += 1; else f.types.add(t === 'integer' ? 'integer' : t);
      if (['string', 'integer', 'number', 'boolean'].includes(t) && String(v).length <= 40 && f.values.size <= 6) f.values.add(v);
      if (t === 'string') for (const [name, re] of FORMATS) if (re.test(v)) { f.formats.add(name); break; }
    }
    if (Array.isArray(v)) v.forEach((x) => visit(x, `${path}[]`, counted));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k, counted);
  };
  for (const s of samples) visit(s, '', new Set());
  return [...fields.values()].map((f) => {
    const types = [...f.types];
    // A field that is sometimes integer and sometimes number is a number.
    const merged = types.includes('number') ? types.filter((t) => t !== 'integer') : types;
    const values = [...f.values];
    const enumish = values.length > 0 && values.length <= 5 && merged.length === 1 && merged[0] === 'string' && f.seen >= 2 && f.formats.size === 0;
    return {
      path: f.path,
      types: merged.length ? merged : ['null'],
      nullable: f.nulls > 0,
      present: f.present,
      total,
      formats: [...f.formats],
      values: enumish || merged[0] === 'boolean' ? values : [],
      example: values[0] ?? null,
    };
  });
}

const parse = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; } };

const describeField = (f) => {
  const type = f.types.join(' or ') + (f.nullable ? ', can be null' : '') + (f.formats.length ? `, ${f.formats.join('/')}` : '');
  const seen = f.total > 1 ? `; in ${f.present} of ${f.total} responses` : '';
  const vals = f.values.length ? `; values seen: ${f.values.join(', ')}` : f.example !== null && f.example !== '' ? `; example: ${f.example}` : '';
  return `\`${f.path}\` (${type})${seen}${vals}`;
};

function groupFor(ep) {
  if (ep.folders.length) return ep.folders[0].name;
  const seg = ep.path.split('/').filter((s) => s && !/^v\d+$/i.test(s) && !s.startsWith(':') && !s.startsWith('{'))[0];
  return seg ? seg.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'General';
}

/** `/v1/orders/:id` → `/v1/orders/{id}`, and `{{orderId}}` → `{orderId}`. */
export const displayPath = (p) => p.replace(/\/:([A-Za-z_][\w-]*)/g, '/{$1}').replace(/\{\{([^}]+)\}\}/g, '{$1}');

/**
 * Builds the fact sheet. Returns { facts: Map(id → fact), groups, endpoints,
 * errors, quickstart, auth }. A fact is { id, text, sources }.
 */
export function buildFacts(endpoints, { quickstart = [], verified = {} } = {}) {
  const facts = new Map();
  const add = (id, text, sources = []) => { facts.set(id, { id, text, sources }); return id; };
  const groupsByName = new Map();
  const slugs = new Set();
  const epSlugs = new Set();
  const out = [];

  for (const ep of endpoints) {
    const key = slugify(`${ep.method}-${ep.name}`, epSlugs);
    const group = groupFor(ep);
    if (!groupsByName.has(group)) {
      const folder = ep.folders[0];
      groupsByName.set(group, { name: group, slug: slugify(group, slugs), description: folder?.description || '', endpoints: [] });
    }
    groupsByName.get(group).endpoints.push(key);
    const p = `ep.${key}`;
    const route = `${ep.method} ${displayPath(ep.path)}`;
    const f = { route: add(`${p}.route`, `${route}: "${ep.name}"`, ['request']) };
    if (ep.description) f.desc = add(`${p}.desc`, ep.description.slice(0, 2000), ['description']);
    if (ep.auth && ep.auth.type !== 'noauth') f.auth = add(`${p}.auth`, `authentication: ${ep.auth.type}${ep.auth.name ? ` (${ep.auth.in} "${ep.auth.name}")` : ''}`, ['request']);
    const params = [];
    for (const v of ep.pathVars) params.push({ in: 'path', name: v.key, example: v.value, description: v.description });
    for (const name of [...ep.path.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1])) if (!params.some((x) => x.name === name)) params.push({ in: 'path', name, example: '', description: '' });
    for (const q of ep.query) params.push({ in: 'query', name: q.key, example: q.value, description: q.description });
    for (const h of ep.headers) if (!/^(content-type|accept|user-agent)$/i.test(h.key)) params.push({ in: 'header', name: h.key, example: h.value, description: h.description });
    for (const x of params) x.fact = add(`${p}.param.${x.in}.${x.name}`, `${x.in} parameter \`${x.name}\`${x.example && !/^\{\{.*\}\}$/.test(x.example) ? `, example ${x.example}` : ''}`, ['request']);

    // Request body fields.
    let requestFields = [];
    const reqSamples = [ep.body.raw, ...ep.examples.map((e) => e.requestBody)].map((t) => parse(stripVars(t || ''))).filter(Boolean);
    if (reqSamples.length) {
      requestFields = mergeShape(reqSamples).map((x) => ({ ...x, fact: add(`${p}.body.${x.path}`, `request body field ${describeField(x)}`, ['request body']) }));
    }
    for (const fld of ep.body.fields) requestFields.push({ path: fld.key, types: [fld.type === 'file' ? 'file' : 'string'], formats: [], values: [], present: 1, total: 1, nullable: false, example: fld.value, description: fld.description, fact: add(`${p}.body.${fld.key}`, `form field \`${fld.key}\` (${fld.type})`, ['request body']) });

    // Responses by status.
    const byCode = new Map();
    const note = (code, body, source) => {
      if (!code) return;
      if (!byCode.has(code)) byCode.set(code, { code, samples: [], sources: new Set(), examples: [] });
      const r = byCode.get(code);
      r.sources.add(source);
      const v = parse(body || '');
      if (v) r.samples.push(v);
    };
    for (const ex of ep.examples) { note(ex.code, ex.body, `example "${ex.name}"`); if (ex.code) byCode.get(ex.code).examples.push(ex); }
    for (const h of ep.history) note(h.code, h.body, 'history');
    for (const code of ep.tests.statuses) { if (!byCode.has(code)) byCode.set(code, { code, samples: [], sources: new Set(), examples: [] }); byCode.get(code).sources.add('test'); }
    const responses = [...byCode.values()].sort((a, b) => a.code - b.code).map((r) => {
      const fact = add(`${p}.status.${r.code}`, `returns ${r.code} (seen in ${[...r.sources].join(', ')})`, [...r.sources]);
      const fields = mergeShape(r.samples).map((x) => ({ ...x, fact: add(`${p}.resp.${r.code}.${x.path}`, `response ${r.code} field ${describeField(x)}`, [...r.sources]) }));
      return { code: r.code, fact, fields, sampleCount: r.samples.length, example: r.examples[0] || null, historyExample: r.examples[0] ? null : ep.history.find((h) => h.code === r.code) || null };
    });
    const tests = ep.tests.tests.map((name, i) => ({ name, fact: add(`${p}.test.${i}`, `checked by the test "${name}"`, ['test']) }));
    const v = verified[ep.id];
    if (v) add(`${p}.verified`, `ran against ${v.env} on ${v.date}: ${v.ok ? 'passed' : 'failed'}`, ['run']);

    out.push({ key, id: ep.id, name: ep.name, group, method: ep.method, path: ep.path, displayPath: displayPath(ep.path), hostVar: ep.hostVar, host: ep.host, url: ep.url, description: ep.description, auth: ep.auth, authObject: ep.authObject, headers: ep.headers, query: ep.query, pathVars: ep.pathVars, body: ep.body, params, requestFields, responses, tests, facts: f, verified: v || null });
  }

  // Quickstart from request chains: the calls a real integration makes first.
  const qs = [];
  for (const step of quickstart.slice(0, 6)) {
    const ep = out.find((e) => e.id === step.id);
    if (!ep) continue;
    const users = step.usedBy.map((id) => out.find((e) => e.id === id)).filter(Boolean);
    const fact = add(`qs.${qs.length}`, `${ep.method} ${ep.displayPath} ("${ep.name}") sets ${step.sets.map((s) => `\`${s}\``).join(', ')}, used by ${users.slice(0, 4).map((u) => `"${u.name}"`).join(', ')}`, ['chain']);
    qs.push({ endpoint: ep.key, sets: step.sets, usedBy: users.map((u) => u.key), fact });
  }

  // Errors across the API.
  const errMap = new Map();
  for (const ep of out) for (const r of ep.responses) if (r.code >= 400) {
    if (!errMap.has(r.code)) errMap.set(r.code, { code: r.code, endpoints: [], fields: new Map(), messages: new Set() });
    const e = errMap.get(r.code);
    e.endpoints.push(ep.key);
    for (const fld of r.fields) { e.fields.set(fld.path, fld); if (/message|error|detail|title/i.test(fld.path) && typeof fld.example === 'string') e.messages.add(fld.example); }
  }
  const errors = [...errMap.values()].sort((a, b) => a.code - b.code).map((e) => ({
    code: e.code,
    endpoints: e.endpoints,
    fields: [...e.fields.keys()],
    fact: add(`err.${e.code}`, `${e.code} returned by ${e.endpoints.length} request${e.endpoints.length === 1 ? '' : 's'}; body fields: ${[...e.fields.keys()].map((k) => `\`${k}\``).join(', ') || 'none seen'}${e.messages.size ? `; messages seen: ${[...e.messages].slice(0, 3).map((m) => `"${m}"`).join(', ')}` : ''}`, ['examples', 'history']),
  }));

  const authTypes = [...new Set(out.map((e) => e.auth?.type).filter((t) => t && t !== 'noauth'))];
  const groups = [...groupsByName.values()].map((g) => ({ ...g, fact: add(`group.${g.slug}`, `${g.name}: ${g.endpoints.length} request${g.endpoints.length === 1 ? '' : 's'}: ${g.endpoints.map((k) => { const e = out.find((x) => x.key === k); return `${e.method} ${e.displayPath}`; }).join('; ')}`, ['collection']) }));
  return { facts, groups, endpoints: out, errors, quickstart: qs, authTypes };
}

/** `{"id": {{orderId}}}` isn't JSON; fill placeholders so the shape can still be read. */
function stripVars(text) {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/"\{\{[^}]+\}\}"/g, '"x"').replace(/\{\{[^}]+\}\}/g, '0');
}

/** The structural part of a fact sheet, kept with each version for the changelog. */
export function structure(sheet) {
  return {
    endpoints: sheet.endpoints.map((e) => ({
      route: `${e.method} ${e.displayPath}`,
      name: e.name,
      statuses: e.responses.map((r) => r.code),
      fields: Object.fromEntries(e.responses.map((r) => [r.code, Object.fromEntries(r.fields.map((f) => [f.path, f.types.join('|') + (f.nullable ? '|null' : '')]))])),
      body: Object.fromEntries(e.requestFields.map((f) => [f.path, f.types.join('|')])),
    })),
  };
}

/** Differences between two structures, as plain sentences. Deterministic. */
export function diffStructure(before, after) {
  if (!before?.endpoints) return [];
  const lines = [];
  const prev = new Map(before.endpoints.map((e) => [e.route, e]));
  const next = new Map(after.endpoints.map((e) => [e.route, e]));
  for (const [route, e] of next) if (!prev.has(route)) lines.push(`Added \`${route}\` (${e.name}).`);
  for (const [route, e] of prev) if (!next.has(route)) lines.push(`Removed \`${route}\` (${e.name}).`);
  for (const [route, e] of next) {
    const old = prev.get(route);
    if (!old) continue;
    for (const s of e.statuses) if (!old.statuses.includes(s)) lines.push(`\`${route}\` can now return ${s}.`);
    for (const s of old.statuses) if (!e.statuses.includes(s)) lines.push(`\`${route}\` no longer documents ${s}.`);
    for (const [code, fields] of Object.entries(e.fields)) {
      const was = old.fields[code] || {};
      if (!old.fields[code]) continue;
      for (const [path, t] of Object.entries(fields)) {
        if (!(path in was)) lines.push(`\`${route}\` ${code}: added \`${path}\` (${t.replace(/\|/g, ' or ')}).`);
        else if (was[path] !== t) lines.push(`\`${route}\` ${code}: \`${path}\` changed from ${was[path].replace(/\|/g, ' or ')} to ${t.replace(/\|/g, ' or ')}.`);
      }
      for (const path of Object.keys(was)) if (!(path in fields)) lines.push(`\`${route}\` ${code}: removed \`${path}\`.`);
    }
    for (const [path, t] of Object.entries(e.body)) if (!(path in old.body)) lines.push(`\`${route}\` request body: added \`${path}\` (${t.replace(/\|/g, ' or ')}).`);
    for (const path of Object.keys(old.body)) if (!(path in e.body)) lines.push(`\`${route}\` request body: removed \`${path}\`.`);
  }
  return lines;
}
