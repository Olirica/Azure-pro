# Pipeline Bench — STT / MT / TTS health & latency checks

This suite gives you quick, automated barometers for each hop and for the combined path.

## Install
```bash
cd pipeline-bench
npm i
cp .env.example .env   # fill keys, server URL, tokens
```

## Tests
1. **00_env_check** — confirms required env is present.
   ```bash
   node tests/00_env_check.js
   ```

2. **10_stt_file_harness** — feeds a WAV to Azure STT, prints partial/final timing, and flags late finals.
   ```bash
   node tests/10_stt_file_harness.js --wav ./samples/intro_30s.wav --lang en-US --maxFinalSec 10
   ```

3. **20_mt_eval** — checks translation quality for TSV (`src \t ref`) or a single line using Azure Translator; computes token F1 + tiny BLEU.
   ```bash
   node tests/20_mt_eval.js --text "Hello world." --to fr
   # or
   node tests/20_mt_eval.js --tsv ./samples/en-fr.tsv --to fr
   ```

4. **30_pipeline_smoke** — WS virtual speaker+listener; sends prefixes/final (or uses a WAV transcript) to your server and verifies translated text/TTS arrival & latency.
   ```bash
   node tests/30_pipeline_smoke.js --server ws://localhost:3000/ws --room demo-room --speaker demo2025-speaker --listener demo2025 --lang fr-FR
   ```

5. **40_tts_backlog_probe** — connects as a listener, watches `tts` events and estimates backlog trend; fails if drift keeps growing.
   ```bash
   node tests/40_tts_backlog_probe.js --server ws://localhost:3000/ws --listener demo2025
   ```

## Sample Files

The `samples/` directory contains benchmark audio and translation test data:

- **intro_30s.wav** (938KB) - 30-second English conference intro, 16kHz mono PCM
- **intro_60s.wav** (1.8MB) - 60-second English conference intro
- **conference_full.wav** (15MB) - Full ~8min conference audio (music intro trimmed)
- **en-fr.tsv** - English→French translation test pairs for quality benchmarks

All audio files are 16kHz mono 16-bit PCM, ready for Azure Speech STT.

## Notes
- These are **agent-friendly** (can run from CI, Droid, Claude Code, etc.).
- You can schedule them against staging before every show; failures print precise diagnostics (where and why).

