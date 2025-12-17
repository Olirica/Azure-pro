/**
 * LocalWhisperSession - Server-side STT with local faster-whisper
 *
 * Connects to the Python whisper-svc via Unix socket (local) or TCP (Railway).
 * Same interface as SttSession (Deepgram) for drop-in replacement.
 *
 * Connection modes:
 * - Unix socket: Set WHISPER_SOCKET_PATH (default: /tmp/whisper-stt.sock)
 * - TCP socket: Set WHISPER_TCP_HOST and WHISPER_TCP_PORT
 */

const net = require('net')
const crypto = require('crypto')
const metrics = require('./metrics')

// Connection configuration
const WHISPER_SOCKET_PATH = process.env.WHISPER_SOCKET_PATH || '/tmp/whisper-stt.sock'
const WHISPER_TCP_HOST = process.env.WHISPER_TCP_HOST || ''
const WHISPER_TCP_PORT = process.env.WHISPER_TCP_PORT ? parseInt(process.env.WHISPER_TCP_PORT, 10) : 0

// Use TCP if host and port are configured
const USE_TCP = !!(WHISPER_TCP_HOST && WHISPER_TCP_PORT)

const PROVIDER_NAME = 'local-whisper'

// Language code mapping: BCP-47 → Whisper short codes
const LANG_CODE_MAP = {
  'en-US': 'en',
  'en-CA': 'en',
  'en-GB': 'en',
  'en-AU': 'en',
  'fr-FR': 'fr',
  'fr-CA': 'fr',
  'es-ES': 'es',
  'es-MX': 'es',
  'de-DE': 'de',
  'it-IT': 'it',
  'pt-BR': 'pt',
  'zh-CN': 'zh',
  'ja-JP': 'ja',
  'ko-KR': 'ko',
}

// Reverse mapping: Whisper short codes → BCP-47
const REVERSE_LANG_MAP = {
  'en': 'en-US',
  'fr': 'fr-CA',  // Default French to Canadian for Canoë
  'es': 'es-ES',
  'de': 'de-DE',
  'it': 'it-IT',
  'pt': 'pt-BR',
  'zh': 'zh-CN',
  'ja': 'ja-JP',
  'ko': 'ko-KR',
}

function mapToWhisperLang(bcp47) {
  if (!bcp47) return null
  return LANG_CODE_MAP[bcp47] || bcp47.split('-')[0]
}

function mapFromWhisperLang(whisperLang) {
  if (!whisperLang) return 'en-US'
  return REVERSE_LANG_MAP[whisperLang] || `${whisperLang}-${whisperLang.toUpperCase()}`
}

class LocalWhisperSession {
  /**
   * @param {Object} config
   * @param {string} config.roomId - Room identifier
   * @param {string} config.sourceLang - Source language ('en-US', 'fr-CA', or 'auto')
   * @param {string[]} config.autoDetectLangs - Candidate languages for auto-detect
   * @param {string[]} config.targetLangs - Target languages for translation
   * @param {string[]} config.phraseHints - Custom vocabulary/keywords
   * @param {string} config.sttPrompt - Domain prompt for transcription style/vocabulary
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
    this.sttPrompt = config.sttPrompt || ''
    this.processor = processor
    this.broadcast = broadcast
    this.logger = logger || console

    // Session state
    this.sessionId = crypto.randomUUID()
    this.unitIndex = 0
    this.version = 0
    this.currentLang = this.sourceLang !== 'auto' ? this.sourceLang : ''
    this.isAutoDetect = this.sourceLang === 'auto'

    // Socket connection
    this.socket = null
    this.isConnected = false
    this.isStarted = false

    // Buffer for incomplete JSON lines
    this.lineBuffer = ''

    // Pending audio during connection
    this.pendingAudio = []
    this.maxPendingAudio = 50

    // Soft patch throttling
    this.lastSoftAt = 0
    this.lastSoftText = ''

    // Metrics
    this.audioStartTime = null
    this.firstPartialAt = null
    this.firstFinalAt = null
  }

  /**
   * Generate unit ID in the same format as Speaker.tsx
   */
  unitId(lang) {
    return `${this.sessionId}|${lang}|${this.unitIndex}`
  }

  /**
   * Start the session - connect to whisper service
   */
  async start() {
    if (this.isStarted) {
      this.logger.warn(`[LocalWhisper:${this.roomId}] Already started`)
      return
    }

    this.isStarted = true
    this.audioStartTime = Date.now()
    metrics.recordSttSession(this.roomId, PROVIDER_NAME)

    const connectionInfo = USE_TCP
      ? { mode: 'tcp', host: WHISPER_TCP_HOST, port: WHISPER_TCP_PORT }
      : { mode: 'unix', socketPath: WHISPER_SOCKET_PATH }

    this.logger.info(`[LocalWhisper:${this.roomId}] Connecting to whisper service`, {
      ...connectionInfo,
      sourceLang: this.sourceLang,
      isAutoDetect: this.isAutoDetect
    })

    return new Promise((resolve, reject) => {
      // Connect via TCP or Unix socket
      if (USE_TCP) {
        this.socket = net.createConnection({ host: WHISPER_TCP_HOST, port: WHISPER_TCP_PORT })
      } else {
        this.socket = net.createConnection(WHISPER_SOCKET_PATH)
      }

      this.socket.on('connect', () => {
        this.logger.info(`[LocalWhisper:${this.roomId}] Connected to whisper service`)
        this.isConnected = true

        // Send START command
        const startCmd = JSON.stringify({
          cmd: 'START',
          session_id: this.sessionId,
          source_lang: this.sourceLang,
          auto_detect_langs: this.autoDetectLangs,
          phrase_hints: this.phraseHints,
          initial_prompt: this.sttPrompt || undefined,
        })
        this.socket.write(startCmd + '\n')

        // Send any pending audio
        while (this.pendingAudio.length > 0) {
          const chunk = this.pendingAudio.shift()
          this._sendAudio(chunk)
        }

        resolve()
      })

      this.socket.on('data', (data) => {
        this._handleData(data)
      })

      this.socket.on('error', (err) => {
        this.logger.error(`[LocalWhisper:${this.roomId}] Socket error:`, err)
        if (!this.isConnected) {
          reject(err)
        }
      })

      this.socket.on('close', () => {
        this.logger.info(`[LocalWhisper:${this.roomId}] Socket closed`)
        this.isConnected = false
      })

      // Timeout for connection
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Connection timeout'))
        }
      }, 5000)
    })
  }

  /**
   * Handle incoming data from the socket
   */
  _handleData(data) {
    this.lineBuffer += data.toString()

    // Process complete lines
    const lines = this.lineBuffer.split('\n')
    this.lineBuffer = lines.pop() // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const msg = JSON.parse(line)
        this._handleMessage(msg)
      } catch (err) {
        this.logger.warn(`[LocalWhisper:${this.roomId}] Invalid JSON:`, line)
      }
    }
  }

  /**
   * Handle a parsed message from the whisper service
   */
  async _handleMessage(msg) {
    if (msg.type === 'READY') {
      this.logger.info(`[LocalWhisper:${this.roomId}] Session ready`)
      return
    }

    if (msg.type === 'ERROR') {
      this.logger.error(`[LocalWhisper:${this.roomId}] Service error:`, msg.error)
      return
    }

    if (msg.type === 'PARTIAL') {
      await this._handlePartial(msg)
    } else if (msg.type === 'FINAL') {
      await this._handleFinal(msg)
    }
  }

  /**
   * Handle PARTIAL response (soft patch)
   */
  async _handlePartial(msg) {
    const now = Date.now()

    // Track TTFT
    if (!this.firstPartialAt) {
      this.firstPartialAt = now
      const ttft = now - this.audioStartTime
      this.logger.info(`[LocalWhisper:${this.roomId}] TTFT: ${ttft}ms`)
      metrics.observeSttTtft(this.roomId, PROVIDER_NAME, ttft / 1000)
    }

    // Throttle soft patches (700ms, 12 char delta)
    const textDelta = msg.text.length - this.lastSoftText.length
    const timeSinceLast = now - this.lastSoftAt
    const shouldEmit = (textDelta > 12 || /[.?!]\s*$/.test(msg.text)) && timeSinceLast > 700

    if (!shouldEmit) return

    this.lastSoftText = msg.text
    this.lastSoftAt = now

    const srcLang = mapFromWhisperLang(msg.language)
    if (!this.currentLang) {
      this.currentLang = srcLang
    }

    this.version++
    const patch = {
      unitId: this.unitId(this.currentLang || srcLang),
      version: this.version,
      stage: 'soft',
      text: msg.text,
      srcLang: this.currentLang || srcLang,
    }

    await this._emitPatch(patch)
  }

  /**
   * Handle FINAL response (hard patch)
   */
  async _handleFinal(msg) {
    const now = Date.now()

    // Track TTFC
    if (!this.firstFinalAt) {
      this.firstFinalAt = now
      const ttfc = now - this.audioStartTime
      this.logger.info(`[LocalWhisper:${this.roomId}] TTFC: ${ttfc}ms`)
      metrics.observeSttTtfc(this.roomId, PROVIDER_NAME, ttfc / 1000)
    }

    const srcLang = mapFromWhisperLang(msg.language)
    if (!this.currentLang) {
      this.currentLang = srcLang
    }

    // Build timestamps from words if available
    let ts = undefined
    if (msg.words && msg.words.length > 0) {
      ts = {
        t0: Math.floor(msg.words[0].start * 1000),
        t1: Math.floor(msg.words[msg.words.length - 1].end * 1000),
      }
    }

    this.version++
    const patch = {
      unitId: this.unitId(this.currentLang || srcLang),
      version: this.version,
      stage: 'hard',
      text: msg.text,
      srcLang: this.currentLang || srcLang,
      ts,
      ttsFinal: msg.tts_final || false,
    }

    await this._emitPatch(patch)

    // Advance unit if this was a TTS final
    if (msg.tts_final) {
      this.unitIndex++
      this.version = 0
      this.currentLang = ''
      this.lastSoftText = ''
      this.lastSoftAt = Date.now()
    }
  }

  /**
   * Emit a patch through the processor and broadcast
   */
  async _emitPatch(patch) {
    try {
      const result = await this.processor.processPatch(patch, this.targetLangs)
      if (!result.stale) {
        await this.broadcast(result)
      }
    } catch (err) {
      this.logger.error(`[LocalWhisper:${this.roomId}] Failed to emit patch:`, err)
    }
  }

  /**
   * Feed audio data to the whisper service
   * @param {Buffer} audioData - PCM audio data (16kHz, mono, 16-bit)
   */
  feedAudio(audioData) {
    if (!this.isStarted) {
      this.logger.warn(`[LocalWhisper:${this.roomId}] Cannot feed audio - session not started`)
      return
    }

    if (!this.isConnected) {
      // Buffer audio during connection
      if (this.pendingAudio.length < this.maxPendingAudio) {
        this.pendingAudio.push(audioData)
      }
      return
    }

    this._sendAudio(audioData)
  }

  /**
   * Send audio to the whisper service
   */
  _sendAudio(audioData) {
    if (!this.socket || !this.isConnected) return

    const audioCmd = JSON.stringify({
      cmd: 'AUDIO',
      session_id: this.sessionId,
      pcm_b64: audioData.toString('base64'),
    })

    try {
      this.socket.write(audioCmd + '\n')
    } catch (err) {
      this.logger.error(`[LocalWhisper:${this.roomId}] Failed to send audio:`, err)
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
    }
  }

  /**
   * Stop the session
   */
  async stop() {
    this.logger.info(`[LocalWhisper:${this.roomId}] Stopping session`)

    if (this.socket && this.isConnected) {
      // Send STOP command
      const stopCmd = JSON.stringify({
        cmd: 'STOP',
        session_id: this.sessionId,
      })

      try {
        this.socket.write(stopCmd + '\n')
        // Give service time to flush
        await new Promise(resolve => setTimeout(resolve, 100))
      } catch (err) {
        this.logger.error(`[LocalWhisper:${this.roomId}] Error sending STOP:`, err)
      }

      this.socket.end()
    }

    this.isStarted = false
    this.isConnected = false
    this.pendingAudio = []
    this.socket = null
  }

  /**
   * Dispose of the session
   */
  dispose() {
    this.stop()
  }

  /**
   * Get metrics for this session
   */
  getMetrics() {
    return {
      ttft_ms: this.firstPartialAt ? this.firstPartialAt - this.audioStartTime : null,
      ttfc_ms: this.firstFinalAt ? this.firstFinalAt - this.audioStartTime : null,
      unit_count: this.unitIndex,
      total_patches: this.version,
    }
  }
}

/**
 * Create a new local whisper STT session
 */
function createLocalWhisperSession(config, processor, broadcast, logger) {
  return new LocalWhisperSession(config, processor, broadcast, logger)
}

/**
 * Check if the whisper service is available
 */
async function isWhisperServiceAvailable() {
  return new Promise((resolve) => {
    let socket

    // Connect via TCP or Unix socket
    if (USE_TCP) {
      socket = net.createConnection({ host: WHISPER_TCP_HOST, port: WHISPER_TCP_PORT })
    } else {
      socket = net.createConnection(WHISPER_SOCKET_PATH)
    }

    socket.on('connect', () => {
      socket.end()
      resolve(true)
    })

    socket.on('error', () => {
      resolve(false)
    })

    setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1000)
  })
}

module.exports = {
  LocalWhisperSession,
  createLocalWhisperSession,
  isWhisperServiceAvailable,
  mapToWhisperLang,
  mapFromWhisperLang,
}
