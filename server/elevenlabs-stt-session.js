/**
 * ElevenLabs STT Session - Server-side speech-to-text with Scribe Realtime v2
 *
 * Handles:
 * - ElevenLabs WebSocket connection lifecycle
 * - Audio streaming from browser (PCM → base64)
 * - Transcript → patch conversion
 * - Language detection (automatic)
 */

const crypto = require('crypto')
const WebSocket = require('ws')

// Environment configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v2_realtime'

// Language code mapping: ElevenLabs short codes → full BCP-47 codes
const LANG_CODE_MAP = {
  'en': 'en-US',
  'en-US': 'en-US',
  'en-CA': 'en-CA',
  'en-GB': 'en-GB',
  'en-AU': 'en-AU',
  'fr': 'fr-CA',
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

function mapLangCode(elLang) {
  if (!elLang) return null
  const normalized = elLang.toLowerCase().replace('_', '-')
  return LANG_CODE_MAP[normalized] || LANG_CODE_MAP[normalized.split('-')[0]] || elLang
}

// Common words/patterns for language detection
const FRENCH_PATTERNS = [
  /\b(je|tu|il|elle|nous|vous|ils|elles|on)\b/i,
  /\b(le|la|les|un|une|des|du|de|au|aux)\b/i,
  /\b(est|sont|était|était|être|avoir|fait|fait)\b/i,
  /\b(que|qui|quoi|dont|où|quand|comment|pourquoi)\b/i,
  /\b(ne|pas|plus|jamais|rien|personne)\b/i,
  /\b(mais|donc|car|parce|puisque|alors|ainsi)\b/i,
  /\b(avec|sans|pour|dans|sur|sous|entre)\b/i,
  /\b(très|bien|mal|peu|beaucoup|trop|assez)\b/i,
  /\b(bonjour|merci|s'il|c'est|n'est|j'espère|aujourd'hui)\b/i,
  /[àâäéèêëïîôùûüç]/i,
]

const ENGLISH_PATTERNS = [
  /\b(I|you|he|she|it|we|they)\b/,
  /\b(the|a|an|this|that|these|those)\b/i,
  /\b(is|are|was|were|be|been|being|have|has|had)\b/i,
  /\b(do|does|did|will|would|could|should|can|may|might)\b/i,
  /\b(what|who|where|when|why|how|which)\b/i,
  /\b(not|no|never|nothing|nobody|none)\b/i,
  /\b(and|but|or|so|because|if|then|than)\b/i,
  /\b(with|without|for|from|to|at|in|on|by)\b/i,
  /\b(very|well|good|bad|much|many|few|little)\b/i,
  /\b(hello|thanks|please|everyone|doing|week|team)\b/i,
]

/**
 * Detect language from text content
 * Returns 'fr' or 'en' based on pattern matching
 */
function detectLanguageFromText(text) {
  if (!text || text.length < 3) return null

  let frenchScore = 0
  let englishScore = 0

  for (const pattern of FRENCH_PATTERNS) {
    const matches = text.match(new RegExp(pattern, 'gi'))
    if (matches) frenchScore += matches.length
  }

  for (const pattern of ENGLISH_PATTERNS) {
    const matches = text.match(new RegExp(pattern, 'gi'))
    if (matches) englishScore += matches.length
  }

  // Require a minimum score difference to be confident
  if (frenchScore > englishScore && frenchScore >= 2) return 'fr'
  if (englishScore > frenchScore && englishScore >= 2) return 'en'

  // Default to null if uncertain
  return null
}

class ElevenLabsSttSession {
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

    // ElevenLabs connection
    this.ws = null
    this.isConnected = false
    this.isStarted = false

    // Language stability tracking
    this.langStability = {
      current: '',
      detectedAt: 0,
      switchCandidate: null,
      switchCount: 0
    }

    // Track current partial transcript
    this.currentPartial = ''
    this.lastPartialAt = 0

    // Soft patch throttling
    this.lastSoftAt = 0
    this.lastSoftText = ''

    // Track pending audio during connection
    this.pendingAudio = []
    this.maxPendingAudio = 50

    // Audio stats for debugging
    this.audioStats = null

    this.limitations = []
  }

  getStableLanguage(detected, fallback) {
    if (!this.isAutoDetect || !detected) {
      return fallback
    }

    const now = Date.now()
    const stability = this.langStability

    if (!stability.current) {
      stability.current = detected
      stability.detectedAt = now
      return detected
    }

    const timeSinceLock = now - stability.detectedAt
    const lockDurationMs = 8000

    if (timeSinceLock < lockDurationMs) {
      return stability.current
    }

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

  unitId(lang) {
    return `${this.sessionId}|${lang}|${this.unitIndex}`
  }

  buildPatch(text, detectedLang, isFinal, timestamps) {
    if (!text?.trim()) return null

    const cleanText = text.trim()
    detectedLang = mapLangCode(detectedLang)

    const fallback = this.sourceLang !== 'auto' ? this.sourceLang : 'en-US'
    const stableLang = this.getStableLanguage(detectedLang, fallback)

    if (isFinal && detectedLang) {
      this.logger.debug(`[ElevenLabsStt:${this.roomId}] Language: ${detectedLang} → stable: ${stableLang}`)
    }

    if (!this.currentLang) {
      this.currentLang = stableLang
    }
    const langForUnit = this.currentLang || stableLang

    this.version++
    const patch = {
      unitId: this.unitId(langForUnit),
      version: this.version,
      stage: isFinal ? 'hard' : 'soft',
      text: cleanText,
      srcLang: langForUnit
    }

    if (timestamps) {
      patch.ts = timestamps
    }

    if (isFinal) {
      patch.ttsFinal = true
    }

    return patch
  }

  async start() {
    if (this.isStarted) {
      this.logger.warn(`[ElevenLabsStt:${this.roomId}] Already started`)
      return
    }

    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY not configured')
    }

    this.isStarted = true
    this.logger.info(`[ElevenLabsStt:${this.roomId}] Starting ElevenLabs connection`, {
      model: ELEVENLABS_STT_MODEL,
      sourceLang: this.sourceLang,
      isAutoDetect: this.isAutoDetect
    })

    try {
      const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${ELEVENLABS_STT_MODEL}`

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY
        }
      })

      this.ws.on('open', () => {
        this.logger.info(`[ElevenLabsStt:${this.roomId}] WebSocket connected`)
        this.isConnected = true

        // Send any pending audio
        while (this.pendingAudio.length > 0) {
          const chunk = this.pendingAudio.shift()
          this.sendAudioChunk(chunk)
        }
      })

      this.ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString())
          await this.handleMessage(msg)
        } catch (err) {
          this.logger.error(`[ElevenLabsStt:${this.roomId}] Failed to parse message:`, err)
        }
      })

      this.ws.on('error', (err) => {
        this.logger.error({ err, errMessage: err?.message }, `[ElevenLabsStt:${this.roomId}] WebSocket error`)
      })

      this.ws.on('close', (code, reason) => {
        this.logger.info(`[ElevenLabsStt:${this.roomId}] WebSocket closed: ${code} ${reason}`)
        this.isConnected = false
      })

    } catch (err) {
      this.logger.error(`[ElevenLabsStt:${this.roomId}] Failed to start:`, err)
      this.isStarted = false
      throw err
    }
  }

  async handleMessage(msg) {
    const msgType = msg.message_type || msg.type

    switch (msgType) {
      case 'partial_transcript':
        await this.handlePartialTranscript(msg)
        break

      case 'final_transcript':
      case 'transcript':
        await this.handleFinalTranscript(msg)
        break

      case 'speech_started':
        this.logger.debug(`[ElevenLabsStt:${this.roomId}] Speech started`)
        break

      case 'speech_ended':
        this.logger.debug(`[ElevenLabsStt:${this.roomId}] Speech ended`)
        break

      case 'error':
        this.logger.error(`[ElevenLabsStt:${this.roomId}] API error:`, msg.error || msg)
        break

      default:
        this.logger.debug(`[ElevenLabsStt:${this.roomId}] Unknown message type: ${msgType}`, msg)
    }
  }

  async handlePartialTranscript(msg) {
    const text = msg.text || msg.transcript || ''
    if (!text.trim()) return

    this.currentPartial = text
    this.lastPartialAt = Date.now()

    // Throttle soft patches
    const now = Date.now()
    const textDelta = text.length - this.lastSoftText.length
    const timeOk = now - this.lastSoftAt > 700
    const charOk = textDelta > 12

    if ((charOk || /[.?!]\s*$/.test(text)) && timeOk) {
      const detectedLang = msg.language || msg.detected_language
      const patch = this.buildPatch(text, detectedLang, false)

      if (patch) {
        this.lastSoftText = text
        this.lastSoftAt = now
        await this.emitPatch(patch)
      }
    }
  }

  async handleFinalTranscript(msg) {
    const text = msg.text || msg.transcript || ''
    if (!text.trim()) return

    // Use API-provided language or detect from text
    let detectedLang = msg.language || msg.detected_language
    if (!detectedLang && this.isAutoDetect) {
      detectedLang = detectLanguageFromText(text)
      if (detectedLang) {
        this.logger.debug(`[ElevenLabsStt:${this.roomId}] Text-based detection: ${detectedLang}`)
      }
    }

    // Build timestamps if word-level data available
    let timestamps
    if (msg.words?.length > 0) {
      timestamps = {
        t0: Math.floor(msg.words[0].start * 1000),
        t1: Math.floor(msg.words[msg.words.length - 1].end * 1000)
      }
    }

    const patch = this.buildPatch(text, detectedLang, true, timestamps)

    if (patch) {
      this.logger.info(`[ElevenLabsStt:${this.roomId}] Final: "${text.substring(0, 50)}" lang=${detectedLang || 'N/A'}`)
      await this.emitPatch(patch)
      this.advanceUnit()
    }
  }

  async emitPatch(patch) {
    try {
      const result = await this.processor.processPatch(patch, this.targetLangs)
      if (!result.stale) {
        await this.broadcast(result)
      }
    } catch (err) {
      this.logger.error(`[ElevenLabsStt:${this.roomId}] Failed to emit patch:`, err)
    }
  }

  advanceUnit() {
    this.unitIndex++
    this.version = 0
    this.currentLang = ''
    this.currentPartial = ''
    this.lastSoftText = ''
    this.lastSoftAt = Date.now()
  }

  sendAudioChunk(audioData) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    // Convert PCM buffer to base64
    const audioBase64 = audioData.toString('base64')

    const message = {
      message_type: 'input_audio_chunk',
      audio_base_64: audioBase64,
      sample_rate: 16000
    }

    this.ws.send(JSON.stringify(message))
  }

  feedAudio(audioData) {
    if (!this.isStarted) {
      this.logger.warn(`[ElevenLabsStt:${this.roomId}] Cannot feed audio - session not started`)
      return
    }

    // Track audio stats
    if (!this.audioStats) {
      this.audioStats = { chunks: 0, bytes: 0, lastLog: Date.now(), maxAmplitude: 0 }
    }
    this.audioStats.chunks++
    this.audioStats.bytes += audioData.length

    // Analyze first chunk
    if (this.audioStats.chunks === 1) {
      const samples = new Int16Array(audioData.buffer, audioData.byteOffset, Math.min(100, audioData.length / 2))
      const nonZero = Array.from(samples).filter(s => s !== 0).length
      this.logger.info(`[ElevenLabsStt:${this.roomId}] First chunk: ${audioData.length} bytes, non-zero: ${nonZero}/100`)
    }

    // Track max amplitude
    const samples = new Int16Array(audioData.buffer, audioData.byteOffset, audioData.length / 2)
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i])
      if (abs > this.audioStats.maxAmplitude) this.audioStats.maxAmplitude = abs
    }

    // Log audio flow every second
    const now = Date.now()
    if (now - this.audioStats.lastLog >= 1000) {
      this.logger.info(`[ElevenLabsStt:${this.roomId}] Audio: ${this.audioStats.chunks} chunks, ${this.audioStats.bytes} bytes, maxAmp: ${this.audioStats.maxAmplitude}, connected: ${this.isConnected}`)
      this.audioStats.lastLog = now
      this.audioStats.maxAmplitude = 0
    }

    if (!this.isConnected) {
      if (this.pendingAudio.length < this.maxPendingAudio) {
        this.pendingAudio.push(audioData)
      }
      return
    }

    this.sendAudioChunk(audioData)
  }

  updateConfig(config) {
    if (config.targetLangs) {
      this.targetLangs = config.targetLangs
    }
    if (config.phraseHints) {
      this.phraseHints = config.phraseHints
    }
  }

  async stop() {
    this.logger.info(`[ElevenLabsStt:${this.roomId}] Stopping session`)

    this.isStarted = false
    this.isConnected = false
    this.pendingAudio = []

    if (this.ws) {
      try {
        // Send end-of-stream signal
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ message_type: 'end_of_stream' }))
        }
        this.ws.close()
      } catch (err) {
        this.logger.error(`[ElevenLabsStt:${this.roomId}] Error closing WebSocket:`, err)
      }
      this.ws = null
    }
  }

  getLimitations() {
    return this.limitations
  }

  dispose() {
    this.stop()
  }
}

function createElevenLabsSttSession(config, processor, broadcast, logger) {
  return new ElevenLabsSttSession(config, processor, broadcast, logger)
}

function isElevenLabsConfigured() {
  return !!ELEVENLABS_API_KEY
}

module.exports = {
  ElevenLabsSttSession,
  createElevenLabsSttSession,
  isElevenLabsConfigured,
  mapLangCode
}
