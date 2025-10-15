# Fast Finals mode

This branch adds a conservative “fast finals” path that lets the speaker client hand off stable prefixes while Azure is still listening, so the translated audio can start several seconds sooner without turning partials into speech.

## What changed

- **Speaker client** keeps a ring buffer of the last _K_ partials, computes the stable common prefix, and only promotes it when it has held for `FASTFINALS_MIN_STABLE_MS` and either ends on punctuation or clears both `FASTFINALS_MIN_CHARS` and `FASTFINALS_MIN_WORDS`. Each promoted slice is posted as a hard segment (with a fresh unit id); the Azure final only sends the remainder.
- **Server tunables** are lowered to encourage earlier Azure finals (`SPEECH_SEGMENTATION_SILENCE_MS=500`, `SPEECH_END_SILENCE_MS=350`, `SPEECH_STABLE_PARTIALS=4`). The `/api/config` response exposes these values plus the fast‑finals parameters to the browser client.
- **TTS queue** now pre-synthesises the next segment while the current one is delivered and applies a small `<prosody rate="+10%">` boost once backlog exceeds `TTS_MAX_BACKLOG_SEC`, matching the recommended +10% rate increase.

## Environment knobs

```bash
# Fast finals
FASTFINALS_STABLE_K=3
FASTFINALS_MIN_STABLE_MS=600
FASTFINALS_MIN_CHARS=28
FASTFINALS_MIN_WORDS=6
FASTFINALS_EMIT_THROTTLE_MS=700
FASTFINALS_PUNCT_STABLE_MS=350

# Azure STT pressure
SPEECH_STABLE_PARTIALS=4
SPEECH_SEGMENTATION_SILENCE_MS=500
SPEECH_INITIAL_SILENCE_MS=3000
SPEECH_END_SILENCE_MS=350

# TTS backlog protection
TTS_MAX_BACKLOG_SEC=8
TTS_RESUME_BACKLOG_SEC=4
TTS_RATE_BOOST_PERCENT=10
```

Legacy variables (`STABLE_PARTIALS`, `SEG_SILENCE_MS`, etc.) are still honoured, but the new names map directly to the Azure setting names and should be preferred.

## Rollback switches

If you need to fall back mid-show:

1. Set `FASTFINALS_MIN_CHARS=9999` (and optionally `FASTFINALS_MIN_WORDS=999`) in the environment. This keeps the prefix guardrails in place but effectively disables early commits without a redeploy.
2. The speaker page also reads the updated values on reload—no rebuild required.

## Speech hygiene tips

- Keep phrase hints up to date for each event (the loader now guarantees that “session” is always in the list to fight the “recession” mishear).
- Raise `FASTFINALS_STABLE_K` to 4–5 if you expect noisier rooms or highly accented speakers; lower to 2 for very crisp audio once you trust the pipeline.
- Leave `FASTFINALS_MIN_STABLE_MS` at 600 ms unless you have short, punchy scripts—dropping it further will increase the chance of committing the wrong word.
- Adjust `FASTFINALS_PUNCT_STABLE_MS` (default 350 ms) if you need prefixes to snap even faster on obvious punctuation, or increase it for speakers who pause mid-sentence.

## Testing checklist

- Start the speaker UI, talk for ~20 seconds with pauses: you should see “Prefix committed” entries in the debug log and hear the listener audio 3–6 s sooner.
- Watch the listener queue metrics: the TTS backlog should hover below 8 s; when it rises above, the log should mention the rate boost and revert once the backlog drains.
