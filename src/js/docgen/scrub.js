// Removes secrets and personal data from everything that could reach a
// published page. Values are replaced with realistic fakes in the same format,
// and the same original always becomes the same fake, so an ID that appears on
// two pages still matches. Originals stay in memory for the review screen only.

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$|token|secret|password|passwd|api[-_]?key|session|signature/i;
const SENSITIVE_KEY = /(^|_|-|\b)(pass(word)?|passwd|secret|token|api_?key|apikey|access_?key|private_?key|auth(orization)?|session(_?id)?|cookie|ssn|cvv|cvc|pin|card_?number|iban|otp)$/i;

/** Deterministic 32-bit hash (FNV-1a), so fakes are stable between runs. */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function rng(seed) {
  let s = seed || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGIT = '0123456789';
const HEX = '0123456789abcdef';

/** Same length and the same kind of character in each position. */
function lookalike(original, rand) {
  let out = '';
  for (const ch of original) {
    if (LOWER.includes(ch)) out += LOWER[Math.floor(rand() * 26)];
    else if (UPPER.includes(ch)) out += UPPER[Math.floor(rand() * 26)];
    else if (DIGIT.includes(ch)) out += DIGIT[Math.floor(rand() * 10)];
    else out += ch;
  }
  return out;
}

const luhnOk = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return digits.length >= 13 && sum % 10 === 0;
};

const mask = (s) => (s.length <= 8 ? `${s[0] || ''}…` : `${s.slice(0, 4)}…${s.slice(-3)}`);

// Order matters: specific shapes first, the generic long-token rule last.
const RULES = [
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, fake: () => '-----BEGIN PRIVATE KEY-----\n(removed)\n-----END PRIVATE KEY-----' },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, fake: (m, r) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.${lookalike(m.split('.')[2], r)}` },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, fake: (m, r, n) => (/@(example\.(com|org|net)|test\.com)$/i.test(m) ? m : `user${n}@example.com`) },
  { kind: 'AWS key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, fake: (m, r) => `AKIA${lookalike(m.slice(4), r).replace(/[a-z]/g, (c) => c.toUpperCase())}` },
  { kind: 'API key', re: /\b([a-z]{2,10}_(?:live_|test_|prod_)?)([A-Za-z0-9]{16,})\b/g, fake: (m, r) => { const i = m.lastIndexOf('_') + 1; return m.slice(0, i) + lookalike(m.slice(i), r); } },
  { kind: 'card number', re: /\b(?:\d[ -]?){12,18}\d\b/g, test: (m) => luhnOk(m.replace(/\D/g, '')), fake: (m) => { let i = 0; const d = '4242424242424242424'; return m.replace(/\d/g, () => d[i++]); } },
  { kind: 'phone number', re: /\+\d[\d ().-]{7,16}\d\b/g, fake: (m, r) => { let i = 0; return m.replace(/\d/g, (c) => (i++ < 2 ? c : DIGIT[Math.floor(r() * 10)])); } },
  { kind: 'IP address', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, test: (m) => !/^(127\.|0\.0\.0\.0$|10\.|192\.168\.|203\.0\.113\.)/.test(m), fake: (m, r, n) => `203.0.113.${(n % 250) + 1}` },
  { kind: 'token', re: /\b[A-Za-z0-9_-]{28,}\b/g, test: (m) => /[0-9]/.test(m) && /[A-Za-z]/.test(m) && !/^[a-z]+(_[a-z]+)+$/.test(m) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(m), fake: (m, r) => lookalike(m, r) },
];

/**
 * A scrubber for one generation run. `known` holds values that must never
 * appear (vault secrets, current values, secret-typed variables).
 */
export function createScrubber({ known = [] } = {}) {
  const fakes = new Map(); // original → fake
  const fakeSet = new Set();
  const log = []; // { kind, masked, fake, where }
  const knownList = [...new Set(known.map(String).filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);
  let counter = 0;

  const fakeFor = (original, kind, make, where) => {
    if (fakeSet.has(original)) return original;
    if (!fakes.has(original)) {
      counter += 1;
      const value = make(original, rng(hash(`${kind}:${original}`)), counter);
      fakes.set(original, value);
      fakeSet.add(value);
      log.push({ kind, masked: mask(original), fake: value, where });
    } else if (where && !log.some((l) => l.fake === fakes.get(original) && l.where === where)) {
      log.push({ kind, masked: mask(original), fake: fakes.get(original), where });
    }
    return fakes.get(original);
  };

  function text(value, where = '') {
    if (typeof value !== 'string' || !value) return value;
    let out = value.replace(/\{\{vault:([^}]+)\}\}/g, '{{$1}}');
    for (const k of knownList) if (out.includes(k)) out = out.split(k).join(fakeFor(k, 'saved secret', (m, r) => lookalike(m, r), where));
    for (const rule of RULES) {
      out = out.replace(rule.re, (m) => {
        if (fakeSet.has(m) || /\{\{|\}\}/.test(m)) return m;
        if (rule.test && !rule.test(m)) return m;
        return fakeFor(m, rule.kind, rule.fake, where);
      });
    }
    return out;
  }

  /** A whole value under a sensitive name, whatever it looks like. */
  function secretValue(value, where) {
    if (typeof value !== 'string' || !value || /^\{\{[^}]+\}\}$/.test(value.trim())) return value;
    const scheme = /^(Bearer|Basic|Token|Digest)\s+/i.exec(value);
    const rest = scheme ? value.slice(scheme[0].length) : value;
    if (/^\{\{[^}]+\}\}$/.test(rest.trim())) return value;
    return (scheme ? scheme[0] : '') + fakeFor(rest, 'credential', (m, r) => lookalike(m, r), where);
  }

  function json(value, where = '', key = '') {
    if (Array.isArray(value)) return value.map((v) => json(v, where, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v, where, k)]));
    if (typeof value === 'string') return SENSITIVE_KEY.test(key) ? secretValue(value, where) : text(value, where);
    if (typeof value === 'number' && SENSITIVE_KEY.test(key)) return Number(fakeFor(String(value), 'number', (m, r) => lookalike(m, r).replace(/^0/, '1'), where));
    return value;
  }

  /** A body: JSON is scrubbed field by field (and kept pretty), anything else as text. */
  function body(raw, where = '') {
    if (typeof raw !== 'string' || !raw.trim()) return raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return JSON.stringify(json(parsed, where), null, 2);
    } catch { /* not plain JSON: may hold {{variables}} or comments */ }
    return text(raw, where);
  }

  function headers(list = [], where = '') {
    return list.map((h) => ({ ...h, value: SENSITIVE_HEADER.test(h.key || '') ? secretValue(String(h.value ?? ''), where) : text(String(h.value ?? ''), where) }));
  }

  return { text, json, body, headers, log, isFake: (v) => fakeSet.has(v), known: knownList };
}

/**
 * Final check over the built files. Anything that looks like a credential and
 * isn't one of this run's fakes blocks publishing.
 */
export function findSecrets(files, scrubber) {
  const hits = [];
  const known = scrubber?.known || [];
  const add = (file, kind, value, index, body) => {
    if (scrubber?.isFake(value)) return;
    const line = body.slice(0, index).split('\n').length;
    hits.push({ file, kind, line, masked: mask(value) });
  };
  const checks = [
    { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\n(?!\(removed\))/g },
    { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    { kind: 'AWS key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
    { kind: 'live API key', re: /\b(sk|rk|pk)_live_[A-Za-z0-9]{16,}\b/g },
    { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
    { kind: 'Postman key', re: /\bPMAK-[A-Za-z0-9-]{20,}\b/g },
    { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  ];
  for (const f of files) {
    const body = String(f.body || '');
    for (const k of known) {
      let i = body.indexOf(k);
      while (i !== -1) { add(f.path, 'saved secret', k, i, body); i = body.indexOf(k, i + k.length); }
    }
    for (const c of checks) for (const m of body.matchAll(c.re)) add(f.path, c.kind, m[0], m.index, body);
  }
  return hits;
}
