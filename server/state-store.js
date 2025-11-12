const Redis = require('ioredis');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    const buf = await fsp.readFile(file);
    return JSON.parse(String(buf));
  } catch (e) {
    return fallback;
  }
}

function createFsStateStore(baseDir, { logger, maxUnits, maxPatches }) {
  const roomsDir = path.join(baseDir, 'rooms');

  function roomPath(roomId, ...parts) {
    return path.join(roomsDir, roomId, ...parts);
  }

  async function saveUnit(roomId, unit) {
    const root = unit.root || unit.unitId.split('#')[0];
    const unitsFile = roomPath(roomId, 'units.json');
    const orderFile = roomPath(roomId, 'order.json');
    const units = (await readJson(unitsFile, {})) || {};
    const order = (await readJson(orderFile, [])) || [];
    units[root] = unit;
    const updatedAt = unit.updatedAt || Date.now();
    const existingIdx = order.findIndex((e) => e && e.root === root);
    if (existingIdx >= 0) {
      order.splice(existingIdx, 1);
    }
    order.push({ root, t: updatedAt });
    if (maxUnits && order.length > maxUnits) {
      const overflow = order.length - maxUnits;
      const remove = order.splice(0, overflow);
      for (const entry of remove) {
        delete units[entry.root];
      }
    }
    await writeJsonAtomic(unitsFile, units);
    await writeJsonAtomic(orderFile, order);
  }

  async function removeUnit(roomId, root) {
    const unitsFile = roomPath(roomId, 'units.json');
    const orderFile = roomPath(roomId, 'order.json');
    const units = (await readJson(unitsFile, {})) || {};
    const order = (await readJson(orderFile, [])) || [];
    delete units[root];
    const idx = order.findIndex((e) => e && e.root === root);
    if (idx >= 0) order.splice(idx, 1);
    await writeJsonAtomic(unitsFile, units);
    await writeJsonAtomic(orderFile, order);
  }

  async function loadUnits(roomId) {
    const unitsFile = roomPath(roomId, 'units.json');
    const orderFile = roomPath(roomId, 'order.json');
    const units = (await readJson(unitsFile, {})) || {};
    const order = (await readJson(orderFile, [])) || [];
    if (order.length) {
      const list = [];
      for (const entry of order) {
        const unit = units[entry.root];
        if (unit) list.push(unit);
      }
      return list;
    }
    return Object.values(units);
  }

  async function appendPatch(roomId, lang, patch) {
    if (!maxPatches) return;
    const file = roomPath(roomId, 'patches', `${lang}.json`);
    const arr = (await readJson(file, [])) || [];
    arr.push(patch);
    const trimmed = maxPatches > 0 ? arr.slice(-maxPatches) : arr;
    await writeJsonAtomic(file, trimmed);
  }

  async function loadPatches(roomId, lang, limit = maxPatches) {
    const file = roomPath(roomId, 'patches', `${lang}.json`);
    const arr = (await readJson(file, [])) || [];
    if (typeof limit === 'number' && limit > 0) {
      return arr.slice(-limit);
    }
    return arr;
  }

  async function saveTtsQueue(roomId, lang, queueItems) {
    const file = roomPath(roomId, 'tts', `${lang}.json`);
    await writeJsonAtomic(file, queueItems || []);
  }

  async function loadTtsQueue(roomId, lang) {
    const file = roomPath(roomId, 'tts', `${lang}.json`);
    const arr = (await readJson(file, [])) || [];
    return Array.isArray(arr) ? arr : [];
  }

  async function clearTtsQueue(roomId, lang) {
    const file = roomPath(roomId, 'tts', `${lang}.json`);
    try { await fsp.unlink(file); } catch {}
  }

  async function clearRoom(roomId) {
    const dir = roomPath(roomId);
    try {
      if (fs.existsSync(dir)) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    } catch (e) {
      logger?.warn?.({ component: 'state-store', roomId, err: e?.message }, 'Failed to clear room directory.');
    }
  }

  async function close() {
    // nothing to do for FS store
  }

  return {
    type: 'fs',
    client: null,
    saveUnit,
    removeUnit,
    loadUnits,
    appendPatch,
    loadPatches,
    saveTtsQueue,
    loadTtsQueue,
    clearTtsQueue,
    clearRoom,
    close
  };
}

function createStateStore({ logger, maxUnits, maxPatches }) {
  const url = process.env.REDIS_URL;
  const fsDir = process.env.FS_STORE_DIR;

  if (url) {
  const tls =
    (typeof url === 'string' && url.startsWith('rediss://')) || process.env.REDIS_TLS === 'true'
      ? { rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' }
      : undefined;

  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...(tls ? { tls } : {})
  });

    redis.on('error', (err) => {
      logger.error({ component: 'state-store', err: err?.message }, 'Redis error.');
    });

    const prefix = process.env.REDIS_PREFIX || 'polyglot';
    const key = (...parts) => [prefix, ...parts].join(':');

    async function ensure() {
      if (redis.status === 'ready' || redis.status === 'connect') {
        return;
      }
      await redis.connect();
    }

    async function trimUnitOverflow(roomId) {
      if (!maxUnits) {
        return;
      }
      const orderKey = key('room', roomId, 'order');
      const overflow = await redis.zcard(orderKey);
      if (overflow <= maxUnits) {
        return;
      }
      const removeCount = overflow - maxUnits;
      const roots = await redis.zrange(orderKey, 0, removeCount - 1);
      if (!roots.length) {
        return;
      }
      const hashKey = key('room', roomId, 'units');
      const pipeline = redis.pipeline();
      pipeline.zrem(orderKey, ...roots);
      pipeline.hdel(hashKey, ...roots);
      await pipeline.exec();
    }

    async function saveUnit(roomId, unit) {
      await ensure();
      const root = unit.root || unit.unitId.split('#')[0];
      const payload = JSON.stringify(unit);
      const hashKey = key('room', roomId, 'units');
      const orderKey = key('room', roomId, 'order');
      await redis
        .pipeline()
        .hset(hashKey, root, payload)
        .zadd(orderKey, unit.updatedAt || Date.now(), root)
        .exec();
      await trimUnitOverflow(roomId);
    }

    async function removeUnit(roomId, root) {
      await ensure();
      const hashKey = key('room', roomId, 'units');
      const orderKey = key('room', roomId, 'order');
      await redis
        .pipeline()
        .hdel(hashKey, root)
        .zrem(orderKey, root)
        .exec();
    }

    async function loadUnits(roomId) {
      await ensure();
      const orderKey = key('room', roomId, 'order');
      const hashKey = key('room', roomId, 'units');
      const roots = await redis.zrange(orderKey, 0, -1);
      if (!roots.length) {
        return [];
      }
      const pipeline = redis.pipeline();
      for (const root of roots) {
        pipeline.hget(hashKey, root);
      }
      const responses = await pipeline.exec();
      const units = [];
      for (let i = 0; i < roots.length; i += 1) {
        const [, value] = responses[i];
        if (!value) {
          continue;
        }
        try {
          units.push(JSON.parse(value));
        } catch (err) {
          logger.warn(
            { component: 'state-store', roomId, err: err?.message },
            'Failed to parse unit payload from Redis.'
          );
        }
      }
      return units;
    }

    async function appendPatch(roomId, lang, patch) {
      if (!maxPatches) {
        return;
      }
      await ensure();
      const listKey = key('room', roomId, 'patch', lang);
      const payload = JSON.stringify(patch);
      const pipeline = redis
        .pipeline()
        .rpush(listKey, payload)
        .ltrim(listKey, -maxPatches, -1);
      await pipeline.exec();
    }

    async function loadPatches(roomId, lang, limit = maxPatches) {
      await ensure();
      const listKey = key('room', roomId, 'patch', lang);
      const values = await redis.lrange(listKey, -limit, -1);
      const patches = [];
      for (const value of values) {
        try {
          patches.push(JSON.parse(value));
        } catch (err) {
          logger.warn(
            { component: 'state-store', roomId, lang, err: err?.message },
            'Failed to parse stored patch.'
          );
        }
      }
      return patches;
    }

    async function saveTtsQueue(roomId, lang, queueItems) {
      await ensure();
      const keyName = key('room', roomId, 'tts', lang);
      const payload = JSON.stringify(queueItems);
      await redis.set(keyName, payload);
    }

    async function loadTtsQueue(roomId, lang) {
      await ensure();
      const keyName = key('room', roomId, 'tts', lang);
      const payload = await redis.get(keyName);
      if (!payload) {
        return [];
      }
      try {
        const parsed = JSON.parse(payload);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        logger.warn(
          { component: 'state-store', roomId, lang, err: err?.message },
          'Failed to parse TTS queue payload.'
        );
        return [];
      }
    }

    async function clearTtsQueue(roomId, lang) {
      await ensure();
      const keyName = key('room', roomId, 'tts', lang);
      await redis.del(keyName);
    }

    async function clearRoom(roomId) {
      await ensure();
      const pattern = key('room', roomId, '*');
      const keys = await redis.keys(pattern);
      if (keys.length) {
        await redis.del(keys);
      }
    }

    async function close() {
      try {
        await redis.quit();
      } catch (err) {
        logger.warn(
          { component: 'state-store', err: err?.message },
          'Failed to close Redis connection cleanly.'
        );
      }
    }

    return {
      type: 'redis',
      client: redis,
      saveUnit,
      removeUnit,
      loadUnits,
      appendPatch,
      loadPatches,
      saveTtsQueue,
      loadTtsQueue,
      clearTtsQueue,
      clearRoom,
      close
    };
  }

  if (fsDir) {
    const store = createFsStateStore(fsDir, { logger, maxUnits, maxPatches });
    logger.info({ component: 'state-store', dir: fsDir }, 'Using filesystem state store.');
    return store;
  }

  logger.info({ component: 'state-store' }, 'No REDIS_URL/FS_STORE_DIR set – running without persistence.');
  return null;
}

module.exports = {
  createStateStore
};
