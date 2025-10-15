const path = require('path');
const http = require('http');
const express = require('express');
const pino = require('pino');
const dotenv = require('dotenv');
const WS = require('ws');
const axios = require('axios');

const metrics = require('./metrics');
const { SegmentProcessor } = require('./segment-processor');
const { createTranslator } = require('./translator');
const { createTtsQueue } = require('./tts');
const { createWatchdog } = require('./watchdog');
const { createStateStore } = require('./state-store');

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: null
});

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(metrics.httpMetricsMiddleware);
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
server.keepAliveTimeout = 61000;
server.headersTimeout = 65000;

const STABLE_PARTIALS = Number(process.env.STABLE_PARTIALS || 3);
const SEG_SILENCE_MS = Number(process.env.SEG_SILENCE_MS || 800);
const INITIAL_SILENCE_MS = Number(process.env.INITIAL_SILENCE_MS || 5000);
const END_SILENCE_MS = Number(process.env.END_SILENCE_MS || 500);
const SOFT_THROTTLE_MS = Number(process.env.SOFT_THROTTLE_MS || 1000);
const SOFT_MIN_DELTA_CHARS = Number(process.env.SOFT_MIN_DELTA_CHARS || 18);
const SPEECH_TOKEN_REFRESH_MS = Number(process.env.SPEECH_TOKEN_REFRESH_MS || 9 * 60 * 1000);
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 30000);
const PATCH_LRU_PER_ROOM = Number(process.env.PATCH_LRU_PER_ROOM || 500);
const TTS_MAX_BACKLOG_SEC =
  process.env.TTS_MAX_BACKLOG_SEC !== undefined ? Number(process.env.TTS_MAX_BACKLOG_SEC) : 10;
const TTS_RESUME_BACKLOG_SEC =
  process.env.TTS_RESUME_BACKLOG_SEC !== undefined
    ? Number(process.env.TTS_RESUME_BACKLOG_SEC)
    : TTS_MAX_BACKLOG_SEC > 0
    ? Math.max(Math.floor(TTS_MAX_BACKLOG_SEC / 2), 2)
    : 5;
const TTS_BACKLOG_FALLBACK_VOICE =
  process.env.TTS_BACKLOG_FALLBACK_VOICE !== undefined
    ? process.env.TTS_BACKLOG_FALLBACK_VOICE || null
    : process.env.DEFAULT_TTS_VOICE_FALLBACK || null;
const FINAL_DEBOUNCE_MS = Number(process.env.FINAL_DEBOUNCE_MS || 180);
const WATCHDOG_EVENT_IDLE_MS = Number(process.env.WATCHDOG_EVENT_IDLE_MS || 12000);
const WATCHDOG_PCM_IDLE_MS = Number(process.env.WATCHDOG_PCM_IDLE_MS || 7000);
const PHRASE_HINTS = (process.env.PHRASE_HINTS || '')
  .split(',')
  .map((hint) => hint.trim())
  .filter(Boolean);
const AUTO_DETECT_LANGS = (process.env.AUTO_DETECT_LANGS || '')
  .split(',')
  .map((lang) => lang.trim())
  .filter(Boolean);
const SPEECH_TTS_FORMAT = process.env.SPEECH_TTS_FORMAT || '';

const translator = createTranslator({ logger, metrics });
const stateStore = createStateStore({
  logger,
  maxUnits: PATCH_LRU_PER_ROOM,
  maxPatches: PATCH_LRU_PER_ROOM
});

const rooms = new Map();

function defaultRoomTargets(room) {
  const langs = new Set();
  for (const client of room.clients) {
    if (client.role === 'listener' && client.lang && client.lang !== 'source') {
      langs.add(client.lang);
    }
  }
  return langs;
}

function ensureRoom(roomId) {
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }

  const roomLogger = logger.child({ roomId });
  const processor = new SegmentProcessor({
    roomId,
    logger: roomLogger.child({ component: 'segment-processor' }),
    translator,
    metrics: {
      observePatch: metrics.observePatch,
      dropPatch: metrics.dropPatch
    },
    maxUnits: PATCH_LRU_PER_ROOM,
    store: stateStore
  });

  const ttsQueues = new Map();

  function getTtsQueueForLang(lang) {
    if (!lang) {
      return null;
    }
    if (!ttsQueues.has(lang)) {
      const queue = createTtsQueue({
        roomId,
        logger: roomLogger.child({ component: `tts:${lang}` }),
        metrics,
        updateBacklog: metrics.setTtsBacklog,
        backlogLimitSeconds: TTS_MAX_BACKLOG_SEC,
        backlogResumeSeconds: TTS_RESUME_BACKLOG_SEC,
        fallbackVoice: TTS_BACKLOG_FALLBACK_VOICE,
        store: stateStore,
        audioFormat: SPEECH_TTS_FORMAT
      });
      queue.on('audio', (payload) => {
        broadcastAudio(room, payload);
      });
      queue.on('error', (payload) => {
        roomLogger.error(
          { component: 'tts', lang: payload.lang, unitId: payload.unitId, err: payload.err?.message },
          'TTS error.'
        );
      });
      queue.on('skipped', (payload) => {
        roomLogger.debug(
          { component: 'tts', lang: payload.lang, unitId: payload.unitId, reason: payload.reason },
          'Skipped TTS synthesis.'
        );
      });
      queue.on('throttle', (payload) => {
        roomLogger.warn(
          { component: 'tts', lang: payload.lang, backlog: payload.backlog },
          'TTS backlog high – applying throttle.'
        );
      });
      queue.on('resume', (payload) => {
        roomLogger.info(
          { component: 'tts', lang: payload.lang, backlog: payload.backlog },
          'TTS backlog recovered – resuming normal voice.'
        );
      });
      ttsQueues.set(lang, queue);
    }
    return ttsQueues.get(lang);
  }

  const room = {
    id: roomId,
    logger: roomLogger,
    processor,
    clients: new Set(),
    ttsQueues,
    getTtsQueueForLang,
    watchdog: createWatchdog({
      logger: roomLogger.child({ component: 'watchdog' }),
      idleEventMs: WATCHDOG_EVENT_IDLE_MS,
      idlePcmMs: WATCHDOG_PCM_IDLE_MS
    }),
    ready: null
  };

  rooms.set(roomId, room);

  if (stateStore) {
    const hydration = hydrateRoom(room);
    room.ready = hydration
      .then(() => {
        room.ready = null;
      })
      .catch((err) => {
        room.ready = null;
        room.logger.error(
          { component: 'state-store', err: err?.message },
          'Failed to hydrate room from store.'
        );
      });
  }
  return room;
}

async function hydrateRoom(room) {
  if (!stateStore) {
    return;
  }
  try {
    const units = await stateStore.loadUnits(room.id);
    for (const unit of units) {
      room.processor.hydrateUnit(unit);
    }
  } catch (err) {
    room.logger.error(
      { component: 'state-store', err: err?.message },
      'Failed to hydrate units from store.'
    );
  }
}

function safeSend(socket, payload) {
  if (socket.readyState === WS.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      logger.warn({ component: 'ws', err: err?.message }, 'Failed to send payload.');
    }
  }
}

async function broadcastPatch(room, result) {
  if (!result || result.stale) {
    return;
  }
  const { sourcePatch, translatedPatches } = result;

  const patchesByLang = new Map();
  if (sourcePatch) {
    const langKey = sourcePatch.srcLang || 'source';
    patchesByLang.set(langKey, {
      type: 'patch',
      payload: sourcePatch
    });
    // Mirror source patch for listeners explicitly requesting 'source'.
    patchesByLang.set('source', {
      type: 'patch',
      payload: sourcePatch
    });
  }

  if (Array.isArray(translatedPatches)) {
    for (const patch of translatedPatches) {
      patchesByLang.set(patch.targetLang, {
        type: 'patch',
        payload: patch
      });
    }
  }

  room.logger.debug(
    {
      component: 'broadcast',
      unitId: sourcePatch?.unitId,
      languages: Array.from(patchesByLang.keys())
    },
    'Broadcasting patch.'
  );

  if (stateStore) {
    for (const [langKey, message] of patchesByLang.entries()) {
      stateStore
        .appendPatch(room.id, langKey, message.payload)
        .catch((err) =>
          room.logger.warn(
            { component: 'state-store', lang: langKey, err: err?.message },
            'Failed to append patch to store.'
          )
        );
    }
  }

  for (const client of room.clients) {
    if (client.socket.readyState !== WS.OPEN) {
      continue;
    }
    let message = null;
    if (client.lang && patchesByLang.has(client.lang)) {
      message = patchesByLang.get(client.lang);
    } else if (sourcePatch && !client.lang) {
      message = patchesByLang.get(sourcePatch.srcLang || 'source');
    }

    if (message) {
      const payload = message.payload;
      const lastSeenVersion =
        client.lastSeen && typeof client.lastSeen[payload.unitId] === 'number'
          ? client.lastSeen[payload.unitId]
          : undefined;
      if (lastSeenVersion !== undefined && payload.version <= lastSeenVersion) {
        continue;
      }
      safeSend(client.socket, message);
      if (client.lastSeen) {
        client.lastSeen[payload.unitId] = payload.version;
      }
    }

    if (client.lang && message && message.payload.stage === 'hard' && client.wantsTts) {
      const queue = room.getTtsQueueForLang(client.lang);
      if (queue) {
        const incomingSentLen = message.payload.sentLen;
        const targetSentLen = Array.isArray(incomingSentLen?.tgt)
          ? incomingSentLen.tgt
          : Array.isArray(incomingSentLen)
          ? incomingSentLen
          : null;
        queue.enqueue(client.lang, message.payload.unitId, message.payload.text, {
          voice: client.voice,
          sentLen: targetSentLen
        });
      }
    }
  }
}

function broadcastAudio(room, payload) {
  if (!payload || !payload.audio) {
    if (room.logger && typeof room.logger.warn === 'function') {
      room.logger.warn(
        { component: 'tts', unitId: payload?.unitId, lang: payload?.lang },
        'Skipping TTS broadcast – missing audio payload.'
      );
    }
    return;
  }
  for (const client of room.clients) {
    if (!client.wantsTts || client.lang !== payload.lang) {
      continue;
    }
    safeSend(client.socket, {
      type: 'tts',
      payload: {
        unitId: payload.unitId,
        rootUnitId: payload.rootUnitId || payload.unitId?.split('#')[0],
        lang: payload.lang,
        text: payload.text,
        audio: payload.audio.toString('base64'),
        format: payload.format,
        voice: payload.voice || client.voice || null,
        sentLen: payload.sentLen || null
      }
    });
    metrics.recordTtsEvent(room.id, payload.lang, 'delivered');
  }
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, rooms: Array.from(rooms.keys()) });
});

app.get('/metrics', metrics.sendMetrics);

app.get('/api/config', (_req, res) => {
  res.json({
    stablePartials: STABLE_PARTIALS,
    segmentationSilenceMs: SEG_SILENCE_MS,
    initialSilenceMs: INITIAL_SILENCE_MS,
    endSilenceMs: END_SILENCE_MS,
    softThrottleMs: SOFT_THROTTLE_MS,
    softMinDeltaChars: SOFT_MIN_DELTA_CHARS,
    speechTokenRefreshMs: SPEECH_TOKEN_REFRESH_MS,
    wsPingIntervalMs: WS_PING_INTERVAL_MS,
    ttsMaxBacklogSec: TTS_MAX_BACKLOG_SEC,
    ttsResumeBacklogSec: TTS_RESUME_BACKLOG_SEC,
    patchLruPerRoom: PATCH_LRU_PER_ROOM,
    finalDebounceMs: FINAL_DEBOUNCE_MS,
    phraseHints: PHRASE_HINTS,
    autoDetectLangs: AUTO_DETECT_LANGS,
    ttsFormat: SPEECH_TTS_FORMAT || undefined
  });
});

app.post('/api/speech/token', async (_req, res) => {
  const speechKey = process.env.SPEECH_KEY;
  const speechRegion = process.env.SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    return res.status(500).json({ ok: false, error: 'Speech credentials are not configured.' });
  }

  const url = `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

  try {
    const response = await axios.post(url, null, {
      headers: {
        'Ocp-Apim-Subscription-Key': speechKey,
        'Content-Length': '0'
      },
      timeout: 5000
    });

    return res.json({
      ok: true,
      token: response.data,
      region: speechRegion,
      expiresInSeconds: Math.max(Math.floor(SPEECH_TOKEN_REFRESH_MS / 1000), 60)
    });
  } catch (err) {
    logger.error(
      { component: 'speech-token', err: err?.response?.data || err?.message },
      'Failed to acquire speech token.'
    );
    return res.status(500).json({ ok: false, error: 'Unable to acquire speech token.' });
  }
});

app.post('/api/segments', async (req, res) => {
  const { roomId = 'default', patch, targets = [] } = req.body || {};
  if (!patch || typeof patch !== 'object') {
    metrics.dropPatch(roomId, 'missing_patch');
    return res.status(400).json({ ok: false, error: 'Invalid patch payload.' });
  }
  const room = ensureRoom(roomId);
  if (room.ready) {
    await room.ready;
  }

  try {
    room.watchdog.markEvent();

    const listenerTargets = defaultRoomTargets(room);
    for (const target of targets) {
      listenerTargets.add(target);
    }

    const targetLangs = Array.from(listenerTargets);
    const result = await room.processor.processPatch(patch, targetLangs);
    if (result.stale) {
      return res.status(202).json({ ok: false, stale: true, empty: Boolean(result.empty) });
    }

    await broadcastPatch(room, result);
    return res.json({ ok: true });
  } catch (err) {
    metrics.dropPatch(roomId, 'exception');
    room.logger.error(
      { component: 'api', err: err?.message, patch },
      'Failed to process patch.'
    );
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

const wsServer = new WS.WebSocketServer({ server, path: '/ws' });

wsServer.on('connection', async (socket, request) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const roomId = url.searchParams.get('room') || 'default';
    const role = url.searchParams.get('role') || 'listener';
    const lang = url.searchParams.get('lang') || 'source';
    const wantsTts = url.searchParams.get('tts') === 'true';
    const requestedVoice = url.searchParams.get('voice') || undefined;
    const room = ensureRoom(roomId);
    if (room.ready) {
      await room.ready;
    }
    const client = { socket, role, lang, wantsTts, voice: requestedVoice, lastSeen: {} };

    room.clients.add(client);
    metrics.trackWsConnection(roomId, role, 1);
    socket.isAlive = true;

    safeSend(socket, {
      type: 'hello',
      payload: {
        roomId,
        role,
        lang,
        wantsTts
      }
    });

    let history = [];
    if (stateStore) {
      try {
        history = await stateStore.loadPatches(roomId, lang || 'source');
      } catch (err) {
        room.logger.warn(
          { component: 'state-store', lang, err: err?.message },
          'Failed to load patch history from store.'
        );
      }
    }

    if (history.length) {
      for (const patchPayload of history) {
        safeSend(socket, { type: 'patch', payload: patchPayload });
      }
    } else {
      const snapshot = await room.processor.snapshot(lang);
      if (snapshot.length) {
        for (const entry of snapshot) {
          safeSend(socket, { type: 'patch', payload: entry });
        }
      }
    }

    socket.on('message', (data) => {
      if (role === 'speaker') {
        room.watchdog.markEvent();
      }
      // Speakers can push PCM heartbeat events to keep the watchdog alive.
      try {
        const parsed = JSON.parse(data);
        if (parsed?.type === 'heartbeat' && parsed?.payload?.pcm === true) {
          room.watchdog.markPcm();
          return;
        }
        if (parsed?.type === 'resume' && parsed?.payload?.versions) {
          client.lastSeen = parsed.payload.versions || {};
          return;
        }
      } catch (err) {
        room.logger.debug({ component: 'ws', err: err?.message }, 'Failed to parse WS message.');
      }
    });

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('close', () => {
      room.clients.delete(client);
      metrics.trackWsConnection(roomId, role, -1);
    });

    socket.on('error', (err) => {
      room.logger.warn({ component: 'ws', err: err?.message }, 'Socket error.');
    });
  } catch (err) {
    logger.error({ component: 'ws', err: err?.message }, 'WS connection failed to initialise.');
    socket.close(1011, 'Internal error');
  }
});

const pingInterval = setInterval(() => {
  wsServer.clients.forEach((socket) => {
    if (socket.readyState !== WS.OPEN) {
      return;
    }
    if (socket.isAlive === false) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch (err) {
      logger.warn({ component: 'ws', err: err?.message }, 'Failed to send WS ping.');
    }
  });
}, WS_PING_INTERVAL_MS).unref();

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.watchdog.shouldTriggerRestart()) {
      metrics.recordWatchdogTrigger(room.id);
      for (const client of room.clients) {
        if (client.role === 'speaker') {
          safeSend(client.socket, {
            type: 'watchdog',
            payload: room.watchdog.getState()
          });
        }
      }
    }
  }
}, 5000).unref();

server.listen(PORT, HOST, () => {
  logger.info({ port: PORT, host: HOST }, 'Server listening.');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down server.');
  clearInterval(pingInterval);
  for (const room of rooms.values()) {
    for (const queue of room.ttsQueues.values()) {
      queue.shutdown();
    }
    for (const client of room.clients) {
      try {
        client.socket.close(1001, 'Server shutting down');
      } catch (err) {
        // ignore
      }
    }
  }
  server.close(() => {
    logger.info('HTTP server closed.');
    if (stateStore && typeof stateStore.close === 'function') {
      stateStore.close().catch((err) =>
        logger.warn({ component: 'state-store', err: err?.message }, 'Failed to close store.')
      );
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
