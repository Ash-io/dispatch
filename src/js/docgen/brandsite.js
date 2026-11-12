// Brand facts from a company's website: colours and font names only. The
// page's text is never kept or sent anywhere, so instructions hidden in a
// website can't reach the AI. Font names must look like font names, and
// colours are normalised to hex, which is all the design step uses.

import { toOklch, fromOklch } from './theme.js';
import { WEB_FONTS } from './fonts.js';

const MAX_SHEETS = 4;

/** Stylesheet URLs linked from the page, resolved against it, http(s) only. */
export function stylesheetLinks(html, pageUrl) {
  const out = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) continue;
    const href = (/\bhref\s*=\s*"([^"]+)"/i.exec(tag) || /\bhref\s*=\s*'([^']+)'/i.exec(tag) || /\bhref\s*=\s*([^\s>]+)/i.exec(tag) || [])[1];
    if (!href) continue;
    try {
      const u = new URL(href.replace(/&amp;/g, '&'), pageUrl);
      if (/^https?:$/.test(u.protocol) && !out.includes(u.href)) out.push(u.href);
    } catch { /* not a URL */ }
    if (out.length >= MAX_SHEETS) break;
  }
  return out;
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

const alphaOk = (a, pct) => a === undefined || (pct ? Number(a) / 100 : Number(a)) >= 0.8;

function hslHex(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
}

/** A CSS colour (hex, rgb(), hsl() or oklch(), with enough opacity) as #rrggbb, or null. */
export function cssColor(text) {
  const s = String(text).trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    if (m[2] && parseInt(m[2], 16) < 200) return null;
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return `#${h}`;
  }
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*\.?\d+)(%)?)?\s*\)$/.exec(s);
  if (m) {
    if (m[4] !== undefined && (m[5] ? Number(m[4]) / 100 : Number(m[4])) < 0.8) return null;
    return `#${hex2(m[1])}${hex2(m[2])}${hex2(m[3])}`;
  }
  m = /^hsla?\(\s*(-?\d*\.?\d+)(?:deg)?[\s,]+(\d*\.?\d+)%[\s,]+(\d*\.?\d+)%(?:[\s,/]+(\d*\.?\d+)(%)?)?\s*\)$/.exec(s);
  if (m) return alphaOk(m[4], m[5]) ? hslHex(((Number(m[1]) % 360) + 360) % 360, Number(m[2]) / 100, Number(m[3]) / 100) : null;
  m = /^oklch\(\s*(\d*\.?\d+)(%)?\s+(\d*\.?\d+)\s+(-?\d*\.?\d+)(?:deg)?(?:\s*\/\s*(\d*\.?\d+)(%)?)?\s*\)$/.exec(s);
  if (m) return alphaOk(m[5], m[6]) ? fromOklch({ l: m[2] ? Number(m[1]) / 100 : Number(m[1]), c: Number(m[3]), h: Number(m[4]) }) : null;
  return null;
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset', 'revert', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'helvetica neue', 'arial', 'noto sans', 'apple color emoji', 'segoe ui emoji', 'segoe ui symbol', 'noto color emoji', 'sfmono-regular', 'menlo', 'monaco', 'consolas', 'liberation mono', 'courier new', 'courier', 'times new roman', 'times', 'georgia', 'var']);
// Font names are short. Anything longer, or with other characters, is left out, so page text can't pass as one.
const FONT_NAME = /^[A-Za-z][A-Za-z0-9 -]{1,31}$/;
const fontName = (n) => FONT_NAME.test(n) && n.split(/\s+/).length <= 4;
const fontKey = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(variable|var)$/, '');

const isNeutral = (hex) => { const o = toOklch(hex); return o.c < 0.03 || o.l > 0.97 || o.l < 0.1; };

/**
 * Colours and fonts from the page and its stylesheets. Colours named like
 * brand tokens (--brand, --primary, --accent) count more; near-greys,
 * near-white and near-black are left out. Returns
 * { themeColor, colors: [hex], fonts: [{ name, id }] } where `id` is the
 * matching catalogue font, if there is one.
 */
export function brandFacts(html, sheets = []) {
  const page = String(html || '');
  const inline = [...page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const css = [...inline, ...sheets.map(String)].join('\n').slice(0, 2_000_000);
  const metaTag = (/<meta\b[^>]*\bname\s*=\s*["']?theme-color["']?[^>]*>/i.exec(page) || [])[0] || '';
  const themeColor = cssColor((/\bcontent\s*=\s*["']([^"']+)["']/i.exec(metaTag) || [])[1] || '');

  const score = new Map();
  const add = (hex, w) => { if (hex && !isNeutral(hex)) score.set(hex, (score.get(hex) || 0) + w); };
  if (themeColor) add(themeColor, 30);
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) {
    const c = cssColor(m[2]);
    add(c, /brand|primary|accent|main|key|theme/i.test(m[1]) ? 12 : 2);
  }
  for (const m of css.matchAll(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch)\([^)]*\)/gi)) add(cssColor(m[0]), 1);
  // Close shades of one colour count as one.
  const ranked = [...score].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  const colors = [];
  for (const hex of ranked) {
    const o = toOklch(hex);
    if (colors.every((x) => { const p = toOklch(x); const dh = Math.min(Math.abs(p.h - o.h), 360 - Math.abs(p.h - o.h)); return dh > 20 || Math.abs(p.l - o.l) > 0.15; })) colors.push(hex);
    if (colors.length >= 5) break;
  }

  const fontCount = new Map();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/!important/i, '').trim().replace(/^["']|["']$/g, '').trim();
      if (!fontName(name) || GENERIC.has(name.toLowerCase())) continue;
      fontCount.set(name, (fontCount.get(name) || 0) + 1);
      break; // the first real family is the one the site means
    }
  }
  const byName = new Map(Object.entries(WEB_FONTS).map(([id, f]) => [fontKey(f.name), id]));
  const fonts = [...fontCount].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => ({ name, id: byName.get(fontKey(name)) || null }));
  return { themeColor, colors, fonts };
}
