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

## Install

```
ln -s /path/to/wiki-plugin-audionote <wiki>/node_modules/wiki-plugin-audionote
```

and add `"wiki-plugin-audionote": "*"` to the wiki package's `dependencies` (required for the factory menu and the `/plugins/audionote/` static route), then restart the wiki.

## License

MIT
