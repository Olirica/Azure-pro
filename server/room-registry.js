const Redis = require('ioredis');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Minimal room registry backed by Redis when available, otherwise in-memory.
 * Stores room metadata: schedule window, defaults, and role codes (hashed).
 */
function createRoomRegistry({ logger, redisClient } = {}) {
  const useRedis = Boolean(redisClient) || Boolean(process.env.REDIS_URL);
  const prefix = process.env.REDIS_PREFIX || 'polyglot';
  const key = (...parts) => [prefix, ...parts].join(':');

  const fsDir = process.env.FS_STORE_DIR || '';
  const fsRegistryFile = process.env.FS_ROOMS_FILE || (fsDir ? path.join(fsDir, 'rooms-registry.json') : '');
  const useFs = !useRedis && Boolean(fsRegistryFile);

  const EARLY_JOIN_MIN = parseNumber(process.env.ROOM_EARLY_JOIN_MINUTES, 15);
  const GRACE_MIN = parseNumber(process.env.ROOM_GRACE_MINUTES, 60);

  let redis = redisClient || null;
  if (!redis && useRedis) {
    const url = process.env.REDIS_URL;
    redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, enableReadyCheck: true });
    redis.on('error', (err) => logger?.warn?.({ component: 'room-registry', err: err?.message }, 'Redis error.'));
  }

  const memory = new Map();
  let fsLoaded = false;

  async function fsLoad() {
    if (!useFs || fsLoaded) return;
    try {
      const buf = await fsp.readFile(fsRegistryFile);
      const json = JSON.parse(String(buf));
      memory.clear();
      if (json && typeof json === 'object') {
        for (const [slug, meta] of Object.entries(json)) {
          memory.set(slug, meta);
        }
      }
      fsLoaded = true;
    } catch {
      // fresh file; mark loaded so we don't retry every call
      fsLoaded = true;
    }
  }

  async function fsSave() {
    if (!useFs) return;
    const obj = {};
    for (const [slug, meta] of memory.entries()) {
      obj[slug] = meta;
    }
    const dir = path.dirname(fsRegistryFile);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${fsRegistryFile}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fsp.writeFile(tmp, JSON.stringify(obj));
    await fsp.rename(tmp, fsRegistryFile);
  }

  async function ensure() {
    if (!redis) return;
    if (redis.status === 'ready' || redis.status === 'connect') return;
    await redis.connect();
  }

  function normalizeMeta(input) {
    if (!input || typeof input !== 'object') return null;
    const now = Date.now();
    const startsAt = Number(input.startsAt || 0) || 0;
    const endsAt = Number(input.endsAt || 0) || 0;
    const srcLang = (input.sourceLang || '').trim();
    const autoDetectLangs = Array.isArray(input.autoDetectLangs)
      ? input.autoDetectLangs.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const defaultTargetLangs = Array.isArray(input.defaultTargetLangs)
      ? input.defaultTargetLangs.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const title = (input.title || '').trim();
    const speakerCodeHash = input.speakerCodeHash || null;
    const listenerCodeHash = input.listenerCodeHash || null;
    return {
      slug: String(input.slug || '').trim().toLowerCase(),
      title,
      startsAt,
      endsAt,
      sourceLang: srcLang,
      autoDetectLangs,
      defaultTargetLangs,
      speakerCodeHash,
      listenerCodeHash,
      createdAt: Number(input.createdAt || now),
      updatedAt: now,
      status: input.status || 'scheduled'
    };
  }

  function cleanMeta(meta) {
    if (!meta) return null;
    const { speakerCodeHash, listenerCodeHash, ...clean } = meta;
    return clean;
  }

  function windowState(meta, now = Date.now()) {
    if (!meta) return { state: 'open' };
    const early = EARLY_JOIN_MIN * 60 * 1000;
    const grace = GRACE_MIN * 60 * 1000;
    const notYet = meta.startsAt && now + early < meta.startsAt;
    const expired = meta.endsAt && now > meta.endsAt + grace;
    if (notYet) return { state: 'early' };
    if (expired) return { state: 'expired' };
    return { state: 'open' };
  }

  async function upsert(meta, { speakerCode, listenerCode } = {}) {
    const normalized = normalizeMeta({
      ...meta,
      speakerCodeHash: speakerCode ? sha256(speakerCode) : meta?.speakerCodeHash || null,
      listenerCodeHash: listenerCode ? sha256(listenerCode) : meta?.listenerCodeHash || null
    });
    if (!normalized || !normalized.slug) {
      throw new Error('Invalid room meta');
    }
    const ttlMs = Math.max((normalized.endsAt || 0) + GRACE_MIN * 60 * 1000 - Date.now(), 0);
    if (redis) {
      await ensure();
      const payload = JSON.stringify(normalized);
      const k = key('room', normalized.slug, 'meta');
      const pipe = redis.pipeline().set(k, payload);
      if (ttlMs > 0) pipe.pexpire(k, ttlMs);
      await pipe.exec();
    } else if (useFs) {
      await fsLoad();
      memory.set(normalized.slug, normalized);
      await fsSave();
    } else {
      memory.set(normalized.slug, normalized);
    }
    return cleanMeta(normalized);
  }

  async function get(slug) {
    const id = String(slug || '').trim().toLowerCase();
    if (!id) return null;
    if (redis) {
      await ensure();
      const k = key('room', id, 'meta');
      const raw = await redis.get(k);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        logger?.warn?.({ component: 'room-registry', slug: id, err: e?.message }, 'Failed to parse meta');
        return null;
      }
    }
    if (useFs) {
      await fsLoad();
    }
    return memory.get(id) || null;
  }

  async function resolveCode(code) {
    const value = String(code || '').trim();
    if (!value) return null;
    // Heuristic: codes may be <slug>-speaker or <slug> for listener
    const maybeSpeaker = value.toLowerCase().endsWith('-speaker');
    const slugGuess = maybeSpeaker ? value.slice(0, -8) : value;
    const meta = await get(slugGuess);
    if (meta) {
      const hashed = sha256(value);
      const role = hashed === meta.speakerCodeHash ? 'speaker' : hashed === meta.listenerCodeHash ? 'listener' : null;
      if (role) return { slug: meta.slug, role };
    }
    return null;
  }

  async function close() {
    if (redis) {
      try { await redis.quit(); } catch (e) {}
    }
  }

  return {
    upsert,
    get,
    cleanMeta,
    resolveCode,
    windowState,
    close,
    EARLY_JOIN_MIN,
    GRACE_MIN
  };
}

module.exports = {
  createRoomRegistry
};
