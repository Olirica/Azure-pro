#!/usr/bin/env node
/**
 * Test Deepgram STT via WebSocket
 *
 * Sends audio from a WAV file to the server and checks if transcripts are received.
 * Usage: node scripts/test-deepgram-stt.js [wav-file]
 */

const fs = require('fs');
const path = require('path');
const ws = require('ws');

const WAV_FILE = process.argv[2] || path.join(__dirname, '../tests/pipeline-bench/samples/intro_30s.wav');
const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8090';
const ROOM = 'dev';

function parseWav(buffer) {
  let offset = 12;
  let format = null;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('utf8', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      format = {
        sampleRate: buffer.readUInt32LE(offset + 12),
        numChannels: buffer.readUInt16LE(offset + 10),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    }

    if (chunkId === 'data') {
      return { format, data: buffer.slice(offset + 8, offset + 8 + chunkSize) };
    }

    offset += 8 + chunkSize;
  }
  throw new Error('Invalid WAV');
}

async function runTest() {
  console.log(`Loading WAV: ${WAV_FILE}`);

  if (!fs.existsSync(WAV_FILE)) {
    console.error('WAV file not found:', WAV_FILE);
    process.exit(1);
  }

  const wavBuffer = fs.readFileSync(WAV_FILE);
  const wav = parseWav(wavBuffer);
  console.log(`Format: ${wav.format.sampleRate}Hz, ${wav.format.numChannels}ch, ${wav.format.bitsPerSample}bit`);
  console.log(`Audio duration: ${(wav.data.length / 2 / wav.format.sampleRate).toFixed(2)}s`);

  // Need to resample if not 16kHz
  if (wav.format.sampleRate !== 16000) {
    console.error('WAV must be 16kHz. Current:', wav.format.sampleRate);
    process.exit(1);
  }

  console.log(`\nConnecting to ${SERVER_URL}/ws?room=${ROOM}&role=speaker&stt=stream`);

  const socket = new ws.WebSocket(`${SERVER_URL}/ws?room=${ROOM}&role=speaker&stt=stream`);

  let sttReady = false;
  let patchCount = 0;
  let transcripts = [];

  socket.on('open', () => {
    console.log('Connected');
  });

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('Received:', msg.type, msg.payload ? JSON.stringify(msg.payload).substring(0, 100) : '');

      if (msg.type === 'stt:ready') {
        sttReady = true;
        console.log('\n✓ STT ready, starting audio stream...\n');

        // Start sending audio
        let offset = 0;
        const chunkSize = 4096; // 128ms at 16kHz mono 16-bit

        const sendChunk = () => {
          if (offset >= wav.data.length) {
            console.log('\nAll audio sent. Waiting for final transcripts...');
            setTimeout(() => {
              console.log('\n--- Results ---');
              console.log(`Patches received: ${patchCount}`);
              console.log('Transcripts:', transcripts.join(' | '));
              socket.close();
            }, 3000);
            return;
          }

          const chunk = wav.data.slice(offset, offset + chunkSize);

          // Send as binary PCM
          socket.send(chunk);

          offset += chunkSize;

          // Pace at ~1.5x real-time
          const msPerChunk = (chunkSize / 2) / wav.format.sampleRate * 1000;
          setTimeout(sendChunk, msPerChunk / 1.5);
        };

        sendChunk();
      }

      if (msg.type === 'patch' && msg.payload) {
        patchCount++;
        if (msg.payload.text && msg.payload.stage === 'hard') {
          transcripts.push(msg.payload.text);
        }
      }

      if (msg.type === 'stt:error') {
        console.error('STT Error:', msg.payload?.error);
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });

  socket.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  socket.on('close', () => {
    console.log('Connection closed');
    process.exit(patchCount > 0 ? 0 : 1);
  });

  // Timeout
  setTimeout(() => {
    console.error('Test timed out');
    socket.close();
    process.exit(1);
  }, 60000);
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
