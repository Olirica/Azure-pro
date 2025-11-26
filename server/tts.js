const { EventEmitter } = require('events');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
let segmentText = null;
try {
  ({ segmentText } = require('../scripts/segment-text'));
} catch (e) {
  // Fallback sentence splitter if helper is unavailable (e.g., minimal container)
  segmentText = function fallbackSegmentText(input) {
    const text = (input || '').trim();
    if (!text) return [];
    const parts = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];
    return parts.map((s) => s.trim()).filter(Boolean);
  };
}

const DEFAULT_VOICE = 'en-US-JennyNeural';
const WORDS_PER_MINUTE = 160;
const LANGUAGE_VOICE_DEFAULTS = {
  'en-US': 'en-US-GuyNeural',
  'en-CA': 'en-CA-ClaraNeural',
  'en-GB': 'en-GB-RyanNeural',
  'fr-CA': 'fr-CA-SylvieNeural',
  'fr-FR': 'fr-FR-DeniseNeural',
  'es-ES': 'es-ES-AlvaroNeural',
  'es-MX': 'es-MX-JorgeNeural'
};
const DEFAULT_RATE_BOOST_PERCENT = 10;

const FORMAT_MIME = {
  [sdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm]: 'audio/wav',
  [sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm]: 'audio/wav',
  [sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3]: 'audio/mpeg',
  [sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3]: 'audio/mpeg'
};

function inferMimeType(formatEnum) {
  return FORMAT_MIME[formatEnum] || 'audio/wav';
}

function estimateSeconds(text) {
  const words = (text || '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean).length;
  if (!words) {
    return 0;
  }
  return Math.max((words / WORDS_PER_MINUTE) * 60, 1.5);
}

function createStubQueue({ roomId, logger, metrics }) {
  const stub = new EventEmitter();
  stub.enqueue = (lang, unitId, text, _options = {}) => {
    logger.debug(
      { component: 'tts', lang, unitId, text },
      'TTS disabled (no credentials); skipping enqueue.'
    );
    metrics?.recordTtsEvent?.(roomId, lang, 'skipped_stub');
    stub.emit('skipped', { lang, unitId, text, reason: 'credentials_missing' });
  };
  stub.cancel = () => {};
  stub.shutdown = () => {};
  stub.getBacklogSeconds = () => 0;
  return stub;
}

function normalizeLengths(lengths) {
  if (!Array.isArray(lengths)) {
    return null;
  }
  const normalized = lengths
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return normalized.length ? normalized : null;
}

function splitByCharLengths(text, lengths) {
  const normalized = normalizeLengths(lengths);
  const clean = (text || '').trim();
  if (!clean || !normalized) {
    return null;
  }
  const segments = [];
  let cursor = 0;
  for (const length of normalized) {
    if (cursor >= clean.length) {
      break;
    }
    const slice = clean.slice(cursor, cursor + length);
    if (slice.trim()) {
      segments.push(slice.trim());
    }
    cursor += length;
  }
  if (cursor < clean.length) {
    const tail = clean.slice(cursor).trim();
    if (tail) {
      segments.push(tail);
    }
  }
  return segments.length ? segments : null;
}


/**
 * Create a per-room TTS queue that synthesizes audio for final patches.
 * @param {Object} deps
 * @param {string} deps.roomId
 * @param {import('pino').Logger} deps.logger
 * @param {Object} deps.metrics
 * @param {(roomId: string, lang: string, seconds: number) => void} deps.updateBacklog
 * @param {number} [deps.backlogLimitSeconds]
 * @param {number} [deps.backlogResumeSeconds]
 * @param {string} [deps.fallbackVoice]
 * @param {{ saveTtsQueue?: Function, loadTtsQueue?: Function, clearTtsQueue?: Function }} [deps.store]
 * @returns {EventEmitter & { enqueue(lang: string, unitId: string, text: string, options?: { voice?: string }), cancel(lang: string, unitId: string): void, shutdown(): void, getBacklogSeconds(lang?: string): number }}
 */
function createTtsQueue({
  roomId,
  logger,
  metrics,
  updateBacklog,
  backlogLimitSeconds,
  backlogResumeSeconds,
  rateBoostPercent,
  fallbackVoice,
  store,
  audioFormat
}) {
  const speechKey = process.env.SPEECH_KEY;
  const speechRegion = process.env.SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    logger.warn(
      { component: 'tts', roomId },
      'SPEECH_KEY or SPEECH_REGION missing – TTS queue running in stub mode.'
    );
    return createStubQueue({ roomId, logger, metrics });
  }

  const queueByLang = new Map();
  let disposed = false;

  const configuredRateBoost =
    typeof rateBoostPercent === 'number' && !Number.isNaN(rateBoostPercent)
      ? rateBoostPercent
      : DEFAULT_RATE_BOOST_PERCENT;
  const rateBoostMultiplier = configuredRateBoost > 0 ? 1 + configuredRateBoost / 100 : 1;

  const emitter = new EventEmitter();
  const resolvedAudioFormat =
    audioFormat && sdk.SpeechSynthesisOutputFormat[audioFormat]
      ? sdk.SpeechSynthesisOutputFormat[audioFormat]
      : sdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm;



  function serializeQueue(state) {
    return state.queue.map((item) => ({
      unitId: item.unitId,
      rootUnitId: item.rootUnitId,
      text: item.text,
      voice: item.voice,
      duration: item.duration,
      createdAt: item.createdAt,
      sentLen: typeof item.sentLen === 'number' ? item.sentLen : null,
      version: typeof item.version === 'number' ? item.version : null
    }));
  }

  function persistQueueState(lang) {
    if (!store || typeof store.saveTtsQueue !== 'function') {
      return;
    }
    const state = queueByLang.get(lang);
    if (!state) {
      return;
    }
    const payload = serializeQueue(state);
    let op;
    if (payload.length) {
      op = store.saveTtsQueue(roomId, lang, payload);
    } else if (typeof store.clearTtsQueue === 'function') {
      op = store.clearTtsQueue(roomId, lang);
    }
    if (op && typeof op.then === 'function') {
      op.catch((err) => {
        logger.warn(
          { component: 'tts', roomId, lang, err: err?.message },
          'Failed to persist TTS queue state.'
        );
      });
    }
  }

  function ensureVoice(lang, overrideVoice, state) {
    if (state?.voiceOverride) {
      return state.voiceOverride;
    }
    if (overrideVoice) {
      return overrideVoice;
    }
    const envKey = `DEFAULT_TTS_VOICE_${lang.toUpperCase().replace(/-/g, '_')}`;
    return (
      process.env[envKey] ||
      LANGUAGE_VOICE_DEFAULTS[lang] ||
      process.env.DEFAULT_TTS_VOICE ||
      DEFAULT_VOICE
    );
  }

  // Smooth TTS speed curve configuration
  const BASE_SPEED = parseFloat(process.env.TTS_BASE_SPEED) || 1.05;
  const RAMP_START_SEC = parseFloat(process.env.TTS_BACKLOG_RAMP_START_SEC) || 5;
  const RAMP_END_SEC = parseFloat(process.env.TTS_BACKLOG_RAMP_END_SEC) || 20;
  const MAX_SPEED = parseFloat(process.env.TTS_MAX_SPEED) || 1.35;
  const MAX_SPEED_CHANGE_PERCENT = parseFloat(process.env.TTS_MAX_SPEED_CHANGE_PERCENT) || 25;

  /**
   * Calculate smooth speed multiplier based on backlog using piecewise linear interpolation.
   * @param {number} backlogSeconds - Current TTS queue backlog in seconds
   * @returns {number} Speed multiplier (1.05 to 1.35)
   */
  function calculateSpeedMultiplier(backlogSeconds) {
    // Below ramp start: constant base speed
    if (backlogSeconds < RAMP_START_SEC) {
      return BASE_SPEED;
    }

    // Above ramp end: constant max speed
    if (backlogSeconds >= RAMP_END_SEC) {
      return MAX_SPEED;
    }

    // Between ramp start and end: linear interpolation
    const progress = (backlogSeconds - RAMP_START_SEC) / (RAMP_END_SEC - RAMP_START_SEC);
    const speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * progress;

    return speed;
  }

  /**
   * Apply smooth speed transitions with maximum change limit to prevent jarring jumps.
   * @param {number} currentSpeed - Current speed multiplier
   * @param {number} targetSpeed - Target speed multiplier from curve
   * @returns {number} Clamped speed multiplier
   */
  function smoothSpeedTransition(currentSpeed, targetSpeed) {
    const maxChange = MAX_SPEED_CHANGE_PERCENT / 100;
    const maxIncrease = currentSpeed * (1 + maxChange);
    const maxDecrease = currentSpeed * (1 - maxChange);

    if (targetSpeed > maxIncrease) {
      return maxIncrease;
    }
    if (targetSpeed < maxDecrease) {
      return maxDecrease;
    }

    return targetSpeed;
  }

  /**
   * Update TTS speed based on current backlog using smooth curve.
   * Replaces old binary on/off throttle with gradual acceleration.
   */
  function updateTtsSpeed(state, lang, backlog) {
    if (!state) {
      return;
    }

    const targetSpeed = calculateSpeedMultiplier(backlog);
    const currentSpeed = state.rateMultiplier || BASE_SPEED;
    const newSpeed = smoothSpeedTransition(currentSpeed, targetSpeed);

    // Only update if speed actually changed
    if (Math.abs(newSpeed - currentSpeed) > 0.001) {
      const wasAccelerated = currentSpeed > BASE_SPEED + 0.001;
      const isAccelerating = newSpeed > BASE_SPEED + 0.001;

      state.rateMultiplier = newSpeed;

      // Emit events for significant transitions
      if (!wasAccelerated && isAccelerating) {
        metrics?.recordTtsEvent?.(roomId, lang, 'speed_ramp_start');
        emitter.emit('speed_ramp_start', { roomId, lang, backlog, speed: newSpeed });
        logger.debug(
          { component: 'tts', roomId, lang, backlog, speed: newSpeed.toFixed(3) },
          'TTS speed ramp started'
        );
      } else if (wasAccelerated && !isAccelerating) {
        metrics?.recordTtsEvent?.(roomId, lang, 'speed_ramp_end');
        emitter.emit('speed_ramp_end', { roomId, lang, backlog, speed: newSpeed });
        logger.debug(
          { component: 'tts', roomId, lang, backlog, speed: newSpeed.toFixed(3) },
          'TTS speed returned to base'
        );
      }
    }
  }

  function updateQueueBacklog(lang) {
    const backlog = getBacklogSeconds(lang);
    if (typeof updateBacklog === 'function') {
      updateBacklog(roomId, lang, backlog);
    } else if (metrics?.setTtsBacklog) {
      metrics.setTtsBacklog(roomId, lang, backlog);
    }
    const state = queueByLang.get(lang);
    updateTtsSpeed(state, lang, backlog);
  }

  function getBacklogSeconds(lang) {
    if (!lang) {
      let total = 0;
      for (const [, state] of queueByLang.entries()) {
        total += state.queue.reduce((sum, item) => sum + (item.duration || 0), 0);
        if (state.playing && !state.playing.cancelled) {
          total += Math.max(state.playing.duration || 0, 0);
        }
      }
      return total;
    }

    const state = queueByLang.get(lang);
    if (!state) {
      return 0;
    }
    let total = state.queue.reduce((sum, item) => sum + (item.duration || 0), 0);
    if (state.playing && !state.playing.cancelled) {
      total += Math.max(state.playing.duration || 0, 0);
    }
    return total;
  }

  function ensureLangState(lang) {
    if (queueByLang.has(lang)) {
      return queueByLang.get(lang);
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechSynthesisVoiceName = ensureVoice(lang);
    speechConfig.speechSynthesisOutputFormat = resolvedAudioFormat;

    const state = {
      speechConfig,
      synthesizer: null,
      queue: [],
      playing: null,
      processing: false,
      voiceOverride: null,
      isThrottled: false,
      rateMultiplier: BASE_SPEED, // Start at base speed (1.05x)
      hydrated: false,
      audioFormat: resolvedAudioFormat,
      prefetch: new Map(),
      latestVersion: new Map()
    };

    queueByLang.set(lang, state);

    if (store && typeof store.loadTtsQueue === 'function') {
      store
        .loadTtsQueue(roomId, lang)
        .then((items) => {
          if (!Array.isArray(items)) {
            return;
          }
          for (const item of items) {
            if (!item || !item.unitId || !item.text) {
              continue;
            }
            const duration =
              typeof item.duration === 'number' ? item.duration : estimateSeconds(item.text);
            const rootUnitId = item.rootUnitId || item.unitId.split('#')[0];
            const version = typeof item.version === 'number' ? item.version : null;
            state.queue.push({
              lang,
              unitId: item.unitId,
              rootUnitId,
              text: item.text,
              voice: item.voice,
              duration,
              createdAt: item.createdAt || Date.now(),
              sentLen: typeof item.sentLen === 'number' ? item.sentLen : null,
              version
            });
            if (version !== null) {
              state.latestVersion.set(rootUnitId, version);
            }
          }
          updateQueueBacklog(lang);
          if (state.queue.length) {
            setImmediate(() => processQueueForLang(lang));
          }
        })
        .catch((err) => {
          logger.warn(
            { component: 'tts', roomId, lang, err: err?.message },
            'Failed to hydrate TTS queue from store.'
         );
        })
        .finally(() => {
          state.hydrated = true;
        });
    } else {
      state.hydrated = true;
    }

    return state;
  }

  function cleanupSynthesizer(state) {
    if (state.synthesizer) {
      try {
        state.synthesizer.close();
      } catch (err) {
        logger.warn(
          { component: 'tts', roomId, err: err?.message },
          'Failed to close synthesizer cleanly.'
        );
      }
      state.synthesizer = null;
    }
  }

  function escapeXml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function buildSsml(text, lang, voiceName, rate) {
    const safeText = escapeXml(text);
    const clampedRate = Math.min(Math.max(rate || 1, 0.5), 2);
    const rateAttr = clampedRate !== 1 ? ` rate="${clampedRate.toFixed(2)}"` : '';
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">
  <voice name="${voiceName}"><prosody${rateAttr}>${safeText}</prosody></voice>
</speak>`;
  }

  async function synthesize(state, item, voiceName, { trackSynth = false } = {}) {
    const speechConfig = trackSynth
      ? state.speechConfig
      : sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechSynthesisVoiceName = voiceName;
    speechConfig.speechSynthesisOutputFormat = state.audioFormat;
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
    if (trackSynth) {
      state.synthesizer = synthesizer;
    }

    // Always use SSML with rate control (base speed is 1.05x, not 1.0x)
    const rateMultiplier = state.rateMultiplier || BASE_SPEED;
    const payload = buildSsml(item.text, item.lang, voiceName, rateMultiplier);

    return new Promise((resolve, reject) => {
      const finalize = () => {
        try {
          synthesizer.close();
        } catch (err) {
          logger.warn(
            { component: 'tts', roomId, lang: item.lang, err: err?.message },
            'Failed to close synthesizer cleanly.'
          );
        }
        if (trackSynth && state.synthesizer === synthesizer) {
          state.synthesizer = null;
        }
      };
      const onSuccess = (result) => {
        finalize();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(Buffer.from(result.audioData));
        } else {
          reject(new Error(`Speech synthesis failed: ${result.errorDetails || result.reason}`));
        }
      };
      const onError = (err) => {
        finalize();
        reject(err);
      };

      // Always use SSML (we always have rate control now)
      synthesizer.speakSsmlAsync(payload, onSuccess, onError);
    });
  }

  function ensurePrefetchForItem(state, lang, item, { trackSynth = false } = {}) {
    if (!item) {
      return null;
    }
    if (state.prefetch.has(item.unitId)) {
      return state.prefetch.get(item.unitId);
    }
    const voiceName = ensureVoice(lang, item.voice, state);
    const promise = synthesize(state, item, voiceName, { trackSynth })
      .then((audioBuffer) => ({ audioBuffer, voiceName }))
      .catch((err) => {
        state.prefetch.delete(item.unitId);
        throw err;
      });
    state.prefetch.set(item.unitId, promise);
    return promise;
  }

  function clearPrefetchForUnit(state, rootUnitId) {
    if (!state || !state.prefetch) {
      return;
    }
    const prefix = `${rootUnitId}#`;
    for (const key of Array.from(state.prefetch.keys())) {
      if (key === rootUnitId || key.startsWith(prefix)) {
        state.prefetch.delete(key);
      }
    }
  }

  async function processQueueForLang(lang) {
    if (disposed) {
      return;
    }
    const state = ensureLangState(lang);
    if (state.processing || !state.queue.length) {
      updateQueueBacklog(lang);
      return;
    }
    const item = state.queue[0];
    const latestVersion = state.latestVersion.get(item.rootUnitId || item.unitId);
    const itemVersion = typeof item.version === 'number' ? item.version : null;
    if (
      latestVersion !== undefined &&
      (itemVersion === null || itemVersion < latestVersion)
    ) {
      state.queue.shift();
      clearPrefetchForUnit(state, item.rootUnitId || item.unitId);
      updateQueueBacklog(lang);
      setImmediate(() => processQueueForLang(lang));
      return;
    }
    state.playing = item;
    state.processing = true;
    updateQueueBacklog(lang);
    try {
      const current = ensurePrefetchForItem(state, lang, item, { trackSynth: true });
      const nextItem = state.queue[1];
      if (nextItem) {
        ensurePrefetchForItem(state, lang, nextItem, { trackSynth: false });
      }
      const { audioBuffer, voiceName } = await current;
      if (!item.cancelled) {
        metrics?.recordTtsEvent?.(roomId, lang, 'spoken');
        emitter.emit('audio', {
          roomId,
          lang,
          unitId: item.unitId,
          rootUnitId: item.rootUnitId || item.unitId.split('#')[0],
          text: item.text,
          audio: audioBuffer,
          format: inferMimeType(state.audioFormat),
          voice: voiceName,
          sentLen: typeof item.sentLen === 'number' ? item.sentLen : null,
          version: typeof item.version === 'number' ? item.version : null
        });
      } else {
        emitter.emit('cancelled', { roomId, lang, unitId: item.unitId });
      }
    } catch (err) {
      metrics?.recordTtsEvent?.(roomId, lang, 'error');
      emitter.emit('error', { roomId, lang, unitId: item.unitId, err });
      logger.error(
        { component: 'tts', roomId, lang, err: err?.message },
        'TTS synthesis error.'
      );
    } finally {
      state.prefetch.delete(item.unitId);
      if (state.queue[0] && state.queue[0].unitId === item.unitId) {
        state.queue.shift();
      } else {
        state.queue = state.queue.filter((entry) => entry.unitId !== item.unitId);
      }
      cleanupSynthesizer(state);
      state.playing = null;
      state.processing = false;
      updateQueueBacklog(lang);
      if (state.queue.length) {
        setImmediate(() => processQueueForLang(lang));
      }
      persistQueueState(lang);
    }
  }

  function enqueue(lang, unitId, text, options = {}) {
    if (disposed) {
      logger.warn(
        { component: 'tts', roomId, lang, unitId },
        'Attempted to enqueue after queue was disposed.'
      );
      return;
    }

    const trimmed = (text || '').trim();
    if (!trimmed) {
      return;
    }

    const state = ensureLangState(lang);
    const incomingVersion = typeof options.version === 'number' ? options.version : null;
    if (incomingVersion !== null) {
      const prev = state.latestVersion.get(unitId);
      if (prev !== undefined && incomingVersion <= prev) {
        metrics?.recordTtsEvent?.(roomId, lang, incomingVersion === prev ? 'duplicate_version' : 'stale_version');
        return;
      }
      state.latestVersion.set(unitId, incomingVersion);
    }

    state.queue = state.queue.filter((item) => item.rootUnitId !== unitId && item.unitId !== unitId);
    clearPrefetchForUnit(state, unitId);
    if (state.playing && (state.playing.unitId === unitId || state.playing.rootUnitId === unitId)) {
      state.playing.cancelled = true;
      cleanupSynthesizer(state);
      metrics?.recordTtsEvent?.(roomId, lang, 'cancelled');
    }

    const lengths = normalizeLengths(options.sentLen);
    const segmentsFromLengths = splitByCharLengths(trimmed, lengths);
    const totalFromLengths = Array.isArray(segmentsFromLengths)
      ? segmentsFromLengths.reduce((sum, part) => sum + part.length, 0)
      : 0;
    const lengthDelta = Math.abs(totalFromLengths - trimmed.length);
    const useLengths =
      segmentsFromLengths &&
      segmentsFromLengths.length &&
      lengthDelta <= Math.max(12, Math.floor(trimmed.length * 0.05));
    const segments =
      (useLengths ? segmentsFromLengths : segmentText(trimmed)) || [trimmed];
    // Duration accounts for current playback speed
    const currentRate = state.rateMultiplier || BASE_SPEED;
    const makeDuration = (input) => estimateSeconds(input) / currentRate;
    segments.forEach((segment, index) => {
      const segmentId = `${unitId}#${index}`;
      state.queue.push({
        lang,
        unitId: segmentId,
        rootUnitId: unitId,
        text: segment,
        voice: options.voice,
        duration: makeDuration(segment),
        createdAt: Date.now(),
        sentLen: lengths ? lengths[index] || null : null,
        version: incomingVersion
      });
    });

    metrics?.recordTtsEvent?.(roomId, lang, 'enqueued');

    updateQueueBacklog(lang);
    setImmediate(() => processQueueForLang(lang));
    persistQueueState(lang);
  }

  function cancel(lang, unitId) {
    const state = queueByLang.get(lang);
    if (!state) {
      return;
    }
    state.queue = state.queue.filter(
      (item) => item.unitId !== unitId && item.rootUnitId !== unitId
    );
    if (
      state.playing &&
      (state.playing.unitId === unitId || state.playing.rootUnitId === unitId)
    ) {
      state.playing.cancelled = true;
      cleanupSynthesizer(state);
      metrics?.recordTtsEvent?.(roomId, lang, 'cancelled');
    }
    clearPrefetchForUnit(state, unitId);
    updateQueueBacklog(lang);
    persistQueueState(lang);
  }

  function shutdown() {
    disposed = true;
    for (const [lang, state] of queueByLang.entries()) {
      cleanupSynthesizer(state);
      state.queue = [];
      state.playing = null;
      state.processing = false;
      if (state.prefetch) {
        state.prefetch.clear();
      }
      if (state.latestVersion) {
        state.latestVersion.clear();
      }
      persistQueueState(lang);
      if (store && typeof store.clearTtsQueue === 'function') {
        store
          .clearTtsQueue(roomId, lang)
          .catch((err) =>
            logger.warn(
              { component: 'tts', roomId, lang, err: err?.message },
              'Failed to clear TTS queue state from store.'
            )
          );
      }
    }
    queueByLang.clear();
  }

  emitter.enqueue = enqueue;
  emitter.cancel = cancel;
  emitter.shutdown = shutdown;
  emitter.getBacklogSeconds = getBacklogSeconds;
  emitter.reset = () => {
    for (const [lang, state] of queueByLang.entries()) {
      cleanupSynthesizer(state);
      state.queue = [];
      state.playing = null;
      state.processing = false;
      if (state.prefetch) {
        state.prefetch.clear();
      }
      if (state.latestVersion) {
        state.latestVersion.clear();
      }
      updateQueueBacklog(lang);
      persistQueueState(lang);
    }
  };

  return emitter;
}

module.exports = {
  createTtsQueue
};
