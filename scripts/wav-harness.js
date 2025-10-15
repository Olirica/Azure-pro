#!/usr/bin/env node
/**
 * Streams a WAV file through Azure Speech and posts replace-in-place patches to the local server.
 * Intended for smoke tests and CI in lieu of a live microphone.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const process = require('process');

require('dotenv').config();

const sdk = require('microsoft-cognitiveservices-speech-sdk');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

function usage() {
  console.log(`Usage: node scripts/wav-harness.js --file sample.wav [--room demo-room] [--lang en-US] [--targets fr-FR,es-ES] [--wait-final 10000]`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--file':
        args.file = next;
        i += 1;
        break;
      case '--room':
        args.room = next;
        i += 1;
        break;
      case '--lang':
        args.lang = next;
        i += 1;
        break;
      case '--targets':
        args.targets = next;
        i += 1;
        break;
      case '--wait-final':
        args.waitFinal = Number(next);
        i += 1;
        break;
      case '--self-test':
        args.selfTest = true;
        i -= 1;
        argv.splice(i + 1, 0);
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.warn(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function normalizeLangList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeContinuation(previous, incoming) {
  const next = (incoming || '').trim();
  if (!previous) return next;
  const prev = previous.trim();
  if (!prev) return next;
  if (next.startsWith(prev)) {
    return next;
  }
  const normPrev = normalize(prev);
  const normNext = normalize(next);
  if (!normPrev || !normNext) return next;
  let i = 0;
  while (i < normPrev.length && i < normNext.length && normPrev[i] === normNext[i]) {
    i += 1;
  }
  const overlapRatio = i / Math.max(normPrev.length, 1);
  if (overlapRatio >= 0.8) {
    return `${prev}${next.slice(i)}`;
  }
  return next;
}

async function postPatch(roomId, targetLangs, patch) {
  const payload = {
    roomId,
    targets: targetLangs,
    patch
  };
  const res = await fetch(`${SERVER_URL}/api/segments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.warn('Patch POST failed', { status: res.status, body });
  }
}

async function runSelfTest() {
  console.log('Self-test: generating synthetic patches.');
  const roomId = `selftest-${Date.now()}`;
  const targets = ['fr-FR'];
  const patch = {
    unitId: `${crypto.randomUUID()}|en-US|0`,
    stage: 'hard',
    op: 'replace',
    version: 1,
    text: 'Self-test message.',
    srcLang: 'en-US'
  };
  try {
    await postPatch(roomId, targets, patch);
  } catch (err) {
    console.warn('Self-test POST failed (expected if server is down).', err?.message);
  }
  console.log('Self-test complete.');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  if (args.selfTest) {
    await runSelfTest();
    process.exit(0);
  }

  const speechKey = process.env.SPEECH_KEY;
  const speechRegion = process.env.SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    console.error('SPEECH_KEY and SPEECH_REGION must be configured to run the harness.');
    process.exit(1);
  }

  if (!args.file) {
    console.error('--file is required.');
    usage();
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const roomId = args.room || 'demo-room';
  const lang = args.lang || 'en-US';
  const targetLangs = normalizeLangList(args.targets || process.env.HARNESS_TARGETS || '');
  const waitFinal = args.waitFinal || 10000;

  console.log(`Streaming ${filePath} to room ${roomId} (${lang} → ${targetLangs.join(', ') || '—'})`);

  const sessionId = crypto.randomUUID();
  let unitIndex = 0;
  let version = 0;
  let lastSoftAt = 0;
  let lastSoftText = '';

  const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
  speechConfig.speechRecognitionLanguage = lang;
  speechConfig.outputFormat = sdk.OutputFormat.Detailed;
  speechConfig.setProperty(
    sdk.PropertyId.SpeechServiceResponse_StablePartialResultThreshold,
    '3'
  );
  speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, '800');
  speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '5000');

  const wavBuffer = fs.readFileSync(filePath);
  const audioConfig = sdk.AudioConfig.fromWavFileInput(wavBuffer);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  function unitId() {
    return `${sessionId}|${lang}|${unitIndex}`;
  }

  function timestamps(result) {
    if (!result) return undefined;
    const offsetMs = Math.floor(result.offset / 10000);
    const durationMs = Math.floor(result.duration / 10000);
    return { t0: offsetMs, t1: offsetMs + durationMs };
  }

  recognizer.recognizing = async (_sender, event) => {
    if (!event?.result?.text) return;
    const merged = dedupeContinuation(lastSoftText, event.result.text.trim());
    const now = Date.now();
    const punctuationTrigger = /[.?!]\s*$/.test(merged);
    const delta = merged.length - lastSoftText.length;
    const charTrigger = delta > 18;
    const timeTrigger = now - lastSoftAt > 1000;
    if ((punctuationTrigger || charTrigger) && timeTrigger) {
      lastSoftText = merged;
      lastSoftAt = now;
      version += 1;
      await postPatch(roomId, targetLangs, {
        unitId: unitId(),
        stage: 'soft',
        op: 'replace',
        version,
        text: merged,
        srcLang: lang,
        ts: timestamps(event.result)
      });
      console.log(`soft v${version}: ${merged}`);
    }
  };

  recognizer.recognized = async (_sender, event) => {
    if (!event?.result) return;
    if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
      const finalText = event.result.text.trim();
      if (!finalText) return;
      version += 1;
      await postPatch(roomId, targetLangs, {
        unitId: unitId(),
        stage: 'hard',
        op: 'replace',
        version,
        text: finalText,
        srcLang: lang,
        ts: timestamps(event.result)
      });
      console.log(`hard v${version}: ${finalText}`);
      unitIndex += 1;
      version = 0;
      lastSoftText = '';
      lastSoftAt = Date.now();
    } else if (event.result.reason === sdk.ResultReason.NoMatch) {
      console.warn('No match for segment.');
    }
  };

  recognizer.canceled = (_sender, event) => {
    console.warn('Recognition canceled', event);
  };

  recognizer.sessionStarted = () => {
    console.log('Session started.');
  };

  recognizer.sessionStopped = () => {
    console.log('Session stopped.');
  };

  recognizer.startContinuousRecognitionAsync();

  await new Promise((resolve) => setTimeout(resolve, waitFinal));
  recognizer.stopContinuousRecognitionAsync(() => {
    console.log('Recognition completed.');
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
