// Documentation themes: a JSON document of design choices (layout, colours,
// fonts, shape) that build.js turns into CSS. Themes come from presets, the
// author's own edits or, later, the AI; every one is validated here and its
// colours are checked for contrast in code. Nothing in a theme can add markup
// or script to a page. See docs/design/docs-theming.md.

export const LAYOUTS = {
  reference: 'Sidebar and two columns per endpoint. Suits large APIs with many groups.',
  split: 'Three panes, with the code samples in a dark pane on the right. Suits APIs where samples matter most.',
  editorial: 'One wide reading column with large type and a contents list on the right. Suits small APIs and public products.',
  index: 'A top menu, the overview as a grid of groups, endpoints stacked on each group page. Suits APIs with a few distinct areas.',
};
export const MODES = ['auto', 'light', 'dark'];
export const HEADERS = ['plain', 'banded', 'split'];
export const NAVS = ['quiet', 'boxed'];
export const DENSITIES = ['compact', 'regular', 'airy'];
export const BORDERS = ['hairline', 'none'];

import { WEB_FONTS } from './fonts.js';

/**
 * Fonts: web fonts from the catalogue in fonts.js, downloaded once, checked
 * against their SHA-256 and published inside the site, plus system stacks
 * that load nothing. A web font's stack ends in a system fallback of the
 * same kind, used until it loads or if it couldn't be downloaded.
 */
const SYSTEM_FONTS = {
  'system-sans': { name: 'System sans', voice: 'neutral sans, the reader\'s own UI font', roles: ['body', 'display'], stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  grotesque: { name: 'Grotesque', voice: 'crisp neo-grotesque (Inter, Helvetica, Arial)', roles: ['body', 'display'], stack: 'Inter, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Helvetica, Arial, sans-serif' },
  humanist: { name: 'Humanist', voice: 'warm, calligraphic sans (Seravek, Gill Sans, Ubuntu, Calibri)', roles: ['body', 'display'], stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif' },
  geometric: { name: 'Geometric', voice: 'round, even geometric sans (Avenir, Montserrat, Futura)', roles: ['body', 'display'], stack: 'Avenir, "Avenir Next LT Pro", Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif' },
  classical: { name: 'Classical humanist', voice: 'flared, elegant sans (Optima, Candara)', roles: ['body', 'display'], stack: 'Optima, Candara, "Noto Sans", source-sans-pro, sans-serif' },
  rounded: { name: 'Rounded', voice: 'soft, friendly rounded sans', roles: ['display'], stack: 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", "Arial Rounded MT Bold", Calibri, source-sans-pro, sans-serif' },
  industrial: { name: 'Industrial', voice: 'condensed, engineered (Bahnschrift, DIN)', roles: ['display'], stack: 'Bahnschrift, "DIN Alternate", "Franklin Gothic Medium", "Nimbus Sans Narrow", sans-serif-condensed, sans-serif' },
  transitional: { name: 'Transitional serif', voice: 'sturdy, readable book serif (Charter, Cambria)', roles: ['body', 'display'], stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif' },
  'old-style': { name: 'Old-style serif', voice: 'literary, classic serif (Iowan, Palatino)', roles: ['body', 'display'], stack: '"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, serif' },
  didone: { name: 'Didone', voice: 'high-contrast fashion serif (Didot, Bodoni)', roles: ['display'], stack: 'Didot, "Bodoni MT", "Noto Serif Display", "URW Palladio L", P052, Sylfaen, serif' },
  slab: { name: 'Slab serif', voice: 'blocky, confident slab (Rockwell, Roboto Slab)', roles: ['display'], stack: 'Rockwell, "Rockwell Nova", "Roboto Slab", "DejaVu Serif", "Sitka Small", serif' },
  'mono-code': { name: 'Code mono', voice: 'modern coding monospace', roles: ['mono'], stack: 'ui-monospace, "Cascadia Code", "Source Code Pro", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace' },
  'mono-type': { name: 'Typewriter mono', voice: 'typewriter monospace', roles: ['mono'], stack: '"Nimbus Mono PS", "Courier New", Courier, monospace' },
};
const FALLBACK = { 'sans-serif': 'system-sans', serif: 'transitional', monospace: 'mono-code', display: 'system-sans', handwriting: 'system-sans' };
export const FONTS = {
  ...Object.fromEntries(Object.entries(WEB_FONTS).map(([id, f]) => [id, { name: f.name, voice: f.voice, roles: f.roles, kind: 'web', stack: `"${f.name}", ${SYSTEM_FONTS[FALLBACK[f.category] || 'system-sans'].stack}` }])),
  ...Object.fromEntries(Object.entries(SYSTEM_FONTS).map(([id, f]) => [id, { ...f, name: `${f.name} (system)`, kind: 'system' }])),
};

const nearest = (weights, want) => weights.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));

/**
 * The web font files a theme needs: regular, semibold and bold for text, the
 * heading weight for headings, regular and bold for code. Weights a family
 * doesn't have map to its nearest. Returns [{ id, weight, url, size, sha256 }].
 */
export function fontFiles(theme) {
  const want = new Map();
  const add = (id, weights) => {
    const f = WEB_FONTS[id];
    if (!f) return;
    const have = Object.keys(f.files).map(Number);
    for (const w of weights) {
      const pick = nearest(have, w);
      want.set(`${id}:${pick}`, { id, weight: pick, ...f.files[pick] });
    }
  };
  add(theme.type.body, [400, 600, 700]);
  add(theme.type.display, [theme.type.headingWeight >= 650 ? 700 : theme.type.headingWeight]);
  add(theme.type.mono, [400, 700]);
  return [...want.values()];
}

/** The licence files for the web font families a theme uses. */
export const fontLicenses = (theme) => [...new Set([theme.type.body, theme.type.display, theme.type.mono])].filter((id) => WEB_FONTS[id]).map((id) => ({ id, name: WEB_FONTS[id].name, copyright: WEB_FONTS[id].copyright, ...WEB_FONTS[id].license }));

/** @font-face rules with the font inline, so pages load nothing from elsewhere. `data` maps "id:weight" to base64. */
export function fontFaceCss(theme, data = {}) {
  return fontFiles(theme).filter((f) => data[`${f.id}:${f.weight}`]).map((f) => `@font-face { font-family: "${WEB_FONTS[f.id].name}"; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url(data:font/woff2;base64,${data[`${f.id}:${f.weight}`]}) format("woff2"); }`).join('\n');
}

export const COLOR_KEYS = ['bg', 'surface', 'text', 'muted', 'line', 'accent', 'onAccent', 'codeBg', 'codeText', 'get', 'post', 'put', 'patch', 'delete'];
export const SYNTAX_KEYS = ['key', 'string', 'number', 'literal', 'punct'];

// ---------------------------------------------------------------- colour maths

const HEX = /^#([0-9a-f]{6})$/i;
export const isHex = (s) => typeof s === 'string' && HEX.test(s);
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const hexOf = (r, g, b) => `#${[r, g, b].map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

export function luminance(hex) {
  const [r, g, b] = rgb(hex).map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two hex colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Hex to OKLCH ({ l: 0..1, c, h: degrees }). */
export function toOklch(hex) {
  const [r, g, b] = rgb(hex).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

function oklchToLinear({ l, c, h }) {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** OKLCH to hex, lowering chroma until the colour fits in sRGB. */
export function fromOklch({ l, c, h }) {
  const L = Math.min(1, Math.max(0, l));
  const inGamut = (cc) => oklchToLinear({ l: L, c: cc, h }).every((x) => x >= -1e-4 && x <= 1 + 1e-4);
  let cc = Math.max(0, c);
  if (!inGamut(cc)) {
    let lo = 0, hi = cc;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(mid)) lo = mid; else hi = mid; }
    cc = lo;
  }
  const [r, g, b] = oklchToLinear({ l: L, c: cc, h }).map((x) => fromLin(Math.min(1, Math.max(0, x))));
  return hexOf(r, g, b);
}

/**
 * Moves `fg`'s OKLCH lightness, keeping hue and chroma, until it reaches
 * `min` contrast against every colour in `against`. Goes darker on light
 * backgrounds and lighter on dark ones; falls back to the other direction.
 */
export function fixContrast(fg, against, min) {
  const list = [].concat(against);
  const ok = (hex) => list.every((b) => contrast(hex, b) >= min);
  if (ok(fg)) return fg;
  const base = toOklch(fg);
  const bgL = Math.max(...list.map((b) => toOklch(b).l));
  const dirs = bgL > 0.6 ? [-1, 1] : [1, -1];
  for (const dir of dirs) {
    for (let step = 1; step <= 100; step++) {
      const candidate = fromOklch({ ...base, l: base.l + dir * step * 0.01 });
      if (ok(candidate)) return candidate;
    }
  }
  return bgL > 0.6 ? '#111111' : '#f5f5f5';
}

// ---------------------------------------------------------------- palettes

const METHOD_HUES = { get: 150, post: 65, put: 250, patch: 300, delete: 25 };
const SYNTAX_HUES = { key: 250, string: 145, number: 45, literal: 310 };

/**
 * A full palette from a few seeds, used by presets and when the author picks
 * an accent. `hue`/`tint` colour the neutrals, `code` puts the code pane in
 * a dark or light scheme. The result still goes through checkTheme.
 */
export function derivePalette({ accent, hue, tint = 0.012, code = 'dark' }) {
  const a = toOklch(accent);
  const nh = hue ?? a.h;
  const n = (l, c = tint) => fromOklch({ l, c, h: nh });
  const methods = (bg, l) => Object.fromEntries(Object.entries(METHOD_HUES).map(([k, h]) => [k, fixContrast(fromOklch({ l, c: 0.13, h }), bg, 4.6)]));
  const pane = (dark) => (dark ? { codeBg: n(0.2, tint * 1.4), codeText: n(0.92, tint * 0.6) } : { codeBg: n(0.95, tint * 1.2), codeText: n(0.25, tint) });

  const lightBg = n(0.985, tint * 0.6);
  const lightSurface = n(1, tint * 0.2);
  const lightAccent = fixContrast(fromOklch({ ...a, l: Math.min(a.l, 0.55) }), [lightBg, lightSurface], 4.6);
  const light = {
    bg: lightBg, surface: lightSurface, text: n(0.22), muted: n(0.48, tint * 1.2), line: n(0.9, tint * 1.2),
    accent: lightAccent, onAccent: contrast(lightAccent, '#ffffff') >= 4.6 ? n(0.995, tint * 0.3) : n(0.18),
    ...pane(code === 'dark'), ...methods([lightBg, lightSurface], 0.5),
  };
  const darkBg = n(0.17, tint * 1.2);
  const darkSurface = n(0.21, tint * 1.3);
  const darkAccent = fixContrast(fromOklch({ ...a, l: Math.max(a.l, 0.72) }), [darkBg, darkSurface], 4.6);
  const dark = {
    bg: darkBg, surface: darkSurface, text: n(0.93, tint * 0.6), muted: n(0.72, tint), line: n(0.3, tint * 1.4),
    accent: darkAccent, onAccent: contrast(darkAccent, '#111111') >= 4.6 ? n(0.16, tint) : n(0.98, tint * 0.3),
    ...pane(true), codeBg: n(0.13, tint * 1.2), ...methods([darkBg, darkSurface], 0.78),
  };
  return { light, dark };
}

export function deriveSyntax(codeBg) {
  const dark = toOklch(codeBg).l < 0.5;
  const l = dark ? 0.8 : 0.45;
  const s = Object.fromEntries(Object.entries(SYNTAX_HUES).map(([k, h]) => [k, fixContrast(fromOklch({ l, c: 0.12, h }), codeBg, 4.6)]));
  const p = toOklch(codeBg);
  s.punct = fixContrast(fromOklch({ l: dark ? 0.68 : 0.5, c: Math.min(p.c, 0.02), h: p.h }), codeBg, 4.6);
  return s;
}

// ---------------------------------------------------------------- themes

const base = (over) => {
  const palette = derivePalette(over.seed);
  const t = {
    version: 1, layout: 'reference', mode: 'auto',
    colors: palette, syntax: { light: deriveSyntax(palette.light.codeBg), dark: deriveSyntax(palette.dark.codeBg) },
    type: { display: 'system-sans', body: 'system-sans', mono: 'mono-code', baseSize: 15, scale: 1.2, headingWeight: 650, headingTracking: -0.01 },
    shape: { radius: 8, borders: 'hairline', density: 'regular' },
    header: 'plain', nav: 'boxed', extraCss: '',
  };
  return { ...t, ...over.theme, type: { ...t.type, ...(over.theme?.type || {}) }, shape: { ...t.shape, ...(over.theme?.shape || {}) } };
};

/** Today's look, before themes existed. */
export const DEFAULT_THEME = Object.freeze(base({
  seed: { accent: '#2f6f5e', hue: 130, tint: 0.006, code: 'light' },
  theme: {},
}));

export const PRESETS = [
  { id: 'default', name: 'Dispatch', note: 'The default: sidebar, green accent, system fonts.', theme: DEFAULT_THEME },
  { id: 'ledger', name: 'Ledger', note: 'Warm paper, Newsreader headings and the code in a dark pane.', theme: base({
    seed: { accent: '#b4462b', hue: 70, tint: 0.014, code: 'dark' },
    theme: { layout: 'split', header: 'split', nav: 'quiet', type: { display: 'newsreader', body: 'source-sans-3', mono: 'ibm-plex-mono', headingWeight: 600, scale: 1.25, baseSize: 16 }, shape: { radius: 4 } },
  }) },
  { id: 'signal', name: 'Signal', note: 'Engineered and dense: condensed headings, IBM Plex, a cobalt band.', theme: base({
    seed: { accent: '#2a55d4', hue: 255, tint: 0.01, code: 'dark' },
    theme: { layout: 'index', header: 'banded', nav: 'quiet', type: { display: 'barlow-condensed', body: 'ibm-plex-sans', mono: 'ibm-plex-mono', headingWeight: 600, headingTracking: 0, scale: 1.333 }, shape: { radius: 2, density: 'compact' } },
  }) },
  { id: 'field-notes', name: 'Field notes', note: 'A reading column in Instrument Serif and Literata, for small public APIs.', theme: base({
    seed: { accent: '#2f6b3a', hue: 95, tint: 0.016, code: 'light' },
    theme: { layout: 'editorial', header: 'plain', nav: 'quiet', type: { display: 'instrument-serif', body: 'literata', mono: 'source-code-pro', headingWeight: 400, headingTracking: 0, scale: 1.333, baseSize: 17 }, shape: { radius: 3, density: 'airy' } },
  }) },
  { id: 'night-shift', name: 'Night shift', note: 'Dark only, Outfit and DM Sans, amber accent.', theme: base({
    seed: { accent: '#e3a23b', hue: 260, tint: 0.018, code: 'dark' },
    theme: { mode: 'dark', layout: 'reference', header: 'banded', nav: 'boxed', type: { display: 'outfit', body: 'dm-sans', mono: 'jetbrains-mono', headingWeight: 600, scale: 1.25 }, shape: { radius: 10 } },
  }) },
  { id: 'studio', name: 'Studio', note: 'Soft and roomy, Bricolage Grotesque headings, plum accent.', theme: base({
    seed: { accent: '#7a3d8f', hue: 320, tint: 0.012, code: 'dark' },
    theme: { layout: 'split', header: 'banded', nav: 'boxed', type: { display: 'bricolage-grotesque', body: 'manrope', mono: 'fira-code', headingWeight: 700, headingTracking: -0.02, scale: 1.25, baseSize: 16 }, shape: { radius: 14, density: 'airy' } },
  }) },
];

/** Returns a copy of `theme` with a new accent, re-deriving the colours that depend on it. */
export function withAccent(theme, accent) {
  if (!isHex(accent)) return theme;
  const next = clone(theme);
  for (const mode of ['light', 'dark']) {
    const p = next.colors[mode];
    p.accent = fixContrast(mode === 'light' ? fromOklch({ ...toOklch(accent), l: Math.min(toOklch(accent).l, 0.55) }) : fromOklch({ ...toOklch(accent), l: Math.max(toOklch(accent).l, 0.72) }), [p.bg, p.surface], 4.6);
    p.onAccent = fixContrast(contrast(p.accent, '#ffffff') >= contrast(p.accent, '#111111') ? '#ffffff' : '#111111', p.accent, 4.6);
  }
  return next;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Checks a theme's shape. Returns { ok, errors, theme } with defaults filled in. */
export function validateTheme(input) {
  const errors = [];
  const t = clone(input && typeof input === 'object' ? input : {});
  const d = DEFAULT_THEME;
  const pick = (val, list, name, fallback) => {
    if (val === undefined) return fallback;
    if (!list.includes(val)) { errors.push(`${name} must be one of ${list.join(', ')}`); return fallback; }
    return val;
  };
  const num = (val, lo, hi, name, fallback) => {
    if (val === undefined) return fallback;
    if (typeof val !== 'number' || !Number.isFinite(val) || val < lo || val > hi) { errors.push(`${name} must be a number from ${lo} to ${hi}`); return fallback; }
    return val;
  };
  const font = (val, role, fallback) => {
    if (val === undefined) return fallback;
    if (!FONTS[val]) { errors.push(`type.${role} "${val}" isn't in the font catalogue`); return fallback; }
    if (!FONTS[val].roles.includes(role === 'mono' ? 'mono' : role)) { errors.push(`type.${role} "${val}" can't be used as a ${role} font`); return fallback; }
    return val;
  };
  const out = {
    version: 1,
    layout: pick(t.layout, Object.keys(LAYOUTS), 'layout', d.layout),
    mode: pick(t.mode, MODES, 'mode', d.mode),
    header: pick(t.header, HEADERS, 'header', d.header),
    nav: pick(t.nav, NAVS, 'nav', d.nav),
    colors: {},
    syntax: {},
    type: {
      display: font(t.type?.display, 'display', d.type.display),
      body: font(t.type?.body, 'body', d.type.body),
      mono: font(t.type?.mono, 'mono', d.type.mono),
      baseSize: num(t.type?.baseSize, 14, 19, 'type.baseSize', d.type.baseSize),
      scale: num(t.type?.scale, 1.125, 1.414, 'type.scale', d.type.scale),
      headingWeight: num(t.type?.headingWeight, 400, 800, 'type.headingWeight', d.type.headingWeight),
      headingTracking: num(t.type?.headingTracking, -0.04, 0.04, 'type.headingTracking', d.type.headingTracking),
    },
    shape: {
      radius: num(t.shape?.radius, 0, 18, 'shape.radius', d.shape.radius),
      borders: pick(t.shape?.borders, BORDERS, 'shape.borders', d.shape.borders),
      density: pick(t.shape?.density, DENSITIES, 'shape.density', d.shape.density),
    },
    extraCss: '',
  };
  const modes = out.mode === 'auto' ? ['light', 'dark'] : [out.mode];
  for (const mode of ['light', 'dark']) {
    const given = t.colors?.[mode];
    if (!given && modes.includes(mode)) errors.push(`colors.${mode} is missing`);
    out.colors[mode] = {};
    for (const k of COLOR_KEYS) {
      const v = given?.[k];
      if (v === undefined) { if (given && modes.includes(mode)) errors.push(`colors.${mode}.${k} is missing`); out.colors[mode][k] = d.colors[mode][k]; }
      else if (!isHex(v)) { errors.push(`colors.${mode}.${k} must be a #rrggbb colour`); out.colors[mode][k] = d.colors[mode][k]; }
      else out.colors[mode][k] = v.toLowerCase();
    }
  }
  for (const mode of ['light', 'dark']) {
    out.syntax[mode] = {};
    const derived = deriveSyntax(out.colors[mode].codeBg);
    for (const k of SYNTAX_KEYS) {
      const v = t.syntax?.[mode]?.[k];
      if (v !== undefined && !isHex(v)) errors.push(`syntax.${mode}.${k} must be a #rrggbb colour`);
      out.syntax[mode][k] = isHex(v) ? v.toLowerCase() : derived[k];
    }
  }
  if (t.extraCss) errors.push('extraCss isn\'t supported yet');
  return { ok: !errors.length, errors, theme: out };
}

const TEXT_KEYS = ['text', 'muted', 'accent', 'get', 'post', 'put', 'patch', 'delete'];

/** Every contrast pair the theme must meet, measured. */
export function contrastReport(theme) {
  const modes = theme.mode === 'auto' ? ['light', 'dark'] : [theme.mode];
  const rows = [];
  for (const mode of modes) {
    const p = theme.colors[mode];
    for (const k of TEXT_KEYS) for (const bg of ['bg', 'surface']) rows.push({ mode, fg: k, bg, ratio: contrast(p[k], p[bg]), min: 4.5 });
    rows.push({ mode, fg: 'onAccent', bg: 'accent', ratio: contrast(p.onAccent, p.accent), min: 4.5 });
    rows.push({ mode, fg: 'codeText', bg: 'codeBg', ratio: contrast(p.codeText, p.codeBg), min: 4.5 });
    rows.push({ mode, fg: 'line', bg: 'bg', ratio: contrast(p.line, p.bg), min: 1.2 });
    for (const k of SYNTAX_KEYS) rows.push({ mode, fg: `syntax.${k}`, bg: 'codeBg', ratio: contrast(theme.syntax[mode][k], p.codeBg), min: 4.5 });
  }
  return rows.map((r) => ({ ...r, ok: r.ratio >= r.min }));
}

/** Human-readable contrast failures, e.g. "muted on bg (dark) is 3.1:1, needs 4.5:1". */
export function contrastFailures(theme) {
  return contrastReport(theme).filter((r) => !r.ok).map((r) => `${r.fg} on ${r.bg} (${r.mode}) is ${r.ratio.toFixed(1)}:1, needs ${r.min}:1`);
}

/** Fixes every contrast failure by moving the foreground's lightness. */
export function fixTheme(theme) {
  const t = clone(theme);
  const modes = t.mode === 'auto' ? ['light', 'dark'] : [t.mode];
  for (const mode of modes) {
    const p = t.colors[mode];
    for (const k of TEXT_KEYS) p[k] = fixContrast(p[k], [p.bg, p.surface], 4.55);
    p.onAccent = fixContrast(p.onAccent, p.accent, 4.55);
    p.codeText = fixContrast(p.codeText, p.codeBg, 4.55);
    if (contrast(p.line, p.bg) < 1.2) p.line = fixContrast(p.line, p.bg, 1.22);
    for (const k of SYNTAX_KEYS) t.syntax[mode][k] = fixContrast(t.syntax[mode][k], p.codeBg, 4.55);
  }
  return t;
}

/** Validates, then fixes contrast. What every build uses. */
export function normalizeTheme(input) {
  const { theme, errors } = validateTheme(input || DEFAULT_THEME);
  return { theme: fixTheme(theme), errors };
}

// ---------------------------------------------------------------- CSS

const vars = (p, sx) => `--bg: ${p.bg}; --panel: ${p.surface}; --text: ${p.text}; --muted: ${p.muted}; --line: ${p.line}; --accent: ${p.accent}; --on-accent: ${p.onAccent}; --code-bg: ${p.codeBg}; --code-text: ${p.codeText}; --get: ${p.get}; --post: ${p.post}; --put: ${p.put}; --patch: ${p.patch}; --delete: ${p.delete}; --syn-key: ${sx.key}; --syn-string: ${sx.string}; --syn-number: ${sx.number}; --syn-literal: ${sx.literal}; --syn-punct: ${sx.punct};`;

/**
 * The theme's custom properties. Light and dark follow the reader's setting
 * (`auto`), and `html[data-mode]` forces one, which the preview uses.
 */
export function themeCss(theme) {
  const ty = theme.type;
  const space = { compact: 0.8, regular: 1, airy: 1.3 }[theme.shape.density];
  const scale = (n) => `${(ty.baseSize * ty.scale ** n).toFixed(1)}px`;
  const common = `:root {
  --font: ${FONTS[ty.body].stack};
  --display: ${FONTS[ty.display].stack};
  --mono: ${FONTS[ty.mono].stack};
  --base: ${ty.baseSize}px; --h1: ${scale(4)}; --h2: ${scale(2)}; --h3: ${scale(1)};
  --heading-weight: ${ty.headingWeight}; --heading-tracking: ${ty.headingTracking}em;
  --radius: ${theme.shape.radius}px; --radius-sm: ${Math.round(theme.shape.radius * 0.6)}px;
  --space: ${space};
  --rule: ${theme.shape.borders === 'none' ? 'transparent' : 'var(--line)'};
}`;
  if (theme.mode !== 'auto') {
    return `${common}\n:root { color-scheme: ${theme.mode}; ${vars(theme.colors[theme.mode], theme.syntax[theme.mode])} }\n`;
  }
  return `${common}
:root { color-scheme: light dark; ${vars(theme.colors.light, theme.syntax.light)} }
@media (prefers-color-scheme: dark) { :root:not([data-mode="light"]) { ${vars(theme.colors.dark, theme.syntax.dark)} } }
:root[data-mode="dark"] { color-scheme: dark; ${vars(theme.colors.dark, theme.syntax.dark)} }
:root[data-mode="light"] { color-scheme: light; }
`;
}

/** Classes on <body> that select the layout and its options. */
export const bodyClasses = (theme) => [`layout-${theme.layout}`, `header-${theme.header}`, `nav-${theme.nav}`, `density-${theme.shape.density}`].join(' ');
