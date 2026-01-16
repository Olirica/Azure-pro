# AI working rules (read this first)

- **Think first, then edit**: start every task with a short plan (files to touch, constraints/invariants, how you’ll verify). This prevents “codegen wandering.”
- **Keep changes minimal**: prefer small diffs over rewrites; reuse existing patterns/files.
- **No AI code slop** (match local style):
  - Don’t add filler comments.
  - Don’t add defensive `try/catch` or extra validation unless the surrounding code already does it or the boundary is truly untrusted.
  - Don’t use `any` casts to silence type issues.
  - Don’t introduce new abstractions/files unless they pay for themselves immediately.
  - Before finishing, skim the diff and remove anything that looks “generated” rather than idiomatic for this repo.
- **Back-compat matters**: patch shapes + WebSocket messages must remain compatible with `public/*.html` clients and the React clients.
- **Secrets**: never hard-code credentials; if you add config, wire it via `process.env` and update `.env.example`.
- **Verification**: when relevant, run `npm run lint` and `npm test` (and Playwright specs for E2E changes).
- **Response format**: end with **only** a 1–3 sentence summary of what changed (no long narration).

---

# Project snapshot (what this repo is)

Simo is a real-time, multilingual “conference interpreter”:

1. **Speaker** captures audio and produces STT text.
2. Speaker sends **text patches** to the server.
3. Server **stabilizes** partials into segments, **translates**, and (optionally) **TTS** synthesizes.
4. **Listeners** subscribe over WebSocket for live captions + optional TTS audio.

Deep details live in:
- `README.md` (setup + ops)
- `docs/SYSTEM-ARCHITECTURE.md` (pipeline internals)

---

# Critical concepts and invariants

## Rooms
A **room** is a translation session identified by `slug` (created/edited in Admin).
Room meta drives source language behavior (`sourceLang` vs `autoDetectLangs`) and default target languages.

## Patches (the unit of truth)
Speaker/server/listener speak in **patches**. The stable contract is:

- `unitId`: `sessionId|srcLang|counter` (monotonic within a speaker session)
- `version`: increments for updates to the same `unitId`
- `stage`: `soft` (partial) or `hard` (final)
- `op`: currently `"replace"`
- `text`: transcript for this unit
- `srcLang`: BCP-47 language code (required for correct MT fan-out)

Invariants to preserve:
- **Monotonic `version` per `unitId`** (listeners drop stale versions).
- **Hard-finals drive TTS** (prevents repeated audio).
- **Don’t change message shapes** on `/ws` without updating both React and static clients.

## Auto-detect (source language)
- Admin “Languages” with **1 value** ⇒ fixed `sourceLang`.
- Admin “Languages” with **2+ values** ⇒ `sourceLang: "auto"` + `autoDetectLangs`.
- Azure’s browser SDK expects a **small candidate set** (Speaker currently caps to ≤4).
- Speaker applies a **stability/lock** so detection doesn’t flap mid-sentence.

## “Glossary” field on Speaker
The Speaker UI’s “Glossary” textbox is currently used as **ASR phrase hints** (biasing STT / named entities), not a translation glossary.

---

# Repo map (where to make changes)

## Server (Node.js, CommonJS, Express 5)
- `server/index.js` — HTTP routes, WebSocket upgrade/router, room APIs, patch ingest, broadcast fan-out, metrics endpoints.
- `server/segment-processor.js` — merges partial patches into stable segments (“fast-finals”).
- `server/translation-buffer.js` — batching/merge before MT.
- `server/translator.js` — Azure Translator with optional OpenAI path (`TRANSLATOR_PROVIDER=openai|azure`).
- `server/tts.js` — per-language TTS queue, backlog controls, audio broadcast.
- `server/state-store.js` — optional persistence (Redis / filesystem).
- `server/room-registry*.js` — room metadata storage (in-mem/FS/Redis; Postgres when `DATABASE_URL` set).
- `server/stt-provider-factory.js` — STT provider selection; some providers are server-side.
- `server/edge-agent-hub.js` + `edge-agent/` — reverse WebSocket bridge for local GPU STT (`local-canary`, `local-whisper`).

## Client (React + Vite)
- `client/src/pages/Speaker.tsx` — STT + patch emission; also streams PCM to server for server-side STT providers.
- `client/src/pages/Listener.tsx` — WebSocket patches + TTS playback.
- `client/src/pages/Admin.tsx` — room CRUD + language configuration.
- `client/src/data/languages.ts` — supported locale list.

---

# Common commands

```bash
npm install
cp .env.example .env
npm run dev           # server on :3000 (serves React if built; serves public/ always)

npm run lint          # quick structural checks (patch fuzzer lint-check)
npm test              # wav-harness self-test
```

Useful endpoints (dev):
- Speaker: `http://localhost:3000/speaker` (or `/speaker.html`)
- Listener: `http://localhost:3000/listener` (or `/listener.html`)
- Admin: `http://localhost:3000/admin` (or `/admin.html`)
- Metrics: `http://localhost:3000/metrics`
- Health: `http://localhost:3000/healthz`

Node baseline: **Node 20** (matches `Dockerfile`).

---

# Known footguns (read before changing plumbing)

- **WebSocket wiring**: the server uses a single HTTP upgrade handler and `WebSocketServer({ noServer: true })`. Don’t add a separate WS server in `{ server, path }` mode (it can trigger RSV1/compression issues).
- **Token refresh**: if you touch Azure Speech token refresh, verify you’re updating the *recognizer’s* auth token (details in `docs/SYSTEM-ARCHITECTURE.md`).
- **Binary vs JSON frames**: some `ws` paths may deliver text as `Buffer`; don’t assume “Buffer == audio.” (See edge-agent framing in `server/edge-agent-hub.js`.)

---

# When you’re unsure

- Prefer reading `docs/SYSTEM-ARCHITECTURE.md` before refactoring pipeline code.
- If behavior is ambiguous, add a focused test (or extend the existing harness) instead of guessing.
