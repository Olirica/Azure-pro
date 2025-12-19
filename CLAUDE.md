If you’re about to modify code, read this first.

# Remove AI code slop

   Check the diff against main, 
   and remove all AI generated slop 
   introduced in this branch.

   This includes:
      - Extra comments that a human wouldn't 
         add or is inconsistent with the rest 
         of the file
      - Extra defensive checks or try/catch
         blocks that are abnormal for that area
         of the codebase (especially if called by 
         trusted / validated codepaths)
      - Casts to any to get around type issues
      - Any other style that is inconsistent with 
         the file

      Report at the end with only a 1-3 
      sentence summary of what you changed

# Team culture

To accomplish this, the team has a shared culture and sense of identity that
drives how they build products. You'll be expected to contribute to this, and
the work you do is critical in helping us drive toward our goals.

## Build less, ship more

It's really important we solve the right problems, than solve lots of problems.
Rather than try to build the most complex feature that covers all cases, we
strive to build precisely the right amount of software to solve the problem
we're currently facing. We're ok with leaving work for "future us" rather than
today. This maxim hopefully prevents us from over engineering solutions that our
3-person development team can't maintain.
---

## 1. What this repo does (mental model)

### Core Purpose of the Project

This project mimicks the work of a conference interpreter, using AI, through Azure Cognitive Services for speech recognition. The app provides **real-time multilingual speech translation**, enabling any speaker to talk in one language and allowing listeners to hear (or read) the message in another. 

The system:
1. **Captures audio input** from the speaker’s microphone.
2. **Processes the audio through Azure Cognitive Services**, including:
   - Speech recognition (ASR)
   - Optional multi-language **auto detection**
3. **Transcribes** the speech into text with low latency.
4. **Translates** that text into one or more target languages.
5. **Synthesizes translated audio** (TTS) and streams it to listeners.
6. Provides **listener pages** where users can:
   - select a language,
   - read live captions,
   - or listen to real-time translated speech.

This entire chain — **audio → text → translation → audio** — runs in real time
for multilingual events and is configurable per “room” through the Admin UI.

Simo is a **real‑time speech translation platform** built primarily on
**Azure Cognitive Services**:

-**Speaker page** captures microphone audio, runs **Azure Speech SDK**
  **in the browser**, and streams **sentence‑level text patches** to the server.
-**Node.js server**:
  - normalizes and stabilizes partial transcripts into “segments”
  - translates segments into one or more target languages
  - queues **TTS audio** per language and streams it to listeners
-**Listener page**:
  - subscribes via WebSocket
  - displays live subtitles
  - optionally plays synthesized audio in the chosen target language

Core goals:

1. **Real‑time**: low latency soft+hard captions, plus TTS that stays close
   to the speaker.
2. **Multilingual**: configurable per‑room target languages.
3. **Auto language detection**: when a speaker mixes 2+ input languages
   (e.g. en‑US + fr‑CA).
4. **Key‑terms / glossary support (planned)**: room‑specific terminology that
   translation should respect (product names, medical terms, etc.).

---

## 2. High‑level architecture

### 2.1 Components

- **Server (Node.js / Express)**
  - Entry point: `server/index.js`
  - Azure integration:
    - Uses Azure Speech SDK on the **client** (browser) for ASR
    - Uses Speech SDK on the **server** for TTS (`server/tts.js`)
  - Translation:
    - `server/translator.js` supports:
      - `TRANSLATOR_PROVIDER=openai` (default) or `azure`
  - Patch pipeline:
    - `server/segment-processor.js` – merges partials into stable segments
    - `server/translation-buffer.js` – merges fast‑final segments before MT
    - `server/state-store.js` – optional Redis/FS persistence
    - `server/room-registry.js` (+ `room-registry-pg.js`) – room metadata
  - Observability:
    - Prometheus metrics in `server/metrics.js`
    - `/metrics`, `/healthz` endpoints

- **Client (React + Vite + Tailwind + shadcn)**
  - `client/src/pages/Speaker.tsx`
    - Microphone capture via Azure Speech SDK (browser CDN)
    - Emits **soft** and **hard** patches via HTTP → server
    - Can use **auto‑detect source language** based on room metadata
  - `client/src/pages/Listener.tsx`
    - Connects to server via WebSocket (`/ws?room=…&role=listener&lang=…`)
    - Renders patch stream, manages subtitle view + TTS playback
  - `client/src/pages/Admin.tsx`
    - Creates/updates “rooms” with:
      - `slug` (event id)
      - `sourceLang` or `autoDetectLangs` (for bilingual input)
      - `defaultTargetLangs` (typical audience languages)
  - Shared:
    - `client/src/data/languages.ts` – curated Azure locale list
    - `client/src/components/ui` – shadcn style primitives

- **Static fallbacks**
  - `public/speaker.html`, `public/listener.html`, `public/admin.html`
  - `server/index.js` serves SPA variants at `/speaker`, `/listener`, `/admin`

- **Testing / tooling**
  - `scripts/patch-fuzzer.js` – segment processor fuzzing + `--lint-check`
  - `scripts/wav-harness.js` – streams WAV → Azure STT → local server
  - `tests/pipeline-bench/`
    - Node test suite for STT / MT / TTS health & latency
  - `tests/e2e-bilingual-autodetect.spec.js`
    - Playwright test for bilingual auto‑detect pipeline
  - `mcp/playwright-server/`
    - MCP server to drive Simo via Playwright for agents/CI

---

## 3. Running the app (for agents)

**Requirements**

- Node 20 (see `Dockerfile`: `FROM node:20-alpine`)
- Azure Cognitive Services keys

**Minimal steps**

From repo root:

```bash
cp .env.example .env   # fill in keys
npm install
npm run dev            # or `npm start` for production mode
````

Key envs (see `.env.example` for full list):

* `PORT`, `HOST`
* `SPEECH_KEY`, `SPEECH_REGION`
* `TRANSLATOR_KEY`, `TRANSLATOR_REGION`, `TRANSLATOR_ENDPOINT`
* `TRANSLATOR_PROVIDER` (`openai` or `azure`)
* `DEFAULT_TTS_VOICE`
* `ADMIN_TOKEN` (for /admin)
* Optional:

  * `REDIS_URL` for durable patch/TTS state
  * `DATABASE_URL` if using Postgres room registry
  * Tuning params: `FASTFINALS_*`, `TTS_*`, `TRANSLATION_*`, `WATCHDOG_*`

**Pages**

* Speaker: `http://localhost:3000/speaker`
* Listener: `http://localhost:3000/listener`
* Admin: `http://localhost:3000/admin`

---

## 4. Core data concepts

### 4.1 Rooms

A **room** is a translation session identified by `slug`:

* Stored via `room-registry.js` (in memory / Redis / filesystem / Postgres).
* Metadata includes (as seen in `server/index.js`):

  * `slug`
  * `title`
  * `startsAt`, `endsAt` (room window)
  * `sourceLang` (`en-CA`, `fr-CA`, or `'auto'`)
  * `autoDetectLangs` (array of source candidates when `sourceLang === 'auto'`)
  * `defaultTargetLangs` (e.g. `['fr-CA', 'es-MX']`)
  * Optional access codes (`baseCode`, `speakerCode`, `viewerCode`)

Admin UI (`Admin.tsx`) writes this via `POST /api/admin/rooms`.

### 4.2 Patches (text units)

Speaker and server communicate in **patches**:

Typical fields (see `server/segment-processor.js`/`server/index.js`):

* `unitId`: `sessionId|srcLang|counter` (monotonic within a speech session)
* `version`: integer, increments for updates to the same unit
* `stage`: `'soft'` (partial) or `'hard'` (final)
* `op`: usually `"replace"` for current implementation
* `text`: transcript text for this unit
* `srcLang`: BCP‑47 language code when known (e.g. `'en-CA'`, `'fr-CA'`)
* `ts`: optional `{ t0, t1 }` timestamps (ms) relative to session

The **SegmentProcessor**:

* Accepts incoming patches from speaker (`POST /api/segments`).
* Stabilizes partials into final segments (fast‑finals logic).
* Hands off segments to:

  * Translation buffer (for MT)
  * State store (for late‑joiner snapshots)
  * TTS queue (per language)

Listeners receive patches via the `/ws` WebSocket and render them.

---

## 5. Auto language detection (multi‑language input)

### 5.1 How auto detection is configured

**Admin page (`Admin.tsx`)**

* `Languages` field allows comma‑separated BCP‑47 codes.

* Logic:

  ```ts
  const langs = parseList(languages)
  let sourceLang = ''
  let autoDetectLangs: string[] = []

  if (langs.length <= 1) {
    sourceLang = langs[0] || ''
  } else {
    sourceLang = 'auto'
    autoDetectLangs = langs
  }
  ```

* Payload is sent to `/api/admin/rooms` with:

  * `sourceLang: 'auto'`
  * `autoDetectLangs: ['en-US', 'fr-CA', …]`
  * `defaultTargetLangs: […]`

**Server (`server/index.js`)**

* `POST /api/admin/rooms` persists `sourceLang` and `autoDetectLangs` via
  `roomRegistry.upsert` / `updateRoomMeta`.
* `GET /api/rooms/:slug` returns this metadata to the Speaker page.

### 5.2 How auto detection behaves on the Speaker page

In `Speaker.tsx`:

1. On `start()`:

   * Fetches room meta: `/api/rooms/:slug`.
   * If `meta.sourceLang === 'auto'` and `meta.autoDetectLangs.length > 0`:

     * Uses **Azure Speech SDK AutoDetectSourceLanguageConfig**:

       ```ts
       const candidates = meta.autoDetectLangs.slice(0, 4)
       isAutoDetect.current = true
       if (candidates.length >= 2) {
         speechConfig.setProperty(
           SDK.PropertyId.SpeechServiceConnection_LanguageIdMode,
           'Continuous'
         )
       }
       const autoCfg = SDK.AutoDetectSourceLanguageConfig.fromLanguages(candidates)
       recognizer = SDK.SpeechRecognizer.FromConfig(speechConfig, autoCfg, audioConfig)
       ```

     * If targets are empty and `meta.defaultTargetLangs` is set, it seeds the
       `Targets` field with those values.

2. During `recognizing` / `recognized` events:

   * Extracts detected language from the Azure result via `detectedLangFrom(result)`:

     * tries `result.language`
     * then `AutoDetectSourceLanguageResult.fromResult`
     * finally JSON from `SpeechServiceConnection_AutoDetectSourceLanguageResult`
   * Applies **stability logic** in `getStableLanguage()`:

     * Only used when `isAutoDetect.current === true`.
     * Locks onto a detected language for ~15s.
     * Requires multiple consecutive detections before switching.
     * This prevents rapid flapping between languages mid‑sentence.

3. When posting soft/hard patches:

   * Uses the **stable language**:

     ```ts
     const rawDetected = detectedLangFrom(e.result)
     const fallback = meta?.sourceLang !== 'auto' ? meta.sourceLang : srcLang
     const stableLang = getStableLanguage(rawDetected, fallback)

     await postPatch({
       unitId: unitId(),
       stage: 'hard',
       text,
       srcLang: stableLang,
       ts: timestamps(e.result),
       // ...
     })
     ```

The server then uses `srcLang` as `fromLang` for translation.

### 5.3 Where to modify auto‑detect behavior

If you need to **tune or extend multi‑language detection**, touch:

* `client/src/pages/Admin.tsx`

  * How `Languages` → `sourceLang` & `autoDetectLangs` is computed.
* `client/src/pages/Speaker.tsx`

  * Construction of `AutoDetectSourceLanguageConfig`
  * `getStableLanguage()` thresholds and behavior
* `server/index.js`

  * How patches’ `srcLang` are passed into `translator.translate(...)`

Don’t break the following invariants:

* If `sourceLang` is a specific language (not `'auto'`), ignore auto‑detect and
  trust that language.
* `autoDetectLangs` must be a small BCP‑47 set (Azure expects up to 4).

---

## 6. Key‑terms / glossary support (planned)

> Current state: **no user‑facing glossary input exists** on the Speaker page.
> Translation is purely MT (plus any provider‑specific tuning).

### 6.1 Intended behavior

Goal: allow per‑room **terminology hints** that influence translation without
breaking real‑time behavior.

High‑level design intent:

* **Glossary defined at room level**, editable in Admin or Speaker UI.
* Stored as structured data (e.g. JSON or simple DSL), not freeform text.
* Passed to the translation layer in a **provider‑agnostic** way.
* Fallback behavior:

  * If glossary is invalid or missing, translation **must still work**.
  * Glossary should not block or slow down the pipeline.

### 6.2 Likely integration points

**UI / UX**

* **Speaker page (`Speaker.tsx`)**

  * Add a **“Key terms / glossary”** input region:

    * e.g. a textarea or structured editor near the `Targets` field.
  * For a first iteration, a simple format is fine:

    * `sourceTerm => targetTerm (langCode)` per line, or
    * JSON like `{ "en": { "Simo": "Simo" }, "fr-CA": { "Simo": "Simo" } }`

* **Admin page (`Admin.tsx`)**

  * Optionally allow room‑level glossary definition so all speakers for that
    room share the same glossary.

**API / backend**

* **Room metadata**

  * Extend room meta object (in `Admin.tsx` and `server/index.js`) with a new
    field such as:

    * `glossary` or `terminologyHints` (serialized JSON string or map)
  * Store it via `room-registry` just like `defaultTargetLangs`.

* **Translator (`server/translator.js`)**

  * Extend `translate(roomId, text, fromLang, targetLangs, options?)` to accept
    a glossary/hints object.
  * For Azure:

    * If using Text Translator, you may eventually map glossary to its
      dictionary features or pre/post‑process.
  * For OpenAI:

    * Inject glossary in the system/user prompt as *strict terminology rules*.
  * Ensure:

    * Timeouts still enforced.
    * Errors recorded in metrics.
    * Fallback to standard translation on failure.

* **Patch / room plumbing**

  * When SegmentProcessor triggers translation, it must pass:

    * `roomId`
    * `text`
    * `fromLang`
    * `targetLangs`
    * `glossary` derived from room meta (if present)

### 6.3 Constraints for agents

When implementing glossary support:

* Do **not** block or delay patch processing if glossary parsing fails.
* Avoid per‑patch heavy work:

  * Normalize glossary once per room / per update.
  * Reuse across segments.
* Preserve existing behavior when no glossary is configured.
* Maintain compatibility with both `TRANSLATOR_PROVIDER=openai` and `azure`.

---

## 7. Testing & diagnostics

Before and after changes, agents should run:

### 7.1 Quick checks

From repo root:

```bash
npm run lint    # uses scripts/patch-fuzzer.js --lint-check
npm test        # runs scripts/wav-harness.js --self-test
```

### 7.2 Pipeline Bench

For deeper STT/MT/TTS health checks:

```bash
cd tests/pipeline-bench
npm install
cp .env.example .env   # fill required keys + server URL
node tests/00_env_check.js
node tests/10_stt_file.js
node tests/20_mt_eval.js
node tests/30_pipeline_smoke.js
node tests/40_tts_backlog_probe.js
```

Read `tests/pipeline-bench/README.md` for details.

### 7.3 Bilingual / auto‑detect tests

* `tests/BILINGUAL_TEST_GUIDE.md` – manual procedure for bilingual WAV tests.
* `tests/e2e-bilingual-autodetect.spec.js` – Playwright E2E, subject to
  Azure browser SDK limitations.
* `test-results/` – reference screenshots & metrics JSON.

---

## 8. Coding conventions & guardrails

Agents should follow these practices:

* **Server**

  * Use existing logging (`pino`) and metrics (`server/metrics.js`) patterns.
  * Keep WebSocket message shapes backward compatible for `listener.html`
    and React listener.
  * Don’t break `SegmentProcessor` invariants for `unitId` / `version`
    ordering and patch stages.

* **Client**

  * Use React functional components and hooks (no new class components).
  * Reuse shadcn primitives in `client/src/components/ui`.
  * Respect `LANGS` in `client/src/data/languages.ts` for language lists.
  * Avoid blocking the main thread with heavy computation; prefer async calls.

* **Secrets & configuration**

  * Never hard‑code keys; use `.env` / `process.env` and document changes in
    `.env.example` if you add new variables.

* **Performance**

  * Keep translation and TTS calls batched/reused where possible.
  * Don’t introduce per‑patch global reinitialization of SDK clients.

---

## 9. Quick task recipes (for agents)

1. **Add a new supported language**

   * Add it to `client/src/data/languages.ts`.
   * Ensure Azure supports this locale for:

     * STT (browser SDK)
     * TTS (server `tts.js`)
   * Optionally add a mapping to a preferred voice in env (e.g. via
     `TTS_VOICE_OVERRIDES_*` if present).

2. **Tune auto‑detect stability**

   * Adjust thresholds in `getStableLanguage()` in `Speaker.tsx`.
   * Keep a reasonable lockout window (~10–20s) to avoid flapping.
   * Re‑run bilingual tests (`BILINGUAL_TEST_GUIDE.md`).

3. **Implement glossary input UI**

   * Add a textarea/field on `Speaker.tsx` (and/or `Admin.tsx`).
   * Wire it to a new `glossary` field in room meta.
   * Extend `translator.translate` to accept a glossary parameter.
   * Ensure translation still works with no glossary configured.

---

This file is the source of truth for how **agents** should reason about and
modify Simo. If you add major features (especially around auto‑detect,
glossaries, or the ASR/MT/TTS pipeline), update this `agents.md` accordingly.

```
```
