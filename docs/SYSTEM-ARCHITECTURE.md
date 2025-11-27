# Simo System Architecture

## Complete Pipeline Overview

This document describes the full audio-to-audio pipeline: from speaker's microphone to listener's TTS playback.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SPEAKER CLIENT                                      │
│  ┌─────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────────┐    │
│  │   Mic   │───▶│ Azure Speech │───▶│ Fast-Finals │───▶│ POST /api/segments│    │
│  │ (Audio) │    │  SDK (STT)   │    │  (Speaker.tsx)   │    └────────┬─────────┘    │
│  └─────────┘    └──────────────┘    └─────────────┘              │               │
└──────────────────────────────────────────────────────────────────┼───────────────┘
                                                                   │
                                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                 SERVER                                           │
│  ┌────────────────────┐    ┌─────────────────────┐    ┌────────────────────┐   │
│  │ Segment Processor  │───▶│ Translation Buffer  │───▶│ Azure/OpenAI       │   │
│  │ (segment-processor)│    │ (translation-buffer)│    │ Translator         │   │
│  └────────────────────┘    └─────────────────────┘    └────────┬───────────┘   │
│           │                                                     │               │
│           │ sourcePatch                          translatedPatch│               │
│           ▼                                                     ▼               │
│  ┌────────────────────────────────────────────────────────────────────────┐    │
│  │                     broadcastResult (index.js)                          │    │
│  │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐   │    │
│  │  │ patchesByLang│──▶│ Send to      │──▶│ TTS Trigger Check        │   │    │
│  │  │ Map          │   │ Listeners    │   │ (if ttsFinal && wantsTts)│   │    │
│  │  └──────────────┘   └──────────────┘   └───────────┬──────────────┘   │    │
│  └────────────────────────────────────────────────────┼───────────────────┘    │
│                                                       │                         │
│                                                       ▼                         │
│  ┌────────────────────────────────────────────────────────────────────────┐    │
│  │                        TTS Queue (tts.js)                               │    │
│  │  ┌─────────────┐   ┌──────────────┐   ┌────────────────────────────┐  │    │
│  │  │ Deduplication│──▶│ Azure TTS    │──▶│ broadcastAudio             │  │    │
│  │  │ Check        │   │ Synthesis    │   │ (type: 'tts' to listeners) │  │    │
│  │  └─────────────┘   └──────────────┘   └────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            LISTENER CLIENT                                       │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────────┐  │
│  │ WebSocket        │───▶│ Patch Display    │    │ Audio Playback           │  │
│  │ (patches + tts)  │    │ (real-time text) │    │ (TTS audio from server)  │  │
│  └──────────────────┘    └──────────────────┘    └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Speech-to-Text (STT)

### Location: `client/src/pages/Speaker.tsx`

### Components

| Component | Purpose |
|-----------|---------|
| Azure Speech SDK | Browser-based continuous speech recognition |
| Token Manager | Fetches/refreshes Azure auth tokens |
| Fast-Finals Engine | Emits stable text before SDK finalizes |
| WebSocket Heartbeat | Keeps server connection alive |

### Token Lifecycle

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│ fetchToken()│────▶│ Create      │────▶│ Schedule Refresh    │
│ POST /api/  │     │ Recognizer  │     │ at (expiry - 60s)   │
│ speech/token│     │             │     │                     │
└─────────────┘     └─────────────┘     └──────────┬──────────┘
                                                   │
                         ┌─────────────────────────┘
                         ▼
              ┌─────────────────────────┐
              │ On refresh timer:       │
              │ recogRef.authToken =    │  ◀── CRITICAL: Must update
              │   fresh.token           │      recognizer, not config!
              └─────────────────────────┘
```

**Key Variables:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `SPEECH_TOKEN_REFRESH_MS` | 540000 (9 min) | Token validity period |
| `expiresInSeconds` | 540 | Returned by server |
| Refresh scheduled at | `(expiry - 60) * 1000` | 8 minutes |

**Critical Bug Fixed (Nov 27):** Token refresh must update `recogRef.current.authorizationToken`, not `speechConfigRef.current.authorizationToken`. The recognizer has its own internal token copy.

### Azure SDK Events

```javascript
recognizer.recognizing = (s, e) => {
  // Partial results - text may change
  // Fast-Finals analyzes these for stable prefixes
}

recognizer.recognized = (s, e) => {
  // Final result - definitive text
  // Always emits ttsFinal: true
}

recognizer.sessionStopped = () => {
  // Session ended (normal or timeout)
}

recognizer.canceled = (s, e) => {
  // Error or cancellation
  // e.reason: CancellationReason.Error | EndOfStream
}
```

### Fast-Finals Algorithm

**Purpose:** Reduce latency by emitting "hard" patches before Azure SDK finalizes.

```
Azure recognizing stream:
  t=0:    "Hello"
  t=100:  "Hello, how"
  t=200:  "Hello, how are"
  t=300:  "Hello, how are you"
  t=400:  "Hello, how are you today?"  ← Punctuation!

Fast-Finals detects stable prefix ending with punctuation
  → Emits: stage='hard', ttsFinal=true, text="Hello, how are you today?"

  t=800:  SDK recognized event
  → Emits: stage='hard', ttsFinal=true (dedup will prevent duplicate TTS)
```

**Decision Logic:**

```javascript
// Emit fast-final if ANY of these AND time throttle satisfied:
const shouldEmit = (
  hasNewSentence ||      // /[.?!]\s/ in new text
  prefixEndsSentence ||  // /[.?!]\s*$/ at end
  enoughNewChars         // >= FASTFINALS_MIN_CHARS
) && timeSinceLastEmit >= FASTFINALS_EMIT_THROTTLE_MS;

// ttsFinal only set when punctuation-final:
ttsFinal = /[.?!]\s*$/.test(candidate);
```

**Key Variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `FASTFINALS_MIN_CHARS` | 45 | Min new chars to emit |
| `FASTFINALS_EMIT_THROTTLE_MS` | 800 | Min time between emissions |
| `FASTFINALS_TAIL_GUARD_CHARS` | 10 | Don't emit last N chars (prevents revision) |
| `FASTFINALS_PUNCT_STABLE_MS` | 300 | Extra stability for punctuation |

### Soft vs Hard Patches

| Type | Purpose | TTS? |
|------|---------|------|
| `soft` | UI preview, mutable | Never |
| `hard` (fast-final) | Stable prefix, may revise | Only if `ttsFinal: true` |
| `hard` (SDK final) | Definitive | Always `ttsFinal: true` |

---

## Phase 2: Server Processing

### Location: `server/segment-processor.js`

### Patch Ingestion Flow

```
POST /api/segments { patch, targets }
         │
         ▼
┌─────────────────────────────────────┐
│ SegmentProcessor.process(patch)    │
│                                     │
│ 1. Validate unitId, stage, version │
│ 2. Strip filler words              │
│ 3. Infer/normalize srcLang         │
│ 4. Dedupe continuation text        │
│ 5. Calculate ttsReady flag         │
│ 6. Store unit in memory + DB       │
│ 7. Route to TranslationBuffer      │
└─────────────────────────────────────┘
```

### ttsReady Calculation

```javascript
// segment-processor.js:1006
const ttsReady = ttsFinal === true ||
                 (ttsFinal === undefined && finalStage === 'hard');
```

| Incoming `ttsFinal` | `stage` | Result `ttsReady` |
|---------------------|---------|-------------------|
| `true` | any | `true` |
| `false` | any | `false` |
| `undefined` | `hard` | `true` |
| `undefined` | `soft` | `false` |

### Language Detection

```javascript
// segment-processor.js:52
function inferLikelyBase(text) {
  // French signals (strong)
  const hasFrenchWords = /\b(merci|bonjour|je|nous|vous|...)\b/
  const hasFrenchPatterns = /\b(l'|d'|j'|n'|s'|c'|qu')\w+/

  // French accents (weak - only if no English)
  const hasFrenchAccents = /[àâäæçéèêëîïôœùûüÿ]/

  // English signals
  const hasEnglishWords = /\b(the|this|that|with|have|...)\b/

  // Priority: English words > French words/patterns > French accents
}
```

**Use Cases:**
1. Auto-detect mislabeling: Speaker says French but SDK returns `en-US`
2. TTS language check: Prevent French text from English TTS

---

## Phase 3: Translation

### Location: `server/translation-buffer.js`

### Buffering Strategy

```
Segment arrives
     │
     ▼
┌─────────────────────────────────────────┐
│ TranslationBuffer.add(segment, targets) │
│                                         │
│ If buffering disabled:                  │
│   → Translate immediately               │
│                                         │
│ Else:                                   │
│   → Add to pendingSegments[]            │
│   → Start/reset flush timer             │
│                                         │
│ Flush when:                             │
│   • Timer expires (mergeWindowMs)       │
│   • Max segments reached (maxMergeCount)│
└─────────────────────────────────────────┘
```

**Key Variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRANSLATION_MERGE_ENABLED` | true | Enable segment merging |
| `TRANSLATION_MERGE_WINDOW_MS` | 1500 | Wait time for next segment |
| `TRANSLATION_MIN_MERGE_CHARS` | 50 | Min chars to justify merge |
| `TRANSLATION_MAX_MERGE_COUNT` | 3 | Max segments to merge |

### Translation Providers

```javascript
// Priority: OpenAI > Azure Translator

// OpenAI (preferred)
OPENAI_API_KEY=...
OPENAI_TRANSLATE_MODEL=gpt-4o-mini

// Azure (fallback)
TRANSLATOR_KEY=...
TRANSLATOR_REGION=eastus
```

### Translated Patch Structure

```javascript
{
  unitId: "session|fr-CA|5",
  targetLang: "en-US",
  text: "Translated text here",
  srcLang: "fr-CA",
  stage: "hard",
  ttsFinal: true,
  sentLen: { src: [12, 15], tgt: [14, 18] },  // Sentence boundaries
  provider: "openai",
  version: 3
}
```

---

## Phase 4: Broadcast

### Location: `server/index.js` → `broadcastResult()`

### Patch Distribution

```javascript
// Build patches by language
const patchesByLang = new Map();
patchesByLang.set(sourcePatch.srcLang, sourcePatch);  // Source listeners
patchesByLang.set('source', sourcePatch);             // Explicit source
for (const translated of translatedPatches) {
  patchesByLang.set(translated.targetLang, translated);
}

// Send to each client based on their lang preference
for (const client of room.clients) {
  const message = patchesByLang.get(client.lang);
  if (message) safeSend(client.socket, message);
}
```

### TTS Triggering

```javascript
// index.js:669 - Condition for TTS
if (client.lang &&                    // Client has language set
    payload.stage === 'hard' &&       // Not a soft preview
    client.wantsTts &&                // Client wants TTS
    payload.ttsFinal) {               // Patch is TTS-ready

  // Collect for batch enqueue
  ttsEnqueueByLang.get(client.lang).set(payload.unitId, {
    payload, voice: client.voice, version
  });
}
```

### TTS Deduplication

```javascript
// index.js:706 - Prevent duplicate TTS
const rootUnitId = payload.unitId.split('#')[0];
const ttsKey = `${lang}:${rootUnitId}`;

if (room.ttsTriggeredUnits.has(ttsKey)) {
  // Skip - already triggered TTS for this unit
  continue;
}

// After enqueue:
room.ttsTriggeredUnits.set(ttsKey, Date.now());
```

### Language Mismatch Check

```javascript
// index.js:717 - Prevent wrong-language TTS
const textLangBase = inferLikelyBase(payload.text);
if (textLangBase && textLangBase !== targetLangBase) {
  // Skip - text appears to be wrong language
  // (e.g., French source sent to English TTS)
  continue;
}
```

---

## Phase 5: TTS Synthesis

### Location: `server/tts.js`

### Queue Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    TTS Queue (per language)                │
│                                                            │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐      │
│  │ Segment 1   │──▶│ Segment 2   │──▶│ Segment 3   │      │
│  │ (playing)   │   │ (prefetch)  │   │ (queued)    │      │
│  └─────────────┘   └─────────────┘   └─────────────┘      │
│        │                                                   │
│        ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Azure TTS Synthesizer                               │  │
│  │ speakSsmlAsync(ssml) → audioBuffer                  │  │
│  └─────────────────────────────────────────────────────┘  │
│        │                                                   │
│        ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ emitter.emit('audio', { audio, lang, unitId, ... }) │  │
│  └─────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Enqueue Skip Conditions

```javascript
// tts.js:678-688
if (!trimmed) {
  // Skip empty text
  return;
}

const words = trimmed.split(/\s+/).filter(Boolean).length;
const isPunctFinal = /[.?!]\s*$/.test(trimmed);
if (words < 2 && !isPunctFinal) {
  // Skip ultra-short non-sentences
  return;
}
```

### Speed Adjustment (Backlog Management)

```
Backlog (seconds)    Speed Multiplier
─────────────────    ────────────────
0-5                  1.05x (base)
5-20                 1.05x → 1.30x (linear ramp)
20+                  1.30x (max)
```

**Key Variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `TTS_BASE_SPEED` | 1.05 | Normal playback speed |
| `TTS_MAX_SPEED` | 1.30 | Max speed when behind |
| `TTS_BACKLOG_RAMP_START_SEC` | 5 | Start ramping at N sec backlog |
| `TTS_BACKLOG_RAMP_END_SEC` | 20 | Max speed at N sec backlog |
| `TTS_MAX_SPEED_CHANGE_PERCENT` | 15 | Max speed change per segment |

### SSML Generation

```javascript
// tts.js:478
function buildSsml(text, lang, voiceName, rate) {
  return `<speak version="1.0" xmlns="..." xml:lang="${lang}">
    <voice name="${voiceName}">
      <prosody rate="${rate.toFixed(2)}">
        ${escapeXml(text)}
      </prosody>
    </voice>
  </speak>`;
}
```

---

## Phase 6: Audio Delivery

### Location: `server/index.js` → `broadcastAudio()`

### Audio Broadcast

```javascript
// index.js:778 - Send TTS audio to listeners
safeSend(client.socket, {
  type: 'tts',
  payload: {
    unitId: payload.unitId,
    rootUnitId: payload.rootUnitId,
    lang: payload.lang,
    text: payload.text,
    audio: payload.audio.toString('base64'),  // Base64 encoded
    format: payload.format,  // e.g., 'audio/mpeg'
    voice: payload.voice,
    version: payload.version
  }
});
```

### Listener Reception

Listeners receive:
1. **Patch messages** (`type: 'patch'`) - Real-time text updates
2. **TTS messages** (`type: 'tts'`) - Audio for playback

**Note:** Historical patches (from state store on connect) do NOT trigger TTS. Only live patches trigger TTS synthesis.

---

## Key Data Structures

### Unit (Server-side)

```javascript
{
  unitId: "uuid|fr-CA|5",      // Full unit ID
  root: "uuid|fr-CA|5",        // Root (without segment suffix)
  stage: "hard",               // soft | hard
  version: 3,                  // Monotonic version
  text: "Bonjour tout le monde",
  srcLang: "fr-CA",
  ts: { t0: 1234, t1: 5678 },  // Timestamps from STT
  updatedAt: 1701234567890,    // Server timestamp
  ttsFinal: true               // Safe for TTS
}
```

### Patch (Wire format)

```javascript
{
  type: "patch",
  payload: {
    unitId: "uuid|fr-CA|5",
    stage: "hard",
    op: "replace",
    version: 3,
    text: "Hello everyone",
    srcLang: "fr-CA",
    targetLang: "en-US",       // Only on translated patches
    ttsFinal: true,
    sentLen: { src: [10], tgt: [14] },
    provider: "openai",
    emittedAt: 1701234567890
  }
}
```

### TTS Audio (Wire format)

```javascript
{
  type: "tts",
  payload: {
    unitId: "uuid|fr-CA|5#0",  // With segment suffix
    rootUnitId: "uuid|fr-CA|5",
    lang: "en-US",
    text: "Hello everyone",
    audio: "base64encodedaudio...",
    format: "audio/mpeg",
    voice: "en-US-JennyNeural",
    version: 3
  }
}
```

---

## Environment Variables Summary

### STT (Speaker)

| Variable | Default | Description |
|----------|---------|-------------|
| `SPEECH_KEY` | - | Azure Speech subscription key |
| `SPEECH_REGION` | eastus | Azure region |
| `SPEECH_TOKEN_REFRESH_MS` | 540000 | Token validity (ms) |
| `RECOGNITION_MODE` | dictation | dictation/conversation/interactive |

### Fast-Finals

| Variable | Default | Description |
|----------|---------|-------------|
| `FASTFINALS_MIN_CHARS` | 45 | Min new chars to emit |
| `FASTFINALS_EMIT_THROTTLE_MS` | 800 | Min time between emissions |
| `FASTFINALS_TAIL_GUARD_CHARS` | 10 | Don't emit last N chars |

### Translation

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | - | OpenAI API key |
| `OPENAI_TRANSLATE_MODEL` | gpt-4o-mini | Model for translation |
| `TRANSLATION_MERGE_WINDOW_MS` | 1500 | Buffer window |
| `TRANSLATION_MAX_MERGE_COUNT` | 3 | Max segments to merge |

### TTS

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_BASE_SPEED` | 1.05 | Normal playback speed |
| `TTS_MAX_SPEED` | 1.30 | Max speed when behind |
| `TTS_BACKLOG_RAMP_START_SEC` | 5 | Start ramping threshold |
| `TTS_BACKLOG_RAMP_END_SEC` | 20 | Max speed threshold |
| `DEFAULT_TTS_VOICE` | en-US-JennyNeural | Default English voice |
| `DEFAULT_TTS_VOICE_FR_CA` | fr-CA-SylvieNeural | Default French voice |

---

## Debugging Checklist

### TTS Not Playing

1. Check `ttsFinal` on patches in HAR
2. Verify listener has `wantsTts: true` in hello
3. Check language mismatch (French text → English TTS blocked)
4. Check deduplication (`ttsTriggeredUnits` may have already fired)
5. Check server logs for `[TTS Enqueue]` messages

### Recording Stops After ~10 Minutes

1. Token refresh must update `recogRef.current.authorizationToken`
2. Check `recognizer.canceled` event for errors
3. Verify network stability

### Duplicate TTS

1. Check `ttsTriggeredUnits` deduplication is working
2. Verify root unit ID extraction: `unitId.split('#')[0]`

### Translation Missing

1. Check `OPENAI_API_KEY` is set
2. Check translation buffer flush logs
3. Verify `stage === 'hard'` (soft patches don't translate)

---

*Document generated: November 27, 2025*
*Last updated: Token refresh fix for 10-minute recording timeout*
