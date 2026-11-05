// JSON bodies with comments and {{variables}}, as Postman allows. Comments are
// stripped before sending; Beautify keeps them. Also the analysis behind the
// body editor: problems with positions, bracket pairs and suggestions.

/** Splits text into strings, comments, {{variables}}, punctuation and bare values. */
function tokenize(text) {
  const out = [];
  let i = 0;
  let nl = false; // a line break came before this token
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { if (c === '\n') nl = true; i++; continue; }
    let j = i + 1;
    let type = 'lit';
    if (c === '"') {
      type = 'str';
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, text.length);
    } else if (c === '/' && text[i + 1] === '/') {
      type = 'comment';
      while (j < text.length && text[j] !== '\n') j++;
    } else if (c === '/' && text[i + 1] === '*') {
      type = 'block';
      const end = text.indexOf('*/', i + 2);
      j = end < 0 ? text.length : end + 2;
    } else if (c === '{' && text[i + 1] === '{' && text.indexOf('}}', i + 2) > 0) {
      j = text.indexOf('}}', i + 2) + 2;
    } else if ('{}[],:'.includes(c)) {
      type = 'punc';
    } else {
      while (j < text.length && !/[\s{}[\],:"]/.test(text[j]) && !(text[j] === '/' && '/*'.includes(text[j + 1]))) j++;
    }
    out.push({ type, text: text.slice(i, j), nl });
    nl = false;
    i = j;
  }
  return out;
}

/** Walks the text outside strings, replacing each comment via `swap`. Strings are copied exactly. */
function rewrite(text, swap) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    let j = i + 1;
    if (c === '"') {
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (j < text.length && text[j] !== '\n') j++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      j = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
      continue;
    }
    out += swap(text.slice(i, j));
    i = j;
  }
  return out;
}

/** Removes // and /* *\/ comments that sit outside strings. Everything else is left exactly as typed. */
export function stripJsonComments(text) {
  return rewrite(text, () => '');
}

/** Every token with its offsets. Unlike tokenize, a string or {{variable}} never runs past its line, so half-typed text stays local. */
function lex(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    let j = i + 1;
    let type = 'lit';
    if (c === '"') {
      type = 'str';
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      j = Math.min(text[j] === '"' ? j + 1 : j, text.length);
    } else if (c === '/' && text[i + 1] === '/') {
      type = 'comment';
      while (j < text.length && text[j] !== '\n') j++;
    } else if (c === '/' && text[i + 1] === '*') {
      type = 'comment';
      const end = text.indexOf('*/', i + 2);
      j = end < 0 ? text.length : end + 2;
    } else if (c === '{' && text[i + 1] === '{' && /^\{\{[^{}\n]*\}\}/.test(text.slice(i, i + 300))) {
      type = 'var';
      j = text.indexOf('}}', i) + 2;
    } else if ('{}[],:'.includes(c)) {
      type = 'punc';
    } else {
      while (j < text.length && !/[\s{}[\],:"]/.test(text[j]) && !(text[j] === '/' && '/*'.includes(text[j + 1]))) j++;
    }
    out.push({ type, text: text.slice(i, j), from: i, to: j });
    i = j;
  }
  return out;
}

const VALID_STRING = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"$/;
const VALID_LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

/**
 * Problems with exact positions: [{ from, to, message, severity }]. Comments and
 * {{variables}} are allowed. Stops at the first error, because later ones are
 * usually echoes of it; duplicate keys found before that are warnings. Written by
 * hand because the wording and positions in JSON.parse's errors differ per webview.
 */
export function jsonIssues(text) {
  const toks = lex(text).filter((t) => t.type !== 'comment');
  if (!toks.length) return [];
  const issues = [];
  let n = 0;
  const fail = (t, message) => {
    const at = t || { from: text.length, to: text.length };
    const err = new Error(message);
    err.issue = { from: at.from, to: Math.max(at.to, at.from + (t ? 1 : 0)), message, severity: 'error' };
    throw err;
  };
  const stringOk = (t) => {
    if (t.text.length < 2 || !t.text.endsWith('"')) fail(t, 'This string is missing its closing quote.');
    if (!VALID_STRING.test(t.text)) fail(t, 'This string has an invalid escape or a raw control character.');
  };
  const value = () => {
    const t = toks[n];
    if (!t) fail(null, 'The JSON ends here, but a value was expected.');
    if (t.type === 'var') { n++; return; }
    if (t.type === 'str') { stringOk(t); n++; return; }
    if (t.text === '{') return object();
    if (t.text === '[') return array();
    if (t.type === 'lit' && VALID_LITERAL.test(t.text)) { n++; return; }
    if (t.type === 'punc') fail(t, `Expected a value, but found "${t.text}".`);
    fail(t, `"${t.text}" isn't a JSON value. Strings need double quotes.`);
  };
  const object = () => {
    const open = toks[n++];
    const seen = new Set();
    if (toks[n]?.text === '}') { n++; return; }
    for (;;) {
      const k = toks[n];
      if (!k) fail(open, 'This { is never closed.');
      if (k.type !== 'str') fail(k, k.text === '}' ? 'Remove this trailing comma: JSON doesn\'t allow one.' : `Expected a key in double quotes, but found "${k.text}".`);
      stringOk(k);
      if (seen.has(k.text)) issues.push({ from: k.from, to: k.to, message: `Duplicate key ${k.text}. Only the last one takes effect.`, severity: 'warning' });
      seen.add(k.text);
      n++;
      if (toks[n]?.text !== ':') fail(toks[n] || k, `Expected ":" after the key ${k.text}.`);
      n++;
      value();
      const next = toks[n];
      if (!next) fail(open, 'This { is never closed.');
      if (next.text === '}') { n++; return; }
      if (next.text !== ',') fail(next, 'Expected "," or "}" here. Is a comma missing?');
      n++;
      if (toks[n]?.text === '}') fail(toks[n - 1], 'Remove this trailing comma: JSON doesn\'t allow one.');
    }
  };
  const array = () => {
    const open = toks[n++];
    if (toks[n]?.text === ']') { n++; return; }
    for (;;) {
      if (!toks[n]) fail(open, 'This [ is never closed.');
      value();
      const next = toks[n];
      if (!next) fail(open, 'This [ is never closed.');
      if (next.text === ']') { n++; return; }
      if (next.text !== ',') fail(next, 'Expected "," or "]" here. Is a comma missing?');
      n++;
      if (toks[n]?.text === ']') fail(toks[n - 1], 'Remove this trailing comma: JSON doesn\'t allow one.');
    }
  };
  try {
    value();
    if (toks[n]) fail(toks[n], 'Only one top-level value is allowed: remove this or wrap everything in [ ].');
  } catch (e) {
    if (e.issue) issues.push(e.issue);
    else if (!(e instanceof RangeError)) throw e; // nesting too deep to check is not worth flagging
  }
  return issues;
}

/** Bracket pairs spanning more than one token, as [openOffset, closeOffset], for code folding. */
export function bracketPairs(text) {
  const pairs = [];
  const stack = [];
  for (const t of lex(text)) {
    if (t.type !== 'punc') continue;
    if (t.text === '{' || t.text === '[') stack.push(t);
    else if (t.text === '}' || t.text === ']') {
      const open = stack.pop();
      if (open && (open.text === '{') === (t.text === '}')) pairs.push([open.from, t.from]);
    }
  }
  return pairs;
}

/** Removes comments and whitespace, keeping {{variables}}. Throws if the JSON isn't valid. */
export function minifyJsonc(text) {
  const bad = jsonIssues(text).find((i) => i.severity === 'error');
  if (bad) throw new Error(bad.message);
  return lex(text).filter((t) => t.type !== 'comment').map((t) => t.text).join('');
}

/**
 * What the caret is on, for suggestions:
 * { kind: 'key' | 'value' | null, path, prefix, from, to, quoted, used }
 * `path` names objects by key and arrays as '[]', `from`-`to` is the text a
 * suggestion replaces, and `used` holds the keys this object already has.
 */
export function contextAt(text, pos) {
  const toks = lex(text);
  const stack = [];
  let pendingKey = null; // the key whose value comes next
  let lastKey = null;
  let current = null;
  let i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.to >= pos && t.from < pos && t.type !== 'punc') { current = t; break; }
    if (t.from >= pos) break;
    if (t.type === 'comment') continue;
    if (t.text === '{' || t.text === '[') {
      stack.push({ type: t.text === '{' ? 'obj' : 'arr', key: pendingKey, expect: t.text === '{' ? 'key' : 'value', used: new Set() });
      pendingKey = null;
    } else if (t.text === '}' || t.text === ']') {
      stack.pop();
      pendingKey = null;
      if (stack.length) stack[stack.length - 1].expect = 'comma';
    } else if (t.text === ',') {
      const top = stack[stack.length - 1];
      if (top) top.expect = top.type === 'obj' ? 'key' : 'value';
    } else if (t.text === ':') {
      const top = stack[stack.length - 1];
      if (top?.type === 'obj') { top.expect = 'value'; pendingKey = lastKey; }
    } else {
      const top = stack[stack.length - 1];
      if (top?.type === 'obj' && top.expect === 'key' && t.type === 'str') {
        lastKey = t.text.slice(1, -1);
        top.used.add(lastKey);
        top.expect = 'colon';
      } else if (top) {
        top.expect = 'comma';
        pendingKey = null;
      }
    }
  }
  const top = stack[stack.length - 1];
  const none = { kind: null, path: [], prefix: '', from: pos, to: pos, quoted: false, used: new Set() };
  if (current?.type === 'comment' || current?.type === 'var') return none;
  const kind = !stack.length ? (toks.some((t) => t.to <= pos && t.type !== 'comment') ? null : 'value') : top.expect === 'key' || top.expect === 'value' ? top.expect : null;
  if (!kind) return none;
  // Keys later in the same object count as used too.
  if (top?.type === 'obj') {
    let depth = 0;
    for (let k = current ? i + 1 : i; k < toks.length; k++) {
      const t = toks[k];
      if (t.text === '{' || t.text === '[') depth++;
      else if (t.text === '}' || t.text === ']') { if (depth === 0) break; depth--; }
      else if (depth === 0 && t.type === 'str' && toks[k + 1]?.text === ':') top.used.add(t.text.slice(1, -1));
    }
  }
  const path = [];
  for (let k = 0; k < stack.length; k++) {
    if (k > 0) path.push(stack[k].key ?? '[]');
  }
  // The final segment for a value is the key it belongs to.
  if (kind === 'value' && top?.type === 'obj' && pendingKey != null) path.push(pendingKey);
  const quoted = current?.type === 'str';
  const closed = quoted && current.text.length > 1 && current.text.endsWith('"');
  return {
    kind,
    path,
    prefix: current ? text.slice(current.from + (quoted ? 1 : 0), pos) : '',
    from: current ? current.from : pos,
    to: current ? current.to : pos,
    quoted,
    closed,
    used: top?.used || new Set(),
  };
}

/** Parses text leniently: comments are dropped and bare {{variables}} become null. */
function parseLoose(text) {
  try {
    return JSON.parse(lex(text).filter((t) => t.type !== 'comment').map((t) => (t.type === 'var' ? 'null' : t.text)).join(''));
  } catch { return undefined; }
}

/**
 * Keys found in other JSON documents, per object path: Map<'a/[]/b', Map<key, typeName>>.
 * Only names and types are kept, never values, so nothing secret reaches a suggestion.
 */
export function collectKeys(texts) {
  const index = new Map();
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const walk = (v, path) => {
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, [...path, '[]']); return; }
    if (!v || typeof v !== 'object') return;
    const id = path.join('/');
    const known = index.get(id) || new Map();
    index.set(id, known);
    for (const [k, x] of Object.entries(v)) {
      if (!known.has(k) || known.get(k) === 'null') known.set(k, typeOf(x));
      walk(x, [...path, k]);
    }
  };
  for (const text of texts) {
    if (!text || text.length > 500000) continue;
    const parsed = parseLoose(text);
    if (parsed !== undefined) walk(parsed, []);
  }
  return index;
}

/** Why the body isn't valid JSON once comments and {{variables}} are set aside, or null if it is. */
export function jsonProblem(text) {
  const bad = jsonIssues(text).find((i) => i.severity === 'error');
  if (!bad) return null;
  return `Line ${text.slice(0, bad.from).split('\n').length}: ${bad.message}`;
}

/**
 * Pretty-prints JSON with two-space indents, keeping comments where they were
 * (a comment at the end of a line stays at the end of that line) and leaving
 * {{variables}} untouched.
 */
export function formatJsonc(text) {
  const toks = tokenize(text);
  const lines = [];
  let depth = 0;
  let line = '';
  let pending = false; // a line break is due before the next value
  const pad = () => '  '.repeat(depth);
  const breakLine = () => { lines.push(line.trimEnd()); line = pad(); };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'comment' || t.type === 'block') {
      if (!t.nl && line.trim()) line += t.type === 'block' ? ` ${t.text} ` : ` ${t.text}`;
      else { if (line.trim()) breakLine(); else line = pad(); line += t.text; }
      if (t.type === 'comment' || t.nl) pending = true;
      continue;
    }
    const close = t.text === '}' || t.text === ']';
    if (close) {
      depth = Math.max(0, depth - 1);
      pending = false;
      if (line.trim()) breakLine(); else line = pad();
      line += t.text;
      continue;
    }
    if (pending) { breakLine(); pending = false; }
    if (t.text === '{' || t.text === '[') {
      const next = toks[i + 1];
      if (next && next.text === (t.text === '{' ? '}' : ']')) { line += t.text + next.text; i++; continue; }
      line += t.text;
      depth++;
      pending = true;
    } else if (t.type === 'punc' && t.text === ',') {
      line += ',';
      pending = true;
    } else if (t.type === 'punc' && t.text === ':') {
      line += ': ';
    } else {
      line += t.text;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
}
