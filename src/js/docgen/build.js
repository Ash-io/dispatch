// Builds the published site from a fact sheet and the written texts: HTML
// pages, OpenAPI 3.1, llms.txt, Markdown copies and a search index. Pages
// carry no inline script or style, so the server's strict CSP holds.

import { buildOutgoing } from '../send.js';
import { generate } from '../codegen.js';
import { structure } from './facts.js';
import { SITE_CSS, SITE_JS } from './assets.js';
import { normalizeTheme, themeCss, bodyClasses, withAccent, isHex, DEFAULT_THEME, fontFaceCss, fontLicenses } from './theme.js';

export const OMIT = '__omit__';
/** Publish without a description: the row stays, the text is empty. */
export const BLANK = '__blank__';
const SAMPLE_LANGS = [['curl', 'cURL'], ['python', 'Python'], ['fetch', 'JavaScript'], ['go', 'Go']];
const REASONS = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/** A small, safe Markdown subset for descriptions people wrote: everything is escaped first. */
export function markdown(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const span = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}" rel="noopener">${t}</a>`);
  return blocks.map((b) => {
    if (/^```/.test(b)) return `<pre><code>${esc(b.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''))}</code></pre>`;
    const h = /^(#{1,6})\s+(.*)$/.exec(b);
    if (h && !b.includes('\n')) return `<h4>${span(h[2])}</h4>`;
    if (/^([-*]|\d+\.)\s/.test(b)) {
      const ordered = /^\d+\./.test(b);
      const items = b.split('\n').map((l) => l.replace(/^\s*([-*]|\d+\.)\s+/, '')).map((l) => `<li>${span(l)}</li>`).join('');
      return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
    }
    return `<p>${span(b).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

const mdInline = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Resolves {{variables}} for samples: the host variable becomes the public base URL, the rest `{name}`. */
function placeholderResolver(hostVar, baseUrl) {
  return {
    replace: (s) => String(s ?? '').replace(/\{\{([^}]+)\}\}/g, (m, name) => (name === hostVar && baseUrl ? baseUrl.replace(/\/+$/, '') : `{${name.replace(/^vault:/, '')}}`)),
  };
}

export function codeSamples(ep, baseUrl) {
  const req = {
    method: ep.method,
    url: { raw: ep.url, variable: ep.pathVars.map((v) => ({ key: v.key, value: `{{${v.key}}}` })) },
    header: ep.headers.map((h) => ({ key: h.key, value: h.value })),
    body: ep.body.mode === 'raw' ? { mode: 'raw', raw: ep.body.raw || '', options: { raw: { language: ep.body.language || 'json' } } }
      : ep.body.mode === 'urlencoded' || ep.body.mode === 'formdata' ? { mode: ep.body.mode, [ep.body.mode]: ep.body.fields.map((f) => ({ key: f.key, value: f.value || `{${f.key}}`, type: f.type === 'file' ? 'text' : f.type })) }
        : ep.body.mode === 'graphql' ? { mode: 'graphql', graphql: ep.body.graphql } : undefined,
  };
  let outgoing;
  try { outgoing = buildOutgoing(req, ep.authObject, placeholderResolver(ep.hostVar, baseUrl), {}); } catch { return []; }
  // Path variables written as :id stay readable as {id}.
  outgoing.url = String(outgoing.url).replace(/%7B([^%]+)%7D/g, '{$1}');
  return SAMPLE_LANGS.map(([lang, name]) => {
    try { return { lang, name, code: generate(lang, outgoing) }; } catch { return null; }
  }).filter(Boolean);
}

const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

/** Escaped HTML for a code block, with JSON coloured by token. Anything that isn't JSON is only escaped. */
export function highlightJson(text) {
  try { JSON.parse(text); } catch { return esc(text); }
  let out = '';
  let last = 0;
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;
  for (let m; (m = re.exec(text));) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="sx-k">${esc(m[1])}</span><span class="sx-p">${esc(m[2])}</span>` : `<span class="sx-s">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="sx-n">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="sx-l">${m[4]}</span>`;
    else out += `<span class="sx-p">${esc(m[5])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}

const LOGO = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/** Nested JSON Schema from merged field paths (a.b, items[].id). */
export function schemaFrom(fields) {
  const root = { type: fields.some((f) => f.path.startsWith('[]')) ? 'array' : 'object' };
  const typeOf = (f) => {
    const t = f.types.filter((x) => x !== 'null');
    const one = t.length === 1 ? t[0] : t.length ? t : 'string';
    return f.nullable ? [].concat(one, 'null') : one;
  };
  for (const f of fields) {
    const parts = f.path.replace(/\[\]/g, '.[]').split('.').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      if (part === '[]') {
        node.type = node.type || 'array';
        node.items = node.items || {};
        node = node.items;
      } else {
        node.type = node.type || 'object';
        node.properties = node.properties || {};
        node.properties[part] = node.properties[part] || {};
        node = node.properties[part];
      }
      if (last) {
        node.type = typeOf(f);
        if (f.formats?.length === 1) node.format = f.formats[0];
        if (f.values?.length && f.types[0] === 'string') node.enum = f.values;
        if (f.description) node.description = f.description;
      }
    });
  }
  return root;
}

function authSentence(sheet, baseUrl) {
  const lines = [];
  const eps = sheet.endpoints;
  for (const type of sheet.authTypes) {
    const ep = eps.find((e) => e.auth?.type === type);
    if (type === 'bearer') lines.push('Send a token in the <code>Authorization</code> header: <code>Authorization: Bearer {token}</code>.');
    else if (type === 'apikey') lines.push(`Send your API key in the <code>${esc(ep.auth.name)}</code> ${ep.auth.in === 'query' ? 'query parameter' : 'header'}.`);
    else if (type === 'basic') lines.push('Use HTTP Basic authentication: a username and password in the <code>Authorization</code> header.');
    else if (type === 'oauth2') lines.push('Send an OAuth 2.0 access token in the <code>Authorization</code> header.');
    else lines.push(`Some requests use ${esc(type)} authentication.`);
  }
  const open = eps.filter((e) => !e.auth || e.auth.type === 'noauth').length;
  if (open && sheet.authTypes.length) lines.push(`${open} request${open === 1 ? ' needs' : 's need'} no authentication.`);
  return lines;
}

/**
 * Builds every file. `texts` maps targets to { text, ai }. Options:
 *   site: { name, logoDataUrl (a PNG data URL) }, theme (see theme.js),
 *   fonts: { data: { "id:weight": base64 woff2 }, licenses: { id: text } }, baseUrl,
 *   version, generatedAt (ISO),
 *   changelog: [lines for this version], history: [{ version, published_at, changelog }],
 *   preview: true marks AI text and gaps for the review screen.
 */
export function buildSite(sheet, texts, opts = {}) {
  const site = { name: 'API documentation', ...(opts.site || {}) };
  // Sites set up before themes only had an accent colour.
  const theme = normalizeTheme(opts.theme || (isHex(site.accent) ? withAccent(DEFAULT_THEME, site.accent) : DEFAULT_THEME)).theme;
  const logo = LOGO.test(site.logoDataUrl || '') ? site.logoDataUrl : '';
  // Web fonts travel inside the site; a family that wasn't downloaded falls back to its system stack.
  const faces = fontFaceCss(theme, opts.fonts?.data || {});
  const MAX_FONT_CSS = 1000 * 1024;
  if (faces.length > MAX_FONT_CSS) throw new Error('The chosen fonts are too large to publish together. Choose fewer families.');
  const baseUrl = (opts.baseUrl || '').trim().replace(/\/+$/, '');
  const preview = !!opts.preview;
  const date = (opts.generatedAt || new Date().toISOString()).slice(0, 10);
  const files = [];
  const search = [];
  const md = { index: [] };
  const put = (path, content_type, body) => files.push({ path, content_type, body });

  const textOf = (target) => {
    const t = texts[target];
    if (!t || t.text === OMIT || t.text === BLANK) return null;
    return t;
  };
  const omitted = (target) => texts[target]?.text === OMIT;
  const blank = (target) => texts[target]?.text === BLANK;
  const render = (target, { block = false } = {}) => {
    const t = textOf(target);
    if (!t) return preview && !omitted(target) && !blank(target) ? `<mark class="gap" data-target="${esc(target)}">Needs a description</mark>` : '';
    const html = inline(t.text);
    const marked = preview && t.ai ? `<span class="ai" title="Written by AI">${html}</span>` : html;
    return block ? `<p>${marked}</p>` : marked;
  };
  const plain = (target) => textOf(target)?.text || '';

  const groupHref = (g, root) => `${root}r/${g.slug}.html`;
  const nav = (root, current) => `<nav class="side" aria-label="Sections"><a class="nav-home${current === 'home' ? ' on' : ''}" href="${root}index.html">Overview</a>${sheet.groups.map((g) => `<div class="nav-group"><a class="${current === g.slug ? 'on' : ''}" href="${groupHref(g, root)}">${esc(g.name)}</a><ul>${g.endpoints.map((k) => { const e = sheet.endpoints.find((x) => x.key === k); return `<li><a href="${groupHref(g, root)}#${e.key}"><span class="m m-${e.method.toLowerCase()}">${e.method}</span>${esc(e.name)}</a></li>`; }).join('')}</ul></div>`).join('')}<a class="${current === 'changelog' ? 'on' : ''}" href="${root}changelog.html">Changelog</a></nav>`;
  const page = (current) => (current === 'home' ? 'page-home' : current === 'changelog' ? 'page-changelog' : 'page-group');
  const shell = (title, root, current, main) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="generator" content="Dispatch">
${faces ? `<link rel="stylesheet" href="${root}assets/fonts.css">\n` : ''}<link rel="stylesheet" href="${root}assets/site.css">
<script src="${root}assets/site.js" defer></script>
</head>
<body data-root="${root}" class="${bodyClasses(theme)} ${page(current)}">
<header class="top"><a class="brand" href="${root}index.html">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<span>${esc(site.name)}</span></a><div class="search"><input id="q" type="search" placeholder="Search" aria-label="Search the documentation" autocomplete="off"><ol id="hits" hidden></ol></div></header>
<div class="layout">${nav(root, current)}<main>${main}</main></div>
<footer>Generated ${date}${opts.version ? ` · version ${esc(opts.version)}` : ''} · <a href="${root}openapi.json">OpenAPI</a> · <a href="${root}llms.txt">llms.txt</a></footer>
</body>
</html>
`;

  // ---- one page per group
  for (const g of sheet.groups) {
    const eps = g.endpoints.map((k) => sheet.endpoints.find((e) => e.key === k));
    const mdLines = [`# ${g.name}`, '', g.description || plain(`group.${g.slug}`), ''];
    const sections = eps.map((ep) => {
      const b = `ep.${ep.key}`;
      const summary = ep.description ? markdown(ep.description) : render(`${b}.summary`, { block: true });
      const verified = ep.verified?.ok ? `<span class="badge ok" title="Run against ${esc(ep.verified.env)}">Verified against ${esc(ep.verified.env)} on ${esc(ep.verified.date)}</span>` : '';
      const paramRows = (where) => ep.params.filter((p) => p.in === where && !omitted(`${b}.param.${p.in}.${p.name}`)).map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${p.description ? inline(p.description) : render(`${b}.param.${p.in}.${p.name}`)}${p.example && !/^\{\{.*\}\}$/.test(p.example) ? ` <span class="eg">Example: <code>${esc(p.example)}</code></span>` : ''}</td></tr>`).join('');
      const table = (title, rows) => (rows ? `<h4>${title}</h4><table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>` : '');
      const fieldType = (f) => `${f.types.map(esc).join(' or ')}${f.nullable ? ', nullable' : ''}${f.formats.length ? ` <span class="fmt">${esc(f.formats.join(', '))}</span>` : ''}`;
      const fieldRows = (fields, prefix) => fields.filter((f) => !omitted(`${prefix}.${f.path}`)).map((f) => `<tr><td><code>${esc(f.path)}</code></td><td class="type">${fieldType(f)}</td><td>${f.description ? inline(f.description) : textOf(`${prefix}.${f.path}`) || preview ? render(`${prefix}.${f.path}`) : ''}${f.values.length ? ` <span class="eg">Values seen: ${f.values.map((v) => `<code>${esc(v)}</code>`).join(', ')}</span>` : ''}${f.total > 1 && f.present < f.total ? ` <span class="eg">In ${f.present} of ${f.total} responses.</span>` : ''}</td></tr>`).join('');
      const bodyTable = ep.requestFields.length ? `<h4>Request body</h4><table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${fieldRows(ep.requestFields, `${b}.body`)}</tbody></table>` : '';
      const ok = ep.responses.find((r) => r.code < 400);
      const responses = ep.responses.length ? `<h4>Responses</h4>${ep.responses.map((r) => `<div class="resp"><p><span class="code c${String(r.code)[0]}">${r.code}</span> ${esc(REASONS[r.code] || '')}</p>${r === ok && r.fields.length ? `<table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${fieldRows(r.fields, `${b}.resp.${r.code}`)}</tbody></table>` : r.code >= 400 ? `<p class="muted">See <a href="../index.html#errors">errors</a>.</p>` : ''}</div>`).join('')}` : '';
      const tests = ep.tests.length ? `<h4>Checked by tests</h4><ul class="tests">${ep.tests.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ul>` : '';
      const samples = codeSamples(ep, baseUrl);
      const sampleHtml = samples.length ? `<div class="tabs" role="tablist">${samples.map((s, i) => `<button type="button" role="tab" data-lang="${s.lang}" aria-selected="${i === 0}">${esc(s.name)}</button>`).join('')}</div>${samples.map((s, i) => `<pre class="sample" data-lang="${s.lang}"${i ? ' hidden' : ''}><code>${esc(s.code)}</code></pre>`).join('')}` : '';
      const exampleBody = ok?.example?.body || ok?.historyExample?.body || '';
      const exampleHtml = exampleBody ? `<p class="label">${ok.code} response</p><pre><code>${highlightJson(pretty(exampleBody))}</code></pre>` : '';
      const reqBody = ep.body.raw ? `<p class="label">Request body</p><pre><code>${highlightJson(pretty(ep.body.raw))}</code></pre>` : '';
      search.push({ t: ep.name, u: `r/${g.slug}.html#${ep.key}`, s: `${ep.method} ${ep.displayPath}`, x: (ep.description || plain(`${b}.summary`)).slice(0, 200) });

      mdLines.push(`## ${ep.name}`, '', `\`${ep.method} ${ep.displayPath}\``, '', ep.description || plain(`${b}.summary`), '');
      const mdParams = ep.params.filter((p) => !omitted(`${b}.param.${p.in}.${p.name}`));
      if (mdParams.length) mdLines.push('| Parameter | In | Description |', '|---|---|---|', ...mdParams.map((p) => `| \`${p.name}\` | ${p.in} | ${mdInline(p.description || plain(`${b}.param.${p.in}.${p.name}`))} |`), '');
      if (ep.requestFields.length) mdLines.push('Request body:', '', '| Field | Type | Description |', '|---|---|---|', ...ep.requestFields.filter((f) => !omitted(`${b}.body.${f.path}`)).map((f) => `| \`${f.path}\` | ${f.types.join(' or ')}${f.nullable ? ', nullable' : ''} | ${mdInline(f.description || plain(`${b}.body.${f.path}`))} |`), '');
      if (ok?.fields.length) mdLines.push(`Response ${ok.code}:`, '', '| Field | Type | Description |', '|---|---|---|', ...ok.fields.filter((f) => !omitted(`${b}.resp.${ok.code}.${f.path}`)).map((f) => `| \`${f.path}\` | ${f.types.join(' or ')}${f.nullable ? ', nullable' : ''} | ${mdInline(plain(`${b}.resp.${ok.code}.${f.path}`))} |`), '');
      if (ep.responses.length) mdLines.push(`Status codes: ${ep.responses.map((r) => r.code).join(', ')}`, '');
      if (samples[0]) mdLines.push('```sh', samples[0].code, '```', '');
      if (exampleBody) mdLines.push(`Example ${ok.code} response:`, '', '```json', pretty(exampleBody), '```', '');

      return `<section class="endpoint" id="${ep.key}">
<div class="ep-head"><h2>${esc(ep.name)}</h2>${verified}</div>
<p class="route"><span class="m m-${ep.method.toLowerCase()}">${ep.method}</span><code>${esc(ep.displayPath)}</code></p>
${summary}
<div class="cols"><div class="explain">${table('Path parameters', paramRows('path'))}${table('Query parameters', paramRows('query'))}${table('Headers', paramRows('header'))}${bodyTable}${responses}${tests}</div>
<div class="examples">${sampleHtml}${reqBody}${exampleHtml}</div></div>
</section>`;
    });
    const intro = g.description ? markdown(g.description) : render(`group.${g.slug}`, { block: true });
    put(`r/${g.slug}.html`, 'text/html; charset=utf-8', shell(`${g.name} · ${site.name}`, '../', g.slug, `<h1>${esc(g.name)}</h1>${intro}${sections.join('\n')}`));
    put(`md/${g.slug}.md`, 'text/markdown; charset=utf-8', mdLines.join('\n').replace(/\n{3,}/g, '\n\n'));
    search.push({ t: g.name, u: `r/${g.slug}.html`, s: `${eps.length} request${eps.length === 1 ? '' : 's'}`, x: (g.description || plain(`group.${g.slug}`)).slice(0, 200) });
  }

  // ---- home page
  const overview = opts.description ? markdown(opts.description) : render('overview', { block: true });
  const authLines = authSentence(sheet, baseUrl);
  const qs = sheet.quickstart.map((s, i) => {
    const ep = sheet.endpoints.find((e) => e.key === s.endpoint);
    const g = sheet.groups.find((x) => x.name === ep.group);
    return `<li><a href="r/${g.slug}.html#${ep.key}"><span class="m m-${ep.method.toLowerCase()}">${ep.method}</span><code>${esc(ep.displayPath)}</code></a> ${render(`qs.${i}`)}</li>`;
  }).join('');
  const errRows = sheet.errors.map((e) => `<tr><td><span class="code c4">${e.code}</span></td><td>${esc(REASONS[e.code] || '')}</td><td>${render(`err.${e.code}`)}</td><td>${e.endpoints.map((k) => { const ep = sheet.endpoints.find((x) => x.key === k); const g = sheet.groups.find((x) => x.name === ep.group); return `<a href="r/${g.slug}.html#${ep.key}">${esc(ep.name)}</a>`; }).join(', ')}</td></tr>`).join('');
  // The split header shows the first request of the quickstart, or the first one, next to the introduction.
  const heroEp = theme.header === 'split' ? sheet.endpoints.find((e) => e.key === sheet.quickstart[0]?.endpoint) || sheet.endpoints[0] : null;
  const heroCode = (() => {
    if (!heroEp) return '';
    const sample = codeSamples(heroEp, baseUrl)[0];
    const okResp = heroEp.responses.find((r) => r.code < 400);
    const body = okResp?.example?.body || okResp?.historyExample?.body || '';
    const lines = pretty(body).split('\n');
    const shown = lines.length > 14 ? `${lines.slice(0, 13).join('\n')}\n  …` : lines.join('\n');
    return `<aside class="hero-code" aria-label="Example request">${sample ? `<pre><code>${esc(sample.code)}</code></pre>` : ''}${body ? `<pre><code>${lines.length > 14 ? esc(shown) : highlightJson(shown)}</code></pre>` : ''}</aside>`;
  })();
  const home = `<section class="hero"><div><h1>${esc(site.name)}</h1>${overview}</div>${heroCode}</section>
${baseUrl ? `<h2>Base URL</h2><pre><code>${esc(baseUrl)}</code></pre>` : ''}
${authLines.length ? `<h2 id="auth">Authentication</h2>${authLines.map((l) => `<p>${l}</p>`).join('')}` : ''}
${qs ? `<h2 id="quickstart">Quickstart</h2><p class="muted">The order these requests are called in, taken from the collection.</p><ol class="steps">${qs}</ol>` : ''}
<h2>Reference</h2><ul class="groups">${sheet.groups.map((g) => { const gd = g.description || plain(`group.${g.slug}`); return `<li><a href="r/${g.slug}.html">${esc(g.name)}</a> <span class="muted">${g.endpoints.length} request${g.endpoints.length === 1 ? '' : 's'}</span>${gd ? `<span class="gdesc">${inline(gd.split('\n')[0])}</span>` : ''}</li>`; }).join('')}</ul>
${errRows ? `<h2 id="errors">Errors</h2><table><thead><tr><th>Status</th><th></th><th>What to check</th><th>Returned by</th></tr></thead><tbody>${errRows}</tbody></table>` : ''}`;
  put('index.html', 'text/html; charset=utf-8', shell(site.name, '', 'home', home));

  // ---- changelog
  const changes = opts.changelog || [];
  const older = (opts.history || []).filter((h) => h.changelog);
  const changelogHtml = `<h1>Changelog</h1>${changes.length ? `<h2>${date}${opts.version ? ` · version ${esc(opts.version)}` : ''}</h2><ul>${changes.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>` : `<p class="muted">No changes to requests or response fields since the last version.</p>`}${older.map((h) => `<h2>${esc(String(h.published_at || '').slice(0, 10))} · version ${esc(h.version)}</h2><ul>${h.changelog.split('\n').filter(Boolean).map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`).join('')}`;
  put('changelog.html', 'text/html; charset=utf-8', shell(`Changelog · ${site.name}`, '', 'changelog', changelogHtml));

  // ---- machine-readable
  put('openapi.json', 'application/json', JSON.stringify(openapi(sheet, texts, { site, baseUrl, version: opts.version, description: opts.description || plain('overview') }), null, 2));
  put('llms.txt', 'text/plain; charset=utf-8', [`# ${site.name}`, '', `> ${(opts.description || plain('overview') || `Reference for ${sheet.endpoints.length} requests.`).replace(/\n+/g, ' ')}`, '', baseUrl ? `Base URL: ${baseUrl}` : '', authLines.length ? `Authentication: ${authLines.map((l) => l.replace(/<[^>]+>/g, '')).join(' ')}` : '', '', '## Reference', '', ...sheet.groups.map((g) => `- [${g.name}](md/${g.slug}.md): ${g.endpoints.map((k) => { const e = sheet.endpoints.find((x) => x.key === k); return `${e.method} ${e.displayPath}`; }).join(', ')}`), '', '## Optional', '', '- [OpenAPI](openapi.json): the same API as OpenAPI 3.1', '- [Changelog](changelog.html)', ''].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));
  put('md/index.md', 'text/markdown; charset=utf-8', [`# ${site.name}`, '', opts.description || plain('overview'), '', ...sheet.groups.map((g) => `- [${g.name}](${g.slug}.md)`), ''].join('\n'));
  put('search.json', 'application/json', JSON.stringify(search));
  put('assets/site.css', 'text/css; charset=utf-8', `${SITE_CSS}\n/* Theme */\n${themeCss(theme)}`);
  put('assets/site.js', 'text/javascript; charset=utf-8', SITE_JS);
  if (faces) {
    put('assets/fonts.css', 'text/css; charset=utf-8', `/* Fonts under the SIL Open Font License 1.1. See fonts-license.txt. */\n${faces}\n`);
    const licenses = opts.fonts?.licenses || {};
    put('assets/fonts-license.txt', 'text/plain; charset=utf-8', fontLicenses(theme).map((f) => [`${f.name}`, f.copyright, `Source: ${f.url.replace(/\/LICENSE$/, '')}`, '', licenses[f.id] || 'Licensed under the SIL Open Font License, Version 1.1: https://openfontlicense.org', ''].join('\n')).join('\n------------------------------------------------------------\n\n'));
  }
  put('_dispatch/structure.json', 'application/json', JSON.stringify(structure(sheet)));
  put('_dispatch/theme.json', 'application/json', JSON.stringify(theme));
  put('_dispatch/meta.json', 'application/json', JSON.stringify({ generator: 'Dispatch', generatedAt: opts.generatedAt || new Date().toISOString(), version: opts.version ?? null }));
  return files;
}

export function openapi(sheet, texts, { site, baseUrl, version, description }) {
  const t = (target) => (texts[target] && texts[target].text !== OMIT && texts[target].text !== BLANK ? texts[target].text : undefined);
  const paths = {};
  const schemes = {};
  for (const ep of sheet.endpoints) {
    const path = ep.displayPath.replace(/^\{[^}]+\}(?=\/|$)/, '') || '/';
    const b = `ep.${ep.key}`;
    const op = {
      operationId: ep.key,
      summary: ep.name,
      description: ep.description || t(`${b}.summary`),
      tags: [ep.group],
      parameters: ep.params.filter((p) => texts[`${b}.param.${p.in}.${p.name}`]?.text !== OMIT).map((p) => ({ name: p.name, in: p.in, required: p.in === 'path', description: p.description || t(`${b}.param.${p.in}.${p.name}`), schema: { type: 'string' }, ...(p.example && !/\{\{/.test(p.example) ? { example: p.example } : {}) })),
      responses: {},
    };
    if (ep.requestFields.length) {
      const fields = ep.requestFields.map((f) => ({ ...f, description: f.description || t(`${b}.body.${f.path}`) }));
      let example;
      try { example = JSON.parse(ep.body.raw); } catch { /* has variables */ }
      op.requestBody = { content: { [ep.body.mode === 'raw' ? 'application/json' : ep.body.mode === 'formdata' ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: { schema: schemaFrom(fields), ...(example ? { example } : {}) } } };
    }
    for (const r of ep.responses) {
      const fields = r.fields.map((f) => ({ ...f, description: t(`${b}.resp.${r.code}.${f.path}`) }));
      let example;
      try { example = JSON.parse(r.example?.body || r.historyExample?.body || ''); } catch { /* not JSON */ }
      op.responses[String(r.code)] = { description: REASONS[r.code] || `Status ${r.code}`, ...(fields.length ? { content: { 'application/json': { schema: schemaFrom(fields), ...(example !== undefined ? { example } : {}) } } } : {}) };
    }
    if (!Object.keys(op.responses).length) op.responses.default = { description: 'No responses were recorded for this request.' };
    if (ep.auth?.type === 'bearer') { schemes.bearerAuth = { type: 'http', scheme: 'bearer' }; op.security = [{ bearerAuth: [] }]; }
    else if (ep.auth?.type === 'basic') { schemes.basicAuth = { type: 'http', scheme: 'basic' }; op.security = [{ basicAuth: [] }]; }
    else if (ep.auth?.type === 'apikey') { schemes.apiKey = { type: 'apiKey', in: ep.auth.in === 'query' ? 'query' : 'header', name: ep.auth.name }; op.security = [{ apiKey: [] }]; }
    else if (ep.auth?.type === 'oauth2') { schemes.oauth2 = { type: 'oauth2', flows: {} }; op.security = [{ oauth2: [] }]; }
    paths[path] = paths[path] || {};
    paths[path][ep.method.toLowerCase()] = JSON.parse(JSON.stringify(op));
  }
  return {
    openapi: '3.1.0',
    info: { title: site.name, version: String(version ?? '1'), ...(description ? { description } : {}) },
    ...(baseUrl ? { servers: [{ url: baseUrl }] } : {}),
    tags: sheet.groups.map((g) => ({ name: g.name, ...(g.description || t(`group.${g.slug}`) ? { description: g.description || t(`group.${g.slug}`) } : {}) })),
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
  };
}

/** A page with its stylesheet inlined, for the in-app preview (scripts are never run there). `mode` forces light or dark. */
export function previewHtml(files, path, { mode } = {}) {
  const page = files.find((f) => f.path === path);
  const css = files.find((f) => f.path === 'assets/site.css')?.body || '';
  const fonts = files.find((f) => f.path === 'assets/fonts.css')?.body || '';
  if (!page) return '';
  return page.body
    .replace(/<link rel="stylesheet" href="[^"]*assets\/fonts\.css">\n?/, `<style>${fonts}</style>`)
    .replace(/<link rel="stylesheet" href="[^"]*assets\/site\.css">/, `<style>${css}\n.ai{background:color-mix(in srgb, #f5c542 28%, transparent);border-radius:3px}.gap{background:#ffd7d7;color:#8a1f1f;padding:0 4px;border-radius:3px}</style>`)
    .replace(/<script[^>]*><\/script>/g, '')
    .replace('<html lang="en">', mode === 'light' || mode === 'dark' ? `<html lang="en" data-mode="${mode}">` : '<html lang="en">');
}
