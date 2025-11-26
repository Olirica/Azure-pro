const crypto = require('crypto');
const { TranslationBuffer } = require('./translation-buffer');
const { shouldPerformBackwardPeek } = require('./peek-detector');

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

function langBase(lang) {
  return (typeof lang === 'string' ? lang.split('-')[0].toLowerCase() : '');
}

// Lightweight French detector to catch mislabelled segments (e.g., auto-detect returns en-US)
function inferLikelyBase(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  const hasFrenchAccents = /[àâäæçéèêëîïôœùûüÿ]/.test(t);
  const hasFrenchWords = /\b(merci|bonjour|s'il|svp|s'il te plaît|pour|avec|dans|semaine|aujourd'hui|aller|souliers|plais|ceux|mettez|d'accord|min)\b/.test(t);
  if (hasFrenchAccents || hasFrenchWords) return 'fr';
  return '';
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

// Filler words to remove (English + French)
// Toggle via FILTER_FILLER_WORDS=true (enabled by default)
// Customize via FILLER_WORDS_EN and FILLER_WORDS_FR env vars
const FILLER_FILTER_ENABLED = process.env.FILTER_FILLER_WORDS !== 'false';

const DEFAULT_FILLERS_EN = [
  'uh', 'um', 'uhm', 'erm', 'er',
  'you know', 'i mean', 'like',
  'sort of', 'kind of',
  'basically', 'actually', 'literally'
];

const DEFAULT_FILLERS_FR = [
  'euh', 'heu', 'ben', 'bah',
  'tu sais', 'vous savez', 'genre',
  'en fait', 'disons', 'bon'
];

// Build filler lists from env or defaults (only if enabled)
const FILLER_LIST = [];
if (FILLER_FILTER_ENABLED) {
  const customEN = (process.env.FILLER_WORDS_EN || '').split(',').map(w => w.trim()).filter(Boolean);
  const customFR = (process.env.FILLER_WORDS_FR || '').split(',').map(w => w.trim()).filter(Boolean);

  if (customEN.length || customFR.length) {
    FILLER_LIST.push(...customEN, ...customFR);
  } else {
    FILLER_LIST.push(...DEFAULT_FILLERS_EN, ...DEFAULT_FILLERS_FR);
  }
}

const FILLER_PATTERNS_LEADING = new RegExp(
  '^(?:' +
    FILLER_LIST
      .map((p) => p.replace(/\s+/g, '\\s+'))
      .join('|') +
    ')(?:\s|,)+',
  'i'
);

const FILLER_PATTERNS_AFTER_PUNCTUATION = new RegExp(
  '([.!?]\s+)(?:' +
    FILLER_LIST
      .map((p) => p.replace(/\s+/g, '\\s+'))
      .join('|') +
    ')(?:\s|,)+',
  'gi'
);

const FILLER_INLINE_COMMA = new RegExp(
  ',\\s*(?:' + FILLER_LIST.join('|') + ')(?:\\s*,)?',
  'gi'
);

const FILLER_SINGLE_WORD = new RegExp(
  '\\s+(?:' + FILLER_LIST.filter(w => !w.includes(' ')).join('|') + ')\\s+',
  'gi'
);

// Remove comma+filler before sentence-ending punctuation (e.g., "now, um." → "now.")
const FILLER_BEFORE_PUNCT = new RegExp(
  ',\\s*(?:' + FILLER_LIST.join('|') + ')\\s*(?=[.!?])',
  'gi'
);

// Remove filler words directly before sentence-ending punctuation (e.g., "is uh." → "is.")
const FILLER_AT_SENTENCE_END = new RegExp(
  '\\s+(?:' + FILLER_LIST.join('|') + ')(?=[.!?])',
  'gi'
);

// NOTE: TRAILING_CONNECTORS pattern removed - continuation merge handles incomplete segments naturally
// Previously replaced "and." → "..." but this broke merge detection by removing the connector

/**
 * Detect if current segment is a continuation of previous segment.
 * Used for merging truncated segments from aggressive VAD.
 * @param {Object} previous - Previous segment
 * @param {Object} current - Current segment
 * @returns {boolean} True if current should merge with previous
 */
function shouldMergeContinuation(previous, current) {
  if (!previous || !current) {
    return false;
  }

  const prevText = (previous.text || '').trim();
  const currText = (current.text || '').trim();

  if (!prevText || !currText) {
    return false;
  }

  // Condition 1: Previous ends with connector word (with or without period)
  const endsWithConnector = /\s+(so|and|but|or|if|because|since|when|while|as)\.?$/i.test(prevText);

  // Condition 2: Previous has no ending punctuation
  const hasNoEndingPunct = !/[.!?]$/.test(prevText);

  // Condition 3: Current starts with lowercase letter
  const startsLowercase = /^[a-z]/.test(currText);

  // Condition 4: Previous ends with ellipsis (trailing connector was replaced by filler filter)
  // This catches segments like "I'm going to the store..." (was "and." before filtering)
  const endsWithEllipsis = /\.\.\.$/.test(prevText);

  // Return true if ANY condition is met
  return endsWithConnector || hasNoEndingPunct || startsLowercase || endsWithEllipsis;
}

function stripFillerPhrases(text) {
  if (!text || !FILLER_FILTER_ENABLED) {
    return text;
  }
  let result = text;
  let iterations = 0;
  while (FILLER_PATTERNS_LEADING.test(result) && iterations < 5) {
    result = result.replace(FILLER_PATTERNS_LEADING, '');
    iterations += 1;
  }
  result = result.replace(FILLER_PATTERNS_AFTER_PUNCTUATION, (_match, prefix) => prefix);
  result = result.replace(FILLER_BEFORE_PUNCT, '');  // Remove ", um." → "."
  result = result.replace(FILLER_AT_SENTENCE_END, '');  // Remove " uh." → "."
  result = result.replace(FILLER_INLINE_COMMA, ', ');
  result = result.replace(FILLER_SINGLE_WORD, ' ');
  result = result.replace(/\s{2,}/g, ' ');
  result = result.replace(/\s+,/g, ',');
  // REMOVED: TRAILING_CONNECTORS replacement - let continuation merge handle incomplete segments
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
   * @param {Function} [deps.onTranslationReady] - Callback when translations are ready
  */
  constructor({ roomId, logger, translator, metrics, maxUnits = 500, store, onTranslationReady }) {
    this.roomId = roomId;
    this.logger = logger;
    this.translator = translator;
    this.metrics = metrics;
    this.maxUnits = maxUnits;
    this.store = store;
    this.onTranslationReady = onTranslationReady; // Callback for async translations

    this.units = new Map(); // root -> unit state
    this.translationCache = new Map(); // cache key -> result
    this.translationIndex = new Map(); // root -> Set(cacheKey)

    // Context buffer for translation (maintains last N hard segments for gender/pronoun continuity)
    const contextSegments = parseInt(process.env.TRANSLATION_CONTEXT_SEGMENTS, 10) || 2;
    this.contextBuffer = []; // Array of {text, srcLang, unitId}
    this.contextBufferSize = Math.max(1, Math.min(contextSegments, 5)); // Clamp 1-5

    // Backward peek window for gender/pronoun correction
    const peekEnabled = process.env.TRANSLATION_PEEK_ENABLED !== 'false';
    const peekWindowMs = parseInt(process.env.TRANSLATION_PEEK_WINDOW_MS, 10) || 500;
    const peekMaxSegments = parseInt(process.env.TRANSLATION_PEEK_MAX_SEGMENTS, 10) || 2;
    const peekMinConfidence = parseFloat(process.env.TRANSLATION_PEEK_MIN_CONFIDENCE) || 0.7;

    this.peekEnabled = peekEnabled;
    this.peekWindowMs = peekWindowMs;
    this.peekMaxSegments = peekMaxSegments;
    this.peekMinConfidence = peekMinConfidence;
    this.peekableSegments = []; // Array of {segment, targetLangs, timestamp}

    // Continuation merge window for joining truncated segments from aggressive VAD
    const continuationEnabled = process.env.CONTINUATION_MERGE_ENABLED !== 'false';
    const continuationWindowMs = parseInt(process.env.CONTINUATION_WINDOW_MS, 10) || 3000;

    this.continuationEnabled = continuationEnabled;
    this.continuationWindowMs = continuationWindowMs;
    this.continuationWindow = []; // Array of {segment, targetLangs, timestamp}
    this.mergedSegments = new Set(); // Track segments that were merged into previous

    // Initialize translation buffer for intelligent segment merging
    const bufferEnabled = process.env.TRANSLATION_MERGE_ENABLED !== 'false';
    const mergeWindowMs = parseInt(process.env.TRANSLATION_MERGE_WINDOW_MS, 10) || 1500;
    const minMergeChars = parseInt(process.env.TRANSLATION_MIN_MERGE_CHARS, 10) || 50;
    const maxMergeCount = parseInt(process.env.TRANSLATION_MAX_MERGE_COUNT, 10) || 3;

    this.translationBuffer = new TranslationBuffer({
      roomId,
      logger,
      onTranslate: this.executeTranslation.bind(this),
      mergeWindowMs,
      minMergeChars,
      maxMergeCount,
      enabled: bufferEnabled
    });
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
   * Prune expired segments from peek window.
   */
  prunePeekWindow() {
    const now = Date.now();
    this.peekableSegments = this.peekableSegments.filter(
      (entry) => now - entry.timestamp < this.peekWindowMs
    );

    // Also enforce max segments limit
    while (this.peekableSegments.length > this.peekMaxSegments) {
      this.peekableSegments.shift(); // Remove oldest
    }
  }

  /**
   * Perform backward peek to re-translate previous segment with gender context.
   * @param {Object} newSegment - New segment that revealed gender
   * @param {string[]} targetLangs - Target languages
   * @returns {Promise<boolean>} True if peek was performed
   */
  async performBackwardPeek(newSegment, targetLangs) {
    if (!this.peekEnabled || !this.peekableSegments.length) {
      return false;
    }

    // Prune expired segments first
    this.prunePeekWindow();

    if (!this.peekableSegments.length) {
      return false;
    }

    // Check most recent peekable segment (LIFO)
    const lastEntry = this.peekableSegments[this.peekableSegments.length - 1];
    const previousSegment = lastEntry.segment;

    // Use peek detector to determine if we should peek
    const peekDecision = shouldPerformBackwardPeek(newSegment, previousSegment);

    this.logger.debug(
      {
        component: 'segment-processor',
        roomId: this.roomId,
        peekDecision,
        newSegmentText: newSegment.text?.substring(0, 50),
        prevSegmentText: previousSegment.text?.substring(0, 50)
      },
      'Backward peek decision.'
    );

    if (!peekDecision.shouldPeek || peekDecision.confidence < this.peekMinConfidence) {
      return false;
    }

    // Perform backward peek: re-translate previous segment with gender context
    this.logger.info(
      {
        component: 'segment-processor',
        roomId: this.roomId,
        previousUnit: previousSegment.unitId,
        gender: peekDecision.gender,
        confidence: peekDecision.confidence,
        markers: peekDecision.markers
      },
      'Performing backward peek translation revision.'
    );

    // Add gender context to translation prompt
    const genderContext = [`Gender: ${peekDecision.gender}`];

    // Re-translate with gender context
    try {
      const translations = await this.translator.translate(
        this.roomId,
        previousSegment.text,
        previousSegment.srcLang,
        targetLangs,
        genderContext // Pass gender as context
      );

      // Emit revision patches
      const revisionPatches = translations.map((translation) => {
        const sourceLen = previousSegment.text.length;
        const targetLen = translation.text.length;
        const lengthRatio = sourceLen > 0 ? targetLen / sourceLen : 1;
        const isIncomplete = /\.\.\.$/.test(translation.text.trim());

        return {
          unitId: previousSegment.unitId,
          utteranceId: previousSegment.unitId,
          stage: 'hard',
          op: 'translation-revision', // Special op for revisions
          version: previousSegment.version + 1, // Increment version to bypass deduplication
          rev: previousSegment.version + 1,
          text: translation.text,
          srcLang: previousSegment.srcLang,
          targetLang: translation.lang,
          isFinal: true,
          sentLen: {
            src: translation.srcSentLen,
            tgt: translation.transSentLen
          },
          ts: previousSegment.ts,
          revisionReason: 'gender_correction',
          revisionGender: peekDecision.gender,
          revisionConfidence: peekDecision.confidence,
          // Translation quality metadata
          sourceText: previousSegment.text,
          lengthRatio,
          isIncomplete,
          provider: translation.provider || 'azure'
        };
      });

      // Broadcast revision patches
      if (revisionPatches.length && this.onTranslationReady) {
        this.onTranslationReady(revisionPatches);
      }

      // Update cache with revised translations
      for (const translation of translations) {
        this.cacheTranslation(
          previousSegment.unitId,
          previousSegment.version,
          translation.lang,
          translation
        );
      }

      return true;
    } catch (err) {
      this.logger.error(
        {
          component: 'segment-processor',
          roomId: this.roomId,
          err: err?.message
        },
        'Backward peek translation failed.'
      );
      return false;
    }
  }

  /**
   * Prune expired segments from continuation window.
   */
  pruneContinuationWindow() {
    const now = Date.now();
    this.continuationWindow = this.continuationWindow.filter(
      (entry) => now - entry.timestamp < this.continuationWindowMs
    );
  }

  /**
   * Perform continuation merge to join truncated segments from aggressive VAD.
   * Emits immediately, then asynchronously merges via revision patches.
   * @param {Object} newSegment - New segment that may continue previous
   * @param {string[]} targetLangs - Target languages
   * @returns {Promise<boolean>} True if merge was performed
   */
  async performContinuationMerge(newSegment, targetLangs) {
    if (!this.continuationEnabled || !this.continuationWindow.length) {
      return false;
    }

    // Prune expired segments first
    this.pruneContinuationWindow();

    if (!this.continuationWindow.length) {
      return false;
    }

    // Check most recent segment (LIFO)
    const lastEntry = this.continuationWindow[this.continuationWindow.length - 1];
    const previousSegment = lastEntry.segment;

    // Avoid cross-language merges that can duplicate text across streams
    const prevBase = langBase(previousSegment?.srcLang);
    const newBase = langBase(newSegment?.srcLang);
    if (prevBase && newBase && prevBase !== newBase) {
      return false;
    }

    // Use helper to determine if we should merge
    const shouldMerge = shouldMergeContinuation(previousSegment, newSegment);

    this.logger.debug(
      {
        component: 'segment-processor',
        roomId: this.roomId,
        shouldMerge,
        newSegmentText: newSegment.text?.substring(0, 50),
        prevSegmentText: previousSegment.text?.substring(0, 50)
      },
      'Continuation merge decision.'
    );

    if (!shouldMerge) {
      return false;
    }

    // Perform continuation merge: combine texts and re-translate
    this.logger.info(
      {
        component: 'segment-processor',
        roomId: this.roomId,
        previousUnit: previousSegment.unitId,
        currentUnit: newSegment.unitId
      },
      'Performing continuation merge.'
    );

    // Merge texts intelligently
    const prevText = previousSegment.text.trim();
    const currText = newSegment.text.trim();

    // Remove trailing connector/ellipsis from previous, then join
    const cleanedPrev = prevText.replace(/\.\.\.$/g, '').replace(/\s+(so|and|but|or|if|because|since|when|while|as)\.?$/i, ' $1');
    const mergedText = `${cleanedPrev} ${currText}`.trim();

    // Re-translate merged text with context
    try {
      // Gather context (exclude both previous and current from context)
      const contextTexts = this.contextBuffer
        .filter(ctx => ctx.unitId !== previousSegment.unitId && ctx.unitId !== newSegment.unitId)
        .slice(-2)
        .map(ctx => ctx.text);

      const translations = await this.translator.translate(
        this.roomId,
        mergedText,
        previousSegment.srcLang,
        targetLangs,
        contextTexts
      );

      this.logger.info(
        {
          component: 'segment-processor',
          roomId: this.roomId,
          translationCount: translations?.length || 0,
          mergedText: mergedText.substring(0, 50),
          targetLangs
        },
        'Continuation merge: translation completed.'
      );

      // Emit revision patches for PREVIOUS segment with merged text
      const revisionPatches = translations.map((translation) => {
        const sourceLen = mergedText.length;
        const targetLen = translation.text.length;
        const lengthRatio = sourceLen > 0 ? targetLen / sourceLen : 1;
        const isIncomplete = /\.\.\.$/.test(translation.text.trim());

        return {
          unitId: previousSegment.unitId,
          utteranceId: previousSegment.unitId,
          stage: 'hard',
          op: 'translation-revision',
          version: previousSegment.version + 1, // Increment version to bypass deduplication
          rev: previousSegment.version + 1,
          text: translation.text,
          srcLang: previousSegment.srcLang,
          targetLang: translation.lang,
          isFinal: true,
          sentLen: {
            src: translation.srcSentLen,
            tgt: translation.transSentLen
          },
          ts: previousSegment.ts,
          revisionReason: 'continuation_merge',
          mergedWith: newSegment.unitId,
          // Translation quality metadata
          sourceText: mergedText,
          lengthRatio,
          isIncomplete,
          provider: translation.provider || 'azure'
        };
      });

      // Broadcast revision patches
      this.logger.info(
        {
          component: 'segment-processor',
          roomId: this.roomId,
          revisionPatchCount: revisionPatches.length,
          hasCallback: !!this.onTranslationReady
        },
        'Continuation merge: emitting revision patches.'
      );

      if (revisionPatches.length && this.onTranslationReady) {
        this.onTranslationReady(revisionPatches);
        this.logger.info(
          {
            component: 'segment-processor',
            roomId: this.roomId,
            emittedCount: revisionPatches.length
          },
          'Continuation merge: revision patches emitted.'
        );
      }

      // Update cache with merged translations
      for (const translation of translations) {
        this.cacheTranslation(
          previousSegment.unitId,
          previousSegment.version,
          translation.lang,
          translation
        );
      }

      // Mark current segment as merged into previous
      this.mergedSegments.add(newSegment.unitId);

      // Emit suppression patch for current segment
      if (this.onTranslationReady) {
        const suppressionPatches = targetLangs.map((lang) => ({
          unitId: newSegment.unitId,
          utteranceId: newSegment.unitId,
          stage: 'hard',
          op: 'suppress',
          version: newSegment.version,
          rev: newSegment.version,
          text: '',
          srcLang: newSegment.srcLang,
          targetLang: lang,
          isFinal: true,
          ts: newSegment.ts,
          mergedIntoPrevious: previousSegment.unitId,
          suppressReason: 'continuation_merge'
        }));

        this.onTranslationReady(suppressionPatches);
      }

      return true;
    } catch (err) {
      this.logger.error(
        {
          component: 'segment-processor',
          roomId: this.roomId,
          err: err?.message
        },
        'Continuation merge failed.'
      );
      return false;
    }
  }

  /**
   * Execute translation for a segment (called by TranslationBuffer).
   * This is the core translation logic extracted for buffering.
   * @param {Object} segment - Segment with unitId, text, srcLang, etc.
   * @param {string[]} targetLangs - Target languages
   * @returns {Promise<Object[]>} Array of translated patches
   */
  async executeTranslation(segment, targetLangs) {
    const { unitId, text, srcLang, stage, version, ts } = segment;
    const uniqueTargets = Array.from(
      new Set(targetLangs.filter((lang) => lang && lang !== srcLang))
    );

    if (!uniqueTargets.length) {
      return [];
    }

    const translatedPatches = [];

    // Check cache first
    const misses = [];
    for (const lang of uniqueTargets) {
      const cached = this.getCachedTranslation(unitId, version, lang);
      if (cached) {
        const sourceLen = text.length;
        const targetLen = cached.text.length;
        const lengthRatio = sourceLen > 0 ? targetLen / sourceLen : 1;
        const isIncomplete = /\.\.\.$/.test(cached.text.trim());

        translatedPatches.push({
          unitId,
          utteranceId: unitId,
          stage: stage || 'hard',
          op: 'replace',
          version,
          rev: version,
          text: cached.text,
          srcLang,
          targetLang: lang,
          isFinal: stage === 'hard',
          ttsFinal: segment.ttsFinal !== false,
          sentLen: {
            src: cached.srcSentLen,
            tgt: cached.transSentLen
          },
          ts,
          mergedFrom: segment.mergedFrom, // Preserve merge metadata
          // Translation quality metadata
          sourceText: text,
          lengthRatio,
          isIncomplete,
          provider: cached.provider || 'azure'
        });
      } else {
        misses.push(lang);
      }
    }

    // Translate cache misses
    if (misses.length) {
      try {
        // Gather context from recent segments (exclude current segment)
        const contextTexts = this.contextBuffer
          .filter(ctx => ctx.unitId !== unitId) // Exclude current segment
          .slice(-2) // Last 2 segments for context
          .map(ctx => ctx.text);

        const translations = await this.translator.translate(
          this.roomId,
          text,
          srcLang,
          misses,
          contextTexts // Pass context for gender/pronoun continuity
        );
        this.logger.debug(
          {
            component: 'segment-processor',
            unitId,
            translations,
            misses,
            contextSegments: contextTexts.length,
            mergedFrom: segment.mergedFrom
          },
          'Translator response.'
        );
        for (const translation of translations) {
          // Calculate quality metrics
          const sourceLen = text.length;
          const targetLen = translation.text.length;
          const lengthRatio = sourceLen > 0 ? targetLen / sourceLen : 1;
          const isIncomplete = /\.\.\.$/.test(translation.text.trim());

          const payload = {
            unitId,
            utteranceId: unitId,
            stage: stage || 'hard',
            op: 'replace',
            version,
            rev: version,
            text: translation.text,
            srcLang,
            targetLang: translation.lang,
            isFinal: stage === 'hard',
            sentLen: {
              src: translation.srcSentLen,
              tgt: translation.transSentLen
            },
            ts,
            mergedFrom: segment.mergedFrom,
            // Translation quality metadata
            sourceText: text, // Original text for comparison
            lengthRatio,       // Ratio for hallucination detection
            isIncomplete,      // Flags segments ending with "..."
            provider: translation.provider || 'azure' // Which translator was used
          };
          this.cacheTranslation(unitId, version, translation.lang, translation);
          translatedPatches.push({
            ...payload,
            ttsFinal: segment.ttsFinal !== false
          });
        }
      } catch (err) {
        this.logger.error(
          { component: 'segment-processor', roomId: this.roomId, err: err?.message },
          'Translation failed.'
        );
      }
    }

    // Emit translations via callback if we have patches
    if (translatedPatches.length && this.onTranslationReady) {
      this.onTranslationReady(translatedPatches);
    }

    return translatedPatches;
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
          [lang],
          [] // No context for snapshots (late-joining listeners)
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

    // Support both old unitId and new utteranceId formats
    const unitId = patch.utteranceId || patch.unitId;
    const rev = patch.rev ?? patch.version;
    const { stage, text, srcLang, ts, isFinal, ttsFinal } = patch;

    if (!unitId || typeof unitId !== 'string') {
      throw new Error('Patch unitId/utteranceId is required.');
    }

    // Map isFinal to stage if not provided
    const finalStage = isFinal != null ? (isFinal ? 'hard' : 'soft') : stage;
    const version = typeof rev === 'number' ? rev : 0;
    if (!['soft', 'hard'].includes(finalStage)) {
      throw new Error('Patch stage must be "soft" or "hard".');
    }

    // Indicates if this segment is safe to speak (skip fast-finals for TTS)
    const ttsReady = ttsFinal !== false;

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

    // If the text clearly looks French but lang is tagged en-US, treat as French
    const inferredBase = inferLikelyBase(incomingText);
    const incomingBase = langBase(srcLang);
    let normalizedSrcLang = srcLang || existing?.srcLang;
    if (inferredBase && inferredBase !== incomingBase) {
      // Prefer preserving region if existing srcLang shares the inferred base
      const existingBase = langBase(existing?.srcLang);
      if (existingBase === inferredBase) {
        normalizedSrcLang = existing?.srcLang;
      } else {
        normalizedSrcLang = `${inferredBase}-${inferredBase.toUpperCase()}`;
      }
    }

    const mergedText =
      finalStage === 'soft' && existing ? dedupeContinuation(existing.text, incomingText) : incomingText;

    const updatedUnit = {
      unitId,
      root,
      stage: finalStage,
      version,
      text: mergedText,
      srcLang: normalizedSrcLang || existing?.srcLang,
      ts: ts || existing?.ts,
      updatedAt: Date.now(),
      ttsFinal: ttsReady
    };

    if (existing) {
      this.units.delete(root);
    }
    this.units.set(root, updatedUnit);
    this.metrics?.observePatch?.(this.roomId, finalStage, 'accepted');
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
      utteranceId: unitId, // Include both for compatibility
      stage: finalStage,
      op: 'replace',
      version,
      rev: version, // Include both for compatibility
      text: mergedText,
      srcLang: updatedUnit.srcLang,
      isFinal: finalStage === 'hard',
      ttsFinal: ttsReady,
      ts
    };

    const uniqueTargets = Array.from(
      new Set(targetLangs.filter((lang) => lang && lang !== updatedUnit.srcLang))
    );
    this.logger.debug(
      {
        component: 'segment-processor',
        unitId,
        stage: finalStage,
        targetLangs,
        uniqueTargets,
        roomId: this.roomId
      },
      'Processing patch targets.'
    );

    // Route translation through buffer for intelligent merging
    // ONLY translate hard finals (fast-finals + SDK finals)
    // Soft patches are mutable previews that will be superseded - skip translation
    if (uniqueTargets.length && finalStage === 'hard') {
      const segmentForTranslation = {
        unitId,
        text: mergedText,
        srcLang: updatedUnit.srcLang,
        stage: finalStage,
        version,
        ttsFinal: ttsReady,
        ts
      };

      // Perform backward peek to check if previous segment needs gender revision
      // This happens BEFORE translating current segment to avoid race conditions
      await this.performBackwardPeek(segmentForTranslation, uniqueTargets);

      // Perform continuation merge to join truncated segments from aggressive VAD
      // This happens AFTER backward peek to ensure gender corrections are applied first
      await this.performContinuationMerge(segmentForTranslation, uniqueTargets);

      // Add current segment to peekable window for future gender corrections
      this.peekableSegments.push({
        segment: segmentForTranslation,
        targetLangs: uniqueTargets,
        timestamp: Date.now()
      });

      // Add current segment to continuation window for future merges
      this.continuationWindow.push({
        segment: segmentForTranslation,
        targetLangs: uniqueTargets,
        timestamp: Date.now()
      });

      // Prune expired segments from both windows
      this.prunePeekWindow();
      this.pruneContinuationWindow();

      // Track hard segment in context buffer for translation context
      this.contextBuffer.push({
        text: mergedText,
        srcLang: updatedUnit.srcLang,
        unitId
      });

      // Keep only last N segments
      if (this.contextBuffer.length > this.contextBufferSize) {
        this.contextBuffer.shift();
      }

      // Add to buffer (translation happens asynchronously)
      await this.translationBuffer.add(segmentForTranslation, uniqueTargets);
    }

    // Return immediately (translations will be emitted asynchronously)
    return {
      stale: false,
      sourcePatch,
      translatedPatches: [] // Empty - translations happen in buffer
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
