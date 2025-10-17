# Simo by Canoë

Real-time multilingual speech translation platform built on Azure Speech + Translator + TTS. A speaker device pushes microphone audio into the Speech SDK, the Node server merges interim segments, fans out translated patches to listeners, and queues Text-to-Speech per language.

## Features

- **Stable patch discipline** – per-sentence unit IDs (`session|lang|idx`), monotonic versions, server-side dedupe of overlapping partials, and `op:"replace"` fan-out.
- **Sentence-aligned MT** – Translator Text API v3 with `includeSentenceLength=true` to preserve sentence spans across languages.
- **TTS hygiene** – hard-finals only, one queue item per `unitId`/language, backlog metrics, and optional voice overrides via env.
- **Watchdog** – idle guard that triggers only when both SDK events and PCM heartbeats stall.
- **Observability** – Prometheus metrics out-of-the-box (`/metrics`), per-room WebSocket counts, TTS backlog gauge, and basic HTTP timings.
- **Durable state (opt-in)** – when `REDIS_URL` is set, patch replay and TTS queue metadata survive restarts for seamless reconnects.
- **Backlog-aware TTS** – automatically switches to faster voices and accelerated prosody when backlog grows, then returns to normal once caught up.
- **Sentence-aware ASR/TTS** – Speech SDK boundary events, optional phrase hints/auto-detect, and sentence-aligned TTS segments keep captions and audio in sync.
- **ElevenLabs voice support** – map languages (e.g., fr-CA) to ElevenLabs voices via env, streaming MP3 to listeners while keeping Azure voices for others.

## Prerequisites

- Node.js 18+
- Azure Speech resource (key + region)
- Azure Translator resource (key + region)

## Install

```bash
npm install
cp .env.example .env
# populate SPEECH_KEY, SPEECH_REGION, TRANSLATOR_KEY, TRANSLATOR_REGION, DEFAULT_TTS_VOICE
```

## Tuning Profiles

Choose a performance profile based on your use case. See `.env.profiles` for complete settings.

| Profile | Latency | Quality | Use Case |
|---------|---------|---------|----------|
| **SPEED** | ~2s ⚡⚡⚡ | ⭐ | Testing, demos |
| **BALANCED** | ~3s ⚡⚡ | ⭐⭐⭐ | Most conferences (default) |
| **ACCURATE** | ~4s ⚡ | ⭐⭐⭐⭐ | Critical presentations |
| **ULTRA-ACCURATE** | ~6s 🐢 | ⭐⭐⭐⭐⭐ | Post-production, subtitles |

**Current configuration**: ACCURATE (slow but accurate)

To change profiles:
1. Open `.env.profiles`
2. Copy the variables from your desired profile section
3. Paste into `.env` (local) or Railway dashboard (production)
4. Restart server

## Run

```bash
npm start
# open http://localhost:3000/speaker.html and http://localhost:3000/listener.html
```

Prometheus metrics are served from `http://localhost:3000/metrics`. Health check at `/healthz`.

## Scripts

- `npm run dev` – start server in development mode.
- `npm run lint` – quick syntax/merge harness (`scripts/patch-fuzzer.js --lint-check`).
- `npm test` – WAV harness self-test (non-destructive).
- `node scripts/wav-harness.js --file path/to.wav --room demo --targets fr-FR,es-ES` – stream a WAV via Azure Speech and POST patches to the server.
- `node scripts/patch-fuzzer.js --iterations 50` – exercise segment merge logic with synthetic units.

## Client notes

### `speaker.html`
- Fetches server-issued Speech tokens (`/api/speech/token`), loads runtime tunables from `/api/config`, and throttles soft patches using configurable punctuation + delta thresholds.
- Maintains a WebSocket to mirror the merged transcript, sends PCM heartbeats to satisfy the watchdog, and auto-refreshes Speech tokens on the configured cadence.

### `listener.html`
- Connects via WebSocket with `role=listener&lang=<BCP47>`.
- Replaces sentences inline (no append), ignores stale versions, and plays TTS if enabled.
- Queue drops by `unitId` ensure “Bonjour…” is spoken once per hard final; auto-reconnect keeps transcripts and TTS backlog alive if the socket drops.

## Environment overrides

- `SERVER_URL` – override default server URL for scripts (defaults to `http://localhost:3000`).
- `DEFAULT_TTS_VOICE_<LANG>` – language-specific Azure voice (e.g. `DEFAULT_TTS_VOICE_FR_FR=fr-FR-DeniseNeural`).
- `DEFAULT_TTS_VOICE_FALLBACK` / `TTS_BACKLOG_FALLBACK_VOICE` – optional alternate voice when backlog grows (leave blank to keep the current voice and just speed it up).
- `DEFAULT_TTS_VOICE_FR_CA` (example) – override for French-Canadian listeners; defaults to `fr-CA-SylvieNeural` when unset.
- The server ships with natural defaults for common languages (`en-US-GuyNeural`, `en-CA-ClaraNeural`, `en-GB-RyanNeural`, `fr-CA-SylvieNeural`, `fr-FR-DeniseNeural`, `es-ES-AlvaroNeural`, `es-MX-JorgeNeural`). Set env vars if you prefer different voices.
- `TTS_THROTTLE_RATE_MULTIPLIER` – prosody rate applied when backlog exceeds the budget (default `1.25`).
- `TTS_SEGMENT_MIN_SENTENCE` – minimum sentence count before segmenting (default `2`; set to `1` to speak even single-sentence finals immediately).
- `FINAL_DEBOUNCE_MS` – delay (ms) before emitting hard finals to allow minimal cleanup and sentence splitting (default `180`).
- `WATCHDOG_EVENT_IDLE_MS`, `WATCHDOG_PCM_IDLE_MS` – idle thresholds before the speaker watchdog advises a restart (defaults: event 12 000 ms, PCM 7 000 ms).
- `PHRASE_HINTS` – comma-separated list of domain phrases/names to bias ASR (e.g., `PHRASE_HINTS=Azure,OpenAI,Paralucent`).
- `AUTO_DETECT_LANGS` – candidate languages for automatic source detection (set `sourceLang` to `auto` on the speaker UI to enable).
- `TRANSLATOR_PROFANITY_ACTION` / `TRANSLATOR_PROFANITY_MARKER` – Translator profanity handling (`NoAction`, `Marked`, or `Deleted`; marker `Asterisk`/`Tag`).
- `SPEECH_TTS_FORMAT` – Azure Speech synthesis output format (e.g., `Audio24Khz48KBitRateMonoMp3`).
- `OPENAI_API_KEY`, `OPENAI_TRANSLATE_MODEL`, `OPENAI_TRANSLATE_ENDPOINT` – optional OpenAI fallback when Azure Translator errors.
- `HARNESS_TARGETS` – default targets for `wav-harness`.
- `REDIS_URL`, `REDIS_PREFIX` – enable Redis persistence for units, patch history, and TTS queue metadata.
- `STABLE_PARTIALS`, `SEG_SILENCE_MS`, `INITIAL_SILENCE_MS`, `END_SILENCE_MS`, `SOFT_THROTTLE_MS`, `SOFT_MIN_DELTA_CHARS`, `SPEECH_TOKEN_REFRESH_MS`, `WS_PING_INTERVAL_MS`, `PATCH_LRU_PER_ROOM`, `TTS_MAX_BACKLOG_SEC`, `TTS_RESUME_BACKLOG_SEC` – runtime tuning knobs surfaced to the clients via `/api/config`.

## Watchdog heartbeats

Speaker clients send `{type:"heartbeat", payload:{pcm:true}}` over the WebSocket to mark PCM flow, preventing restarts during natural pauses. If you replace the capture client, ensure you emit equivalent heartbeats or call `POST /api/segments` frequently enough to avoid idle triggers.

## Metrics (selected)

| Metric | Labels | Meaning |
| ------ | ------ | ------- |
| `simo_patch_total` | room, stage, status | Accepted vs stale soft/hard patches |
| `simo_translation_latency_seconds` | room, lang | Translator REST latency |
| `simo_tts_backlog_seconds` | room, lang | Estimated queued speech duration |
| `simo_ws_clients` | room, role | Active WebSocket clients |
| `simo_http_duration_seconds` | method, route, status | Express latency histogram |

## Development tips

- The server auto-caches translations per `(unitId, version, lang)` to keep late-joiner snapshots fast.
- For multi-room deployments, shard by `roomId` behind a load balancer. All per-room state lives in-memory (`rooms` map).
- Replace `queue.enqueue` in `server/index.js` if you want only specific listener subsets to receive TTS.

## Troubleshooting

- **Speech token errors** – ensure `.env` has valid Speech credentials; tokens require HTTPS in production.
- **Translator 401/403** – Translator region must match your resource; many use `global`.
- **Playback blocked** – browsers require a user gesture before autoplay with audio; click anywhere before enabling TTS.
