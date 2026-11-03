#!/usr/bin/env node
// Generates the Tauri updater manifest (latest.json) from built updater
// artifacts. Each artifact needs its .sig sibling (produced by
// `npx tauri build` with createUpdaterArtifacts enabled).
//
// Usage:
//   node bin/release-latest.mjs --notes "One line for the updater dialog." [--pub-date ISO] \
//     -- platform_key path/to/artifact [platform_key path/to/artifact ...]
//
// Example (from each build machine, collect the paths first):
//   node bin/release-latest.mjs --notes "See the release page." \
//     -- darwin-universal  src-tauri/target/universal-apple-darwin/release/bundle/macos/Dispatch.app.tar.gz \
//     -- linux-x86_64      src-tauri/target/release/bundle/appimage/Dispatch_0.7.0_amd64.AppImage \
//     -- windows-x86_64    src-tauri/target/release/bundle/nsis/Dispatch_0.7.0_x64-setup.exe \
//     > latest.json
//
// Aliases convenience: a darwin-universal entry is also emitted under the
// darwin-aarch64 / darwin-x86_64 / *-app keys (what Dispatch 0.6.x shipped).

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const notes = flag('--notes');
if (!notes) {
  console.error('usage: node bin/release-latest.mjs --notes "..." -- platform path [platform path ...]');
  process.exit(1);
}
const pubDate = flag('--pub-date') ?? new Date().toISOString();
const version = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).version;

const sep = argv.indexOf('--');
const pairs = argv.slice(sep + 1);
if (pairs.length === 0 || pairs.length % 2 !== 0) {
  console.error('need -- platform_key artifact_path pairs after --');
  process.exit(1);
}

const DARWIN_ALIASES = ['darwin-aarch64', 'darwin-x86_64', 'darwin-universal', 'darwin-aarch64-app', 'darwin-x86_64-app'];

const aliases = (key) => (key.startsWith('darwin-') ? DARWIN_ALIASES : [key]);

const platforms = {};
for (let i = 0; i < pairs.length; i += 2) {
  const [key, artifact] = [pairs[i], pairs[i + 1]];
  const sigFile = `${artifact}.sig`;
  if (!fs.existsSync(artifact)) {
    console.error(`artifact not found: ${artifact}`);
    process.exit(1);
  }
  if (!fs.existsSync(sigFile)) {
    console.error(`signature not found (run tauri with createUpdaterArtifacts): ${sigFile}`);
    process.exit(1);
  }
  const name = path.basename(artifact);
  const tag = `v${version}`;
  const url = `https://github.com/Roqak/dispatch/releases/download/${tag}/${encodeURIComponent(name)}`;
  const entry = { signature: fs.readFileSync(sigFile, 'utf8').trim(), url };
  for (const k of aliases(key)) platforms[k] = entry;
}

console.log(JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2));