# Changelog: November 26-27, 2025

## Overview

This document summarizes the extensive TTS (Text-to-Speech) debugging and fixes made during the November 26-27 session. The primary goal was to resolve TTS issues where audio was either not playing, playing duplicates, or playing in the wrong language.

---

## Summary of Issues Addressed

1. **TTS Not Firing** - Text was being translated but not spoken
2. **Duplicate TTS** - Same segment spoken 2-3 times
3. **Wrong Language TTS** - French source text being sent to English TTS
4. **False Positive Language Detection** - English text with French proper nouns blocked from TTS

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
