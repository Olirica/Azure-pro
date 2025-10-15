# Fast Finals Implementation Log

## 2025-10-15

- 15:32:00Z – Branched `faster-finals`; inspected existing ASR/translation pipeline.
- 15:40:00Z – Reviewed Azure overlay guidance and unpacked reference ZIP.
- 16:05:00Z – Integrated prefix stabilisation, STT tunables, and TTS prefetch queue; documented in README-FASTFINALS.md; pushed commit `Add fast finals prefix flow with TTS enhancements`.
- 16:22:00Z – Observed volatile prefixes resetting stability; added candidate-based timing and raw-prefix tracking (`Fix fast finals stability timing on candidate endpoints`).
- 16:38:00Z – Tuned new `FASTFINALS_PUNCT_STABLE_MS` env and client loader to favour punctuation cuts (`Add punctuation dwell tuner for fast finals`).
- 16:45:00Z – Speaker debug log showed continuous partial growth with no hard emits; transcript missing "hello testing…" clause. Logged runtime config and soft patches for comparison.
- 16:55:00Z – Introduced tail guard tuners (`FASTFINALS_TAIL_GUARD_CHARS/WORDS`) to keep trailing words flexible and stop commits from stalling; updated env/server/client wiring (`Guard fast finals tail to prevent dropped clauses`).
- 17:05:00Z – Continuous: ran `npm run lint`, refreshed `azure-pro-fastfinals.zip` (excludes `.git`, `node_modules`, includes `.env`), pushed commits to `origin/fast`, and verified listener transcript playback.
- 17:20:00Z – Noted translator connection refusals in local dev (Azure service unreachable). Pipeline now logs the failure and falls back to identity text so source still propagates; ensure valid credentials/network before live use.

## Known Issues & Follow-ups

- Long monologues without punctuation may still require tuning (`FASTFINALS_MIN_STABLE_MS`, `FASTFINALS_TAIL_GUARD_*`).
- Watchdog triggers highlighted the need for continuous hard patches; tail guard fix resolves observed gaps.
- Azure Translator connectivity issues will continue to log warnings until valid credentials/endpoints are supplied; verify `TRANSLATOR_KEY`, region, or provide offline fallback before production.

## Test Snippets

```log
[2025-10-15T15:56:23.116Z] Runtime config loaded {"stablePartials":4,...,"fastFinals":{"stableK":3,"minStableMs":500,"minChars":28,"minWords":4,"emitThrottleMs":700,"punctStableMs":250}}
[2025-10-15T15:56:47.846Z] Soft patch (hidden) {"text":"hello testing 1"}
[2025-10-15T15:56:48.839Z] Soft patch (hidden) {"text":"hello testing 1 it's it's just a short"}
```

```log
{"level":40,"time":1760543648997,"roomId":"demo-room","component":"watchdog","msg":"Watchdog conditions met, signalling restart."}
```
