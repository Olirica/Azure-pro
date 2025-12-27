#!/usr/bin/env node
/**
 * Streams a WAV file through Deepgram and posts patches to the local server.
 * Intended for smoke tests and CI in lieu of a live microphone.
 *
 * Usage:
 *   node scripts/deepgram-harness.js --file sample.wav [--room demo-room] [--lang en-US] [--targets fr-FR,es-ES]
 *
 * Environment:
 *   DEEPGRAM_API_KEY - Required
 *   DEEPGRAM_MODEL - Optional, defaults to nova-2-general
 *   SERVER_URL - Optional, defaults to http://localhost:3000
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const process = require('process');

require('dotenv').config();

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-2-general';

function usage() {
  console.log(`
Usage: node scripts/deepgram-harness.js --file sample.wav [options]

Options:
  --file <path>       WAV file to stream (required)
  --room <id>         Room ID (default: demo-room)
  --lang <code>       Source language, e.g. en-US (default: en-US)
  --targets <list>    Target languages, comma-separated (default: none)
  --wait-final <ms>   Wait time after last transcript (default: 5000)
  --self-test         Run a simple self-test without audio
  --help              Show this help message

Environment:
  DEEPGRAM_API_KEY    Deepgram API key (required)
  DEEPGRAM_MODEL      Model to use (default: nova-2-general)
  SERVER_URL          Server URL (default: http://localhost:3000)
`);
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
  const roomId = `selftest-deepgram-${Date.now()}`;
  const targets = ['fr-FR'];
  const patch = {
    unitId: `${crypto.randomUUID()}|en-US|0`,
    stage: 'hard',
    op: 'replace',
    version: 1,
    text: 'Deepgram self-test message.',
    srcLang: 'en-US',
    ttsFinal: true
  };
  try {
    await postPatch(roomId, targets, patch);
    console.log('Self-test POST succeeded.');
  } catch (err) {
    console.warn('Self-test POST failed (expected if server is down).', err?.message);
  }
  console.log('Self-test complete.');
}

/**
 * Parse WAV header to extract audio format info
 */
function parseWavHeader(buffer) {
  // Check RIFF header
  const riff = buffer.toString('utf8', 0, 4);
  if (riff !== 'RIFF') {
    throw new Error('Not a valid WAV file (missing RIFF header)');
  }

  const wave = buffer.toString('utf8', 8, 12);
  if (wave !== 'WAVE') {
    throw new Error('Not a valid WAV file (missing WAVE format)');
  }

  // Find fmt chunk
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('utf8', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      const audioFormat = buffer.readUInt16LE(offset + 8);
      const numChannels = buffer.readUInt16LE(offset + 10);
      const sampleRate = buffer.readUInt32LE(offset + 12);
      const bitsPerSample = buffer.readUInt16LE(offset + 22);

      return {
        audioFormat,
        numChannels,
        sampleRate,
        bitsPerSample,
        dataOffset: null  // Will find data chunk next
      };
    }
    offset += 8 + chunkSize;
  }

  throw new Error('Could not find fmt chunk in WAV file');
}

/**
 * Find the data chunk in WAV file
 */
function findDataChunk(buffer) {
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('utf8', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'data') {
      return {
        offset: offset + 8,
        size: chunkSize
      };
    }
    offset += 8 + chunkSize;
  }
  throw new Error('Could not find data chunk in WAV file');
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

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error('DEEPGRAM_API_KEY must be configured to run the harness.');
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
  const waitFinal = args.waitFinal || 5000;

  console.log(`Streaming ${filePath} to room ${roomId} (${lang} → ${targetLangs.join(', ') || '—'})`);
  console.log(`Using Deepgram model: ${DEEPGRAM_MODEL}`);

  // Read and parse WAV file
  const wavBuffer = fs.readFileSync(filePath);
  const wavInfo = parseWavHeader(wavBuffer);
  const dataChunk = findDataChunk(wavBuffer);

  console.log(`WAV format: ${wavInfo.sampleRate}Hz, ${wavInfo.numChannels}ch, ${wavInfo.bitsPerSample}bit`);

  // Session state
  const sessionId = crypto.randomUUID();
  let unitIndex = 0;
  let version = 0;
  let lastSoftAt = 0;
  let lastSoftText = '';
  let lastTranscriptAt = Date.now();

  function unitId() {
    return `${sessionId}|${lang}|${unitIndex}`;
  }

  // Create Deepgram client
  const deepgram = createClient(apiKey);

  // Build Deepgram options
  const dgOptions = {
    model: DEEPGRAM_MODEL,
    language: lang.split('-')[0],  // Deepgram uses short codes
    punctuate: true,
    smart_format: true,
    utterance_end_ms: 1000,
    interim_results: true,
    encoding: 'linear16',
    sample_rate: wavInfo.sampleRate,
    channels: wavInfo.numChannels
  };

  console.log('Connecting to Deepgram...');
  const connection = deepgram.listen.live(dgOptions);

  let resolveCompletion;
  const completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  // Track when we're done sending audio
  let audioSent = false;

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log('Deepgram connection opened');

    // Stream audio data in chunks
    const audioData = wavBuffer.slice(dataChunk.offset, dataChunk.offset + dataChunk.size);
    const chunkSize = 4096;  // ~128ms at 16kHz mono 16-bit

    let offset = 0;
    const sendChunk = () => {
      if (offset >= audioData.length) {
        console.log('All audio data sent');
        audioSent = true;
        // Signal end of audio
        setTimeout(() => {
          connection.finish();
        }, 100);
        return;
      }

      const chunk = audioData.slice(offset, offset + chunkSize);
      connection.send(chunk);
      offset += chunkSize;

      // Simulate real-time by pacing the chunks
      // At 16kHz 16-bit mono, 4096 bytes = 128ms
      const msPerChunk = (chunkSize / 2) / wavInfo.sampleRate * 1000;
      setTimeout(sendChunk, msPerChunk / 2);  // 2x speed for faster testing
    };

    sendChunk();
  });

  connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt || !alt.transcript?.trim()) return;

    lastTranscriptAt = Date.now();
    const text = alt.transcript.trim();
    const isFinal = data.is_final === true;
    const isSpeechFinal = data.speech_final === true;

    // Compute timestamps from words
    const words = alt.words || [];
    const ts = words.length > 0 ? {
      t0: Math.floor(words[0].start * 1000),
      t1: Math.floor(words[words.length - 1].end * 1000)
    } : undefined;

    if (isFinal) {
      version += 1;
      await postPatch(roomId, targetLangs, {
        unitId: unitId(),
        stage: 'hard',
        op: 'replace',
        version,
        text,
        srcLang: lang,
        ttsFinal: isSpeechFinal,
        ts
      });
      console.log(`hard v${version}${isSpeechFinal ? ' [speech_final]' : ''}: ${text}`);

      if (isSpeechFinal) {
        unitIndex += 1;
        version = 0;
        lastSoftText = '';
        lastSoftAt = Date.now();
      }
    } else {
      // Interim result - emit as soft patch with throttling
      const now = Date.now();
      const delta = text.length - lastSoftText.length;
      const charTrigger = delta > 12;
      const timeTrigger = now - lastSoftAt > 700;
      const punctTrigger = /[.?!]\s*$/.test(text);

      if ((charTrigger || punctTrigger) && timeTrigger) {
        lastSoftText = text;
        lastSoftAt = now;
        version += 1;
        await postPatch(roomId, targetLangs, {
          unitId: unitId(),
          stage: 'soft',
          op: 'replace',
          version,
          text,
          srcLang: lang,
          ts
        });
        console.log(`soft v${version}: ${text}`);
      }
    }
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    console.log('Utterance end detected');
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('Deepgram error:', err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log('Deepgram connection closed');
    // Wait a bit for any final transcripts, then resolve
    setTimeout(() => {
      resolveCompletion();
    }, waitFinal);
  });

  // Wait for completion
  await completionPromise;

  console.log('\nHarness complete.');
  console.log(`Final stats: ${unitIndex + 1} utterances, ${version} patches total`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
