// The stylesheet and the one small script every published site ships with.
// The script only switches code tabs, adds copy buttons and runs search; pages
// work without it.

export const SITE_CSS = `:root {
  color-scheme: light dark;
  --accent: #2f6f5e;
  --bg: #fbfbf9; --panel: #ffffff; --text: #1d1f1e; --muted: #67706c; --line: #e4e6e1; --code-bg: #f3f4f0;
  --get: #2f7a4f; --post: #9a5b13; --put: #2f5f9a; --patch: #6b4fa0; --delete: #a23a3a;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #141615; --panel: #1b1e1c; --text: #e7e9e6; --muted: #9aa29e; --line: #2c312e; --code-bg: #202421;
    --get: #6fcf97; --post: #f2b46b; --put: #7fb2f0; --patch: #b79cf0; --delete: #f08a8a; }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 72px; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre { font-family: var(--mono); font-size: 13px; }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow: auto; position: relative; margin: 0 0 14px; }
pre code { background: none; padding: 0; }
h1 { font-size: 30px; line-height: 1.2; margin: 6px 0 14px; letter-spacing: -0.01em; }
h2 { font-size: 21px; margin: 34px 0 10px; }
h4 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 22px 0 8px; }
p { margin: 0 0 12px; }
.muted, .eg { color: var(--muted); }
.eg { font-size: 13px; }
.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 20px; padding: 12px 28px; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; color: var(--text); }
.brand img { height: 26px; width: auto; }
.search { position: relative; margin-left: auto; width: min(340px, 50vw); }
.search input { width: 100%; padding: 7px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; }
.search input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); }
#hits { position: absolute; right: 0; left: 0; top: 40px; margin: 0; padding: 6px; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.12); max-height: 60vh; overflow: auto; }
#hits a { display: block; padding: 7px 9px; border-radius: 6px; color: var(--text); }
#hits a:hover, #hits a:focus { background: var(--code-bg); text-decoration: none; }
#hits small { display: block; color: var(--muted); font-family: var(--mono); font-size: 12px; }
.layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); max-width: 1440px; margin: 0 auto; }
.side { position: sticky; top: 57px; align-self: start; height: calc(100vh - 57px); overflow: auto; padding: 22px 16px 40px 28px; border-right: 1px solid var(--line); font-size: 14px; }
.side > a, .nav-group > a { display: block; padding: 4px 8px; border-radius: 6px; color: var(--text); font-weight: 600; }
.side a.on { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.nav-group { margin: 8px 0; }
.nav-group ul { list-style: none; margin: 2px 0 0; padding: 0; }
.nav-group li a { display: flex; gap: 8px; align-items: baseline; padding: 3px 8px; color: var(--muted); border-radius: 6px; }
.nav-group li a:hover { color: var(--text); text-decoration: none; background: var(--code-bg); }
main { padding: 28px 40px 80px; min-width: 0; }
.m { font: 700 11px/1 var(--mono); letter-spacing: 0.02em; min-width: 46px; display: inline-block; }
.m-get { color: var(--get); } .m-post { color: var(--post); } .m-put { color: var(--put); } .m-patch { color: var(--patch); } .m-delete { color: var(--delete); }
.endpoint { border-top: 1px solid var(--line); padding-top: 26px; margin-top: 30px; }
.ep-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ep-head h2 { margin: 0; }
.route { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.route code { font-size: 14px; }
.badge { font-size: 12px; padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
.badge.ok { color: var(--get); border-color: color-mix(in srgb, var(--get) 40%, transparent); }
.cols { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 28px; align-items: start; }
.examples { position: sticky; top: 70px; }
.label { font-size: 12px; color: var(--muted); margin: 4px 0 6px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 8px; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); padding: 6px 8px 6px 0; }
td { border-bottom: 1px solid var(--line); padding: 8px 8px 8px 0; vertical-align: top; }
td.type { color: var(--muted); font-size: 13px; white-space: nowrap; }
.fmt { font-family: var(--mono); font-size: 12px; }
.code { font: 700 12px/1 var(--mono); padding: 3px 7px; border-radius: 5px; background: var(--code-bg); }
.code.c2 { color: var(--get); } .code.c3 { color: var(--put); } .code.c4, .code.c5 { color: var(--delete); }
.resp p { margin: 10px 0 6px; }
.tests { margin: 0; padding-left: 18px; color: var(--muted); }
.tabs { display: flex; gap: 2px; flex-wrap: wrap; margin-bottom: 6px; }
.tabs button { font: 600 12px var(--font); padding: 5px 10px; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
.tabs button[aria-selected="true"] { color: var(--text); border-color: var(--line); background: var(--panel); }
.copy { position: absolute; top: 6px; right: 6px; font: 600 11px var(--font); padding: 3px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--panel); color: var(--muted); cursor: pointer; opacity: 0; }
pre:hover .copy, .copy:focus { opacity: 1; }
.steps { padding-left: 20px; }
.steps li { margin-bottom: 10px; }
.steps a { display: inline-flex; gap: 8px; align-items: baseline; margin-right: 6px; }
.groups { padding-left: 18px; }
footer { border-top: 1px solid var(--line); padding: 18px 28px; color: var(--muted); font-size: 13px; text-align: center; }
@media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } .examples { position: static; } }
@media (max-width: 760px) { .layout { grid-template-columns: 1fr; } .side { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 20px; } .top { padding: 10px 16px; } }
`;

export const SITE_JS = `(function () {
  var root = document.body.getAttribute('data-root') || '';
  // Code sample tabs; the chosen language sticks across pages.
  function pick(lang) {
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.lang === lang)); });
    document.querySelectorAll('pre.sample').forEach(function (p) { p.hidden = p.dataset.lang !== lang; });
    try { localStorage.setItem('docs-lang', lang); } catch (e) {}
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.tabs button');
    if (b) pick(b.dataset.lang);
  });
  try { var saved = localStorage.getItem('docs-lang'); if (saved && document.querySelector('pre.sample[data-lang="' + saved + '"]')) pick(saved); } catch (e) {}
  // Copy buttons.
  document.querySelectorAll('pre').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'copy'; btn.textContent = 'Copy';
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent).then(function () {
        btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200);
      });
    });
    pre.appendChild(btn);
  });
  // Search over search.json.
  var q = document.getElementById('q'), hits = document.getElementById('hits'), index = null;
  if (!q) return;
  function load() { if (!index) index = fetch(root + 'search.json').then(function (r) { return r.json(); }).catch(function () { return []; }); return index; }
  q.addEventListener('focus', load);
  q.addEventListener('input', function () {
    var term = q.value.trim().toLowerCase();
    if (!term) { hits.hidden = true; return; }
    load().then(function (list) {
      var words = term.split(/\\s+/);
      var found = list.filter(function (x) { var hay = (x.t + ' ' + x.s + ' ' + x.x).toLowerCase(); return words.every(function (w) { return hay.indexOf(w) !== -1; }); }).slice(0, 12);
      hits.textContent = '';
      found.forEach(function (x) {
        var li = document.createElement('li'), a = document.createElement('a'), s = document.createElement('small');
        a.href = root + x.u; a.textContent = x.t; s.textContent = x.s; a.appendChild(s); li.appendChild(a); hits.appendChild(li);
      });
      if (!found.length) { var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Nothing found'; hits.appendChild(li); }
      hits.hidden = false;
    });
  });
  q.addEventListener('keydown', function (e) { if (e.key === 'Escape') { q.value = ''; hits.hidden = true; } if (e.key === 'Enter') { var a = hits.querySelector('a'); if (a) location.href = a.href; } });
  document.addEventListener('click', function (e) { if (!e.target.closest('.search')) hits.hidden = true; });
})();
`;
