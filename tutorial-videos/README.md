# Dispatch how-to videos

24 tutorial videos, one per feature, made with [HyperFrames](https://hyperframes.heygen.com). Every screen in them is the real Dispatch UI: the browser build of `src/` with demo data, the real admin panel (`worker/` under `wrangler dev`), and real `bin/dispatch.mjs` output. Narration is ElevenLabs (voice "Ifeoma Odumodu", Nigerian English), and the music bed is an ElevenLabs instrumental.

## Pipeline

```sh
npm install                       # playwright-core, graphql
node engine/capture.mjs [n|slug]  # drive the UI, save screens + element boxes to shots/<slug>/
node engine/tts.mjs --dry [n]     # character count, nothing spent
node engine/tts.mjs [n]           # narration to voice/, cached by text (re-runs are free)
node engine/build.mjs [n]         # write the HyperFrames project to build/<slug>/
engine/render.sh <slug>...        # render to out/<slug>.mp4, loudness-normalised to -16 LUFS
```

- `episodes/NN-slug.mjs`: one per video. Each step has a rail `title` and `hint`, the narration `say`, and `run(c, page)`, which performs the step with the recorder: `c.click`, `c.type`, `c.fill`, `c.press`, `c.look`, `c.hold`, `c.quietly`. An action's `at` names the narrated word it lands on.
- `engine/build.mjs` times every step to its narration, zooms the camera onto the step's targets, and draws the cursor, highlight rings, labels, key caps and the step rail.
- The ElevenLabs key is read from `ELEVENLABS_API_KEY`, falling back to `launch-video/generate_voiceover.mjs`. Changing a line of narration costs credits for that line only.
- Rendering needs Node 22+ (the script uses `~/.nvm/versions/node/v24.22.1`).

## Not real

- WebSocket (episode 12): the browser build can't open sockets, so frames are written into the tab's state, the same state the desktop app fills from Rust.
- API responses come from canned handlers in `engine/common.mjs` (and a local schema in episode 14), not live servers.
- Episodes 17 and 21 show file trees and commands drawn as HTML; episode 18 shows real CLI output.
