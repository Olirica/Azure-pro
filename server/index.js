// Load environment variables FIRST before any other modules
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const pino = require('pino');
const WS = require('ws');
const axios = require('axios');

const metrics = require('./metrics');
const { SegmentProcessor } = require('./segment-processor');
const { createTranslator } = require('./translator');
const { createTtsQueue } = require('./tts');
const { createWatchdog } = require('./watchdog');
const { createStateStore } = require('./state-store');
const { createRoomRegistry } = require('./room-registry');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CLIENT_DIST_DIR = path.join(__dirname, '..', 'client', 'dist');

function getNumberEnv(keys, fallback) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    const raw = process.env[key];
    if (raw !== undefined && raw !== '') {
      const value = Number(raw);
      if (!Number.isNaN(value)) {
        return value;
      }
    }
  }
  return fallback;
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: null
});

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      const v = decodeURIComponent(part.slice(i + 1).trim());
      if (k) out[k] = v;
    }
  });
  return out;
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(metrics.httpMetricsMiddleware);

// Do not gate the admin UI route here. The React app handles login UX; APIs enforce auth.
app.use((req, _res, next) => next());

// If the client build exists, serve its assets under /assets and send its index for /admin.html
if (fs.existsSync(CLIENT_DIST_DIR)) {
  logger.info({ component: 'admin-ui', dir: CLIENT_DIST_DIR }, 'Serving admin client from dist.');
  const adminIndex = path.join(CLIENT_DIST_DIR, 'index.html');
  const assetsDir = path.join(CLIENT_DIST_DIR, 'assets');
  if (fs.existsSync(assetsDir)) {
    app.use('/assets', express.static(assetsDir));
  }
  // Serve SPA for admin and related routes
  const serveSpa = (req, res, next) => {
    if (fs.existsSync(adminIndex)) {
      return res.sendFile(adminIndex);
    }
    next();
  };
  app.get('/admin', serveSpa);
  app.get('/admin/*', serveSpa);
  app.get('/admin.html', serveSpa);
  // Also serve the same client index for speaker/listener routes
  for (const route of ['/listener.html', '/speaker.html', '/listener', '/speaker']) {
    app.get(route, serveSpa);
  }
}

app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
server.keepAliveTimeout = 61000;
server.headersTimeout = 65000;

const STABLE_PARTIALS = getNumberEnv(
  ['SPEECH_STABLE_PARTIALS', 'STABLE_PARTIALS'],
  4
);
const SEG_SILENCE_MS = getNumberEnv(
  ['SPEECH_SEGMENTATION_SILENCE_MS', 'SEG_SILENCE_MS'],
  500
);
const INITIAL_SILENCE_MS = getNumberEnv(
  ['SPEECH_INITIAL_SILENCE_MS', 'INITIAL_SILENCE_MS'],
  3000
);
const END_SILENCE_MS = getNumberEnv(
  ['SPEECH_END_SILENCE_MS', 'END_SILENCE_MS'],
  350
);
const SOFT_THROTTLE_MS = getNumberEnv('SOFT_THROTTLE_MS', 1000);
const SOFT_MIN_DELTA_CHARS = getNumberEnv('SOFT_MIN_DELTA_CHARS', 18);
const SPEECH_TOKEN_REFRESH_MS = getNumberEnv(
  'SPEECH_TOKEN_REFRESH_MS',
  9 * 60 * 1000
);
const WS_PING_INTERVAL_MS = getNumberEnv('WS_PING_INTERVAL_MS', 30000);
const PATCH_LRU_PER_ROOM = getNumberEnv('PATCH_LRU_PER_ROOM', 500);
const TTS_MAX_BACKLOG_SEC = getNumberEnv('TTS_MAX_BACKLOG_SEC', 8);
const TTS_RESUME_BACKLOG_SEC = getNumberEnv(
  'TTS_RESUME_BACKLOG_SEC',
  TTS_MAX_BACKLOG_SEC > 0 ? Math.max(Math.floor(TTS_MAX_BACKLOG_SEC / 2), 2) : 4
);
const TTS_BACKLOG_FALLBACK_VOICE =
  process.env.TTS_BACKLOG_FALLBACK_VOICE !== undefined
    ? process.env.TTS_BACKLOG_FALLBACK_VOICE || null
    : process.env.DEFAULT_TTS_VOICE_FALLBACK || null;
const FINAL_DEBOUNCE_MS = Number(process.env.FINAL_DEBOUNCE_MS || 180);
const WATCHDOG_EVENT_IDLE_MS = Number(process.env.WATCHDOG_EVENT_IDLE_MS || 12000);
const WATCHDOG_PCM_IDLE_MS = Number(process.env.WATCHDOG_PCM_IDLE_MS || 7000);
const TTS_RATE_BOOST_PERCENT = getNumberEnv('TTS_RATE_BOOST_PERCENT', 10);
const FASTFINALS_STABLE_K = getNumberEnv('FASTFINALS_STABLE_K', 3);
const FASTFINALS_MIN_STABLE_MS = getNumberEnv('FASTFINALS_MIN_STABLE_MS', 600);
const FASTFINALS_MIN_CHARS = getNumberEnv('FASTFINALS_MIN_CHARS', 28);
const FASTFINALS_MIN_WORDS = getNumberEnv('FASTFINALS_MIN_WORDS', 6);
const FASTFINALS_EMIT_THROTTLE_MS = getNumberEnv('FASTFINALS_EMIT_THROTTLE_MS', 700);
const FASTFINALS_PUNCT_STABLE_MS = getNumberEnv('FASTFINALS_PUNCT_STABLE_MS', 350);
const FASTFINALS_TAIL_GUARD_CHARS = getNumberEnv('FASTFINALS_TAIL_GUARD_CHARS', 12);
const FASTFINALS_TAIL_GUARD_WORDS = getNumberEnv('FASTFINALS_TAIL_GUARD_WORDS', 2);
const MAX_UTTERANCE_DURATION_MS = getNumberEnv('MAX_UTTERANCE_DURATION_MS', 9000);
const PHRASE_HINTS = (process.env.PHRASE_HINTS || '')
  .split(',')
  .map((hint) => hint.trim())
  .filter(Boolean);
const AUTO_DETECT_LANGS = (process.env.AUTO_DETECT_LANGS || '')
  .split(',')
  .map((lang) => lang.trim())
  .filter(Boolean);
const SPEECH_TTS_FORMAT = process.env.SPEECH_TTS_FORMAT || '';
const RECOGNITION_MODE = process.env.RECOGNITION_MODE || 'conversation';

const translator = createTranslator({ logger, metrics });
const stateStore = createStateStore({
  logger,
  maxUnits: PATCH_LRU_PER_ROOM,
  maxPatches: PATCH_LRU_PER_ROOM
});

// Minimal room registry (Redis-backed if available)
const roomRegistry = createRoomRegistry({ logger, redisClient: stateStore?.client });
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DISABLE_ADMIN_AUTH =
  process.env.NODE_ENV === 'development' || process.env.DISABLE_ADMIN_AUTH === 'true';

function parseMillis(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const d = new Date(String(value));
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

const WS_VERBOSE =
  process.env.WS_VERBOSE_LOG === 'true' ||
  process.env.WS_VERBOSE_LOG === '1' ||
  process.env.DEBUG_WS === 'true';

function wsVerbose(roomId, tag, details) {
  if (!WS_VERBOSE) {
    return;
  }
  logger.debug(
    {
      component: 'ws-verbose',
      roomId,
      tag,
      ...details
    },
    'WS event.'
  );
}

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

  // Forward declaration - will be set after room is created
  let roomRef = null;

  const processor = new SegmentProcessor({
    roomId,
    logger: roomLogger.child({ component: 'segment-processor' }),
    translator,
    metrics: {
      observePatch: metrics.observePatch,
      dropPatch: metrics.dropPatch
    },
    maxUnits: PATCH_LRU_PER_ROOM,
    store: stateStore,
    // Callback for async translations from buffer
    onTranslationReady: (translatedPatches) => {
      if (!roomRef) {
        return;
      }
      // Broadcast translations when buffer flushes
      broadcastPatch(roomRef, {
        stale: false,
        sourcePatch: null,
        translatedPatches
      });
    }
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
        rateBoostPercent: TTS_RATE_BOOST_PERCENT,
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

  // Set reference for callback
  roomRef = room;

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

async function resetRoom(room) {
  room.logger.info({ component: 'room', action: 'reset' }, 'Resetting room state.');
  room.processor.reset();
  if (stateStore?.clearRoom) {
    try {
      await stateStore.clearRoom(room.id);
    } catch (err) {
      room.logger.warn({ component: 'room', err: err?.message }, 'Failed to clear store cache.');
    }
  }
  for (const queue of room.ttsQueues.values()) {
    if (typeof queue.reset === 'function') {
      queue.reset();
    }
  }
  for (const client of room.clients) {
    safeSend(client.socket, { type: 'reset' });
  }
  room.watchdog.markEvent();
  room.watchdog.markPcm();
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

// Admin: upsert room metadata (requires ADMIN_TOKEN)
app.post('/api/admin/rooms', async (req, res) => {
  try {
    const cookieToken = parseCookies(req).admin_token;
    const headerToken = req.get('x-admin-token');
    if (!DISABLE_ADMIN_AUTH && ADMIN_TOKEN && headerToken !== ADMIN_TOKEN && cookieToken !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const body = req.body || {};
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'Missing slug' });
    }
    // Default: use slug as join code (listener=<slug>, speaker=<slug>-speaker)
    const baseCodeRaw = String(body.code || '').trim();
    const baseCode = baseCodeRaw || slug;
    const listenerCode = String(body.listenerCode || baseCode || '').trim() || undefined;
    const speakerCode = String(
      body.speakerCode || (baseCode ? `${baseCode}-speaker` : '') || ''
    ).trim() || undefined;
    const meta = {
      slug,
      title: String(body.title || '').trim(),
      startsAt: parseMillis(body.startsAt),
      endsAt: parseMillis(body.endsAt),
      sourceLang: String(body.sourceLang || '').trim(),
      autoDetectLangs: Array.isArray(body.autoDetectLangs)
        ? body.autoDetectLangs
        : String(body.autoDetectLangs || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
      defaultTargetLangs: Array.isArray(body.defaultTargetLangs)
        ? body.defaultTargetLangs
        : String(body.defaultTargetLangs || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    };
    const saved = await roomRegistry.upsert(meta, {
      speakerCode,
      listenerCode
    });
    return res.json({ ok: true, room: saved });
  } catch (err) {
    logger.error({ component: 'admin', err: err?.message }, 'Failed to upsert room');
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// Admin: login to set cookie
app.post('/api/admin/login', async (req, res) => {
  try {
    if (!ADMIN_TOKEN || DISABLE_ADMIN_AUTH) {
      // Dev mode or not configured: allow access without strict auth
      return res.json({ ok: true, dev: true });
    }
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });
    if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'Invalid token' });
    const secure = (req.secure || req.headers['x-forwarded-proto'] === 'https') && process.env.NODE_ENV !== 'development';
    res.cookie('admin_token', ADMIN_TOKEN, {
      httpOnly: true,
      sameSite: 'lax',
      secure
    });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// Admin: logout to clear cookie
app.post('/api/admin/logout', (req, res) => {
  const secure = (req.secure || req.headers['x-forwarded-proto'] === 'https') && process.env.NODE_ENV !== 'development';
  res.cookie('admin_token', '', { httpOnly: true, sameSite: 'lax', secure, expires: new Date(0) });
  res.json({ ok: true });
});

// Admin: check auth status
app.get('/api/admin/check', (req, res) => {
  if (!ADMIN_TOKEN || DISABLE_ADMIN_AUTH) {
    return res.json({ ok: true, dev: true });
  }
  const cookieToken = parseCookies(req).admin_token;
  const headerToken = req.get('x-admin-token');
  if (headerToken === ADMIN_TOKEN || cookieToken === ADMIN_TOKEN) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
});

// Public: fetch room defaults/meta
app.get('/api/rooms/:slug', async (req, res) => {
  try {
    const meta = await roomRegistry.get(req.params.slug);
    if (!meta) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({ ok: true, room: roomRegistry.cleanMeta(meta) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// Access: resolve a code to { slug, role }
app.post('/api/access/resolve', async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });
    const resolved = await roomRegistry.resolveCode(code);
    if (!resolved) return res.status(404).json({ ok: false, error: 'Code not found' });
    const meta = await roomRegistry.get(resolved.slug);
    const win = roomRegistry.windowState(meta);
    return res.json({ ok: true, ...resolved, window: win.state });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    recognitionMode: RECOGNITION_MODE,
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
    ttsRateBoostPercent: TTS_RATE_BOOST_PERCENT,
    patchLruPerRoom: PATCH_LRU_PER_ROOM,
    finalDebounceMs: FINAL_DEBOUNCE_MS,
    maxUtteranceDurationMs: MAX_UTTERANCE_DURATION_MS,
    phraseHints: PHRASE_HINTS,
    autoDetectLangs: AUTO_DETECT_LANGS,
    ttsFormat: SPEECH_TTS_FORMAT || undefined,
    speechTunables: {
      segmentationSilenceMs: SEG_SILENCE_MS,
      endSilenceMs: END_SILENCE_MS,
      initialSilenceMs: INITIAL_SILENCE_MS,
      stablePartials: STABLE_PARTIALS
    },
    fastFinals: {
      stableK: FASTFINALS_STABLE_K,
      minStableMs: FASTFINALS_MIN_STABLE_MS,
      minChars: FASTFINALS_MIN_CHARS,
      minWords: FASTFINALS_MIN_WORDS,
      emitThrottleMs: FASTFINALS_EMIT_THROTTLE_MS,
      punctStableMs: FASTFINALS_PUNCT_STABLE_MS,
      tailGuardChars: FASTFINALS_TAIL_GUARD_CHARS,
      tailGuardWords: FASTFINALS_TAIL_GUARD_WORDS
    }
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
  // Enforce room window if registry has metadata
  try {
    const meta = await roomRegistry.get(roomId);
    if (meta) {
      const win = roomRegistry.windowState(meta);
      if (win.state === 'early') {
        return res.status(403).json({ ok: false, error: 'Room not yet open' });
      }
      if (win.state === 'expired') {
        return res.status(410).json({ ok: false, error: 'Room expired' });
      }
    }
  } catch (e) {
    logger.warn({ component: 'admin', err: e?.message }, 'Room window check failed');
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
    // Enforce room window if registry has metadata
    try {
      const meta = await roomRegistry.get(roomId);
      if (meta) {
        const win = roomRegistry.windowState(meta);
        if (win.state === 'early') {
          socket.close(4403, 'Room not yet open');
          return;
        }
        if (win.state === 'expired') {
          socket.close(4410, 'Room expired');
          return;
        }
      }
    } catch (e) {
      logger.warn({ component: 'admin', err: e?.message }, 'Room window check failed');
    }
    const room = ensureRoom(roomId);
    if (room.ready) {
      await room.ready;
    }
    if (role === 'speaker') {
      await resetRoom(room);
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
      let parsed = null;
      let raw = '';
      try {
        raw = typeof data === 'string' ? data : data?.toString?.() || '';
        parsed = JSON.parse(raw);
      } catch (err) {
        wsVerbose(roomId, 'bad-json', { role, error: err?.message, raw: raw.slice(0, 160) });
        room.logger.debug({ component: 'ws', err: err?.message }, 'Failed to parse WS message.');
        return;
      }

      const payloadInfo = {};
      if (parsed?.unitId) {
        payloadInfo.unitId = parsed.unitId;
      }
      if (typeof parsed?.text === 'string') {
        payloadInfo.len = parsed.text.length;
      }
      if (typeof parsed?.seq === 'number') {
        payloadInfo.seq = parsed.seq;
      }
      if (typeof parsed?.srcStart === 'number' || typeof parsed?.srcEnd === 'number') {
        payloadInfo.srcStart = parsed.srcStart;
        payloadInfo.srcEnd = parsed.srcEnd;
      }
      wsVerbose(roomId, parsed?.type || 'unknown', { role, ...payloadInfo });

      if (parsed?.type === 'heartbeat' && parsed?.payload?.pcm === true) {
        room.watchdog.markPcm();
        return;
      }
      if (parsed?.type === 'resume' && parsed?.payload?.versions) {
        client.lastSeen = parsed.payload.versions || {};
        return;
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
    if (roomRegistry && typeof roomRegistry.close === 'function') {
      roomRegistry.close().catch((err) =>
        logger.warn({ component: 'room-registry', err: err?.message }, 'Failed to close registry.')
      );
    }
    if (stateStore && typeof stateStore.close === 'function') {
      stateStore.close().catch((err) =>
        logger.warn({ component: 'state-store', err: err?.message }, 'Failed to close store.')
      );
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
