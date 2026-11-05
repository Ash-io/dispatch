#!/usr/bin/env bash
# Rebuilds src/vendor/codemirror.min.js and its licence file. The app has no build
# step, so the bundle is committed like the other vendored libraries.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund esbuild@0.25.12 \
  @codemirror/state@6 @codemirror/view@6 @codemirror/commands@6 @codemirror/language@6 \
  @codemirror/autocomplete@6 @codemirror/lint@6 @codemirror/search@6 @lezer/highlight@1
cp "$root/scripts/codemirror-entry.js" entry.js
npx esbuild entry.js --bundle --minify --format=iife --global-name=__cm --target=es2020 \
  --legal-comments=none --outfile="$root/src/vendor/codemirror.min.js"
node -e '
const fs = require("fs"), path = require("path");
const seen = [];
for (const scope of ["@codemirror", "@lezer"]) for (const d of fs.readdirSync(`node_modules/${scope}`)) seen.push(`${scope}/${d}`);
seen.push("style-mod", "w3c-keyname", "crelt");
const out = seen.filter((p) => fs.existsSync(`node_modules/${p}`)).map((p) => {
  const dir = `node_modules/${p}`;
  const v = JSON.parse(fs.readFileSync(`${dir}/package.json`)).version;
  const lic = fs.readdirSync(dir).find((f) => /^licen[sc]e/i.test(f));
  return `${p} ${v}\n${lic ? fs.readFileSync(path.join(dir, lic), "utf8").trim() : "MIT"}\n`;
});
fs.writeFileSync(process.argv[1], out.join("\n"));
' "$root/src/vendor/codemirror.LICENSES.txt"
ls -l "$root/src/vendor/codemirror.min.js"
