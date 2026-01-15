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
const { createRoomRegistryPg } = require('./room-registry-pg');
const {
  createSttSession,
  getProviderConfig,
  isProviderAvailable,
  isServerSideProvider,
  STT_PROVIDER,
} = require('./stt-provider-factory');
const zoomRtms = require('./zoom-rtms');

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

// Optional version endpoint for quick verification
const PKG = (() => {
  try {
    // eslint-disable-next-line global-require
    return require('../package.json');
  } catch {
    return { version: '0.0.0-dev' };
  }
})();

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

// OWASP security headers (required for Zoom App Surface validation)
app.use((_req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss: https:; frame-ancestors 'self' https://*.zoom.us");
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Do not gate the admin UI route here. The React app handles login UX; APIs enforce auth.
app.use((req, _res, next) => next());

// If the client build exists, serve its assets and mount SPA routes (Express 5 safe)
if (fs.existsSync(CLIENT_DIST_DIR)) {
  logger.info({ component: 'admin-ui', dir: CLIENT_DIST_DIR }, 'Serving admin client from dist.');
  const adminIndex = path.join(CLIENT_DIST_DIR, 'index.html');
  const assetsDir = path.join(CLIENT_DIST_DIR, 'assets');
  if (fs.existsSync(assetsDir)) {
    app.use(
      '/assets',
      express.static(assetsDir, {
        setHeaders: (res) => {
          try { res.set('Cache-Control', 'no-store'); } catch {}
        }
      })
    );
  }
  const serveSpa = (_req, res, next) => {
    if (fs.existsSync(adminIndex)) {
      try {
        res.set('Cache-Control', 'no-store');
      } catch {}
      return res.sendFile(adminIndex);
    }
    return next();
  };
  // Admin SPA (/admin and any subpath)
  app.get(/^\/admin(?:\/.*)?$/, serveSpa);
  // Listener/Speaker SPA
  app.get(/^\/listener(?:\/.*)?$/, serveSpa);
  app.get(/^\/speaker(?:\/.*)?$/, serveSpa);
  // Back-compat .html entry points
  app.get(/^\/(?:admin|listener|speaker)\.html$/, serveSpa);
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
const FASTFINALS_STABLE_K = getNumberEnv('FASTFINALS_STABLE_K', 2);
const FASTFINALS_MIN_STABLE_MS = getNumberEnv('FASTFINALS_MIN_STABLE_MS', 350);
const FASTFINALS_MIN_CHARS = getNumberEnv('FASTFINALS_MIN_CHARS', 24);
const FASTFINALS_MIN_WORDS = getNumberEnv('FASTFINALS_MIN_WORDS', 6);
const FASTFINALS_EMIT_THROTTLE_MS = getNumberEnv('FASTFINALS_EMIT_THROTTLE_MS', 500);
const FASTFINALS_PUNCT_STABLE_MS = getNumberEnv('FASTFINALS_PUNCT_STABLE_MS', 300);
const FASTFINALS_TAIL_GUARD_CHARS = getNumberEnv('FASTFINALS_TAIL_GUARD_CHARS', 10);
const FASTFINALS_TAIL_GUARD_WORDS = getNumberEnv('FASTFINALS_TAIL_GUARD_WORDS', 2);
const MAX_UTTERANCE_DURATION_MS = getNumberEnv('MAX_UTTERANCE_DURATION_MS', 7000);
const PHRASE_HINTS = (process.env.PHRASE_HINTS || '')
  .split(',')
  .map((hint) => hint.trim())
  .filter(Boolean);
const PATCH_HISTORY_MAX_MS = getNumberEnv('PATCH_HISTORY_MAX_MS', 5 * 60 * 1000); // Default: keep only last 5 minutes of history
const AUTO_DETECT_LANGS = (process.env.AUTO_DETECT_LANGS || '')
  .split(',')
  .map((lang) => lang.trim())
  .filter(Boolean);
const SPEECH_TTS_FORMAT = process.env.SPEECH_TTS_FORMAT || '';
const RECOGNITION_MODE = process.env.RECOGNITION_MODE || 'conversation';
// STT_PROVIDER imported from stt-provider-factory

const translator = createTranslator({ logger, metrics });
const stateStore = createStateStore({
  logger,
  maxUnits: PATCH_LRU_PER_ROOM,
  maxPatches: PATCH_LRU_PER_ROOM
});

// Room registry: prefer Postgres when DATABASE_URL is configured; else Redis/FS
let roomRegistry = null;
if (process.env.DATABASE_URL) {
  roomRegistry = createRoomRegistryPg({ logger });
  if (roomRegistry && typeof roomRegistry.migrate === 'function') {
    roomRegistry
      .migrate()
      .catch((err) => logger.error({ component: 'room-registry', err: err?.message }, 'PG migration failed.'));
  }
} else {
  // Redis-backed if REDIS_URL is set; otherwise in-memory/FS
  roomRegistry = createRoomRegistry({ logger, redisClient: stateStore?.client });
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Dev-only bypass: enabled only when not in production
const ADMIN_DEV_BYPASS = process.env.NODE_ENV !== 'production';

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

function countWords(text) {
  return String(text || '')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean).length;
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
  // Track which root units have already triggered TTS to prevent duplicate playback
  // Key: `${lang}:${rootUnitId}`, Value: true
  const ttsTriggeredUnits = new Map();

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
          'TTS backlog high â€“ applying throttle.'
        );
      });
      queue.on('resume', (payload) => {
        roomLogger.info(
          { component: 'tts', lang: payload.lang, backlog: payload.backlog },
          'TTS backlog recovered â€“ resuming normal voice.'
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
    ttsTriggeredUnits,
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
    const cutoff = PATCH_HISTORY_MAX_MS > 0 ? Date.now() - PATCH_HISTORY_MAX_MS : null;
    for (const unit of units) {
      const updatedAt = unit?.updatedAt || unit?.ts || 0;
      if (cutoff && (!updatedAt || updatedAt < cutoff)) {
        continue;
      }
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
  const now = Date.now();

  const langBase = (lang) => (typeof lang === 'string' ? String(lang).split('-')[0].toLowerCase() : '');

  // Heuristic to guess language base when auto-detect mislabels content
  function inferLikelyBase(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return '';

    // English signals - check first to handle mixed content with French proper nouns
    const hasEnglishWords = /\b(thank you|thanks|hello|hi everyone|i would like to begin|i'd like to begin|speaking to you all|from canada|today|this afternoon|the|this|that|with|have|has|been|will|would|could|should|they|them|their|there|here|what|when|where|which|because|about|into|from|just|some|more|other|only|also|than|then)\b/.test(t);

    // French signals - strong indicators (words and patterns, not just accents)
    const hasFrenchWords = /\b(merci|bonjour|s'il|svp|s'il te plaît|avant de commencer|sous-ministre|avec|dans|semaine|aujourd'hui|aller|souliers|je|j'ai|l'ai|vais|bien|nous|vous|ils|elles|c'est|qu'est|n'est|d'accord|pour|sont|mais|que|qui|quoi|donc|alors|parce|cette|notre|votre|leur|très|aussi|peut|dois|fait|faire|avoir|être|ça|cela|comme|tout|tous|toutes|sur|sous|entre)\b/.test(t);
    // Additional French contractions and patterns
    const hasFrenchPatterns = /\b(l'|d'|j'|n'|s'|c'|qu'|m'|t')\w+/.test(t);
    // French accents alone are weak signal (could be proper nouns in English text)
    const hasFrenchAccents = /[àâäæçéèêëîïôœùûüÿ]/.test(t);

    // If English words are present, require strong French signals (words/patterns) to override
    // This prevents false positives from French proper nouns like "Geneviève" in English text
    if (hasEnglishWords) {
      if (hasFrenchWords || hasFrenchPatterns) return 'fr';
      return 'en';
    }

    // No English words detected - French accents alone are enough
    if (hasFrenchAccents || hasFrenchWords || hasFrenchPatterns) return 'fr';

    return '';
  }

  const patchesByLang = new Map();
  if (sourcePatch && sourcePatch.text && sourcePatch.text.trim()) {
    const stampedSource = { ...sourcePatch, emittedAt: sourcePatch.emittedAt || now };
    const langKey = sourcePatch.srcLang || 'source';
    patchesByLang.set(langKey, {
      type: 'patch',
      payload: stampedSource
    });
    // Mirror source patch for listeners explicitly requesting 'source'.
    patchesByLang.set('source', {
      type: 'patch',
      payload: stampedSource
    });
  }

  if (Array.isArray(translatedPatches)) {
    for (const patch of translatedPatches) {
      if (!patch.text || !String(patch.text).trim()) {
        continue;
      }
      const stampedPatch = { ...patch, emittedAt: patch.emittedAt || now };
      patchesByLang.set(patch.targetLang, {
        type: 'patch',
        payload: stampedPatch
      });
    }
  }

  // On-demand translation safety net: if a listener requests a language that
  // wasn't translated upstream (e.g., late language switch, missing target),
  // generate it here so they never fall back to source text.
  if (sourcePatch) {
    const srcBase = langBase(sourcePatch.srcLang);
    const inferredBase = inferLikelyBase(sourcePatch.text);
    const textSuspicious = inferredBase && inferredBase !== srcBase;
    const directMirrors = [];
    const translateLangs = new Set();
    for (const client of room.clients) {
      if (!client.lang) continue;

      const clientBase = langBase(client.lang);

      // If the text looks mislabeled, force translation for concrete languages (not 'source')
      if (textSuspicious && client.lang !== 'source') {
        translateLangs.add(client.lang);
        continue;
      }

      if (client.lang !== sourcePatch.srcLang && !patchesByLang.has(client.lang)) {
        // If the listener lang shares the same base (fr-FR vs fr-CA), just mirror the source text
        if (clientBase && clientBase === srcBase) {
          directMirrors.push(client.lang);
        } else {
          translateLangs.add(client.lang);
        }
      }
    }
    // Emit direct mirrors (identity copy) for same-language-family listeners
    for (const lang of directMirrors) {
      const stamped = {
        unitId: sourcePatch.unitId,
        utteranceId: sourcePatch.utteranceId || sourcePatch.unitId,
        stage: sourcePatch.stage,
        op: 'replace',
        version: sourcePatch.version,
        rev: sourcePatch.rev || sourcePatch.version,
        text: sourcePatch.text,
        srcLang: sourcePatch.srcLang,
        targetLang: lang,
        isFinal: sourcePatch.stage === 'hard',
        sentLen: sourcePatch.sentLen || null,
        ts: sourcePatch.ts,
        emittedAt: now,
        provider: 'mirror',
        ttsFinal: sourcePatch.ttsFinal === true
      };
      patchesByLang.set(lang, { type: 'patch', payload: stamped });
    }

    if (translateLangs.size) {
      try {
        const fallbackTranslations = await translator.translate(
          room.id,
          sourcePatch.text || '',
          textSuspicious ? undefined : sourcePatch.srcLang,
          Array.from(translateLangs),
          [] // no extra context
        );
        for (const translation of fallbackTranslations) {
          const stamped = {
            unitId: sourcePatch.unitId,
            utteranceId: sourcePatch.utteranceId || sourcePatch.unitId,
            stage: sourcePatch.stage,
            op: 'replace',
            version: sourcePatch.version,
            rev: sourcePatch.rev || sourcePatch.version,
            text: translation.text,
            srcLang: sourcePatch.srcLang,
            targetLang: translation.lang,
            isFinal: sourcePatch.stage === 'hard',
            sentLen: {
              src: translation.srcSentLen,
            tgt: translation.transSentLen
          },
          ts: sourcePatch.ts,
          emittedAt: now,
          provider: translation.provider || 'fallback',
          ttsFinal: sourcePatch.ttsFinal === true
        };
        patchesByLang.set(translation.lang, { type: 'patch', payload: stamped });
      }
      } catch (err) {
        room.logger.warn(
          { component: 'broadcast', err: err?.message, missingLangs: Array.from(translateLangs) },
          'On-demand translation fallback failed.'
        );
      }
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

  // Optional debug: show recipient counts per language
  if (process.env.BROADCAST_DEBUG === 'true') {
    try {
      const recipientsByLang = {};
      let recipientsTotal = 0;
      const sourceLangKey = sourcePatch?.srcLang || 'source';
      for (const client of room.clients) {
        let langKey = null;
        if (client.lang && patchesByLang.has(client.lang)) {
          langKey = client.lang;
        } else if (sourcePatch && !client.lang) {
          langKey = sourceLangKey;
        }
        if (langKey) {
          recipientsByLang[langKey] = (recipientsByLang[langKey] || 0) + 1;
          recipientsTotal += 1;
        }
      }
      room.logger.debug(
        {
          component: 'broadcast',
          unitId: sourcePatch?.unitId,
          totalClients: room.clients.size,
          recipients: recipientsTotal,
          recipientsByLang
        },
        'Broadcast recipients summary.'
      );
    } catch (e) {
      room.logger.debug({ component: 'broadcast', err: e?.message }, 'Broadcast debug summary failed.');
    }
  }

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

  const ttsEnqueueByLang = new Map(); // lang -> Map<unitId, { payload, voice }>

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
      if (client.role === 'speaker') {
        room.logger.info({ component: 'broadcast', role: 'speaker', lang: client.lang, hasMessage: !!message, unitId: payload?.unitId?.substring(0, 30) }, 'Speaker matched for patch');
      }
      const lastSeenVersion =
        client.lastSeen && typeof client.lastSeen[payload.unitId] === 'number'
          ? client.lastSeen[payload.unitId]
          : undefined;

      // Only skip sending if already seen, but ALWAYS check TTS for ttsFinal
      const alreadySeen = lastSeenVersion !== undefined && payload.version <= lastSeenVersion;
      if (!alreadySeen) {
        if (client.role === 'speaker') {
          room.logger.debug({ component: 'broadcast', role: client.role, lang: client.lang, unitId: payload.unitId?.substring(0, 20) }, 'Sending patch to speaker');
        }
        safeSend(client.socket, message);
        if (client.lastSeen) {
          client.lastSeen[payload.unitId] = payload.version;
        }
      }

      // Check TTS even if patch was already sent (ttsFinal might come on same version)
      if (client.lang && payload.stage === 'hard' && client.wantsTts && payload.ttsFinal) {
        if (payload.text && payload.unitId) {
          let byUnit = ttsEnqueueByLang.get(client.lang);
          if (!byUnit) {
            byUnit = new Map();
            ttsEnqueueByLang.set(client.lang, byUnit);
          }
          const version = typeof payload.version === 'number' ? payload.version : 0;
          const existing = byUnit.get(payload.unitId);
          if (!existing) {
            byUnit.set(payload.unitId, { payload, voice: client.voice, version });
          } else {
            const existingVersion = typeof existing.version === 'number' ? existing.version : null;
            if (existingVersion == null || (version != null && version > existingVersion)) {
              byUnit.set(payload.unitId, { payload, voice: client.voice, version });
            } else if (!existing.voice && client.voice) {
              byUnit.set(payload.unitId, { payload: existing.payload, voice: client.voice, version: existing.version });
            }
          }
        }
      }
    }
  }

  // Enqueue TTS once per (lang, unitId) to avoid duplicate playback when multiple listeners request TTS
  for (const [lang, units] of ttsEnqueueByLang.entries()) {
    const queue = room.getTtsQueueForLang(lang);
    if (!queue) {
      room.logger.warn({ component: 'tts', lang }, '[TTS Enqueue] No TTS queue available for language');
      continue;
    }
    const targetLangBase = langBase(lang);
    for (const [, entry] of units.entries()) {
      const { payload, voice, version } = entry;
      const rootUnitId = payload.unitId.split('#')[0];
      const ttsKey = `${lang}:${rootUnitId}`;

      // DEDUPLICATION: Skip if this root unit has already triggered TTS for this language
      if (room.ttsTriggeredUnits && room.ttsTriggeredUnits.has(ttsKey)) {
        room.logger.debug(
          { component: 'tts', lang, unitId: payload.unitId, rootUnitId },
          '[TTS Enqueue] Skipping - unit already triggered TTS'
        );
        continue;
      }

      // LANGUAGE CHECK: Skip if text appears to be in the wrong language
      // This prevents French source text from being sent to English TTS
      const textLangBase = inferLikelyBase(payload.text);
      if (textLangBase && textLangBase !== targetLangBase) {
        room.logger.warn(
          { component: 'tts', lang, unitId: payload.unitId, textLangBase, targetLangBase, textPreview: payload.text?.substring(0, 50) },
          '[TTS Enqueue] Skipping - text language mismatch (possible untranslated text)'
        );
        continue;
      }

      const incomingSentLen = payload.sentLen;
      const targetSentLen = Array.isArray(incomingSentLen?.tgt)
        ? incomingSentLen.tgt
        : Array.isArray(incomingSentLen)
        ? incomingSentLen
        : null;
      room.logger.debug(
        { component: 'tts', lang, unitId: payload.unitId, textLength: payload.text?.length },
        '[TTS Enqueue] Enqueueing text for synthesis'
      );
      queue.enqueue(lang, payload.unitId, payload.text, {
        voice,
        sentLen: targetSentLen,
        version
      });

      // Mark this root unit as having triggered TTS
      if (room.ttsTriggeredUnits) {
        room.ttsTriggeredUnits.set(ttsKey, Date.now());

        // Periodic cleanup: evict entries older than 10 minutes to prevent unbounded growth
        // Only run cleanup occasionally (every 100 entries) to minimize overhead
        if (room.ttsTriggeredUnits.size % 100 === 0) {
          const TTS_DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
          const cutoff = Date.now() - TTS_DEDUP_TTL_MS;
          for (const [key, timestamp] of room.ttsTriggeredUnits.entries()) {
            if (timestamp < cutoff) {
              room.ttsTriggeredUnits.delete(key);
            }
          }
        }
      }
    }
  }
}

function broadcastAudio(room, payload) {
  if (!payload || !payload.audio || (Buffer.isBuffer(payload.audio) && payload.audio.length === 0)) {
    if (room.logger && typeof room.logger.warn === 'function') {
      room.logger.warn({ component: 'tts', unitId: payload?.unitId, lang: payload?.lang }, 'Skipping TTS broadcast - missing or empty audio payload.');
    }
    return;
  }
  room.logger.debug(
    {
      component: 'tts',
      lang: payload.lang,
      unitId: payload.unitId,
      textLength: payload.text?.length,
      audioSize: payload.audio?.length
    },
    'Broadcasting TTS audio to listeners.'
  );
  const targetClients = Array.from(room.clients).filter(c => c.wantsTts && c.lang === payload.lang);
  if (!payload.text || !String(payload.text).trim()) {
    room.logger.warn({ component: 'tts', unitId: payload?.unitId, lang: payload?.lang }, 'Skipping TTS broadcast - empty text.');
    return;
  }
  room.logger.debug(
    { component: 'tts', lang: payload.lang, unitId: payload.unitId, textLength: payload.text?.length, audioSize: payload.audio?.length, targetClients: targetClients.length },
    '[TTS Broadcast] Broadcasting audio to clients'
  );

  for (const client of targetClients) {
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
        sentLen: payload.sentLen || null,
        version: payload.version ?? null
      }
    });
    metrics.recordTtsEvent(room.id, payload.lang, 'delivered');
  }
}

app.get('/healthz', async (_req, res) => {
  const roomIds = Array.from(rooms.keys());
  const redis = { configured: Boolean(process.env.REDIS_URL), up: false };
  const db = { configured: Boolean(process.env.DATABASE_URL), up: false };
  let roomsDbCount = null;
  try {
    // Prefer DB readiness for overall health
    if (roomRegistry && typeof roomRegistry.dbStatus === 'function') {
      const s = await roomRegistry.dbStatus();
      db.configured = Boolean(s?.configured);
      db.up = Boolean(s?.up);
      if (s?.error) db.error = s.error;
    }
    if (roomRegistry && typeof roomRegistry.count === 'function') {
      try {
        roomsDbCount = await roomRegistry.count();
      } catch (err) {
        // ignore count errors; report readiness above
      }
    }
    // Still report Redis state for visibility
    if (stateStore?.client && typeof stateStore.client.ping === 'function') {
      const pong = await stateStore.client.ping();
      redis.up = pong === 'PONG';
    } else if (roomRegistry && typeof roomRegistry.redisStatus === 'function') {
      const s = await roomRegistry.redisStatus();
      redis.configured = Boolean(s?.configured);
      redis.up = Boolean(s?.up);
      if (s?.error) redis.error = s.error;
    }
  } catch (e) {
    db.error = db.error || e?.message;
  }
  const ready = db.configured ? db.up : true;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    rooms: roomIds,
    roomsActive: roomIds.length,
    roomsDb: roomsDbCount,
    db,
    redis
  });
});

app.get('/metrics', metrics.sendMetrics);

// Version info
app.get('/version', (req, res) => {
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '';
  res.json({ ok: true, version: PKG.version, commit: commit || null });
});

// Admin: upsert room metadata (requires ADMIN_TOKEN)
app.post('/api/admin/rooms', async (req, res) => {
  try {
    const cookieToken = parseCookies(req).admin_token;
    const headerToken = req.get('x-admin-token');
    if (!ADMIN_DEV_BYPASS) {
      if (!ADMIN_TOKEN) {
        return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN not configured' });
      }
      if (headerToken !== ADMIN_TOKEN && cookieToken !== ADMIN_TOKEN) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }
    const body = req.body || {};
    const slug = String(body.slug || '').trim().toLowerCase();
    // Prevent ambiguous slugs that collide with role suffix
    if (/-speaker$/i.test(slug)) {
      return res.status(400).json({ ok: false, error: "Invalid slug: '-speaker' suffix is reserved for access codes" });
    }
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
            .filter(Boolean),
      sttPrompt: String(body.sttPrompt || '').trim()
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
    if (ADMIN_DEV_BYPASS) {
      // Dev mode: allow access without strict auth
      return res.json({ ok: true, dev: true });
    }
    if (!ADMIN_TOKEN) {
      return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN not configured' });
    }
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });
    if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'Invalid token' });
    const secure = (req.secure || req.headers['x-forwarded-proto'] === 'https') && process.env.NODE_ENV !== 'development';
    res.cookie('admin_token', ADMIN_TOKEN, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/'
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

// Admin: list rooms (requires ADMIN_TOKEN in production)
app.get('/api/admin/rooms', async (req, res) => {
  try {
    const cookieToken = parseCookies(req).admin_token;
    const headerToken = req.get('x-admin-token');
    if (process.env.NODE_ENV === 'production') {
      if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN not configured' });
      if (headerToken !== ADMIN_TOKEN && cookieToken !== ADMIN_TOKEN) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }
    const list = await roomRegistry.list(500);
    return res.json({ ok: true, rooms: Array.isArray(list) ? list : [] });
  } catch (err) {
    logger.error({ component: 'admin', err: err?.message }, 'Failed to list rooms');
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// Admin: delete a room (requires ADMIN_TOKEN in production)
app.delete('/api/admin/rooms/:slug', async (req, res) => {
  try {
    const cookieToken = parseCookies(req).admin_token;
    const headerToken = req.get('x-admin-token');
    if (process.env.NODE_ENV === 'production') {
      if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN not configured' });
      if (headerToken !== ADMIN_TOKEN && cookieToken !== ADMIN_TOKEN) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!slug) return res.status(400).json({ ok: false, error: 'Missing slug' });
    if (!roomRegistry || typeof roomRegistry.remove !== 'function') {
      return res.status(500).json({ ok: false, error: 'Delete not supported' });
    }
    const removed = await roomRegistry.remove(slug);
    if (!removed) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ component: 'admin', err: err?.message }, 'Failed to delete room');
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// Admin: check auth status
app.get('/api/admin/check', (req, res) => {
  if (ADMIN_DEV_BYPASS) {
    return res.json({ ok: true, dev: true });
  }
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN not configured' });
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

app.get('/api/config', async (_req, res) => {
  // Build list of available STT providers with their availability status
  const { PROVIDERS } = require('./stt-provider-factory');
  const sttProviders = await Promise.all(
    Object.entries(PROVIDERS).map(async ([name, p]) => ({
      name,
      available: await Promise.resolve(typeof p.isConfigured === 'function' ? p.isConfigured() : p.isConfigured),
      isServerSide: p.isServerSide
    }))
  );

  res.json({
    sttProvider: STT_PROVIDER,
    sttProviders,  // Array of available providers with availability status
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

// Zoom OAuth callback (for app authorization)
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('Zoom credentials not configured');
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://zoom.us/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${req.protocol}://${req.get('host')}/oauth/callback`
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        }
      }
    );
    logger.info({ component: 'zoom-oauth' }, 'Zoom app authorized successfully');
    res.send('Zoom app authorized! You can close this window and start a meeting with Live Transcript enabled.');
  } catch (err) {
    logger.error({ component: 'zoom-oauth', err: err?.response?.data || err?.message }, 'OAuth token exchange failed');
    res.status(500).send(`Authorization failed: ${err?.response?.data?.reason || err?.message}`);
  }
});

// Zoom RTMS webhook endpoint
app.post('/api/zoom/webhook', (req, res) => {
  const result = zoomRtms.handleWebhook(req.body || {}, {
    logger,
    ensureRoom,
    broadcastPatch,
    roomRegistry,
    defaultRoomTargets
  }, req); // Pass req for signature verification
  if (result) {
    return res.status(result.status).json(result.body);
  }
  return res.status(400).json({ ok: false, error: 'Unhandled request' });
});

app.post('/api/segments', async (req, res) => {
  const { roomId = 'default', patch, targets = [] } = req.body || {};
  const normalizedRoomId = String(roomId).toLowerCase();
  if (!patch || typeof patch !== 'object') {
    metrics.dropPatch(normalizedRoomId, 'missing_patch');
    return res.status(400).json({ ok: false, error: 'Invalid patch payload.' });
  }
  // Enforce room window if registry has metadata
  try {
    const meta = await roomRegistry.get(normalizedRoomId);
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
  const room = ensureRoom(normalizedRoomId);
  if (room.ready) {
    await room.ready;
  }

  try {
    room.watchdog.markEvent();

    const listenerTargets = defaultRoomTargets(room);
    // Include Admin defaults if present so Speaker doesn't need to pass targets
    try {
      const meta2 = await roomRegistry.get(normalizedRoomId);
      if (meta2 && Array.isArray(meta2.defaultTargetLangs)) {
        for (const t of meta2.defaultTargetLangs) {
          if (t && t !== 'source') listenerTargets.add(t);
        }
      }
    } catch (e) {
      logger.debug({ component: 'admin', roomId: normalizedRoomId, err: e?.message }, 'Failed to read room meta for default targets.');
    }
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
    const roomId = (url.searchParams.get('room') || 'default').toLowerCase();
    const role = url.searchParams.get('role') || 'listener';
    const lang = url.searchParams.get('lang') || 'source';
    const wantsTts = url.searchParams.get('tts') === 'true';
    const requestedVoice = url.searchParams.get('voice') || undefined;
    const sttMode = url.searchParams.get('stt');  // 'stream' for server-side STT
    const requestedProvider = url.searchParams.get('provider');  // Client-selected STT provider
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
        wantsTts,
        sttMode: sttMode || null
      }
    });

    // Server-side STT session for speakers in stream mode
    // Use client-requested provider if valid, otherwise fall back to default
    const effectiveProvider = requestedProvider || STT_PROVIDER;
    let sttSession = null;
    if (role === 'speaker' && sttMode === 'stream' && isServerSideProvider(effectiveProvider)) {
      const providerAvailable = await isProviderAvailable(effectiveProvider);
      if (!providerAvailable) {
        room.logger.warn({ component: 'stt', provider: effectiveProvider }, 'STT provider not available, falling back to client-side STT');
        safeSend(socket, { type: 'stt:error', payload: { error: `${effectiveProvider} not available` } });
      } else {
        try {
          // Get room metadata for language config
          const meta = await roomRegistry.get(roomId);
          const sourceLang = meta?.sourceLang || 'en-US';
          const autoDetectLangs = meta?.autoDetectLangs || AUTO_DETECT_LANGS;
          const defaultTargets = meta?.defaultTargetLangs || [];

          // Broadcast function for STT patches
          const broadcastSttPatch = async (result) => {
            if (!result.stale) {
              await broadcastPatch(room, result);
            }
          };

          sttSession = await createSttSession(
            {
              roomId,
              sourceLang,
              autoDetectLangs,
              targetLangs: defaultTargets,
              phraseHints: PHRASE_HINTS,
              sttPrompt: meta?.sttPrompt || '',
              provider: effectiveProvider
            },
            room.processor,
            broadcastSttPatch,
            room.logger.child({ component: 'stt' })
          );

          if (sttSession && typeof sttSession.start === 'function') {
            await sttSession.start();
          }

          const limitations = sttSession.getLimitations?.() || [];
          room.logger.info({ component: 'stt', provider: effectiveProvider, sourceLang, limitations: limitations.length }, 'Server-side STT session created');
          safeSend(socket, { type: 'stt:ready', payload: { provider: effectiveProvider, limitations } });
        } catch (err) {
          room.logger.error({ component: 'stt', provider: effectiveProvider, err: err?.message }, 'Failed to create STT session');
          safeSend(socket, { type: 'stt:error', payload: { error: err?.message } });
        }
      }
    }

    let history = [];
    const now = Date.now();
    const cutoff = PATCH_HISTORY_MAX_MS > 0 ? now - PATCH_HISTORY_MAX_MS : null;
    if (stateStore && PATCH_HISTORY_MAX_MS !== 0) {
      try {
        history = await stateStore.loadPatches(roomId, lang || 'source');
      } catch (err) {
        room.logger.warn(
          { component: 'state-store', lang, err: err?.message },
          'Failed to load patch history from store.'
        );
      }
    }

    const stampPatchPayload = (payload) => {
      if (!payload) {
        return null;
      }
      const emittedAt = payload.emittedAt || payload.updatedAt || null;
      if (cutoff && (!emittedAt || emittedAt < cutoff)) {
        return null;
      }
      return { ...payload, emittedAt: emittedAt || now };
    };

    if (history.length && PATCH_HISTORY_MAX_MS !== 0) {
      for (const patchPayload of history) {
        const stamped = stampPatchPayload(patchPayload);
        if (stamped) {
          safeSend(socket, { type: 'patch', payload: stamped });
        }
      }
    } else if (PATCH_HISTORY_MAX_MS !== 0) {
      const snapshot = await room.processor.snapshot(lang);
      if (snapshot.length) {
        for (const entry of snapshot) {
          const emittedAt =
            typeof entry?.updatedAt === 'number' && entry.updatedAt > 0 ? entry.updatedAt : now;
          if (cutoff && (!emittedAt || emittedAt < cutoff)) {
            continue;
          }
          safeSend(socket, { type: 'patch', payload: { ...entry, emittedAt } });
        }
      }
    }

    socket.on('message', (data) => {
      if (role === 'speaker') {
        room.watchdog.markEvent();
      }

      // Handle binary audio data for server-side STT
      // Must be a Buffer AND not start with '{' (0x7B) which indicates JSON text
      if (sttSession && Buffer.isBuffer(data) && data.length > 0 && data[0] !== 0x7B) {
        room.watchdog.markPcm();
        sttSession.feedAudio(data);
        return;
      }

      let parsed = null;
      let raw = '';
      try {
        raw = typeof data === 'string' ? data : data?.toString?.() || '';
        parsed = JSON.parse(raw);
      } catch (err) {
        // Could be binary data that we didn't handle
        if (sttSession && data instanceof ArrayBuffer) {
          room.watchdog.markPcm();
          sttSession.feedAudio(Buffer.from(data));
          return;
        }
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

      // Handle STT control messages
      if (sttSession && parsed?.type?.startsWith('stt:')) {
        const sttCommand = parsed.type;
        const payload = parsed.payload || {};

        if (sttCommand === 'stt:start') {
          sttSession.start().then(() => {
            safeSend(socket, { type: 'stt:started', payload: {} });
          }).catch((err) => {
            room.logger.error({ component: 'stt', err: err?.message }, 'Failed to start STT');
            safeSend(socket, { type: 'stt:error', payload: { error: err?.message } });
          });
          return;
        }

        if (sttCommand === 'stt:stop') {
          sttSession.stop().then(() => {
            safeSend(socket, { type: 'stt:stopped', payload: {} });
          }).catch((err) => {
            room.logger.error({ component: 'stt', err: err?.message }, 'Failed to stop STT');
          });
          return;
        }

        if (sttCommand === 'stt:config') {
          // Update STT configuration mid-session
          if (payload.targetLangs) {
            sttSession.updateConfig({ targetLangs: payload.targetLangs });
          }
          if (payload.phraseHints) {
            sttSession.updateConfig({ phraseHints: payload.phraseHints });
          }
          return;
        }
      }
    });

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('close', () => {
      room.clients.delete(client);
      metrics.trackWsConnection(roomId, role, -1);
      // Clean up STT session if active
      if (sttSession) {
        sttSession.dispose();
        sttSession = null;
      }
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

server.listen(PORT, HOST, async () => {
  const COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '';
  logger.info({ port: PORT, host: HOST, commit: COMMIT ? COMMIT.slice(0, 7) : 'dev' }, 'Server listening.');

  // Seed dev room in development mode
  if (process.env.NODE_ENV === 'development') {
    try {
      const devRoom = await roomRegistry.upsert({
        slug: 'dev',
        title: 'Development Room',
        sourceLang: 'auto',
        autoDetectLangs: ['en-CA', 'fr-CA'],
        defaultTargetLangs: ['en-CA', 'fr-CA'],
        startsAt: 0,
        endsAt: 0,
        status: 'active'
      });
      logger.info({ component: 'dev-room', slug: 'dev' }, 'Dev room seeded: bilingual EN/FR, access code "dev"');
    } catch (err) {
      logger.warn({ component: 'dev-room', err: err?.message }, 'Failed to seed dev room');
    }
  }
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
