/**
 * Hybrid STT Poster
 *
 * Processes audio file with Azure Speech SDK and POSTs recognition results
 * to the server simulating a speaker page. This allows automated testing
 * of the full pipeline without browser microphone limitations.
 *
 * Usage:
 *   node hybrid-stt-poster.js \
 *     --wav <path> \
 *     --lang <lang> \
 *     --room <roomId> \
 *     --targetLangs <langs> \
 *     --serverUrl <url>
 */

import 'dotenv/config';
import fs from 'fs';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import WebSocket from 'ws';

// Simple command line argument parsing (no yargs dependency)
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const value = args[i + 1];
    parsed[key] = value;
  }

  return parsed;
}

const argv = parseArgs();

// Validate required args
if (!argv.wav || !argv.room || !argv.targetLangs) {
  console.error(JSON.stringify({
    ev: 'error',
    msg: 'Missing required arguments: --wav, --room, --targetLangs'
  }));
  process.exit(1);
}

// Set defaults
argv.lang = argv.lang || 'en-US';
argv.serverUrl = argv.serverUrl || 'http://localhost:3000';

// ===================================================================
// STATE MANAGEMENT (mimics speaker.html fast-finals logic)
// ===================================================================

// Simple ULID-like ID generator (timestamp + random)
function generateUtteranceId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `U${timestamp}${random}`;
}

const state = {
  room: argv.room,
  sourceLang: argv.lang,
  targetLangs: argv.targetLangs.split(',').map(l => l.trim()),
  serverUrl: argv.serverUrl,
  ws: null,
  sessionId: `test-${Date.now()}`,
  streamId: 'speaker-1',
  // Utterance state (stable ID + revision tracking)
  currentUtteranceId: null,
  rev: 0,
  lastFinalText: '', // Track last final to prevent duplicates
  prefixState: {
    stablePrefix: '',
    candidates: [],
    lastCommitMs: 0
  }
};

// Fast-finals config (from .env)
const FASTFINALS = {
  STABLE_K: parseInt(process.env.FASTFINALS_STABLE_K || '2'),
  MIN_STABLE_MS: parseInt(process.env.FASTFINALS_MIN_STABLE_MS || '300'),
  PUNCT_STABLE_MS: parseInt(process.env.FASTFINALS_PUNCT_STABLE_MS || '200'),
  MIN_CHARS: parseInt(process.env.FASTFINALS_MIN_CHARS || '20'),
  MIN_WORDS: parseInt(process.env.FASTFINALS_MIN_WORDS || '3'),
  EMIT_THROTTLE_MS: parseInt(process.env.FASTFINALS_EMIT_THROTTLE_MS || '700')
};

// ===================================================================
// WEBSOCKET CONNECTION (mimics speaker.html)
// ===================================================================

function connectToServer() {
  return new Promise((resolve, reject) => {
    // Build WebSocket URL with query parameters (server expects URL params, not join message)
    const wsBaseUrl = state.serverUrl.replace('http', 'ws') + '/ws';
    const params = new URLSearchParams({
      room: state.room,
      role: 'speaker',
      lang: state.sourceLang
    });
    const wsUrl = `${wsBaseUrl}?${params.toString()}`;

    console.log(JSON.stringify({ ev: 'info', msg: `Connecting to ${wsUrl}` }));

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(JSON.stringify({ ev: 'info', msg: 'WebSocket connected' }));
      state.ws = ws;
      resolve(ws);
    });

    ws.on('error', (err) => {
      console.error(JSON.stringify({ ev: 'error', msg: `WebSocket error: ${err.message}` }));
      reject(err);
    });

    ws.on('close', () => {
      console.log(JSON.stringify({ ev: 'info', msg: 'WebSocket closed' }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'joined') {
          console.log(JSON.stringify({ ev: 'info', msg: `Joined room: ${state.room}` }));
        }
      } catch (e) {}
    });
  });
}

// ===================================================================
// PATCH POSTING (mimics speaker.html HTTP POST to /api/segments)
// ===================================================================

async function postPatch(patch) {
  try {
    const response = await fetch(`${state.serverUrl}/api/segments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        roomId: state.room,
        patch,
        targets: state.targetLangs
      })
    });

    const result = await response.json();

    console.log(JSON.stringify({
      ev: 'posted',
      patchType: patch.stage,
      unitId: patch.unitId,
      text: patch.text?.substring(0, 40),
      httpStatus: response.status,
      ok: result.ok
    }));
  } catch (err) {
    console.error(JSON.stringify({
      ev: 'error',
      msg: `Failed to post patch: ${err.message}`
    }));
  }
}

// ===================================================================
// FAST-FINALS LOGIC (mimics speaker.html)
// ===================================================================

function resetPrefixState() {
  state.prefixState = {
    stablePrefix: '',
    candidates: [],
    lastCommitMs: 0
  };
}

function tryCommitPrefix(partial) {
  const now = Date.now();
  const ps = state.prefixState;

  // Add this partial to candidates
  ps.candidates.push({ text: partial, at: now });

  // Keep only recent candidates
  const cutoff = now - (FASTFINALS.MIN_STABLE_MS + 200);
  ps.candidates = ps.candidates.filter(c => c.at >= cutoff);

  // Check for stability
  if (ps.candidates.length < FASTFINALS.STABLE_K) return;

  // Find common prefix
  const recent = ps.candidates.slice(-FASTFINALS.STABLE_K).map(c => c.text);
  let commonPrefix = recent[0];
  for (let i = 1; i < recent.length; i++) {
    while (!recent[i].startsWith(commonPrefix)) {
      commonPrefix = commonPrefix.slice(0, -1);
      if (!commonPrefix) break;
    }
  }

  // Skip if no new content or if this prefix was already emitted
  if (!commonPrefix) return;
  if (commonPrefix === ps.stablePrefix) return;
  // Also skip if the new prefix doesn't add enough beyond what was already emitted
  if (ps.stablePrefix && commonPrefix.startsWith(ps.stablePrefix)) {
    const newContent = commonPrefix.slice(ps.stablePrefix.length).trim();
    if (newContent.length < FASTFINALS.MIN_CHARS) return; // Not enough new content
  }

  // Check minimum thresholds
  const words = commonPrefix.trim().split(/\s+/).length;
  const chars = commonPrefix.trim().length;
  if (words < FASTFINALS.MIN_WORDS || chars < FASTFINALS.MIN_CHARS) return;

  // Check time threshold
  const oldestCandidate = ps.candidates.slice(-FASTFINALS.STABLE_K)[0];
  const stability = now - oldestCandidate.at;
  const hasPunct = /[.!?,;:]$/.test(commonPrefix.trim());
  const threshold = hasPunct ? FASTFINALS.PUNCT_STABLE_MS : FASTFINALS.MIN_STABLE_MS;

  if (stability < threshold) return;

  // Check emit throttle
  if (now - ps.lastCommitMs < FASTFINALS.EMIT_THROTTLE_MS) return;

  // Ensure we have a stable utteranceId for this utterance
  if (!state.currentUtteranceId) {
    state.currentUtteranceId = generateUtteranceId();
    state.rev = 0;
  }

  // Emit partial with stable utteranceId and incrementing rev
  postPatch({
    utteranceId: state.currentUtteranceId,
    streamId: state.streamId,
    stage: 'soft',
    text: commonPrefix.trim(),
    rev: state.rev++,
    isFinal: false,
    isFastFinal: true
  });

  console.log(JSON.stringify({
    ev: 'fast-final',
    segment: commonPrefix.trim().substring(0, 50),
    stability_ms: stability
  }));

  ps.stablePrefix = commonPrefix;
  ps.lastCommitMs = now;
}

// ===================================================================
// AZURE SPEECH SDK PROCESSING
// ===================================================================

async function processAudio() {
  console.log(JSON.stringify({ ev: 'info', msg: `Processing audio: ${argv.wav}` }));

  const audioData = fs.readFileSync(argv.wav);
  const pushStream = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));

  // Push audio in real-time chunks (simulate real microphone)
  const CHUNK_SIZE = 32000; // 1 second of 16kHz 16-bit mono audio
  let offset = 44; // Skip WAV header

  const pushInterval = setInterval(() => {
    if (offset >= audioData.length) {
      clearInterval(pushInterval);
      pushStream.close();
      console.log(JSON.stringify({ ev: 'info', msg: 'Audio stream completed' }));
      return;
    }

    const chunk = audioData.slice(offset, offset + CHUNK_SIZE);
    pushStream.write(chunk);
    offset += CHUNK_SIZE;
  }, 1000); // Push 1 second of audio every 1 second (real-time)

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.SPEECH_KEY,
    process.env.SPEECH_REGION
  );
  speechConfig.speechRecognitionLanguage = argv.lang;
  speechConfig.outputFormat = sdk.OutputFormat.Detailed;
  speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_StablePartialResultThreshold, '4');
  speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, '500');
  speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '350');
  speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '3000');

  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  const startTime = Date.now();

  recognizer.recognizing = (_, e) => {
    const elapsed = Date.now() - startTime;
    const text = e.result?.text || '';

    console.log(JSON.stringify({
      ev: 'recognizing',
      t_ms: elapsed,
      text: text.substring(0, 50)
    }));

    // Try fast-finals on partial
    if (text.trim()) {
      tryCommitPrefix(text);
    }
  };

  recognizer.recognized = (_, e) => {
    const elapsed = Date.now() - startTime;
    const text = e.result?.text || '';

    if (e.result.reason === sdk.ResultReason.RecognizedSpeech && text.trim()) {
      // Skip duplicate finals (Azure SDK sometimes emits same final twice)
      if (text.trim() === state.lastFinalText) {
        console.log(JSON.stringify({
          ev: 'final-skipped',
          reason: 'duplicate',
          text: text.substring(0, 50)
        }));
        return;
      }
      state.lastFinalText = text.trim();

      console.log(JSON.stringify({
        ev: 'final',
        t_ms: elapsed,
        text: text.substring(0, 50)
      }));

      // Compute remainder after any prefix commits
      let finalText = text.trim();
      const originalLength = finalText.length;

      if (state.prefixState.stablePrefix) {
        // Remove already-committed prefix
        if (finalText.startsWith(state.prefixState.stablePrefix)) {
          finalText = finalText.slice(state.prefixState.stablePrefix.length).trim();
          console.log(JSON.stringify({
            ev: 'final-remainder',
            original_len: originalLength,
            prefix_len: state.prefixState.stablePrefix.length,
            remainder_len: finalText.length,
            remainder: finalText.substring(0, 50)
          }));
        }
      }

      // Skip if nothing remains after removing prefix
      if (!finalText) {
        console.log(JSON.stringify({
          ev: 'final-skipped',
          reason: 'already_committed_as_prefix'
        }));
        // Finalize current utterance (it was already emitted as fast-final)
        state.currentUtteranceId = null;
        state.rev = 0;
        resetPrefixState();
        return;
      }

      // Ensure we have utteranceId (might not have had fast-final)
      if (!state.currentUtteranceId) {
        state.currentUtteranceId = generateUtteranceId();
        state.rev = 0;
      }

      // Split final into sentences (like speaker.html does)
      const sentences = finalText.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [];

      // Post each sentence as separate final with new utteranceId
      for (const sentence of sentences) {
        if (!sentence.trim()) continue;

        // If this is not the first sentence, we need a new utteranceId
        if (sentences.indexOf(sentence) > 0) {
          state.currentUtteranceId = generateUtteranceId();
          state.rev = 0;
        }

        postPatch({
          utteranceId: state.currentUtteranceId,
          streamId: state.streamId,
          stage: 'hard',
          text: sentence.trim(),
          rev: state.rev++,
          isFinal: true
        });

        // Prepare for next utterance
        state.currentUtteranceId = null;
        state.rev = 0;
      }

      // Reset prefix state after final
      resetPrefixState();
    }
  };

  recognizer.canceled = (_, e) => {
    console.error(JSON.stringify({
      ev: 'error',
      msg: `Recognition canceled: ${e.errorDetails}`
    }));
  };

  recognizer.sessionStopped = () => {
    const totalTime = (Date.now() - startTime) / 1000;
    console.log(JSON.stringify({
      ev: 'done',
      total_sec: totalTime.toFixed(1)
    }));
    process.exit(0);
  };

  await recognizer.startContinuousRecognitionAsync();
}

// ===================================================================
// MAIN
// ===================================================================

(async () => {
  try {
    await connectToServer();
    await processAudio();
  } catch (err) {
    console.error(JSON.stringify({
      ev: 'error',
      msg: err.message
    }));
    process.exit(1);
  }
})();
