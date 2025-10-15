const crypto = require('crypto');

function normalizeForOverlap(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function longestCommonPrefix(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i += 1;
  }
  return a.slice(0, i);
}

function dedupeContinuation(previous, incoming) {
  const next = (incoming || '').trim();
  if (!previous) {
    return next;
  }
  const prev = previous.trim();
  if (!prev) {
    return next;
  }

  if (next.startsWith(prev)) {
    return next;
  }

  const normPrev = normalizeForOverlap(prev);
  const normNext = normalizeForOverlap(next);

  if (!normPrev || !normNext) {
    return next;
  }

  const prefix = longestCommonPrefix(normPrev, normNext);
  const overlapRatio = prefix.length / Math.max(normPrev.length, 1);

  if (overlapRatio >= 0.8) {
    const suffix = next.slice(prefix.length);
    return `${prev}${suffix}`;
  }

  return next;
}

function rootFromUnitId(unitId) {
  return (unitId || '').split('#')[0];
}

const FILLER_PATTERNS_LEADING = new RegExp(
  '^(?:' +
    [
      'uh',
      'um',
      'uhm',
      'erm',
      'you know',
      'i mean',
      'sort of',
      'kind of'
    ]
      .map((p) => p.replace(/\s+/g, '\\s+'))
      .join('|') +
    ')(?:\s|,)+',
  'i'
);

const FILLER_PATTERNS_AFTER_PUNCTUATION = new RegExp(
  '([.!?]\s+)(?:' +
    [
      'uh',
      'um',
      'uhm',
      'erm',
      'you know',
      'i mean',
      'sort of',
      'kind of'
    ]
      .map((p) => p.replace(/\s+/g, '\\s+'))
      .join('|') +
    ')(?:\s|,)+',
  'gi'
);

const FILLER_INLINE_COMMA = /,\s*(?:uh|um|uhm|erm|you know|i mean)(?:\s*,)?/gi;
const FILLER_SINGLE_WORD = /\s+(?:uh|um|uhm|erm)\s+/gi;

function stripFillerPhrases(text) {
  if (!text) {
    return text;
  }
  let result = text;
  let iterations = 0;
  while (FILLER_PATTERNS_LEADING.test(result) && iterations < 5) {
    result = result.replace(FILLER_PATTERNS_LEADING, '');
    iterations += 1;
  }
  result = result.replace(FILLER_PATTERNS_AFTER_PUNCTUATION, (_match, prefix) => prefix);
  result = result.replace(FILLER_INLINE_COMMA, ', ');
  result = result.replace(FILLER_SINGLE_WORD, ' ');
  result = result.replace(/\s{2,}/g, ' ');
  result = result.replace(/\s+,/g, ',');
  return result.trim();
}

class SegmentProcessor {
  /**
   * @param {Object} deps
   * @param {string} deps.roomId
   * @param {import('pino').Logger} deps.logger
   * @param {{ translate: (roomId: string, text: string, fromLang: string | undefined, targetLangs: string[]) => Promise<Array<{ lang: string, text: string, srcSentLen: number[], transSentLen: number[] }>> }} deps.translator
   * @param {Object} deps.metrics
   * @param {number} [deps.maxUnits=500]
   * @param {{ saveUnit?: Function, removeUnit?: Function }} [deps.store]
  */
  constructor({ roomId, logger, translator, metrics, maxUnits = 500, store }) {
    this.roomId = roomId;
    this.logger = logger;
    this.translator = translator;
    this.metrics = metrics;
    this.maxUnits = maxUnits;
    this.store = store;

    this.units = new Map(); // root -> unit state
    this.translationCache = new Map(); // cache key -> result
    this.translationIndex = new Map(); // root -> Set(cacheKey)
  }

  /**
   * Build a cache key for translations.
   */
  buildCacheKey(unitId, version, lang) {
    const hashedUnit = crypto.createHash('md5').update(unitId).digest('hex').slice(0, 12);
    return `${hashedUnit}:${version}:${lang}`;
  }

  /**
   * Persist the translated text to cache.
   */
  cacheTranslation(unitId, version, lang, payload) {
    const cacheKey = this.buildCacheKey(unitId, version, lang);
    const root = rootFromUnitId(unitId);
    this.translationCache.set(cacheKey, {
      ...payload,
      cachedAt: Date.now()
    });
    if (!this.translationIndex.has(root)) {
      this.translationIndex.set(root, new Set());
    }
    this.translationIndex.get(root).add(cacheKey);
  }

  /**
   * Retrieve cached translation if available.
   */
  getCachedTranslation(unitId, version, lang) {
    return this.translationCache.get(this.buildCacheKey(unitId, version, lang));
  }

  /**
   * Remove cached translations for a unit root.
   * @param {string} root
   */
  clearCacheForRoot(root) {
    const keys = this.translationIndex.get(root);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      this.translationCache.delete(key);
    }
    this.translationIndex.delete(root);
  }

  /**
   * Evict the oldest unit when the in-memory limit is exceeded.
   * @param {string} reason
   */
  enforceUnitLimit(reason = 'lru_evict') {
    const evicted = [];
    if (!this.maxUnits) {
      return evicted;
    }
    while (this.units.size > this.maxUnits) {
      const oldestRoot = this.units.keys().next().value;
      if (!oldestRoot) {
        break;
      }
      const removed = this.units.get(oldestRoot);
      this.units.delete(oldestRoot);
      this.clearCacheForRoot(oldestRoot);
      if (removed) {
        this.metrics?.dropPatch?.(this.roomId, reason);
        evicted.push({ root: oldestRoot, unit: removed });
      }
    }
    return evicted;
  }

  hydrateUnit(unit) {
    if (!unit || !unit.unitId) {
      return;
    }
    const root = rootFromUnitId(unit.unitId);
    if (this.units.has(root)) {
      this.units.delete(root);
    }
    this.units.set(root, unit);
    this.enforceUnitLimit('hydrate_evict');
  }

  /**
   * Return snapshot for listeners joining late.
   * @param {string} [lang]
   */
  async snapshot(lang) {
    const entries = [];
    for (const [, unit] of this.units.entries()) {
      if (!lang || lang === unit.srcLang || lang === 'source') {
        entries.push({
          ...unit,
          op: 'replace',
          targetLang: unit.srcLang
        });
        continue;
      }

      const cached = this.getCachedTranslation(unit.unitId, unit.version, lang);
      if (cached) {
        entries.push({
          unitId: unit.unitId,
          stage: unit.stage,
          op: 'replace',
          version: unit.version,
          text: cached.text,
          srcLang: unit.srcLang,
          targetLang: lang,
          sentLen: {
            src: cached.srcSentLen,
            tgt: cached.transSentLen
          },
          ts: unit.ts
        });
      } else if (this.translator) {
        const results = await this.translator.translate(
          this.roomId,
          unit.text,
          unit.srcLang,
          [lang]
        );
        if (results.length) {
          const translation = results[0];
          this.cacheTranslation(unit.unitId, unit.version, lang, translation);
          entries.push({
            unitId: unit.unitId,
            stage: unit.stage,
            op: 'replace',
            version: unit.version,
            text: translation.text,
            srcLang: unit.srcLang,
            targetLang: lang,
            sentLen: {
              src: translation.srcSentLen,
              tgt: translation.transSentLen
            },
            ts: unit.ts
          });
        }
      }
    }
    return entries;
  }

  /**
   * Process an incoming patch and produce source + translated outputs.
   * @param {Object} patch
   * @param {string[]} targetLangs
   */
  async processPatch(patch, targetLangs = []) {
    if (!patch || typeof patch !== 'object') {
      throw new Error('Patch payload missing or invalid.');
    }

    const { unitId, stage, version, text, srcLang, ts } = patch;
    if (!unitId || typeof unitId !== 'string') {
      throw new Error('Patch unitId is required.');
    }
    if (!['soft', 'hard'].includes(stage)) {
      throw new Error('Patch stage must be "soft" or "hard".');
    }
    if (typeof version !== 'number') {
      throw new Error('Patch version must be a number.');
    }

    const root = rootFromUnitId(unitId);
    const rawText = (text || '').trim();
    const incomingText = stripFillerPhrases(rawText);

    if (!incomingText) {
      this.metrics?.dropPatch?.(this.roomId, 'only_filler');
      return { stale: true, empty: true };
    }
    if (!incomingText) {
      this.metrics?.dropPatch?.(this.roomId, 'empty_text');
      return { stale: true, empty: true };
    }

    const existing = this.units.get(root);
    if (existing && version <= existing.version) {
      this.metrics?.observePatch?.(this.roomId, stage, 'stale');
      this.metrics?.dropPatch?.(this.roomId, 'stale_version');
      return { stale: true };
    }

    const mergedText =
      stage === 'soft' && existing ? dedupeContinuation(existing.text, incomingText) : incomingText;

    const updatedUnit = {
      unitId,
      root,
      stage,
      version,
      text: mergedText,
      srcLang: srcLang || existing?.srcLang,
      ts: ts || existing?.ts,
      updatedAt: Date.now()
    };

    if (existing) {
      this.units.delete(root);
    }
    this.units.set(root, updatedUnit);
    this.metrics?.observePatch?.(this.roomId, stage, 'accepted');
    const evicted = this.enforceUnitLimit();

    if (this.store) {
      try {
        await this.store.saveUnit(this.roomId, updatedUnit);
      } catch (err) {
        this.logger.error(
          { component: 'segment-processor', roomId: this.roomId, err: err?.message },
          'Failed to persist unit to store.'
        );
      }
      if (evicted.length) {
        for (const { root: evictedRoot } of evicted) {
          try {
            await this.store.removeUnit(this.roomId, evictedRoot);
          } catch (err) {
            this.logger.warn(
              { component: 'segment-processor', roomId: this.roomId, err: err?.message },
              'Failed to remove evicted unit from store.'
            );
          }
        }
      }
    }

    const sourcePatch = {
      unitId,
      stage,
      op: 'replace',
      version,
      text: mergedText,
      srcLang: updatedUnit.srcLang,
      ts
    };

    const uniqueTargets = Array.from(
      new Set(targetLangs.filter((lang) => lang && lang !== updatedUnit.srcLang))
    );
    this.logger.debug(
      {
        component: 'segment-processor',
        unitId,
        stage,
        targetLangs,
        uniqueTargets,
        roomId: this.roomId
      },
      'Processing patch targets.'
    );

    const translatedPatches = [];

    if (uniqueTargets.length) {
      const misses = [];
      for (const lang of uniqueTargets) {
        const cached = this.getCachedTranslation(unitId, version, lang);
        if (cached) {
          translatedPatches.push({
            unitId,
            stage,
            op: 'replace',
            version,
            text: cached.text,
            srcLang: updatedUnit.srcLang,
            targetLang: lang,
            sentLen: {
              src: cached.srcSentLen,
              tgt: cached.transSentLen
            },
            ts
          });
        } else {
          misses.push(lang);
        }
      }

      if (misses.length) {
        try {
          const translations = await this.translator.translate(
            this.roomId,
            mergedText,
            updatedUnit.srcLang,
            misses
          );
          this.logger.debug(
            {
              component: 'segment-processor',
              unitId,
              translations,
              misses
            },
            'Translator response.'
          );
          for (const translation of translations) {
            const payload = {
              unitId,
              stage,
              op: 'replace',
              version,
              text: translation.text,
              srcLang: updatedUnit.srcLang,
              targetLang: translation.lang,
              sentLen: {
                src: translation.srcSentLen,
                tgt: translation.transSentLen
              },
              ts
            };
            this.cacheTranslation(unitId, version, translation.lang, translation);
            translatedPatches.push(payload);
          }
        } catch (err) {
          this.logger.error(
            { component: 'segment-processor', roomId: this.roomId, err: err?.message },
            'Translation failed.'
          );
        }
      }
    }

    return {
      stale: false,
      sourcePatch,
      translatedPatches
    };
  }

  reset() {
    this.units.clear();
    this.translationCache.clear();
    this.translationIndex.clear();
  }
}

module.exports = {
  SegmentProcessor
};
