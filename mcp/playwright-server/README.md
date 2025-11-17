MCP Playwright Server for Simo

This Model Context Protocol (MCP) server drives the Simo app end‑to‑end with Playwright:
- Launches the speaker and listener pages
- Injects a fake microphone from a local audio file (real‑time playback)
- Observes console signals to collect patches, transcriptions, and TTS metrics

Install

- From the repo root:
  - cd mcp/playwright-server
  - npm install

Run

- Start your app server: `npm start` (serves speaker at `/speaker.html` and listener at `/listener.html`)
- In another terminal, start this MCP server:
  - cd mcp/playwright-server
  - npm start

Tools

- `run_fake_mic_session`
  - Input (JSON):
    - `serverUrl` string, default `http://localhost:3000`
    - `roomId` string, default `mcp-room`
    - `sourceLang` string, default `en-CA`
    - `targetLang` string, default `fr-CA`
    - `audioFile` string, required, path to WAV/MP3 supported by the browser
    - `timeoutMs` number, default `120000`
    - `headed` boolean, default `false`
    - `transferMode` string, default `"route"` ("route" serves bytes via Playwright route; "base64" embeds bytes inline)
    - `targetSampleRate` number, default `16000` (resamples to this rate)
    - `mono` boolean, default `true` (downmix to mono)
    - `normalize` boolean, default `false` (peak-normalize audio)
    - `targetPeak` number, default `0.9` (when `normalize` true)
    - `startAtSec` number, default `0` (trim from start)
    - `durationSec` number, optional (limit playback duration)
    - `playbackRate` number, default `1.0` (real-time). Use >1.0 to fast-forward in synthetic tests.
    - `selectors` object (optional overrides): `startButton`, `connectButton`, `roomInput`, `sourceLangInput`, `targetLangsInput`, `singleTargetSelect`, `ttsToggle`, `speakerListeningStatus`, `listenerConnectionStatus`
  - Behavior:
    - Overrides `navigator.mediaDevices.getUserMedia` via `addInitScript` to feed the audio file into a `MediaStream` using WebAudio.
    - Efficient transfer: in `transferMode="route"`, bytes are served from `/__mcp__/audio` via Playwright routing to avoid large base64 blobs.
    - Decodes the input audio, resamples to `targetSampleRate` and downmixes to mono via `OfflineAudioContext` for Azure-friendly input.
    - Optional peak normalization to improve SNR without clipping.
    - Fills and clicks the default Simo UI controls to start capture and connect.
    - Watches console for:
      - Fast‑finals on speaker
      - `[listener] Hard patch rendered` (translations)
      - `[listener] TTS enqueued` and playback
    - Returns metrics as JSON.

- `close` — force cleanup of browser/contexts.
- `ping` — simple health check.

Audio format

- The injector decodes (WAV/MP3/etc.), then resamples and downmixes to mono at `targetSampleRate` (default 16 kHz), which aligns well with Azure STT. WAV is recommended.

Example MCP client call (pseudo)

{
  "tool": "run_fake_mic_session",
  "input": {
    "serverUrl": "http://localhost:3000",
    "roomId": "e2e-test-room",
    "sourceLang": "en-CA",
    "targetLang": "fr-CA",
    "audioFile": "tests/pipeline-bench/samples/conference_full.wav",
    "timeoutMs": 180000
  }
}

Notes

- Defaults match existing Simo tests and selectors.
- If your app changes UI ids/classes, override via the `selectors` input.
- The server cleans up the browser after each run; call `close` if a session is interrupted.
