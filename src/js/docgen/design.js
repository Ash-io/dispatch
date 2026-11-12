// AI-designed themes. The model gets brand facts (colours taken from the logo
// in code, the audience and tone the author typed, sites they like) and the
// shape of the site, never the API's requests or examples. It answers with a
// theme document; everything it returns is validated and contrast-checked in
// code, retried once with the problems listed, then fixed or dropped.
// See docs/design/docs-theming.md.

import { LAYOUTS, MODES, HEADERS, NAVS, DENSITIES, BORDERS, FONTS, COLOR_KEYS, SYNTAX_KEYS, validateTheme, contrastFailures, fixTheme, isHex, toOklch, fromOklch } from './theme.js';

export const TONES = ['calm', 'technical', 'warm', 'bold', 'playful', 'formal', 'minimal', 'editorial'];

export const DIRECTIONS = [
  { id: 'brand', name: 'Closest to the brand', brief: 'Stay as close to the brand as you can: its colours and the voice its tone words suggest. This is the design the brand team would recognise as theirs.' },
  { id: 'bolder', name: 'Bolder', brief: 'Go bolder than the brand alone suggests: commit more colour to the surface (a banded or split header, a strong accent), and pick a display font with real character. Still readable, never garish.' },
  { id: 'quieter', name: 'Quieter', brief: 'Go quieter: restrained colour with one accent used sparingly, more white space, calm type. It should feel considered, not empty or generic.' },
];

// ---------------------------------------------------------------- brand facts

/**
 * The main colours of an image, from its RGBA pixels: near-transparent,
 * near-white, near-black and near-grey pixels are dropped, the rest are
 * clustered (k-means in RGB, seeded deterministically). Returns up to `max`
 * hex colours, most common first.
 */
export function paletteFromPixels(rgba, max = 4) {
  const pts = [];
  for (let i = 0; i + 3 < rgba.length; i += 4 * Math.max(1, Math.floor(rgba.length / 4 / 6000))) {
    const [r, g, b, a] = [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
    if (a < 128) continue;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi > 245 && lo > 235) continue; // white
    if (hi < 18) continue; // black
    if (hi - lo < 14 && hi > 40 && hi < 230) continue; // grey
    pts.push([r, g, b]);
  }
  if (!pts.length) return [];
  const k = Math.min(max + 2, pts.length);
  let centers = Array.from({ length: k }, (_, i) => pts[Math.floor(((i + 0.5) * pts.length) / k)]);
  let assign = [];
  for (let iter = 0; iter < 12; iter++) {
    assign = pts.map((p) => {
      let best = 0, bd = Infinity;
      centers.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } });
      return best;
    });
    centers = centers.map((c, j) => {
      const mine = pts.filter((_, i) => assign[i] === j);
      return mine.length ? [0, 1, 2].map((x) => mine.reduce((s, p) => s + p[x], 0) / mine.length) : c;
    });
  }
  const counts = centers.map((_, j) => assign.filter((a) => a === j).length);
  const hexOf = (c) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
  const ranked = centers.map((c, j) => ({ hex: hexOf(c), n: counts[j] })).filter((x) => x.n > pts.length * 0.03).sort((a, b) => b.n - a.n);
  // Merge clusters that ended up nearly the same colour.
  const out = [];
  for (const c of ranked) {
    const o = toOklch(c.hex);
    if (out.every((x) => { const p = toOklch(x); const dh = Math.min(Math.abs(p.h - o.h), 360 - Math.abs(p.h - o.h)); return Math.abs(p.l - o.l) > 0.08 || dh > 18 || Math.abs(p.c - o.c) > 0.05; })) out.push(c.hex);
  }
  return out.slice(0, max);
}

/** What the model learns about the site: counts only, to choose a layout that fits. Nothing about the API itself. */
export function siteShape(sheet) {
  return { groups: sheet.groups.length, endpoints: sheet.endpoints.length, hasQuickstart: sheet.quickstart.length > 0 };
}

/** Layouts that read well for a site of this size. */
export function layoutsFor(shape) {
  return Object.keys(LAYOUTS).filter((l) => (l === 'editorial' ? shape.endpoints <= 30 : l === 'index' ? shape.groups >= 2 && shape.groups <= 12 : true));
}

// ---------------------------------------------------------------- the request

const colorSet = { type: 'object', properties: Object.fromEntries(COLOR_KEYS.map((k) => [k, { type: 'string' }])), required: COLOR_KEYS, additionalProperties: false };
const syntaxSet = { type: 'object', properties: Object.fromEntries(SYNTAX_KEYS.map((k) => [k, { type: 'string' }])), required: SYNTAX_KEYS, additionalProperties: false };
const fontIds = (role) => Object.entries(FONTS).filter(([, f]) => f.roles.includes(role)).map(([id]) => id);

/** The JSON Schema the model answers in: a theme plus a name and one sentence about it. */
export const THEME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    rationale: { type: 'string' },
    layout: { type: 'string', enum: Object.keys(LAYOUTS) },
    mode: { type: 'string', enum: MODES },
    header: { type: 'string', enum: HEADERS },
    nav: { type: 'string', enum: NAVS },
    colors: { type: 'object', properties: { light: colorSet, dark: colorSet }, required: ['light', 'dark'], additionalProperties: false },
    syntax: { type: 'object', properties: { light: syntaxSet, dark: syntaxSet }, required: ['light', 'dark'], additionalProperties: false },
    type: {
      type: 'object',
      properties: {
        display: { type: 'string', enum: fontIds('display') },
        body: { type: 'string', enum: fontIds('body') },
        mono: { type: 'string', enum: fontIds('mono') },
        baseSize: { type: 'number' }, scale: { type: 'number' }, headingWeight: { type: 'number' }, headingTracking: { type: 'number' },
      },
      required: ['display', 'body', 'mono', 'baseSize', 'scale', 'headingWeight', 'headingTracking'],
      additionalProperties: false,
    },
    shape: {
      type: 'object',
      properties: { radius: { type: 'number' }, borders: { type: 'string', enum: BORDERS }, density: { type: 'string', enum: DENSITIES } },
      required: ['radius', 'borders', 'density'],
      additionalProperties: false,
    },
  },
  required: ['name', 'rationale', 'layout', 'mode', 'header', 'nav', 'colors', 'syntax', 'type', 'shape'],
  additionalProperties: false,
};

const fontList = (role) => fontIds(role).map((id) => `  - ${id}: ${FONTS[id].name}, ${FONTS[id].voice}${FONTS[id].kind === 'system' ? ' (system font, looks different on each computer)' : ''}`).join('\n');

/** The rules every design call carries. */
export function designSystem() {
  return `You design the visual theme of a public API documentation site. You choose a layout, colours, fonts and shape from fixed options; the site's pages are built from your choices by code. Answer with one JSON object in the given schema.

How to design:
- Start from the brand facts. Pick a colour strategy first: restrained (tinted neutrals and one accent used sparingly), committed (one brand colour carries a large share of the surface, through a banded or split header) or full (a few named colour roles). Then pick colours.
- Work in OKLCH in your head and write hex. Tint every neutral (bg, surface, text, muted, line) slightly towards the brand hue. Never use pure #000000 or #ffffff. Lower the chroma of very light and very dark colours.
- Text must be readable: text, muted, accent and the five method colours need 4.5:1 contrast on both bg and surface; onAccent needs 4.5:1 on accent; codeText and every syntax colour need 4.5:1 on codeBg. This applies to the light and the dark palette. Your colours are measured, and failures are sent back.
- Provide both palettes even when mode is "light" or "dark". The dark palette is a real dark design (dark bg, light text), not an inversion.
- The code pane (codeBg) can be dark in a light theme; split layouts usually want a dark one.
- Pick a display font and a body font with different voices that work together, and a monospace that fits. Headings can be expressive; body text must be easy to read for long stretches.
- Type: baseSize 14 to 19 px, scale 1.125 to 1.414 (steps between heading sizes), headingWeight 400 to 800 (match what the display font is good at; high-contrast serifs often want 400), headingTracking -0.04 to 0.04 em.
- Shape: radius 0 to 18 px; density compact, regular or airy; borders hairline or none.
- Avoid the look anyone would guess from the industry alone (fintech in navy and gold, developer tools in neon on black, healthcare in white and teal). Avoid generic SaaS styling. The result should feel designed for this brand.
- name: two or three words naming the design. rationale: one plain sentence on why it suits the brand, no marketing language.

Fonts you can use (use the id):
Display:
${fontList('display')}
Body:
${fontList('body')}
Monospace:
${fontList('mono')}

Layouts:
${Object.entries(LAYOUTS).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}
Overview header: plain, banded (a full-width band in the accent colour, text in onAccent) or split (the introduction beside a first request and its response).
Menu highlight: quiet (coloured text) or boxed (filled).`;
}

const brandLines = (brand) => [
  `Site name: ${brand.name || 'API documentation'}`,
  brand.colors?.length ? `Brand colours: ${brand.colors.join(', ')}` : 'Brand colours: none given. Choose a palette that suits the audience and tone.',
  brand.audience ? `Audience: ${brand.audience}` : null,
  brand.tone?.length ? `Tone: ${brand.tone.join(', ')}` : null,
  brand.likes ? `Documentation sites the team likes (take a direction from them, don't copy them): ${brand.likes}` : null,
].filter(Boolean).join('\n');

const shapeLines = (shape, allowed) => `The site has ${shape.endpoints} request${shape.endpoints === 1 ? '' : 's'} in ${shape.groups} group${shape.groups === 1 ? '' : 's'}${shape.hasQuickstart ? ', and a quickstart' : ''}. Layouts that fit its size: ${allowed.join(', ')}.`;

export function designPrompt({ brand, shape, direction }) {
  return `BRAND
${brandLines(brand)}

SITE
${shapeLines(shape, layoutsFor(shape))}

DIRECTION: ${direction.name}
${direction.brief}`;
}

export function revisePrompt({ brand, shape, theme, instruction }) {
  const { name, rationale, ...rest } = theme;
  return `BRAND
${brandLines(brand)}

SITE
${shapeLines(shape, layoutsFor(shape))}

CURRENT THEME
${JSON.stringify(rest)}

CHANGE ASKED FOR
${String(instruction).slice(0, 500)}

Return the whole theme with that change made. Keep everything the change doesn't concern as it is.`;
}

// ---------------------------------------------------------------- checking

/**
 * Problems with a designed theme, in two kinds: `fatal` (the theme schema
 * refused it) and `fixable` (fit, colour rules, contrast), which code can
 * correct if the retry doesn't.
 */
export function designProblems(answer, shape) {
  const { errors, theme } = validateTheme(answer);
  const fixable = [];
  if (!layoutsFor(shape).includes(answer.layout)) fixable.push(`layout "${answer.layout}" doesn't suit a site with ${shape.endpoints} requests in ${shape.groups} groups; use one of ${layoutsFor(shape).join(', ')}`);
  for (const mode of ['light', 'dark']) {
    for (const k of ['bg', 'surface', 'text']) {
      const v = String(answer.colors?.[mode]?.[k] || '').toLowerCase();
      if (v === '#000000' || v === '#ffffff') fixable.push(`colors.${mode}.${k} is pure ${v === '#000000' ? 'black' : 'white'}; tint it towards the brand hue`);
    }
  }
  if (answer.colors?.dark && isHex(answer.colors.dark.bg) && toOklch(answer.colors.dark.bg).l > 0.4) fixable.push('colors.dark.bg is too light for a dark palette');
  if (answer.colors?.light && isHex(answer.colors.light.bg) && toOklch(answer.colors.light.bg).l < 0.85) fixable.push('colors.light.bg is too dark for a light palette');
  fixable.push(...contrastFailures(theme));
  return { fatal: errors, fixable, all: [...errors, ...fixable] };
}

/** Corrects what designProblems calls fixable. Returns { theme, adjusted: [what changed] }. */
export function correctDesign(theme, shape) {
  const t = JSON.parse(JSON.stringify(theme));
  const adjusted = [];
  if (!layoutsFor(shape).includes(t.layout)) { adjusted.push(`layout ${t.layout} changed to reference for a site this size`); t.layout = 'reference'; }
  const hue = toOklch(t.colors.light.accent).h;
  for (const mode of ['light', 'dark']) {
    const p = t.colors[mode];
    for (const k of ['bg', 'surface', 'text']) {
      if (p[k] === '#000000' || p[k] === '#ffffff') { const was = p[k]; p[k] = fromOklch({ l: was === '#ffffff' ? 0.99 : 0.16, c: 0.006, h: hue }); adjusted.push(`${mode} ${k} tinted from pure ${was === '#ffffff' ? 'white' : 'black'}`); }
    }
  }
  const clampBg = (mode, test, l) => { const p = t.colors[mode]; const o = toOklch(p.bg); if (test(o.l)) { p.bg = fromOklch({ ...o, l }); adjusted.push(`${mode} background lightness corrected`); } };
  clampBg('dark', (l) => l > 0.4, 0.18);
  clampBg('light', (l) => l < 0.85, 0.97);
  adjusted.push(...contrastFailures(t));
  return { theme: fixTheme(t), adjusted };
}

const retry = (prompt, problems) => `${prompt}

Your previous answer had these problems:
${problems.slice(0, 20).map((p) => `- ${p}`).join('\n')}
Fix them and answer again with the whole JSON object. Keep the rest of the design.`;

/**
 * One design call with the retry-then-fix loop. Returns
 * { theme, name, rationale, adjusted: [contrast fixes made in code] } or
 * { error } when the design couldn't be used.
 */
async function designOnce(ask, system, prompt, shape) {
  let answer = null;
  let problems = { fatal: [], fixable: [], all: [] };
  let failure = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      answer = await ask(system, attempt ? retry(prompt, failure ? [failure] : problems.all) : prompt, THEME_SCHEMA);
      failure = '';
    } catch (e) {
      answer = null;
      failure = String(e?.message || e);
      continue;
    }
    if (!answer || typeof answer !== 'object') { failure = 'the answer was empty'; answer = null; continue; }
    problems = designProblems(answer, shape);
    if (!problems.all.length) break;
  }
  if (!answer) return { error: failure || 'no answer' };
  if (problems.fatal.length) return { error: problems.fatal.slice(0, 3).join('; ') };
  const { theme, adjusted } = correctDesign(validateTheme(answer).theme, shape);
  return { theme, name: String(answer.name || '').slice(0, 40), rationale: String(answer.rationale || '').slice(0, 240), adjusted };
}

/**
 * Three designs, one per direction. `ask(system, prompt, schema)` returns the
 * parsed answer. Returns [{ direction, name, rationale, theme, adjusted } | { direction, error }].
 */
export async function designThemes({ ask, brand, shape, onProgress = () => {} }) {
  const system = designSystem();
  const out = [];
  for (const [i, direction] of DIRECTIONS.entries()) {
    onProgress({ done: i, total: DIRECTIONS.length, direction: direction.name });
    out.push({ direction: direction.id, directionName: direction.name, ...(await designOnce(ask, system, designPrompt({ brand, shape, direction }), shape)) });
  }
  onProgress({ done: DIRECTIONS.length, total: DIRECTIONS.length });
  return out;
}

/** The current theme with one change asked for in plain words, through the same checks. */
export async function reviseTheme({ ask, brand, shape, theme, instruction }) {
  return designOnce(ask, designSystem(), revisePrompt({ brand, shape, theme, instruction }), shape);
}
