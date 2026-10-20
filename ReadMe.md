# wiki-plugin-audionote

Federated Wiki plugin: record a voice note in the browser, save it into the wiki's assets folder, and emit a native `audio` item pointing at the saved file.

Phase 1 of the FedWiki Media Plan. Client-only — no server component: uploads go through the bundled `wiki-plugin-assets` endpoint (`POST /plugin/assets/upload`), so any wiki that ships `wiki-plugin-assets` (it is a core dependency) can accept recordings from the page owner.

## Features

- runtime MIME detection (`audio/webm;codecs=opus` on Chromium, `audio/mp4` on Safari)
- microphone selector persisted in localStorage, preferring the system default device
- **Mic Check** monitor mode: calibrated peak dBFS meter before recording — no wasted takes
- live waveform + level zones while recording (clipping / good / low / no signal)
- preview playback before saving
- saves `assets/<page-slug>/<timestamp>--voice-note.<ext>` plus a JSON metadata sidecar (duration, peak dBFS, device label, nullable `participantId`/`consent`/`signature` fields for the later identity layer)
- emits a native `audio` item with an **absolute URL**, so the note keeps playing when the page is forked
- quiet-take warning if the recording never peaks above −30 dBFS
- `window.audioNoteSelfTest()` — permission-free end-to-end test that records a 2 s oscillator tone, saves it, and emits the item (used for automated verification)

## Item format

```json
{ "type": "audionote", "id": "…", "text": "Caption for the saved audio item" }
```

After a save the item also carries a `recording` summary (src, filename, mime, duration, peakDb, created).

## Engines

The farm hears a recording with **faster-whisper** (`api/transcribe.py`, in `~/voice-engine/venv`) — or, on a Mac where the [MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) app is open, with MacWhisper's own CLI and the model the app has selected. `AUDIONOTE_ENGINE=macwhisper|faster-whisper` pins one; unset, the choice is made per job. `AUDIONOTE_MACWHISPER_MODEL` (engine:id) and `AUDIONOTE_MACWHISPER_PERSIST=1` tune the MacWhisper run.

## The local door

The Voice Tool sends a recording to the farm serving the page — unless the browser is on a machine running a farm of its own. It probes `http://localhost:4242/system/api.json` once; a farm whose `hear` is declared `x-fedwiki-gate: place` and `x-fedwiki-cross-origin: true` (wiki-plugin-farm ≥ 0.9.1) hears the recording instead, without a login there, because hear changes no page and keeps nothing. `DOOR: url` in the item names a door, `DOOR: farm` never looks.

## Auto — the farm picks the summary model

The Model choice beside Summarise names a door (Claude on the farm's account, qwen on the MacMini, the coop's GPU) or **Auto** (0.8.0), which lets the farm pick per summary. It is the Plan Tool's rule from the Auto Model Plan, shared as far as a summary shares its signals — size alone: over `AUDIONOTE_AUTO_BIG_TOKENS` (48k) the question goes to Claude Fable 5.1 (`AUDIONOTE_AUTO_BIG`), anything smaller to the coop's own router `llm_auto-big` (`AUDIONOTE_AUTO_LIGHT`), and to Claude when the coop is down or cannot hold it. The answer carries the pick as `auto` (asked, tier, why, model, note, tokens, line) and the status line says `auto → model: reason`. `node test/auto.cjs` tests the rule without a network.

## Install

```
ln -s /path/to/wiki-plugin-audionote <wiki>/node_modules/wiki-plugin-audionote
```

and add `"wiki-plugin-audionote": "*"` to the wiki package's `dependencies` (required for the factory menu and the `/plugins/audionote/` static route), then restart the wiki.

## License

MIT
