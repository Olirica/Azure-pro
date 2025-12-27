#!/usr/bin/env node
/**
 * Local Whisper STT Harness
 *
 * Streams a WAV file through the full pipeline:
 * WAV → Whisper Service → Node.js Server → Translation → TTS
 *
 * Uses WebSocket streaming mode, same as browser Speaker page.
 *
 * Usage:
 *   node scripts/local-whisper-harness.js --file sample.wav --room demo-room
 *   node scripts/local-whisper-harness.js --file sample.wav --room demo-room --targets fr-FR,es-ES
 *
 * Environment:
 *   SERVER_URL - Server URL (default: http://localhost:3000)
 *   WHISPER_SOCKET_PATH - Unix socket for whisper service
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

require('dotenv').config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const WS_URL = SERVER_URL.replace(/^http/, 'ws');

function usage() {
  console.log(`
Usage: node scripts/local-whisper-harness.js --file sample.wav [options]

Options:
  --file <path>       WAV file to stream (required)
  --room <id>         Room ID (default: demo-room)
  --lang <code>       Source language, e.g. en-US (default: en-US)
  --targets <list>    Target languages, comma-separated (default: none)
  --wait-final <ms>   Wait time after last event (default: 5000)
  --self-test         Run a simple self-test without audio
  --help              Show this help message

Environment:
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

/**
 * Parse WAV file header
 */
function parseWavHeader(buffer) {
  const riff = buffer.toString('utf8', 0, 4);
  if (riff !== 'RIFF') {
    throw new Error('Not a valid WAV file (missing RIFF header)');
  }

  const wave = buffer.toString('utf8', 8, 12);
  if (wave !== 'WAVE') {
    throw new Error('Not a valid WAV file (missing WAVE format)');
  }

  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('utf8', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      return {
        audioFormat: buffer.readUInt16LE(offset + 8),
        numChannels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    }
    offset += 8 + chunkSize;
  }

  throw new Error('Could not find fmt chunk in WAV file');
}

/**
 * Find data chunk in WAV file
 */
function findDataChunk(buffer) {
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('utf8', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'data') {
      return {
        offset: offset + 8,
        size: chunkSize,
      };
    }
    offset += 8 + chunkSize;
  }
  throw new Error('Could not find data chunk in WAV file');
}

/**
 * Convert audio to 16kHz mono 16-bit PCM
 * @param {Buffer} audioData - Raw PCM data
 * @param {Object} wavInfo - WAV header info
 * @returns {Buffer} Converted 16kHz mono PCM
 */
function convertTo16kMono(audioData, wavInfo) {
  const { sampleRate, numChannels, bitsPerSample } = wavInfo;
  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  const numFrames = audioData.length / frameSize;

  if (sampleRate === 16000 && numChannels === 1 && bitsPerSample === 16) {
    return audioData;
  }

  console.log(`Converting: ${sampleRate}Hz ${numChannels}ch → 16000Hz mono`);

  const targetRate = 16000;
  const ratio = sampleRate / targetRate;
  const targetFrames = Math.floor(numFrames / ratio);
  const output = Buffer.alloc(targetFrames * 2);

  for (let i = 0; i < targetFrames; i++) {
    const srcIdx = Math.floor(i * ratio);
    const frameOffset = srcIdx * frameSize;

    let sample = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const offset = frameOffset + ch * bytesPerSample;
      if (bitsPerSample === 16) {
        sample += audioData.readInt16LE(offset);
      } else if (bitsPerSample === 8) {
        sample += (audioData.readUInt8(offset) - 128) * 256;
      }
    }
    sample = Math.round(sample / numChannels);
    sample = Math.max(-32768, Math.min(32767, sample));
    output.writeInt16LE(sample, i * 2);
  }

  const durationSec = targetFrames / targetRate;
  console.log(`Converted: ${(output.length / 1024).toFixed(1)}KB (${durationSec.toFixed(1)}s)`);
  return output;
}

async function runSelfTest() {
  console.log('Self-test: posting synthetic patch via HTTP');
  const roomId = `selftest-whisper-${Date.now()}`;
  const patch = {
    unitId: `${crypto.randomUUID()}|en-US|0`,
    stage: 'hard',
    op: 'replace',
    version: 1,
    text: 'Local whisper self-test message.',
    srcLang: 'en-US',
    ttsFinal: true,
  };

  try {
    const res = await fetch(`${SERVER_URL}/api/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        targets: ['fr-FR'],
        patch,
      }),
    });
    if (res.ok) {
      console.log('Self-test POST succeeded.');
    } else {
      console.warn('Self-test POST failed:', res.status);
    }
  } catch (err) {
    console.warn('Self-test POST failed (server may be down):', err?.message);
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
  console.log(`Server: ${SERVER_URL}`);

  // Read and parse WAV file
  const wavBuffer = fs.readFileSync(filePath);
  const wavInfo = parseWavHeader(wavBuffer);
  const dataChunk = findDataChunk(wavBuffer);

  console.log(`WAV format: ${wavInfo.sampleRate}Hz, ${wavInfo.numChannels}ch, ${wavInfo.bitsPerSample}bit`);

  // Connect to WebSocket in stream mode
  const wsUrl = `${WS_URL}/ws?room=${encodeURIComponent(roomId)}&role=speaker&stt=stream`;
  console.log(`\nConnecting to ${wsUrl}...`);

  const ws = new WebSocket(wsUrl);

  const t0 = Date.now();
  let patchCount = 0;
  let lastEventAt = Date.now();
  let audioSent = false;

  ws.on('open', () => {
    console.log('WebSocket connected');

    // Wait for stt:ready before sending audio
  });

  ws.on('message', (data) => {
    lastEventAt = Date.now();
    const tMs = lastEventAt - t0;

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'hello') {
        console.log(JSON.stringify({ ev: 'hello', t_ms: tMs, ...msg.payload }));
      } else if (msg.type === 'stt:ready') {
        console.log(JSON.stringify({ ev: 'stt:ready', t_ms: tMs, provider: msg.payload?.provider }));

        // Convert audio to 16kHz mono (Whisper's expected format)
        const rawAudio = wavBuffer.slice(dataChunk.offset, dataChunk.offset + dataChunk.size);
        const audioData = convertTo16kMono(rawAudio, wavInfo);
        const chunkSize = 4096; // ~128ms at 16kHz mono 16-bit

        let offset = 0;
        const sendChunk = () => {
          if (offset >= audioData.length) {
            console.log(`\nAll audio sent (${audioData.length} bytes)`);
            audioSent = true;
            return;
          }

          const chunk = audioData.slice(offset, offset + chunkSize);
          ws.send(chunk); // Send as binary
          offset += chunkSize;

          // Pace at 2x real-time for faster testing (16kHz)
          const msPerChunk = (chunkSize / 2) / 16000 * 1000;
          setTimeout(sendChunk, msPerChunk / 2);
        };

        sendChunk();
      } else if (msg.type === 'stt:error') {
        console.error(JSON.stringify({ ev: 'stt:error', t_ms: tMs, error: msg.payload?.error }));
      } else if (msg.type === 'patch') {
        patchCount++;
        const p = msg.payload;
        console.log(JSON.stringify({
          ev: 'patch',
          t_ms: tMs,
          stage: p.stage,
          text: p.text?.substring(0, 80),
          srcLang: p.srcLang,
          translations: p.translations ? Object.keys(p.translations) : [],
        }));
      }
    } catch (e) {
      // Binary data or parse error
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', () => {
    const totalMs = Date.now() - t0;
    console.log(`\nWebSocket closed after ${totalMs}ms`);
    console.log(`Total patches received: ${patchCount}`);
    process.exit(0);
  });

  // Auto-close after audio sent + wait period
  const checkComplete = setInterval(() => {
    if (audioSent && Date.now() - lastEventAt > waitFinal) {
      console.log('\nClosing connection (no new events)');
      clearInterval(checkComplete);
      ws.close();
    }
  }, 1000);

  // Timeout
  setTimeout(() => {
    console.error('\nHarness timed out');
    clearInterval(checkComplete);
    ws.close();
    process.exit(1);
  }, 180000); // 3 minute timeout
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
