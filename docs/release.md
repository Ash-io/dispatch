# Releasing Dispatch (on-device path)

GitHub Actions is not the release vehicle (the account has an Actions billing lock), so releases are built by hand and attached to a tag release. This is the full runbook; `bin/release-latest.mjs` automates the error-prone part.

Every desktop build must be signed with the same updater key, or installed apps reject the update:

```sh
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/dispatch.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
```

## 0. Version + tag

1. Bump the version in **all four** places (they must match or CI/`npm ci` breaks when Actions comes back): `package.json`, `package-lock.json` (both `version` fields at the top), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
2. `npm test` (desktop JS suite) and `cargo test` inside `src-tauri/`; for the backend, `cargo build` inside `server/` (it has no tests yet).
3. Commit, then tag: `git tag -a vX.Y.Z -m "Release notes one-liner" && git push && git push origin vX.Y.Z`.
4. Create the release as a prerelease: `gh release create vX.Y.Z --prerelease --title "Dispatch vX.Y.Z" --notes "..."`. Don't use a draft: `gh release upload <tag>` can't find draft releases, and uploading from another machine created a duplicate release for v0.6.2. A prerelease can be addressed by tag, and installed apps ignore it because `releases/latest` skips prereleases. `install.sh` and `install.ps1` do see it, since they read the newest releases that have their platform's build.

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

**Linux and Windows from one Linux machine.** This is how recent releases were built. Use `ubuntu:22.04` Docker containers so the Linux build links against an older glibc, and mount the repo and signing key (`-v "$PWD:/app" -v "$HOME/.tauri:/signkey" -e TAURI_SIGNING_PRIVATE_KEY=/signkey/dispatch.key -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD=`).

- Linux: install `build-essential curl patchelf pkg-config libssl-dev libfuse2 libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev xdg-utils file binutils unzip`, Rust and Node 22, then run the Linux command above.
- Windows: install `build-essential curl file binutils pkg-config libssl-dev mingw-w64 wine64 nsis unzip`, Rust with the `x86_64-pc-windows-gnu` target, and Node 22. Copy `Include/` and `Plugins/` from Tauri's [nsis-3.13.zip](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip) over `/usr/share/nsis/`, set `CC_`, `CXX_` and `AR_x86_64_pc_windows_gnu` to the `x86_64-w64-mingw32-` tools, then run `npx tauri build --target x86_64-pc-windows-gnu --bundles nsis`. The output is in `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/`. This route produces no MSI.
- Containers run as root, so `chown` `src-tauri`, `server` and `node_modules` back to your user afterwards.

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
cargo build --release --target x86_64-unknown-linux-musl # Linux x64 (needs musl-tools and CC_x86_64_unknown_linux_musl=musl-gcc)
cargo build --release --target aarch64-apple-darwin      # macOS Apple Silicon (on a Mac)
cargo build --release --target x86_64-apple-darwin       # macOS Intel (on a Mac)
cargo build --release --target x86_64-pc-windows-msvc    # Windows (or x86_64-pc-windows-gnu from Linux)
```

Rename (keep the release naming): `dispatch-server-linux-x64`, `dispatch-server-macos-arm64`, `dispatch-server-macos-x64`, `dispatch-server-windows-x64.exe`.

## 4. Attach + publish

Upload to the prerelease with `gh release upload vX.Y.Z <files> --clobber`. On machines where `gh` can't read `/tmp`, stage the files in a folder inside the repo and delete it afterwards.

- macOS DMG and `Dispatch.app.tar.gz` (renamed `Dispatch_X.Y.Z_universal.app.tar.gz`, which `install.sh` looks for; use that name in `latest.json` too), Windows NSIS setup (and MSI if built), Linux deb + rpm + AppImage, each with its `.sig` where present
- `latest.json`
- the four `dispatch-server-*` binaries

Verify the release page lists `latest.json` and its URLs point at the right tag, then publish it with `gh release edit vX.Y.Z --prerelease=false --latest`. Installed apps pick it up on their next daily update check.

## If GitHub Actions ever comes back

`.github/workflows/release.yml` builds everything (desktop bundles + server binaries, tests first) on a `v*` tag push or a manual run; today the account's Actions billing lock stops jobs before their first step ("your account is locked due to a billing issue" — fix under Settings → Billing, then re-run the failed release workflow). Until then, the steps above are the release.