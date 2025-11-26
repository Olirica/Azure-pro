/**
 * TranslationBuffer: Intelligent segment merging for better translation context.
 *
 * Strategy:
 * - Display layer: Fast-finals emit immediately to speaker (low latency)
 * - Translation layer: Buffer segments briefly to merge related content
 * - Result: Fast display + high-quality translations with full context
 */

class TranslationBuffer {
  /**
   * @param {Object} deps
   * @param {string} deps.roomId
   * @param {import('pino').Logger} deps.logger
   * @param {Function} deps.onTranslate - Callback when buffer is ready: (mergedSegment, targetLangs) => Promise
   * @param {number} [deps.mergeWindowMs=1500] - How long to wait for next segment
   * @param {number} [deps.minMergeChars=50] - Minimum chars to justify merging
   * @param {number} [deps.maxMergeCount=3] - Maximum segments to merge together
   * @param {boolean} [deps.enabled=true] - Enable/disable buffering
   */
  constructor({ roomId, logger, onTranslate, mergeWindowMs = 1100, minMergeChars = 40, maxMergeCount = 3, enabled = true }) {
    this.roomId = roomId;
    this.logger = logger;
    this.onTranslate = onTranslate;
    this.mergeWindowMs = mergeWindowMs;
    this.minMergeChars = minMergeChars;
    this.maxMergeCount = maxMergeCount;
    this.enabled = enabled;

    // Buffering state
    this.pendingSegments = []; // Array of { segment, targetLangs, timestamp }
    this.flushTimer = null;
    this.processing = false;
  }

  /**
   * Add a segment to the buffer for potential merging.
   * @param {Object} segment - The source segment with text, unitId, etc.
   * @param {string[]} targetLangs - Target languages for translation
   */
  async add(segment, targetLangs) {
    // If buffering disabled, translate immediately
    if (!this.enabled) {
      this.logger.debug(
        { component: 'translation-buffer', roomId: this.roomId },
        'Buffering disabled, translating immediately'
      );
      await this.onTranslate(segment, targetLangs);
      return;
    }

    // Add to pending buffer
    this.pendingSegments.push({
      segment,
      targetLangs,
      timestamp: Date.now()
    });

    this.logger.debug(
      {
        component: 'translation-buffer',
        roomId: this.roomId,
        unitId: segment.unitId,
        bufferSize: this.pendingSegments.length,
        text: segment.text?.substring(0, 50)
      },
      'Segment added to translation buffer'
    );

    // Clear existing timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    // Check if we should flush immediately (max segments reached)
    if (this.pendingSegments.length >= this.maxMergeCount) {
      this.logger.debug(
        { component: 'translation-buffer', roomId: this.roomId, count: this.pendingSegments.length },
        'Max merge count reached, flushing buffer'
      );
      await this.flush();
      return;
    }

    // Schedule flush after merge window
    this.flushTimer = setTimeout(() => {
      this.flush().catch((err) => {
        this.logger.error(
          { component: 'translation-buffer', roomId: this.roomId, err: err?.message },
          'Buffer flush failed'
        );
      });
    }, this.mergeWindowMs);
  }

  /**
   * Flush the buffer and translate merged segments.
   */
  async flush() {
    if (this.processing || this.pendingSegments.length === 0) {
      return;
    }

    this.processing = true;

    try {
      // Clear timer
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      // Take all pending segments
      const toProcess = [...this.pendingSegments];
      this.pendingSegments = [];

      // Decision: merge or translate individually?
      const shouldMerge = this.shouldMergeSegments(toProcess);

      if (shouldMerge && toProcess.length > 1) {
        await this.translateMerged(toProcess);
      } else {
        await this.translateIndividually(toProcess);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Decide if segments should be merged based on heuristics.
   * @param {Array} segments
   * @returns {boolean}
   */
  shouldMergeSegments(segments) {
    if (segments.length < 2) {
      return false;
    }

    // Check if segments are temporally close
    const first = segments[0];
    const last = segments[segments.length - 1];
    const timeDelta = last.timestamp - first.timestamp;

    // If segments arrived within merge window, merge them
    if (timeDelta <= this.mergeWindowMs) {
      const totalChars = segments.reduce((sum, s) => sum + (s.segment.text?.length || 0), 0);

      // Only merge if result is substantial enough
      if (totalChars >= this.minMergeChars) {
        this.logger.debug(
          {
            component: 'translation-buffer',
            roomId: this.roomId,
            segmentCount: segments.length,
            totalChars,
            timeDelta
          },
          'Merging segments for better translation context'
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Merge segments and translate as a single unit.
   * @param {Array} segments
   */
  async translateMerged(segments) {
    // Merge text from all segments
    const mergedText = segments
      .map(s => (s.segment.text || '').trim())
      .filter(Boolean)
      .join(' ');

    if (!mergedText) {
      return;
    }

    // Use the first segment as the base, but with merged text
    const baseSegment = segments[0].segment;
    const mergedSegment = {
      ...baseSegment,
      text: mergedText,
      unitId: `${baseSegment.unitId}#merged`, // Mark as merged
      mergedFrom: segments.map(s => s.segment.unitId),
      mergedCount: segments.length,
      // Allow TTS only if any of the merged parts were marked TTS-safe
      ttsFinal: segments.some(s => s.segment?.ttsFinal !== false)
    };

    // Get union of all target languages
    const allTargetLangs = new Set();
    for (const { targetLangs } of segments) {
      for (const lang of targetLangs) {
        allTargetLangs.add(lang);
      }
    }

    this.logger.info(
      {
        component: 'translation-buffer',
        roomId: this.roomId,
        mergedCount: segments.length,
        mergedChars: mergedText.length,
        targetLangs: Array.from(allTargetLangs)
      },
      'Translating merged segment'
    );

    // Translate the merged segment
    await this.onTranslate(mergedSegment, Array.from(allTargetLangs));
  }

  /**
   * Translate segments individually (fallback).
   * @param {Array} segments
   */
  async translateIndividually(segments) {
    this.logger.debug(
      {
        component: 'translation-buffer',
        roomId: this.roomId,
        count: segments.length
      },
      'Translating segments individually'
    );

    for (const { segment, targetLangs } of segments) {
      await this.onTranslate(segment, targetLangs);
    }
  }

  /**
   * Shutdown the buffer and flush any pending segments.
   */
  async shutdown() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

module.exports = {
  TranslationBuffer
};
