// The stylesheet and the one small script every published site ships with.
// The script only switches code tabs, adds copy buttons and runs search; pages
// work without it.

export const SITE_CSS = `/* Colours, fonts, sizes and spacing come from the theme (theme.js), appended below. */
* { box-sizing: border-box; }
html { scroll-padding-top: 72px; }
body { margin: 0; background: var(--bg); color: var(--text); font: var(--base)/1.6 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code, pre { font-family: var(--mono); font-size: 0.87em; }
code { background: color-mix(in srgb, var(--text) 7%, transparent); padding: 1px 5px; border-radius: var(--radius-sm); }
pre { background: var(--code-bg); color: var(--code-text); border: 1px solid color-mix(in srgb, var(--code-text) 12%, var(--code-bg)); border-radius: var(--radius); padding: 12px 14px; overflow: auto; position: relative; margin: 0 0 14px; line-height: 1.55; }
pre code { background: none; padding: 0; color: inherit; font-size: 1em; }
.sx-k { color: var(--syn-key); } .sx-s { color: var(--syn-string); } .sx-n { color: var(--syn-number); } .sx-l { color: var(--syn-literal); } .sx-p { color: var(--syn-punct); }
h1, h2, h3, .brand { font-family: var(--display); }
h1 { font-size: var(--h1); line-height: 1.12; margin: 6px 0 14px; font-weight: var(--heading-weight); letter-spacing: var(--heading-tracking); }
h2 { font-size: var(--h2); line-height: 1.25; margin: calc(34px * var(--space)) 0 10px; font-weight: var(--heading-weight); letter-spacing: var(--heading-tracking); }
h4 { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: calc(22px * var(--space)) 0 8px; }
p { margin: 0 0 12px; }
main p, main li { max-width: 72ch; }
.muted, .eg { color: var(--muted); }
.eg { font-size: 0.87em; }
.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 20px; padding: 12px 28px; background: color-mix(in srgb, var(--bg) 92%, transparent); border-bottom: 1px solid var(--rule); }
.brand { display: flex; align-items: center; gap: 10px; font-weight: var(--heading-weight); font-size: 1.08em; color: var(--text); }
.brand:hover { text-decoration: none; }
.brand img { height: 28px; width: auto; }
.search { position: relative; margin-left: auto; width: min(340px, 50vw); }
.search input { width: 100%; padding: 7px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--text); font: inherit; font-size: 0.93em; }
.search input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); }
#hits { position: absolute; right: 0; left: 0; top: 40px; margin: 0; padding: 6px; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 10px 30px rgba(0,0,0,.12); max-height: 60vh; overflow: auto; }
#hits a { display: block; padding: 7px 9px; border-radius: var(--radius-sm); color: var(--text); }
#hits a:hover, #hits a:focus { background: color-mix(in srgb, var(--text) 6%, transparent); text-decoration: none; }
#hits small { display: block; color: var(--muted); font-family: var(--mono); font-size: 12px; }
.layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); max-width: 1440px; margin: 0 auto; }
.side { position: sticky; top: 57px; align-self: start; height: calc(100vh - 57px); overflow: auto; padding: 22px 16px 40px 28px; border-right: 1px solid var(--rule); font-size: 0.93em; }
.side > a, .nav-group > a { display: block; padding: 4px 8px; border-radius: var(--radius-sm); color: var(--text); font-weight: 600; }
.nav-boxed .side a.on { background: color-mix(in srgb, var(--accent) 13%, transparent); }
.nav-quiet .side a.on { color: var(--accent); font-weight: 700; }
.nav-group { margin: 8px 0; }
.nav-group ul { list-style: none; margin: 2px 0 0; padding: 0; }
.nav-group li a { display: flex; gap: 8px; align-items: baseline; padding: 3px 8px; color: var(--muted); border-radius: var(--radius-sm); }
.nav-group li a:hover { color: var(--text); text-decoration: none; background: color-mix(in srgb, var(--text) 6%, transparent); }
main { padding: calc(28px * var(--space)) calc(40px * var(--space)) 80px; min-width: 0; }
.m { font: 700 11px/1 var(--mono); letter-spacing: 0.02em; min-width: 46px; display: inline-block; }
.m-get { color: var(--get); } .m-post { color: var(--post); } .m-put { color: var(--put); } .m-patch { color: var(--patch); } .m-delete { color: var(--delete); }
.endpoint { border-top: 1px solid var(--rule); padding-top: calc(26px * var(--space)); margin-top: calc(30px * var(--space)); }
.ep-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ep-head h2 { margin: 0; }
.route { display: flex; align-items: center; gap: 8px; font-size: 0.93em; }
.badge { font-size: 12px; padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
.badge.ok { color: var(--get); border-color: color-mix(in srgb, var(--get) 40%, transparent); }
.cols { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: calc(28px * var(--space)); align-items: start; }
.explain, .examples, .hero > * { min-width: 0; }
.examples { position: sticky; top: 70px; }
.label { font-size: 12px; color: var(--muted); margin: 4px 0 6px; }
table { width: 100%; border-collapse: collapse; font-size: 0.93em; margin-bottom: 8px; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--rule); padding: 6px 8px 6px 0; }
td { border-bottom: 1px solid var(--rule); padding: calc(8px * var(--space)) 8px calc(8px * var(--space)) 0; vertical-align: top; }
td.type { color: var(--muted); font-size: 0.87em; white-space: nowrap; }
.fmt { font-family: var(--mono); font-size: 12px; }
.code { font: 700 12px/1 var(--mono); padding: 3px 7px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--text) 7%, transparent); }
.code.c2 { color: var(--get); } .code.c3 { color: var(--put); } .code.c4, .code.c5 { color: var(--delete); }
.resp p { margin: 10px 0 6px; }
.tests { margin: 0; padding-left: 18px; color: var(--muted); }
.tabs { display: flex; gap: 2px; flex-wrap: wrap; margin-bottom: 6px; }
.tabs button { font: 600 12px var(--font); padding: 5px 10px; border: 1px solid transparent; border-radius: var(--radius-sm); background: none; color: var(--muted); cursor: pointer; }
.tabs button[aria-selected="true"] { color: var(--text); border-color: var(--line); background: var(--panel); }
.copy { position: absolute; top: 6px; right: 6px; font: 600 11px var(--font); padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--code-text) 25%, var(--code-bg)); border-radius: var(--radius-sm); background: var(--code-bg); color: var(--code-text); cursor: pointer; opacity: 0; }
pre:hover .copy, .copy:focus { opacity: 1; }
.steps { padding-left: 20px; }
.steps li { margin-bottom: 10px; }
.steps a { display: inline-flex; gap: 8px; align-items: baseline; margin-right: 6px; }
.groups { padding-left: 18px; }
.groups .gdesc { display: none; }
.hero { margin-bottom: 8px; }
.hero-code { display: none; }
footer { border-top: 1px solid var(--rule); padding: 18px 28px; color: var(--muted); font-size: 13px; text-align: center; }

/* ---- overview header styles */
.header-banded .hero { background: var(--accent); color: var(--on-accent); border-radius: var(--radius); padding: calc(28px * var(--space)) calc(32px * var(--space)); margin: 0 0 18px; }
.header-banded .hero h1 { margin-top: 0; }
.header-banded .hero a, .header-banded .hero code { color: inherit; }
.header-banded .hero a { text-decoration: underline; }
.header-banded .hero code { background: color-mix(in srgb, var(--on-accent) 16%, transparent); }
.header-split .hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: calc(32px * var(--space)); align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--rule); margin-bottom: 10px; }
.header-split .hero-code { display: block; }
.header-split .hero-code pre:last-child { margin-bottom: 0; }

/* ---- split: code in a dark pane down the right of each group page */
@media (min-width: 1101px) {
  .layout-split.page-group main { --pad: calc(40px * var(--space)); --pane: calc(var(--pad) + (100% - var(--pad)) * 0.54); background: linear-gradient(to right, transparent var(--pane), var(--code-bg) var(--pane)); padding-right: 0; }
  .layout-split.page-group main > h1, .layout-split.page-group main > p, .layout-split.page-group main > ul, .layout-split.page-group main > ol { max-width: calc(54% - 40px); }
  .layout-split.page-group main { padding-left: var(--pad); }
  .layout-split .endpoint { display: grid; grid-template-columns: minmax(0, 54fr) minmax(0, 46fr); align-items: start; border-top: 0; margin-top: 0; padding-top: 0; }
  .layout-split .endpoint > * { grid-column: 1; padding-right: 40px; min-width: 0; }
  .layout-split .endpoint > .ep-head { padding-top: calc(34px * var(--space)); }
  .layout-split .endpoint + .endpoint > .ep-head { border-top: 1px solid var(--rule); }
  .layout-split .cols { display: contents; }
  .layout-split .explain { grid-column: 1; padding-right: 40px; padding-bottom: calc(20px * var(--space)); }
  .layout-split .examples { min-width: 0; grid-column: 2; grid-row: 1 / span 30; position: sticky; top: 57px; padding: calc(34px * var(--space)) 28px 20px; }
  .layout-split .examples { color: var(--code-text); }
  .layout-split .examples pre { border-color: transparent; background: color-mix(in srgb, var(--code-text) 5%, var(--code-bg)); }
  .layout-split .examples .label { color: color-mix(in srgb, var(--code-text) 70%, var(--code-bg)); }
  .layout-split .examples .tabs button { color: color-mix(in srgb, var(--code-text) 72%, var(--code-bg)); }
  .layout-split .examples .tabs button[aria-selected="true"] { color: var(--code-text); border-color: color-mix(in srgb, var(--code-text) 25%, var(--code-bg)); background: transparent; }
}

/* ---- editorial: one reading column, contents on the right */
.layout-editorial .layout { grid-template-columns: minmax(0, 1fr) 230px; max-width: 1120px; }
.layout-editorial .side { order: 2; border-right: 0; border-left: 1px solid var(--rule); padding: 30px 20px 40px; }
.layout-editorial .nav-group ul { display: none; }
.layout-editorial .nav-group:has(> a.on) ul { display: block; }
.layout-editorial main { padding: calc(44px * var(--space)) calc(56px * var(--space)) 96px; max-width: 800px; width: 100%; margin: 0 auto; font-size: 1.06em; }
.layout-editorial .cols { grid-template-columns: 1fr; gap: 6px; }
.layout-editorial .examples { position: static; }
.layout-editorial .endpoint { margin-top: calc(56px * var(--space)); padding-top: calc(40px * var(--space)); }
.layout-editorial .endpoint h2 { font-size: calc(var(--h2) * 1.15); }

/* ---- index: a top menu, the overview as a grid of groups */
.layout-index .layout { display: block; max-width: 1180px; }
.layout-index .side { position: static; height: auto; display: flex; flex-wrap: wrap; gap: 4px 6px; padding: 10px 28px; border-right: 0; border-bottom: 1px solid var(--rule); }
.layout-index .nav-group { margin: 0; }
.layout-index .nav-group ul { display: none; }
.layout-index .side > a, .layout-index .nav-group > a { padding: 6px 12px; }
.layout-index main { padding: calc(32px * var(--space)) 28px 80px; }
.layout-index .groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; padding: 0; list-style: none; }
.layout-index .groups li { max-width: none; border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; background: var(--panel); }
.layout-index .groups li > a { display: block; font-family: var(--display); font-weight: var(--heading-weight); font-size: var(--h3); color: var(--text); }
.layout-index .groups .gdesc { display: block; color: var(--muted); margin-top: 4px; }

@media (max-width: 1100px) { .cols, .layout-split .endpoint { grid-template-columns: minmax(0, 1fr); } .examples { position: static; } .header-split .hero { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .layout, .layout-editorial .layout { grid-template-columns: 1fr; }
  .side, .layout-editorial .side { position: static; height: auto; border-right: 0; border-left: 0; border-bottom: 1px solid var(--rule); order: 0; }
  main, .layout-editorial main, .layout-index main { padding: 20px 16px 60px; }
  .top { padding: 10px 16px; }
  .header-banded .hero { padding: 20px; }
  table { display: block; overflow-x: auto; }
  td code { overflow-wrap: anywhere; }
  .search { width: auto; flex: 1; }
}
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
