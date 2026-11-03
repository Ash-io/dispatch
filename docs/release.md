# Releasing Dispatch (on-device path)

GitHub Actions is not the release vehicle (the account has an Actions billing lock), so releases are built on each device and attached to a tag release. This is the full runbook; `bin/release-latest.mjs` automates the error-prone part.

## 0. Version + tag

1. Bump the version in **all four** places (they must match or CI/`npm ci` breaks when Actions comes back): `package.json`, `package-lock.json` (both `version` fields at the top), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
2. `npm test` (desktop JS suite) and `cargo test` inside `src-tauri/`; for the backend, `cargo build` inside `server/`.
3. Commit, then tag: `git tag -a vX.Y.Z -m "Release notes one-liner" && git push && git push origin vX.Y.Z`.
4. Start the release on GitHub (**Draft a new release**, pick the tag, **Save draft** — don't publish yet).

## 1. Build the desktop bundles

**macOS** (produces the universal build 0.6.x shipped):

```sh
npm install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin
# outputs:
#   src-tauri/target/universal-apple-darwin/release/bundle/dmg/Dispatch_X.Y.Z_universal.dmg
#   src-tauri/target/universal-apple-darwin/release/bundle/macos/Dispatch.app.tar.gz (+ .sig)  ← updater
```

**Linux** (needs `libwebkit2gtk-4.1-dev` etc. — see README's build from source):

```sh
npm install
npx tauri build --bundles deb,rpm,appimage
# outputs (all + .sig for the AppImage):
#   src-tauri/target/release/bundle/deb/Dispatch_X.Y.Z_amd64.deb
#   src-tauri/target/release/bundle/rpm/Dispatch-X.Y.Z-1.x86_64.rpm
#   src-tauri/target/release/bundle/appimage/Dispatch_X.Y.Z_amd64.AppImage  ← updater
```

**Windows** (MSVC + WebView2 preinstalled on Win10/11):

```sh
npm install
npx tauri build --bundles msi,nsis
# outputs:
#   src-tauri/target/release/bundle/msi/Dispatch_X.Y.Z_x64_en-US.msi
#   src-tauri/target/release/bundle/nsis/Dispatch_X.Y.Z_x64-setup.exe  ← updater
```

Keep every `.sig` file next to its artifact — without it the updater can't be built.

## 2. updater manifest (latest.json)

Collect the three updater artifacts (AppImage, `Dispatch.app.tar.gz`, NSIS setup) on one machine (they're small) and run:

```sh
node bin/release-latest.mjs --notes "One line shown in the update dialog." \
  -- darwin-universal  <path>/Dispatch.app.tar.gz \
  -- linux-x86_64      <path>/Dispatch_X.Y.Z_amd64.AppImage \
  -- windows-x86_64    <path>/Dispatch_X.Y.Z_x64-setup.exe > latest.json
```

It reads the version from `tauri.conf.json`, reads each sibling `.sig`, expands the darwin-universal entry to the five `darwin-*` keys (matching what 0.6.x shipped), and writes release-download URLs. Sanity-check it (`latest.json` must be valid JSON and every `url` should end in the artifact's file name) and add it to the release — it must be named **exactly `latest.json`**, because installed apps fetch `releases/latest/download/latest.json`.

## 3. dispatch-server binaries

```sh
cd server
cargo build --release                                   # Linux x64
cargo build --release --target aarch64-apple-darwin     # macOS (on an Apple-Silicon Mac)
cargo build --release --target x86_64-pc-windows-msvc   # Windows
```

Rename (keep the release naming): `dispatch-server-linux-x64`, `dispatch-server-macos-arm64`, `dispatch-server-macos-x64`, `dispatch-server-windows-x64.exe`.

## 4. Attach + publish

Upload to the draft release (drag-and-drop in the browser, or `gh release upload vX.Y.Z <files> --clobber`):

- macOS DMG, Windows MSI + NSIS setup, Linux deb + rpm + AppImage, each with its `.sig` where present
- `latest.json`
- the four `dispatch-server-*` binaries

Verify the release page lists `latest.json` and its URLs point at the right tag, then **publish**. Installed apps pick it up on their next daily update check.

## If GitHub Actions ever comes back

`.github/workflows/release.yml` builds everything (desktop bundles + server binaries, tests first) on a `v*` tag push or a manual run; today the account's Actions billing lock stops jobs before their first step ("your account is locked due to a billing issue" — fix under Settings → Billing, then re-run the failed release workflow). Until then, the steps above are the release.