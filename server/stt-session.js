/**
 * STT Session Manager - Server-side speech-to-text with Deepgram
 *
 * Handles:
 * - Deepgram WebSocket connection lifecycle
 * - Audio streaming from browser
 * - Transcript → patch conversion
 * - Language detection and stabilization
 * - Azure fallback on failure
 */

const crypto = require('crypto')
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk')

// Environment configuration
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-2-general'
const DEEPGRAM_PUNCTUATE = process.env.DEEPGRAM_PUNCTUATE !== 'false'
const DEEPGRAM_SMART_FORMAT = process.env.DEEPGRAM_SMART_FORMAT !== 'false'
const DEEPGRAM_UTTERANCE_END_MS = parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS || '1000', 10)
const DEEPGRAM_VAD_EVENTS = process.env.DEEPGRAM_VAD_EVENTS !== 'false'
const DEEPGRAM_INTERIM_RESULTS = process.env.DEEPGRAM_INTERIM_RESULTS !== 'false'

// Language code mapping: Deepgram short codes → full BCP-47 codes
const LANG_CODE_MAP = {
  'en': 'en-US',
  'en-US': 'en-US',
  'en-CA': 'en-CA',
  'en-GB': 'en-GB',
  'en-AU': 'en-AU',
  'fr': 'fr-CA',  // Default French to Canadian for Canoë/Simo use case
  'fr-FR': 'fr-FR',
  'fr-CA': 'fr-CA',
  'es': 'es-ES',
  'es-ES': 'es-ES',
  'es-MX': 'es-MX',
  'de': 'de-DE',
  'it': 'it-IT',
  'pt': 'pt-BR',
  'zh': 'zh-CN',
  'ja': 'ja-JP',
  'ko': 'ko-KR',
}

function mapLangCode(dgLang) {
  if (!dgLang) return null
  const normalized = dgLang.toLowerCase().replace('_', '-')
  return LANG_CODE_MAP[normalized] || LANG_CODE_MAP[normalized.split('-')[0]] || dgLang
}

class SttSession {
  /**
   * @param {Object} config
   * @param {string} config.roomId - Room identifier
   * @param {string} config.sourceLang - Source language ('en-US', 'fr-CA', or 'auto')
   * @param {string[]} config.autoDetectLangs - Candidate languages for auto-detect
   * @param {string[]} config.targetLangs - Target languages for translation
   * @param {string[]} config.phraseHints - Custom vocabulary/keywords
   * @param {Object} processor - SegmentProcessor instance
   * @param {Function} broadcast - Function to broadcast patches
   * @param {Object} logger - Logger instance
   */
  constructor(config, processor, broadcast, logger) {
    this.roomId = config.roomId
    this.sourceLang = config.sourceLang || 'en-US'
    this.autoDetectLangs = config.autoDetectLangs || []
    this.targetLangs = config.targetLangs || []
    this.phraseHints = config.phraseHints || []
    this.processor = processor
    this.broadcast = broadcast
    this.logger = logger || console

    // Session state
    this.sessionId = crypto.randomUUID()
    this.unitIndex = 0
    this.version = 0
    this.currentLang = this.sourceLang !== 'auto' ? this.sourceLang : ''
    this.isAutoDetect = this.sourceLang === 'auto'

    // Deepgram connection
    this.deepgram = null
    this.connection = null
    this.isConnected = false
    this.isStarted = false

    // Language stability tracking (ported from Speaker.tsx)
    this.langStability = {
      current: '',
      detectedAt: 0,
      switchCandidate: null,
      switchCount: 0
    }

    // Fast-finals state (disabled by default for Deepgram)
    this.fastFinalsEnabled = process.env.FASTFINALS_ENABLED_DEEPGRAM === 'true'
    this.sttState = {
      lastText: '',
      committedPrefix: '',
      lastEmitAt: 0
    }

    // Soft patch throttling
    this.lastSoftAt = 0
    this.lastSoftText = ''

    // Flush timeout for silence handling
    this.flushTimeout = null

    // Track pending audio during connection
    this.pendingAudio = []
    this.maxPendingAudio = 50  // Max buffered chunks during connection
  }

  /**
   * Get stable language with persistence (8s lock + 2 consecutive threshold)
   * Ported from Speaker.tsx getStableLanguage()
   */
  getStableLanguage(detected, fallback) {
    if (!this.isAutoDetect || !detected) {
      return fallback
    }

    const now = Date.now()
    const stability = this.langStability

    // Initialize on first detection
    if (!stability.current) {
      stability.current = detected
      stability.detectedAt = now
      return detected
    }

    const timeSinceLock = now - stability.detectedAt
    const lockDurationMs = 8000  // 8 seconds lock

    if (timeSinceLock < lockDurationMs) {
      return stability.current
    }

    // After lock period, require 2 consecutive detections to switch
    if (detected !== stability.current) {
      if (detected === stability.switchCandidate) {
        stability.switchCount++
        const switchThreshold = 2

        if (stability.switchCount >= switchThreshold) {
          stability.current = detected
          stability.detectedAt = now
          stability.switchCandidate = null
          stability.switchCount = 0
          return detected
        }
      } else {
        stability.switchCandidate = detected
        stability.switchCount = 1
      }
      return stability.current
    }

    stability.switchCandidate = null
    stability.switchCount = 0
    return detected
  }

  /**
   * Generate unit ID in the same format as Speaker.tsx
   */
  unitId(lang) {
    return `${this.sessionId}|${lang}|${this.unitIndex}`
  }

  /**
   * Build a patch from Deepgram result
   */
  buildPatch(result, isFinal) {
    const alt = result.channel?.alternatives?.[0]
    if (!alt || !alt.transcript?.trim()) return null

    const text = alt.transcript.trim()
    const words = alt.words || []

    // Compute timestamps from words
    let ts = undefined
    if (words.length > 0) {
      ts = {
        t0: Math.floor(words[0].start * 1000),
        t1: Math.floor(words[words.length - 1].end * 1000)
      }
    }

    // Determine language
    const detectedLang = mapLangCode(result.channel?.detected_language)
    const fallback = this.sourceLang !== 'auto' ? this.sourceLang : 'en-US'
    const stableLang = this.getStableLanguage(detectedLang, fallback)

    if (!this.currentLang) {
      this.currentLang = stableLang
    }
    const langForUnit = this.currentLang || stableLang

    // Build patch
    this.version++
    const patch = {
      unitId: this.unitId(langForUnit),
      version: this.version,
      stage: isFinal ? 'hard' : 'soft',
      text,
      srcLang: langForUnit,
      ts
    }

    // Set ttsFinal for finals
    if (isFinal) {
      // Check if Deepgram marked this as speech_final (end of utterance)
      const isSpeechFinal = result.speech_final === true
      patch.ttsFinal = isSpeechFinal
    }

    return patch
  }

  /**
   * Start the Deepgram connection
   */
  async start() {
    if (this.isStarted) {
      this.logger.warn(`[SttSession:${this.roomId}] Already started`)
      return
    }

    if (!DEEPGRAM_API_KEY) {
      throw new Error('DEEPGRAM_API_KEY not configured')
    }

    this.isStarted = true
    this.logger.info(`[SttSession:${this.roomId}] Starting Deepgram connection`, {
      model: DEEPGRAM_MODEL,
      sourceLang: this.sourceLang,
      isAutoDetect: this.isAutoDetect
    })

    try {
      this.deepgram = createClient(DEEPGRAM_API_KEY)

      // Build Deepgram options
      const options = {
        model: DEEPGRAM_MODEL,
        punctuate: DEEPGRAM_PUNCTUATE,
        smart_format: DEEPGRAM_SMART_FORMAT,
        utterance_end_ms: DEEPGRAM_UTTERANCE_END_MS,
        interim_results: DEEPGRAM_INTERIM_RESULTS,
        vad_events: DEEPGRAM_VAD_EVENTS,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1
      }

      // Language configuration
      if (this.isAutoDetect) {
        options.detect_language = true
      } else {
        // Map full code to Deepgram format
        const dgLang = this.sourceLang.split('-')[0]  // 'en-US' → 'en'
        options.language = dgLang
      }

      // Add keywords/phrase hints if available
      if (this.phraseHints.length > 0) {
        options.keywords = this.phraseHints.map(hint => `${hint}:2`)  // Boost factor
      }

      this.connection = this.deepgram.listen.live(options)

      // Set up event handlers
      this.connection.on(LiveTranscriptionEvents.Open, () => {
        this.logger.info(`[SttSession:${this.roomId}] Deepgram connection opened`)
        this.isConnected = true

        // Send any pending audio
        while (this.pendingAudio.length > 0) {
          const chunk = this.pendingAudio.shift()
          this.connection.send(chunk)
        }
      })

      this.connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
        await this.handleTranscript(data)
      })

      this.connection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
        await this.handleUtteranceEnd()
      })

      this.connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
        this.logger.debug(`[SttSession:${this.roomId}] Speech started`)
        this.clearFlushTimeout()
      })

      this.connection.on(LiveTranscriptionEvents.Error, (err) => {
        this.logger.error(`[SttSession:${this.roomId}] Deepgram error:`, err)
        // TODO: Implement Azure fallback here
      })

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        this.logger.info(`[SttSession:${this.roomId}] Deepgram connection closed`)
        this.isConnected = false
      })

    } catch (err) {
      this.logger.error(`[SttSession:${this.roomId}] Failed to start Deepgram:`, err)
      this.isStarted = false
      throw err
    }
  }

  /**
   * Handle transcript event from Deepgram
   */
  async handleTranscript(data) {
    const isFinal = data.is_final === true
    const alt = data.channel?.alternatives?.[0]

    if (!alt || !alt.transcript?.trim()) return

    this.clearFlushTimeout()
    this.scheduleFlush()

    const patch = this.buildPatch(data, isFinal)
    if (!patch) return

    if (isFinal) {
      // Final transcript
      await this.emitPatch(patch)

      // If speech_final, advance to next unit
      if (data.speech_final) {
        this.advanceUnit()
      }
    } else {
      // Interim result - emit as soft patch with throttling
      const now = Date.now()
      const textDelta = patch.text.length - this.lastSoftText.length
      const timeOk = now - this.lastSoftAt > 700  // 700ms throttle
      const charOk = textDelta > 12

      if ((charOk || /[.?!]\s*$/.test(patch.text)) && timeOk) {
        this.lastSoftText = patch.text
        this.lastSoftAt = now
        await this.emitPatch(patch)
      }
    }
  }

  /**
   * Handle utterance end event
   */
  async handleUtteranceEnd() {
    this.logger.debug(`[SttSession:${this.roomId}] Utterance end`)

    // If there's uncommitted text, flush it
    if (this.sttState.lastText && this.sttState.lastText.length > this.sttState.committedPrefix.length) {
      const text = this.sttState.lastText.trim()
      if (text) {
        this.version++
        const langForUnit = this.currentLang || this.sourceLang
        const patch = {
          unitId: this.unitId(langForUnit),
          version: this.version,
          stage: 'hard',
          text,
          srcLang: langForUnit,
          ttsFinal: true
        }
        await this.emitPatch(patch)
        this.advanceUnit()
      }
    }
  }

  /**
   * Emit a patch through the processor and broadcast
   */
  async emitPatch(patch) {
    try {
      const result = await this.processor.processPatch(patch, this.targetLangs)
      if (!result.stale) {
        await this.broadcast(result)
      }
    } catch (err) {
      this.logger.error(`[SttSession:${this.roomId}] Failed to emit patch:`, err)
    }
  }

  /**
   * Advance to the next unit
   */
  advanceUnit() {
    this.unitIndex++
    this.version = 0
    this.currentLang = ''
    this.lastSoftText = ''
    this.lastSoftAt = Date.now()
    this.sttState = { lastText: '', committedPrefix: '', lastEmitAt: 0 }
    this.clearFlushTimeout()
  }

  /**
   * Schedule a flush timeout for silence handling
   */
  scheduleFlush() {
    this.flushTimeout = setTimeout(async () => {
      // Flush uncommitted text after 4 seconds of silence
      if (this.sttState.lastText && this.sttState.lastText.length > this.sttState.committedPrefix.length) {
        const text = this.sttState.lastText.trim()
        if (text) {
          this.version++
          const langForUnit = this.currentLang || this.sourceLang
          const patch = {
            unitId: this.unitId(langForUnit),
            version: this.version,
            stage: 'hard',
            text,
            srcLang: langForUnit,
            ttsFinal: true
          }
          await this.emitPatch(patch)
          this.sttState.committedPrefix = text
          this.sttState.lastEmitAt = Date.now()
        }
      }
    }, 4000)
  }

  /**
   * Clear the flush timeout
   */
  clearFlushTimeout() {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout)
      this.flushTimeout = null
    }
  }

  /**
   * Feed audio data to Deepgram
   * @param {Buffer} audioData - PCM audio data (16kHz, mono, 16-bit)
   */
  feedAudio(audioData) {
    if (!this.isStarted) {
      this.logger.warn(`[SttSession:${this.roomId}] Cannot feed audio - session not started`)
      return
    }

    if (!this.isConnected) {
      // Buffer audio during connection
      if (this.pendingAudio.length < this.maxPendingAudio) {
        this.pendingAudio.push(audioData)
      }
      return
    }

    try {
      this.connection.send(audioData)
    } catch (err) {
      this.logger.error(`[SttSession:${this.roomId}] Failed to send audio:`, err)
    }
  }

  /**
   * Update configuration mid-session
   */
  updateConfig(config) {
    if (config.targetLangs) {
      this.targetLangs = config.targetLangs
    }
    if (config.phraseHints) {
      this.phraseHints = config.phraseHints
      // Note: Deepgram doesn't support updating keywords mid-session
      // Would need to reconnect to apply new keywords
    }
  }

  /**
   * Stop the session
   */
  async stop() {
    this.logger.info(`[SttSession:${this.roomId}] Stopping session`)

    this.clearFlushTimeout()
    this.isStarted = false
    this.isConnected = false
    this.pendingAudio = []

    if (this.connection) {
      try {
        this.connection.finish()
      } catch (err) {
        this.logger.error(`[SttSession:${this.roomId}] Error closing connection:`, err)
      }
      this.connection = null
    }

    this.deepgram = null
  }

  /**
   * Dispose of the session
   */
  dispose() {
    this.stop()
  }
}

/**
 * Create a new STT session
 */
function createSttSession(config, processor, broadcast, logger) {
  return new SttSession(config, processor, broadcast, logger)
}

/**
 * Check if Deepgram is configured
 */
function isDeepgramConfigured() {
  return !!DEEPGRAM_API_KEY
}

module.exports = {
  SttSession,
  createSttSession,
  isDeepgramConfigured,
  mapLangCode
}
