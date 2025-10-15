const Redis = require('ioredis');

function createStateStore({ logger, maxUnits, maxPatches }) {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info({ component: 'state-store' }, 'REDIS_URL not set – running without Redis.');
    return null;
  }

  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true
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
    close
  };
}

module.exports = {
  createStateStore
};
