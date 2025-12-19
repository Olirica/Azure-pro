#!/usr/bin/env node
/**
 * Local Whisper STT Benchmark
 *
 * Measures:
 * - TTFT (Time to First Token): time to first soft patch
 * - TTFC (Time to First Commit): time to first hard patch
 * - WER (Word Error Rate): against reference transcript
 * - Total processing time
 *
 * Usage:
 *   node tests/15_whisper_stt_file.js --wav ./samples/intro_30s.wav --ref ./samples/intro_30s.txt
 *   node tests/15_whisper_stt_file.js --wav ../Bilingual_1min.wav --ref ../Bilingual_1min.txt
 *
 * Environment:
 *   WHISPER_SOCKET_PATH - Unix socket path (default: /tmp/whisper-stt.sock)
 */

import 'dotenv/config';
import fs from 'fs';
import net from 'net';
import path from 'path';
import crypto from 'crypto';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { wer, formatWer } from './util/wer.js';

const argv = yargs(hideBin(process.argv))
  .option('wav', { type: 'string', demandOption: true, describe: 'WAV file to transcribe' })
  .option('ref', { type: 'string', describe: 'Reference transcript file for WER calculation' })
  .option('lang', { type: 'string', default: 'en-US', describe: 'Source language' })
  .option('socket', { type: 'string', default: '/tmp/whisper-stt.sock', describe: 'Whisper service socket path' })
  .option('maxTtfcSec', { type: 'number', default: 10, describe: 'Max TTFC threshold in seconds' })
  .option('maxWer', { type: 'number', default: 0.25, describe: 'Max WER threshold (0-1)' })
  .argv;

const SOCKET_PATH = argv.socket || process.env.WHISPER_SOCKET_PATH || '/tmp/whisper-stt.sock';

/**
 * Parse WAV file header and extract audio data
 */
function parseWav(buffer) {
  const riff = buffer.toString('utf8', 0, 4);
  if (riff !== 'RIFF') throw new Error('Not a valid WAV file');

  const wave = buffer.toString('utf8', 8, 12);
  if (wave !== 'WAVE') throw new Error('Not a valid WAV file');

  // Find fmt chunk
  let offset = 12;
  let format = null;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('utf8', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        numChannels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    }

    if (chunkId === 'data') {
      return {
        format,
        data: buffer.slice(offset + 8, offset + 8 + chunkSize),
      };
    }

    offset += 8 + chunkSize;
  }

  throw new Error('Could not find data chunk');
}

/**
 * Run the benchmark
 */
async function runBenchmark() {
  // Check socket exists
  if (!fs.existsSync(SOCKET_PATH)) {
    console.error(`Whisper service socket not found: ${SOCKET_PATH}`);
    console.error('Start the whisper service first: whisper-svc');
    process.exit(1);
  }

  // Load WAV file
  const wavPath = path.resolve(argv.wav);
  if (!fs.existsSync(wavPath)) {
    console.error(`WAV file not found: ${wavPath}`);
    process.exit(1);
  }

  console.log(`Loading WAV: ${wavPath}`);
  const wavBuffer = fs.readFileSync(wavPath);
  const wav = parseWav(wavBuffer);

  console.log(`Format: ${wav.format.sampleRate}Hz, ${wav.format.numChannels}ch, ${wav.format.bitsPerSample}bit`);

  // Load reference transcript if provided
  let refText = null;
  if (argv.ref) {
    const refPath = path.resolve(argv.ref);
    if (fs.existsSync(refPath)) {
      refText = fs.readFileSync(refPath, 'utf-8').trim();
      console.log(`Reference transcript loaded: ${refText.length} chars`);
    }
  }

  // Session state
  const sessionId = crypto.randomUUID();
  const t0 = Date.now();
  let firstPartialAt = null;
  let firstFinalAt = null;
  const partials = [];
  const finals = [];
  let fullText = '';

  // Connect to whisper service
  console.log(`\nConnecting to ${SOCKET_PATH}...`);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let lineBuffer = '';

    socket.on('connect', () => {
      console.log('Connected to whisper service');

      // Send START command
      const startCmd = JSON.stringify({
        cmd: 'START',
        session_id: sessionId,
        source_lang: argv.lang,
        auto_detect_langs: [],
        phrase_hints: [],
      });
      socket.write(startCmd + '\n');

      // Stream audio in chunks (simulate real-time)
      const chunkSize = 8192; // ~256ms at 16kHz 16-bit
      let offset = 0;

      const sendChunk = () => {
        if (offset >= wav.data.length) {
          console.log('\nAll audio sent, waiting for final results...');

          // Send STOP command
          setTimeout(() => {
            const stopCmd = JSON.stringify({
              cmd: 'STOP',
              session_id: sessionId,
            });
            socket.write(stopCmd + '\n');

            // Wait for final response then close
            setTimeout(() => {
              socket.end();
            }, 2000);
          }, 500);

          return;
        }

        const chunk = wav.data.slice(offset, offset + chunkSize);
        const pcmB64 = chunk.toString('base64');

        const audioCmd = JSON.stringify({
          cmd: 'AUDIO',
          session_id: sessionId,
          pcm_b64: pcmB64,
        });
        socket.write(audioCmd + '\n');

        offset += chunkSize;

        // Pace at 2x real-time
        const msPerChunk = (chunkSize / 2) / wav.format.sampleRate * 1000;
        setTimeout(sendChunk, msPerChunk / 2);
      };

      // Start sending after ready
      setTimeout(sendChunk, 100);
    });

    socket.on('data', (data) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);
          const now = Date.now();
          const tMs = now - t0;

          if (msg.type === 'READY') {
            console.log(JSON.stringify({ ev: 'ready', t_ms: tMs }));
          } else if (msg.type === 'PARTIAL') {
            if (!firstPartialAt) {
              firstPartialAt = now;
            }
            partials.push({ t_ms: tMs, text: msg.text });
            console.log(JSON.stringify({ ev: 'partial', t_ms: tMs, text: msg.text }));
          } else if (msg.type === 'FINAL') {
            if (!firstFinalAt) {
              firstFinalAt = now;
            }
            finals.push({ t_ms: tMs, text: msg.text, tts_final: msg.tts_final });
            fullText += (fullText ? ' ' : '') + msg.text;
            console.log(JSON.stringify({ ev: 'final', t_ms: tMs, text: msg.text, tts_final: msg.tts_final }));
          } else if (msg.type === 'ERROR') {
            console.error(JSON.stringify({ ev: 'error', t_ms: tMs, error: msg.error }));
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    });

    socket.on('close', () => {
      const totalMs = Date.now() - t0;
      const ttftMs = firstPartialAt ? firstPartialAt - t0 : null;
      const ttfcMs = firstFinalAt ? firstFinalAt - t0 : null;

      console.log('\n--- Results ---');
      console.log(JSON.stringify({
        ev: 'done',
        total_ms: totalMs,
        ttft_ms: ttftMs,
        ttfc_ms: ttfcMs,
        ttft_sec: ttftMs ? ttftMs / 1000 : null,
        ttfc_sec: ttfcMs ? ttfcMs / 1000 : null,
        partial_count: partials.length,
        final_count: finals.length,
      }));

      // Calculate WER if reference provided
      if (refText && fullText) {
        const werResult = wer(fullText, refText);
        console.log('\n--- WER Analysis ---');
        console.log(JSON.stringify({
          ev: 'wer',
          ...werResult,
          wer_pct: (werResult.wer * 100).toFixed(2),
        }));
        console.log(formatWer(werResult));

        // Check thresholds
        if (werResult.wer > argv.maxWer) {
          console.error(`\nWER ${(werResult.wer * 100).toFixed(2)}% exceeds threshold ${(argv.maxWer * 100).toFixed(2)}%`);
          process.exit(2);
        }
      }

      // Check TTFC threshold
      if (ttfcMs && ttfcMs / 1000 > argv.maxTtfcSec) {
        console.error(`\nTTFC ${(ttfcMs / 1000).toFixed(2)}s exceeds threshold ${argv.maxTtfcSec}s`);
        process.exit(2);
      }

      console.log('\nBenchmark passed!');
      resolve({
        total_ms: totalMs,
        ttft_ms: ttftMs,
        ttfc_ms: ttfcMs,
        partials: partials.length,
        finals: finals.length,
        full_text: fullText,
      });
    });

    socket.on('error', (err) => {
      console.error('Socket error:', err.message);
      reject(err);
    });

    // Timeout
    setTimeout(() => {
      console.error('Benchmark timed out');
      socket.destroy();
      process.exit(1);
    }, 120000); // 2 minute timeout
  });
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
