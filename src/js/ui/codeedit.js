// Code editor for JSON bodies and the response viewer, on CodeMirror (vendored,
// loaded on first use). Exposes the same small surface as codeArea: el, value,
// setValue and setLang. If the bundle can't load, it falls back to codeArea.

import { h } from './dom.js';
import { loadVendor } from '../vendor.js';
import { codeArea, varTitle, SCOPE_LABEL } from './components.js';
import { jsonIssues, bracketPairs, contextAt } from '../jsonc.js';

const MAX_ANALYSE = 1_000_000; // above this, skip problem checks and suggestions while typing
const JS_KEYWORDS = new Set('async await break case catch class const continue default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while yield'.split(' '));

// CodeMirror bindings that would also fire the app's own shortcuts (see app.js).
const TAKEN_KEYS = new Set(['Mod-Enter', 'Shift-Mod-k', 'Mod-Shift-l']);
const free = (bindings) => bindings.filter((b) => !TAKEN_KEYS.has(b.key));

/** JSON with comments and {{variables}}, or JavaScript. Other languages are plain text. */
function languageFor(cm, lang) {
  const js = lang === 'javascript';
  return cm.StreamLanguage.define({
    name: lang,
    startState: () => ({ depth: 0, comment: false }),
    token(stream, state) {
      if (state.comment) {
        if (stream.skipTo('*/')) { stream.match('*/'); state.comment = false; } else stream.skipToEnd();
        return 'comment';
      }
      if (stream.eatSpace()) return null;
      if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
      if (stream.match('/*')) { state.comment = true; return 'comment'; }
      if (stream.match(/^\{\{[^{}\n]*\}\}/)) return null; // coloured by varMarks
      const c = stream.peek();
      if (c === '"' || (js && (c === "'" || c === '`'))) {
        stream.next();
        let esc = false;
        for (let n = stream.next(); n; n = stream.next()) {
          if (n === c && !esc) break;
          esc = !esc && n === '\\';
        }
        return !js && /^\s*:/.test(stream.string.slice(stream.pos)) ? 'propertyName' : 'string';
      }
      if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number';
      const word = stream.match(/^[A-Za-z_$][\w$]*/);
      if (word) {
        if (word[0] === 'true' || word[0] === 'false') return 'bool';
        if (word[0] === 'null' || word[0] === 'undefined') return 'null';
        return js && JS_KEYWORDS.has(word[0]) ? 'keyword' : null;
      }
      stream.next();
      if ('{[('.includes(c)) { state.depth++; return 'bracket'; }
      if ('}])'.includes(c)) { state.depth = Math.max(0, state.depth - 1); return 'bracket'; }
      return null;
    },
    indent: (state, after, cx) => Math.max(0, state.depth - (/^[}\])]/.test(after) ? 1 : 0)) * cx.unit,
    languageData: {
      commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
      closeBrackets: { brackets: ['(', '[', '{', '"'] },
      indentOnInput: /^\s*[}\])]$/,
    },
  });
}

const pairsCache = new WeakMap();
/** Fold ranges per line start. Where one line opens several brackets, the outermost folds. */
function foldsFor(doc) {
  let map = pairsCache.get(doc);
  if (map) return map;
  map = new Map();
  for (const [open, close] of bracketPairs(doc.toString())) {
    const line = doc.lineAt(open);
    if (close <= line.to) continue;
    const had = map.get(line.from);
    if (!had || open + 1 < had.from) map.set(line.from, { from: open + 1, to: close });
  }
  pairsCache.set(doc, map);
  return map;
}

/** Views still alive, so editors dropped by a re-render release their listeners. */
const live = new Set();
let sweeper = null;
function track(view) {
  live.add(view);
  sweeper = sweeper || setInterval(() => {
    for (const v of live) {
      if (v.dom.isConnected) { v.dom.seen = true; v.dom.gone = false; continue; }
      if (v.dom.seen && v.dom.gone) { v.destroy(); live.delete(v); } else if (v.dom.seen) v.dom.gone = true;
    }
  }, 30000);
}

/**
 * opts: { value, lang, placeholder, minHeight, oninput, readOnly, wrap,
 *         resolver () => Resolver, for {{variables}},
 *         keys () => Map from collectKeys, for JSON key suggestions,
 *         onSearchClose }
 */
export function codeEditor(opts) {
  const { oninput, placeholder = '', minHeight = 160, readOnly = false, wrap = false, resolver, keys, onSearchClose } = opts;
  let lang = opts.lang || 'json';
  let text = opts.value || '';
  let view = null;
  let cm = null;
  let fallback = null;
  let silent = false;
  let wantSearch = false;
  let languageSlot = null;
  let lintSlot = null;
  let repaintEffect = null;

  const issueLine = h('button', { class: 'cm-issue', hidden: true, type: 'button' });
  const box = h('div', { class: 'cm-box' }, h('pre', { class: 'cm-loading' }, text));
  const host = h('div', { class: ['cm-host', readOnly && 'readonly'], style: { minHeight: readOnly ? null : `${minHeight}px` } }, box, readOnly ? null : issueLine);

  function completions(context) {
    const { state, pos, explicit } = context;
    const before = state.sliceDoc(Math.max(0, pos - 200), pos);
    const v = /\{\{([^{}\s]*)$/.exec(before);
    if (v) {
      if (!resolver) return null;
      const q = v[1].toLowerCase();
      const withDynamic = !q || q.startsWith('$');
      const rank = (n) => (n.name.toLowerCase().startsWith(q) ? 0 : 2) + (n.scope === 'dynamic' ? 1 : 0);
      const found = resolver().names().filter((n) => (withDynamic || n.scope !== 'dynamic') && n.name.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b)).slice(0, 40);
      if (!found.length) return null;
      return {
        from: pos - v[1].length,
        filter: false,
        options: found.map((n) => ({
          label: n.name,
          detail: SCOPE_LABEL[n.scope] || n.scope,
          info: n.scope === 'dynamic' ? 'New random value on each send' : n.secret || n.scope === 'vault' ? '••••••' : String(n.value ?? ''),
          type: 'variable',
          // Swallow the rest of a name being edited and its closing braces.
          apply: (ed, _c, from, to) => {
            const rest = /^[^{}\s]*\}\}/.exec(ed.state.sliceDoc(to, to + 200))?.[0] || '';
            const insert = `${n.name}}}`;
            ed.dispatch({ changes: { from, to: to + rest.length, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
          },
        })),
      };
    }
    if (lang !== 'json' || state.doc.length > MAX_ANALYSE) return null;
    const c = contextAt(state.doc.toString(), pos);
    if (!c.kind || (!explicit && !c.prefix && !c.quoted)) return null;
    if (c.kind === 'value') {
      if (c.quoted) return null;
      return { from: c.from, options: ['true', 'false', 'null'].map((label) => ({ label, type: 'keyword' })) };
    }
    const known = keys?.()?.get(c.path.join('/'));
    if (!known) return null;
    const options = [...known].filter(([k]) => !c.used.has(k) || k === c.prefix).map(([k, type]) => ({
      label: k,
      detail: type,
      type: 'property',
      apply: (ed) => {
        const end = c.closed ? c.to : ed.state.selection.main.head;
        const hasColon = /^\s*:/.test(ed.state.sliceDoc(end, end + 40));
        const insert = `${JSON.stringify(k)}${hasColon ? '' : ': '}`;
        ed.dispatch({ changes: { from: c.from, to: end, insert }, selection: { anchor: c.from + insert.length }, userEvent: 'input.complete' });
      },
    }));
    if (!options.length) return null;
    return { from: c.quoted ? c.from + 1 : c.from, options };
  }

  function problems(ed) {
    const doc = ed.state.doc;
    const found = lang === 'json' && doc.length <= MAX_ANALYSE ? jsonIssues(doc.toString()) : [];
    const first = found.find((i) => i.severity === 'error') || found[0];
    issueLine.hidden = !first;
    if (first) {
      const at = Math.min(first.from, doc.length);
      issueLine.textContent = `Line ${doc.lineAt(at).number}: ${first.message}`;
      issueLine.classList.toggle('warn', first.severity === 'warning');
      issueLine.onclick = () => { ed.dispatch({ selection: { anchor: at }, scrollIntoView: true }); ed.focus(); };
    }
    return found.map((i) => ({ from: Math.min(i.from, doc.length), to: Math.min(i.to, doc.length), message: i.message, severity: i.severity }));
  }

  function build(lib) {
    cm = lib;
    repaintEffect = cm.StateEffect.define();
    languageSlot = new cm.Compartment();
    lintSlot = new cm.Compartment();
    const varMatcher = new cm.MatchDecorator({
      regexp: /\{\{([^{}\n]*)\}\}/g,
      decoration: (m) => cm.Decoration.mark({ class: resolver && !resolver().lookup(m[1].trim()) ? 'c-var bad' : 'c-var' }),
    });
    const varMarks = cm.ViewPlugin.fromClass(class {
      constructor(v) { this.marks = varMatcher.createDeco(v); }
      update(u) {
        this.marks = u.transactions.some((t) => t.effects.some((e) => e.is(repaintEffect))) ? varMatcher.createDeco(u.view) : varMatcher.updateDeco(u, this.marks);
      }
    }, { decorations: (p) => p.marks });
    const varHover = cm.hoverTooltip((v, pos) => {
      if (!resolver) return null;
      const line = v.state.doc.lineAt(pos);
      for (const m of line.text.matchAll(/\{\{[^{}\n]*\}\}/g)) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        if (pos < from || pos > to) continue;
        return { pos: from, end: to, above: true, create: () => ({ dom: h('div', { class: 'cm-var-tip' }, varTitle(m[0], resolver())) }) };
      }
      return null;
    });
    const colours = cm.HighlightStyle.define([
      { tag: cm.tags.propertyName, class: 'j-key' },
      { tag: cm.tags.string, class: 'j-str' },
      { tag: cm.tags.number, class: 'j-num' },
      { tag: cm.tags.bool, class: 'j-bool' },
      { tag: cm.tags.null, class: 'j-null' },
      { tag: cm.tags.comment, class: 'c-com' },
      { tag: cm.tags.keyword, class: 'c-kw' },
    ]);
    const languageFns = () => (lang === 'json' || lang === 'javascript' ? languageFor(cm, lang) : []);
    const lintFor = () => (lang === 'json' && !readOnly ? [cm.linter(problems, { delay: 250 }), cm.lintGutter()] : []);
    const extensions = [
      cm.lineNumbers(),
      cm.highlightActiveLineGutter(),
      cm.codeFolding(),
      cm.foldGutter({ openText: '▾', closedText: '▸' }),
      cm.foldService.of((state, lineStart) => (lang === 'json' ? foldsFor(state.doc).get(lineStart) || null : null)),
      cm.drawSelection(),
      cm.syntaxHighlighting(colours),
      cm.bracketMatching(),
      cm.highlightSelectionMatches(),
      cm.search({ top: true }),
      cm.EditorState.tabSize.of(2),
      cm.indentUnit.of('  '),
      languageSlot.of(languageFns()),
      varMarks,
      varHover,
      cm.EditorView.updateListener.of((u) => {
        if (u.docChanged && !silent) oninput?.(u.state.doc.toString());
        // The panel closing is how the toolbar's Find button learns it's off.
        if (wantSearch && !u.view.dom.querySelector('.cm-search')) { wantSearch = false; onSearchClose?.(); }
      }),
      cm.keymap.of([
        { key: 'Mod-Alt-[', run: cm.foldCode },
        { key: 'Mod-Alt-]', run: cm.unfoldCode },
        ...free(cm.searchKeymap),
      ]),
    ];
    if (wrap) extensions.push(cm.EditorView.lineWrapping);
    if (readOnly) {
      extensions.push(cm.EditorState.readOnly.of(true), cm.keymap.of(free(cm.defaultKeymap)));
    } else {
      extensions.push(
        cm.history(),
        cm.highlightActiveLine(),
        cm.rectangularSelection(),
        cm.indentOnInput(),
        cm.closeBrackets(),
        cm.autocompletion({ override: [completions], icons: false, activateOnTyping: true, tooltipClass: () => 'cm-suggest' }),
        lintSlot.of(lintFor()),
        cm.EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        cm.keymap.of([
          ...cm.closeBracketsKeymap,
          ...cm.completionKeymap,
          { key: 'Tab', run: cm.acceptCompletion },
          ...free(cm.historyKeymap),
          ...free(cm.defaultKeymap),
          cm.indentWithTab,
        ]),
      );
      if (placeholder) extensions.push(cm.placeholder(placeholder));
    }
    view = new cm.EditorView({ doc: text, extensions, parent: box });
    box.querySelector('.cm-loading')?.remove();
    track(view);
    if (wantSearch) cm.openSearchPanel(view);
    if (focusWanted) view.focus();
  }

  const fall = () => {
    fallback = codeArea({ value: text, lang, placeholder, minHeight, oninput });
    if (readOnly) fallback.readOnly = true;
    box.replaceChildren(fallback.el);
  };
  let focusWanted = false;
  loadVendor('cm').then(build).catch(fall);

  const ed = {
    el: host,
    get value() { return view ? view.state.doc.toString() : fallback ? fallback.value : text; },
    set value(v) {
      text = v;
      if (fallback) { fallback.value = v; return; }
      if (!view) { const l = box.querySelector('.cm-loading'); if (l) l.textContent = v; return; }
      if (view.state.doc.toString() === v) return;
      silent = true;
      // Its own undo step, so Beautify or Minify can be undone on their own.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, annotations: cm.isolateHistory.of('full') });
      silent = false;
    },
    setValue(v) { ed.value = v; },
    setLang(l) {
      lang = l;
      if (fallback) { fallback.setLang?.(l); return; }
      if (!view) return;
      issueLine.hidden = true;
      view.dispatch({ effects: [
        languageSlot.reconfigure(lang === 'json' || lang === 'javascript' ? languageFor(cm, lang) : []),
        lintSlot.reconfigure(lang === 'json' && !readOnly ? [cm.linter(problems, { delay: 250 }), cm.lintGutter()] : []),
      ] });
    },
    focus() { if (view) view.focus(); else focusWanted = true; },
    repaint() { if (view) view.dispatch({ effects: repaintEffect.of(null) }); },
    openSearch() { wantSearch = true; if (view) cm.openSearchPanel(view); },
  };
  host.repaint = ed.repaint;
  return ed;
}
