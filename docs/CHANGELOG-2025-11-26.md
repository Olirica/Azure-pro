# Changelog: November 26-27, 2025

## Overview

This document summarizes the extensive TTS (Text-to-Speech) debugging and fixes made during the November 26-27 session, along with documentation of the Fast-Finals system, SDK configuration variables, and recognition modes.

---

## Table of Contents

1. [TTS Issues Addressed](#summary-of-tts-issues-addressed)
2. [Fast-Finals System](#fast-finals-system)
3. [Recognition Modes](#recognition-modes-dictation-vs-conversation)
4. [Environment Variables Reference](#environment-variables-reference)
5. [Detailed TTS Changes](#detailed-changes)
6. [Language Detection](#enhanced-language-detection-patterns)
7. [Testing & Rollback](#testing-recommendations)

---

## Summary of TTS Issues Addressed

1. **TTS Not Firing** - Text was being translated but not spoken
2. **Duplicate TTS** - Same segment spoken 2-3 times
3. **Wrong Language TTS** - French source text being sent to English TTS
4. **False Positive Language Detection** - English text with French proper nouns blocked from TTS

---

## Fast-Finals System

### What is Fast-Finals?

Fast-Finals is a **client-side STT optimization** that reduces perceived latency by emitting "hard" patches earlier than the Azure SDK's natural `recognized` event. Instead of waiting for Azure to finalize a segment (which can take several seconds of silence), Fast-Finals analyzes the `recognizing` stream and commits stable prefixes as soon as they meet certain criteria.

### Why Fast-Finals?

| Without Fast-Finals | With Fast-Finals |
|---------------------|------------------|
| Wait for 300-500ms silence | Emit as soon as text stabilizes |
| Translation delayed until SDK final | Translation starts on fast-final |
| TTS queued late | TTS queued earlier |
| Higher perceived latency | Lower perceived latency |

### How It Works

```
Azure SDK recognizing events:
  "Hello"
  "Hello, how"
  "Hello, how are"
  "Hello, how are you"
  "Hello, how are you today"
  "Hello, how are you today?"    ← Punctuation detected!

Fast-Finals emits: "Hello, how are you today?" (stage: 'hard', ttsFinal: true)

...later...

Azure SDK recognized event:
  "Hello, how are you today?"    ← SDK final (may be slightly different)

Fast-Finals emits: stage: 'hard', ttsFinal: true (if text changed)
```

### Fast-Finals Algorithm

Located in `client/src/pages/Speaker.tsx`:

```javascript
// In recognizing handler:
const prefix = findStablePrefix(text, sttState.current.lastText, K=2)

// Emit fast-final if:
// 1. New sentence boundary detected: /[.?!]\s/
// 2. Prefix ends with punctuation: /[.?!]\s*$/
// 3. Enough new characters (45+)
// AND time since last emit >= 800ms

if ((hasNewSentence || prefixEndsSentence || enoughNewChars) && timeOk) {
  // Apply tail guard (don't emit last 10 chars unless punctuation-final)
  const candidate = applyTailGuard(prefix, guardChars=10)

  await postPatch({
    stage: 'hard',
    ttsFinal: candidateIsSentence,  // Only TTS if ends with .?!
    text: candidate
  })
}
```

### Stable Prefix Detection

The `findStablePrefix` function finds the longest prefix that has appeared in K consecutive recognizing events:

```javascript
function findStablePrefix(current, previous, K=2) {
  // Find common prefix between current and previous
  // If it's been stable for K events, consider it "committed"
  // This prevents emitting text that Azure might revise
}
```

### Tail Guard

To avoid emitting text that might be revised, Fast-Finals applies a "tail guard":
- Don't emit the last N characters (default: 10)
- UNLESS the text ends with sentence punctuation (.?!)
- Snap to word boundary to avoid mid-word cuts

### ttsFinal Flag

Fast-Finals sets `ttsFinal: true` only when:
- The candidate ends with terminal punctuation: `.` `?` `!`
- This prevents TTS from speaking incomplete sentences

The SDK `recognized` event always sets `ttsFinal: true` as it represents the definitive final.

### Interaction with TTS

```
Timeline:
  t=0:    Recognizing "Hello, how are you today?"
  t=50ms: Fast-Final emitted (ttsFinal: true if punctuation)
  t=100ms: Translation starts
  t=300ms: Translation complete, TTS enqueued
  t=500ms: SDK recognized event (ttsFinal: true)
  t=500ms: TTS dedup prevents duplicate (already triggered for this unit)
```

---

## Recognition Modes: Dictation vs Conversation

### Azure Speech SDK Recognition Modes

Azure Speech SDK supports three recognition modes set via `SpeechConfig`:

| Mode | Use Case | Behavior |
|------|----------|----------|
| **Dictation** | Single speaker, long-form | Longer silence tolerance, punctuation insertion |
| **Conversation** | Multi-speaker, back-and-forth | Shorter segments, faster finals |
| **Interactive** | Commands, short phrases | Very short segments |

### Current Configuration

```javascript
// Speaker.tsx currently hardcodes dictation mode:
speechConfig.outputFormat = SDK.OutputFormat.Detailed
speechConfig.setProperty(
  SDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
  '200'  // SPEECH_END_SILENCE_MS
)
```

### Environment Variable

```bash
# .env
RECOGNITION_MODE=dictation  # dictation | conversation | interactive

# Note: Currently Speaker.tsx ignores this and uses dictation hardcoded
```

### Dictation Mode Characteristics

- **Punctuation**: Azure inserts `.` `?` `!` automatically
- **Silence Detection**: Longer tolerance before finalizing (configurable)
- **Segment Length**: Can produce longer segments
- **Best For**: Interpreters, meetings, lectures

### Conversation Mode Characteristics

- **Punctuation**: Less automatic punctuation
- **Silence Detection**: Shorter, more responsive
- **Segment Length**: Shorter, more frequent finals
- **Best For**: Dialogue, Q&A sessions

### Why Dictation Mode?

For real-time interpretation:
1. Speakers often pause mid-thought
2. Dictation mode's punctuation helps segment sentences
3. Fast-Finals compensates for dictation mode's slower finals
4. Combined: Best of both worlds (accuracy + speed)

---

## Environment Variables Reference

### Speech Recognition Settings

```bash
# Azure Recognition Mode
RECOGNITION_MODE=dictation              # dictation | conversation | interactive

# Silence Detection
SPEECH_SEGMENTATION_SILENCE_MS=300      # Silence to trigger segmentation
SPEECH_INITIAL_SILENCE_MS=3000          # Max silence before utterance starts
SPEECH_END_SILENCE_MS=200               # Silence to end utterance

# Token Management
SPEECH_TOKEN_REFRESH_MS=540000          # Refresh token every 9 minutes

# TTS Audio Format
SPEECH_TTS_FORMAT=Audio24Khz48KBitRateMonoMp3
```

### Fast-Finals Settings

```bash
# Stability Detection
FASTFINALS_STABLE_K=2                   # Consecutive events for stability
FASTFINALS_MIN_STABLE_MS=350            # Min time prefix must be stable

# Emission Thresholds
FASTFINALS_MIN_CHARS=45                 # Min new chars to emit
FASTFINALS_MIN_WORDS=6                  # Min words (alternative threshold)
FASTFINALS_EMIT_THROTTLE_MS=800         # Min time between emissions

# Tail Guard (prevents premature commits)
FASTFINALS_TAIL_GUARD_CHARS=10          # Don't emit last N chars
FASTFINALS_TAIL_GUARD_WORDS=2           # Word-based guard (alternative)

# Punctuation Handling
FASTFINALS_PUNCT_STABLE_MS=300          # Extra stability for punct-final
```

### Soft Patch Settings

```bash
# UI Preview Updates (separate from fast-finals)
SOFT_THROTTLE_MS=700                    # Min time between soft patches
SOFT_MIN_DELTA_CHARS=12                 # Min char change to emit soft
FINAL_DEBOUNCE_MS=50                    # Debounce SDK finals
MAX_UTTERANCE_DURATION_MS=7000          # Force segment after N ms
```

### Language Detection Settings

```bash
# Auto Language Detection
AUTO_DETECT_LANGS=en-CA,fr-CA           # Languages to detect between

# Language Stability (prevents flip-flopping)
SPEECH_LANG_STABILITY_SEC=15            # Seconds before allowing switch
SPEECH_LANG_SWITCH_THRESHOLD=2          # Consecutive detections to switch
SPEECH_MIN_AUDIO_SEC=2                  # Min audio before detection valid
```

### Translation Settings

```bash
# Translation Provider
TRANSLATOR_PROVIDER=openai              # openai | azure

# OpenAI Translation
OPENAI_API_KEY=...
OPENAI_TRANSLATE_MODEL=gpt-4o-mini
OPENAI_TRANSLATE_ENDPOINT=https://api.openai.com/v1/chat/completions

# Azure Translator (fallback)
TRANSLATOR_KEY=...
TRANSLATOR_REGION=eastus
TRANSLATOR_ENDPOINT=https://api.cognitive.microsofttranslator.com
```

### Translation Buffering

```bash
# Merge short segments before translation
TRANSLATION_MERGE_ENABLED=true
TRANSLATION_MERGE_WINDOW_MS=1500        # Window to collect segments
TRANSLATION_MIN_MERGE_CHARS=50          # Min chars to trigger merge
TRANSLATION_MAX_MERGE_COUNT=3           # Max segments to merge
```

### TTS Settings

```bash
# Speed Adjustment (for backlog)
TTS_BASE_SPEED=1.05                     # Normal playback speed
TTS_MAX_SPEED=1.30                      # Max speed when behind
TTS_BACKLOG_RAMP_START_SEC=5            # Start ramping at N sec backlog
TTS_BACKLOG_RAMP_END_SEC=20             # Max speed at N sec backlog
TTS_MAX_SPEED_CHANGE_PERCENT=15         # Max speed change per segment

# Voices
DEFAULT_TTS_VOICE=en-US-JennyNeural
DEFAULT_TTS_VOICE_FALLBACK=en-US-GuyNeural
DEFAULT_TTS_VOICE_FR_CA=fr-CA-SylvieNeural
TTS_BACKLOG_FALLBACK_VOICE=             # Faster voice when behind
```

### Patch Management

```bash
PATCH_LRU_PER_ROOM=500                  # Max patches to keep per room
PATCH_HISTORY_MAX_MS=0                  # Patch history TTL (0 = unlimited)
CONTINUATION_MERGE_ENABLED=false        # Merge truncated segments
```

### Watchdog Settings

```bash
WATCHDOG_EVENT_IDLE_MS=15000            # Alert if no events for N ms
WATCHDOG_PCM_IDLE_MS=7000               # Alert if no audio for N ms
WS_PING_INTERVAL_MS=30000               # WebSocket keepalive
```

---

## Commits (Chronological)

### Early Session - TTS Deduplication Attempts

| Commit | Description |
|--------|-------------|
| `de65918` | Add durable server-side TTS deduplication |
| `5629ba6` | Add segment-level TTS deduplication at synthesis time |
| `a5ed013` | Fix TTS dedup to track segment ID instead of text |
| `6bd4dea` | Add early TTS at sentence boundaries (Option A) |
| `25629f1` | Add 4-second flush timeout for uncommitted speech |

### Mid Session - Simplification

| Commit | Description |
|--------|-------------|
| `3ea76b3` | Remove segment-level deduplication - too error-prone |
| `4e82cc3` | Remove early TTS - only trigger on ttsFinal patches |
| `9302764` | Simplify TTS: remove all dedup and skip logic |
| `a2e0d7c` | Remove version tracking from TTS - simplify further |

### Critical Fix - TTS Not Triggering

| Commit | Description |
|--------|-------------|
| `b76af00` | Add TTS debug logging to diagnose missing TTS |
| `724d4a7` | **Fix TTS not triggering - version skip was blocking TTS check** |

### Final Fixes - Duplicate & Language Issues

| Commit | Description |
|--------|-------------|
| `68cdadf` | Fix duplicate TTS and wrong-language TTS issues |
| `e9c9e61` | Fix false positive French detection on English text with French names |

---

## Detailed Changes

### 1. TTS Not Triggering (`724d4a7`)

**Problem**: TTS was not firing at all despite `ttsFinal` patches being sent.

**Root Cause**: The version skip logic used a `continue` statement that skipped the TTS check entirely:

```javascript
// BEFORE (broken)
if (lastSeenVersion !== undefined && payload.version <= lastSeenVersion) {
  continue;  // THIS SKIPPED TTS CHECK TOO!
}
// TTS check never reached
```

**Fix**: Separated patch sending from TTS enqueuing - TTS check now happens regardless of version skip:

```javascript
// AFTER (fixed)
const alreadySeen = lastSeenVersion !== undefined && payload.version <= lastSeenVersion;
if (!alreadySeen) {
  safeSend(client.socket, message);
  // ...
}

// Check TTS even if patch was already sent
if (client.wantsTts && payload.ttsFinal) {
  // TTS enqueue logic
}
```

---

### 2. Duplicate TTS (`68cdadf`)

**Problem**: Same segment was being spoken 2-3 times because:
- Fast-final with punctuation triggers `ttsFinal: true`
- SDK recognized final also triggers `ttsFinal: true`
- Each triggered separate TTS synthesis

**Example from HAR**:
```
Unit 2:
  v=8, ttsFinal=True  → TTS #1
  v=9, ttsFinal=True  → TTS #2 (duplicate!)
  v=15, ttsFinal=True → TTS #3 (duplicate!)
```

**Fix**: Added `ttsTriggeredUnits` Map per room to track which root units have already triggered TTS:

```javascript
// Track which root units have already triggered TTS
const ttsTriggeredUnits = new Map();

// In TTS enqueue:
const rootUnitId = payload.unitId.split('#')[0];
const ttsKey = `${lang}:${rootUnitId}`;

if (room.ttsTriggeredUnits.has(ttsKey)) {
  // Skip - already triggered TTS for this unit
  continue;
}

// After enqueue:
room.ttsTriggeredUnits.set(ttsKey, Date.now());
```

---

### 3. Wrong Language TTS (`68cdadf`)

**Problem**: French source text was being sent to English TTS. Example:
- Patch has `targetLang=en-US` but text is "Je l'ai lu. Je vais bien."

**Root Cause**: Translation failed or had race condition, but ttsFinal patch was still sent with source text.

**Fix**: Added language detection before TTS enqueue:

```javascript
const textLangBase = inferLikelyBase(payload.text);
if (textLangBase && textLangBase !== targetLangBase) {
  room.logger.warn({ ... }, 'Skipping - text language mismatch');
  continue;
}
```

---

### 4. False Positive French Detection (`e9c9e61`)

**Problem**: English text containing French proper nouns (like "Geneviève") was blocked from TTS because the accent `è` triggered French detection.

**Example blocked text**:
> "Yes, because we have a good one. Thalia, you've often said that the school board is calling... **Geneviève**, do we know who would replace Dahlia?"

**Root Cause**: Any French accent character triggered French detection, even in clearly English text.

**Fix**: Updated language detection priority:

```javascript
// BEFORE: French accents alone triggered French
if (hasFrenchAccents || hasFrenchWords || hasFrenchPatterns) return 'fr';

// AFTER: Check English first, require strong French signals
if (hasEnglishWords) {
  // Only override to French if strong signals (words/patterns, not just accents)
  if (hasFrenchWords || hasFrenchPatterns) return 'fr';
  return 'en';
}
// No English words - accents alone are enough for French
if (hasFrenchAccents || hasFrenchWords || hasFrenchPatterns) return 'fr';
```

---

## Enhanced Language Detection Patterns

### French Detection (Strong Signals)

**Words**:
```
merci, bonjour, je, j'ai, l'ai, vais, bien, nous, vous, ils, elles,
c'est, qu'est, n'est, d'accord, pour, sont, mais, que, qui, quoi,
donc, alors, parce, cette, notre, votre, leur, très, aussi, peut,
dois, fait, faire, avoir, être, ça, cela, comme, tout, tous, toutes
```

**Patterns** (contractions):
```
l', d', j', n', s', c', qu', m', t' (followed by word)
```

**Accents** (weak signal - requires no English words):
```
àâäæçéèêëîïôœùûüÿ
```

### English Detection

**Words**:
```
the, this, that, with, have, has, been, will, would, could, should,
they, them, their, there, here, what, when, where, which, because,
about, into, from, just, some, more, other, only, also, than, then,
thank you, thanks, hello, today, this afternoon
```

---

## Files Modified

| File | Changes |
|------|---------|
| `server/index.js` | TTS triggering logic, deduplication, language detection |
| `server/tts.js` | Removed over-aggressive deduplication, added debug logging |
| `server/segment-processor.js` | ttsFinal propagation |
| `client/src/pages/Speaker.tsx` | Fast-finals ttsFinal logic |

---

## Testing Recommendations

### Before Deploying

1. **Fresh Connection Test**: New listener connections should receive TTS
2. **Duplicate Test**: Same segment should only be spoken once
3. **French Name Test**: English text with "François", "Geneviève", etc. should play
4. **French Text Test**: Actual French like "Je vais bien" targeting English should be blocked

### HAR File Analysis

To debug TTS issues, capture HAR files and analyze:
- Count `ttsFinal` patches vs TTS events
- Check `provider` and `targetLang` on patches
- Verify language detection isn't blocking valid text

---

## Known Limitations

1. **TTS Deduplication**: Once a root unit triggers TTS, subsequent versions won't re-trigger. This is intentional to prevent duplicates but means revisions aren't re-spoken.

2. **Language Detection**: Heuristic-based, may have edge cases. The pattern lists can be expanded if needed.

3. **Translation Failures**: If OpenAI/Azure translation fails and returns source text, the language detection will block it. This is a safety feature but means those segments won't have TTS.

---

## Rollback Information

If issues occur, the last known stable commit before TTS changes was:
```
004e429 Fix TTS word splitting and improve sentence detection
```

To rollback:
```bash
git revert --no-commit e9c9e61..HEAD
git commit -m "Revert TTS changes"
```

---

*Document generated: November 27, 2025*
