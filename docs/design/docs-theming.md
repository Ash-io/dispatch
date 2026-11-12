# Documentation themes

Status: proposed. Extends [Published documentation](published-docs.md), as built in PR #18.

Every published site currently uses one template, with the accent colour as the only choice. Sites end up looking like each other, and like every other generated API reference. This spec lets the AI design a site's look from the team's brand, inside limits that keep the site safe, readable and consistent between versions.

## What stays the same

- **The AI never writes HTML or JavaScript.** Pages are still built by `build.js` from the fact sheet. The AI's design output is a theme: a JSON document of choices, plus at most a small block of extra CSS that is cleaned before use.
- **The AI never sees the API.** Design calls get brand facts and the shape of the site (how many groups and endpoints, the longest path), never requests, examples or prose.
- **A design is chosen once and kept.** The theme is saved with each published version and reused until someone redesigns. Publishing new content never changes the look.
- **It works without AI.** Hand-made presets cover teams with AI off, or with a model that isn't good at design.
- **The published site's rules don't loosen.** No outside requests, no new scripts, the same final secret scan.

## Layouts

Colour and fonts on one layout still look like one template. The variety has to start with layouts, and those are written by hand in `build.js`, not generated.

| Layout | Shape | Suits |
|---|---|---|
| `reference` | Today's layout: top bar, sidebar, two columns per endpoint | Large APIs, many groups |
| `split` | Three panes: sidebar, prose, and a dark code pane fixed on the right for the whole page | Integration-heavy APIs where samples matter most |
| `editorial` | One wide reading column, large type, endpoints as chapters, a contents list on the right, code inline | Small APIs, public developer products |
| `index` | Top menu, overview as a grid of groups, each group a page with endpoints stacked | APIs with a few distinct areas |

All four use the same parts with the same class names and IDs: endpoint sections, parameter and field tables, code tabs, the search box and the changelog. Search, links to `#endpoint` anchors, the code tab script and the OpenAPI links keep working whatever the layout. Each layout has its own mobile behaviour and is tested at 390 px and 1280 px.

## The theme

A theme is a JSON document, validated against a schema in `src/js/docgen/theme.js`:

```json
{
  "version": 1,
  "layout": "split",
  "mode": "auto",
  "colors": {
    "light": { "bg": "#f7f5f0", "surface": "#ffffff", "text": "#1f1d1a", "muted": "#5f5a52", "line": "#e2ddd3",
               "accent": "#b4462b", "onAccent": "#ffffff", "codeBg": "#1d1b19", "codeText": "#ece7de",
               "get": "#2f7a4f", "post": "#9a5b13", "put": "#2f5f9a", "patch": "#6b4fa0", "delete": "#a23a3a" },
    "dark":  { "...": "same keys" }
  },
  "syntax": { "key": "#e6b673", "string": "#9fd39a", "number": "#f0a37a", "literal": "#c9a0f0", "punct": "#8c857a" },
  "type": {
    "display": "fraunces", "body": "inter", "mono": "jetbrains-mono",
    "baseSize": 16, "scale": 1.25, "headingWeight": 600, "headingTracking": -0.01
  },
  "shape": { "radius": 6, "borders": "hairline", "density": "regular" },
  "header": "banded",
  "nav": "quiet",
  "extraCss": ""
}
```

- `mode`: `auto` follows the reader's setting; `light` and `dark` force one, and then only that palette is required.
- Colours are hex, so contrast can be measured in code. The prompt asks the model to reason in OKLCH and to tint greys towards the brand hue.
- `type.*` font values are IDs from the font catalogue (below). Any other value fails validation.
- `header` sets the overview page's top: `plain`, `banded` (a full-width band in a brand colour) or `split` (the intro next to a first request and its response).
- `nav` is `quiet` (text only) or `boxed` (the current item filled).
- `density` (`compact`, `regular`, `airy`) sets spacing.

`build.js` turns the theme into CSS custom properties and layout classes. The current `SITE_CSS` becomes the base stylesheet for the `reference` layout, and the default theme reproduces today's look exactly.

## Fonts

Published pages can't load anything from outside, so fonts ship with the site.

- **Catalogue:** about 24 families under the SIL Open Font License, chosen to cover distinct voices: geometric, humanist and grotesque sans, a few serifs and slab serifs for display, and four monospaces. Each entry records its voice, the weights shipped and what it pairs with. The prompt gets this list; the model can't name a font outside it.
- **Files:** Latin subsets as WOFF2, two or three weights per family, about 25 to 40 KB per weight.
- **In the published site:** `assets/fonts.css`, with each font as a `data:` URL, plus `assets/fonts-license.txt` with the licence and copyright notices the OFL requires. Only the families the theme uses are included.
- **Server change:** the CSP's `font-src 'self'` becomes `font-src 'self' data:`, in both `server/src/docs.rs` and `DOCS_CSP` in `worker/src/index.js`. A `data:` font makes no network request. The contract tests check the header.

## Brand input

The Documentation panel gets a **Design** step. Everything in it is optional except the site name.

- **Logo:** SVG or PNG.
  - An SVG is cleaned before use: no `<script>`, `<foreignObject>`, event attributes, or `href`s outside the file. It's then published as `assets/logo.svg`.
  - A PNG stays inline as a `data:` URL, as `logoDataUrl` already allows. The panel exposes the logo field, which the build already supports but the panel never passes.
- **Brand colours:** taken from the logo in code, by clustering its pixels and dropping near-white and near-black. They're shown as swatches the author can edit or add to.
- **Company website:** optional. Rust fetches the home page and its stylesheets, and code extracts brand facts:
  - `theme-color`;
  - colours used in CSS custom properties and the most common declared colours;
  - `font-family` names.

  The page's text is never sent to the model, only these extracted values, so instructions hidden on a website can't steer the design.
- **Audience and tone:** a sentence such as "fintech engineers integrating payouts", and up to three words from a short list (calm, technical, warm, bold, playful, formal, minimal, editorial).
- **Sites you like:** optional names of documentation sites, used as a direction for tone. The model is told to take a direction from them, not copy them.

## Generating designs

One call per design direction, through the provider chosen for documentation (`ask(system, prompt, schema)`, the same function the writing step uses). The three directions are:

1. **Closest to the brand.**
2. **Bolder:** more colour committed to the surface, a stronger display font.
3. **Quieter:** restrained colour, more white space.

Each call gets:
- the brand facts;
- the audience and tone;
- the site's shape;
- the layout descriptions;
- the font catalogue;
- the theme schema.

The system prompt carries the design rules:
- pick a colour strategy before picking colours;
- no pure black or white;
- tint the greys towards the brand hue;
- lower the chroma near very light and very dark;
- body text 65 to 75 characters wide;
- heading sizes at least 1.25 times apart;
- a display font and a body font from different voices;
- avoid the look someone would guess from the industry alone (fintech in navy and gold, developer tools in neon on black).

The site's shape steers the layout: `editorial` and `index` are offered only when the site has few enough endpoints for them to read well.

## Checks

Every theme goes through these checks before the author sees it.

1. **Schema:** fields, types, catalogue fonts, allowed values.
2. **Contrast:** WCAG 2.1, measured in code, in every palette the mode uses.
   - 4.5:1 for `text`, `muted`, `accent`, the five method colours on `bg` and `surface`, and `onAccent` on `accent`.
   - 4.5:1 for `codeText` and every syntax colour on `codeBg`.
   - 3:1 for `line` against `bg`, because tables rely on it.
3. **Extra CSS:** cleaned (below).
4. **Render check:** the site is built with the theme, the Node tests' link check runs on it, and the widest line of body text is measured at 1280 px.

A theme that fails gets one retry, sent with the failures and their numbers, for example `muted on bg is 3.1:1, needs 4.5:1`. If it fails again, colour failures are fixed in code: the failing colour's OKLCH lightness is moved until it passes, keeping hue and chroma. Any other failure drops that direction. The author sees the designs that passed, and is told when one was dropped.

## Extra CSS

For touches the theme can't express, such as a pattern in the header band or a different table style. It is capped at 8 KB and cleaned with a small CSS tokenizer in `theme.js`, not with regular expressions.

- Every selector is scoped under `body` and must use the site's own classes. `*`, `html` and `:root` are refused.
- These are removed, and each removal is shown in review:
  - `@import`, `@font-face`, `@namespace`;
  - `url()`, `image-set()`, `expression()`, `behavior`, `-moz-binding`, `content` other than plain strings;
  - `position: fixed`;
  - `display: none`, `visibility: hidden`, `opacity` below 0.2, and font sizes below 12 px. These stop the CSS hiding content, including review marks;
  - `outline: none` or `outline: 0` on anything that can take focus.
- Gradients are allowed except as text fill: `background-clip: text` is removed.

With no `url()`, the CSS can't make a request, which also closes off reading attributes out through CSS selectors.

## Review

- The three designs appear side by side, each a live preview in the existing sandboxed iframe of the overview page and one endpoint page, with light, dark, desktop and phone toggles.
- The author picks one. Then:
  - **Direct controls** edit the theme without the AI: layout, accent and other colours, display and body font, radius, density, header style. The checks run on every change, and a failure shows in place, for example "Muted text is 3.9:1 on the background; needs 4.5:1".
  - **Ask for a change** sends the current theme and one instruction ("warmer", "less rounded", "the header feels heavy") and gets a revised theme back, through the same checks.
  - **Reset** returns to the default theme.
- What the review shows:
  - the contrast table for the chosen theme;
  - anything removed from the extra CSS;
  - which fonts and logo will be published, with their sizes.

## Presets

Six hand-made themes spread across the four layouts. They're offered:
- when AI writing is off;
- when the documentation provider is a model on this machine, as the suggested option, though the author can still ask that model;
- whenever the author wants a starting point.

A preset is an ordinary theme, so the direct controls and "Ask for a change" work on it.

## Storage and versions

- The chosen theme is published in each version as `_dispatch/theme.json`, next to `_dispatch/structure.json`.
- The next build reads it from the current version, the same way `docsite.js` reads `structure.json` today. So the whole team shares one design without a schema change, and rolling back a version rolls back its look too.
- A design that hasn't been published yet lives in the device's settings for that site, as the accent colour does today. The per-device `accent` setting goes, and an existing value becomes the accent of the first theme.
- The logo and font files are part of the version, so the 20 MB and 1,000-file limits cover them.

## Roles

Changing the design is part of publishing, so editors and above with access to the workspace can do it, as they can publish now. Admins can turn this off per site ("Design locked"). Then only admins can change the theme, and a publish by anyone else keeps the current theme.

The lock is a new boolean on `docs_sites`. Add it to `server/src/db.rs`, `worker/schema.sql` and the Worker migrations together, and cover it in the contract tests.

## Code layout

- `src/js/docgen/theme.js`: schema, default theme, presets, contrast maths, OKLCH correction, CSS cleaning, SVG cleaning, theme to CSS.
- `src/js/docgen/fonts.js`: the catalogue, and reading font files into `fonts.css`.
- `src/js/docgen/design.js`: brand facts from a logo and a website, prompts, the three directions, and the retry-then-fix loop.
- `src/js/docgen/build.js` and `assets.js`: the four layouts and the base stylesheets.
- `src/js/ui/docsite.js`: the Design step and the review controls.
- `src-tauri`: fetching the brand website. It reuses the HTTP client, caps the response size and follows at most a few redirects, and returns only the HTML and CSS text to the page.
- `bridge.js` and `mock.js`: the website fetch, with the mock returning a sample site.
- `server/src/docs.rs` and `worker/src/index.js`: the CSP change and the design lock.

## Testing

- `npm test`:
  - schema validation;
  - contrast values against known pairs;
  - OKLCH correction always reaching 4.5:1;
  - CSS cleaning against a list of hostile inputs (`url()` in every property that takes one, escapes, comments splitting tokens, `@import` in different cases);
  - SVG cleaning;
  - every preset passing every check;
  - each layout building with working links and anchors.
- Browser check of every layout and preset at 390 px and 1280 px, in light and dark. Report anything that couldn't be checked.
- Contract tests: the new CSP header and the design lock, against both servers.

## Release plan

1. **Themes without AI.** The theme schema and checks, the four layouts, the font catalogue, presets, direct controls, the logo field, and storage in `_dispatch/theme.json`. This alone fixes "every site looks the same".
2. **AI designs.** Brand facts from the logo, the three directions, retry and correction, and "Ask for a change".
3. **Website input and extra CSS.** Brand facts from a website, and cleaned extra CSS.

## Open questions

- **Font delivery.** Bundling the catalogue adds roughly 2 MB to the app, against a download that's 8 MB today. The alternative is downloading a font the first time a theme uses it, from a pinned URL with a SHA-256 check, and caching it. That keeps the app small, but designing then needs a network connection. Proposal: download on first use.
- **Images as input.** Models that accept images could look at the logo or a screenshot of the brand site directly. Extracted colours work with every provider, so they come first; image input could follow for providers that support it.
- **Custom fonts.** Teams with their own licensed font would need to upload it, and confirm they're allowed to publish it on the web. Left out of this spec.
