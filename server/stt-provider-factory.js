/**
 * STT Provider Factory
 *
 * Factory for creating STT sessions based on configuration.
 * Supports: azure (client-side), deepgram, elevenlabs, local-whisper (server-side)
 */

const { createSttSession: createDeepgramSession, isDeepgramConfigured } = require('./stt-session')
const { createLocalWhisperSession, isWhisperServiceAvailable } = require('./local-whisper-session')
const { createElevenLabsSttSession, isElevenLabsConfigured } = require('./elevenlabs-stt-session')

// Provider selection from environment
const STT_PROVIDER = process.env.STT_PROVIDER || 'azure'
const STT_FALLBACK_PROVIDER = process.env.STT_FALLBACK_PROVIDER || 'deepgram'

/**
 * Available STT providers
 */
const PROVIDERS = {
  /**
   * Azure Speech SDK (client-side)
   * Browser handles STT, posts patches via HTTP
   * Server just receives patches - no session needed
   */
  azure: {
    name: 'azure',
    isServerSide: false,
    isConfigured: () => true, // Always available (runs in browser)
    createSession: null, // No server-side session
  },

  /**
   * Deepgram (server-side)
   * Browser streams PCM via WebSocket, server runs Deepgram SDK
   */
  deepgram: {
    name: 'deepgram',
    isServerSide: true,
    isConfigured: isDeepgramConfigured,
    createSession: createDeepgramSession,
  },

  /**
   * ElevenLabs Scribe (server-side)
   * Browser streams PCM via WebSocket, server runs ElevenLabs Scribe Realtime v2
   */
  elevenlabs: {
    name: 'elevenlabs',
    isServerSide: true,
    isConfigured: isElevenLabsConfigured,
    createSession: createElevenLabsSttSession,
  },

  /**
   * Local Whisper (server-side)
   * Browser streams PCM via WebSocket, server forwards to whisper-svc
   */
  'local-whisper': {
    name: 'local-whisper',
    isServerSide: true,
    isConfigured: async () => await isWhisperServiceAvailable(),
    createSession: createLocalWhisperSession,
  },
}

/**
 * Get the current STT provider configuration
 */
function getProviderConfig() {
  return {
    provider: STT_PROVIDER,
    fallback: STT_FALLBACK_PROVIDER,
    isServerSide: PROVIDERS[STT_PROVIDER]?.isServerSide ?? false,
  }
}

/**
 * Check if the configured provider is available
 */
async function isProviderAvailable(providerName = STT_PROVIDER) {
  const provider = PROVIDERS[providerName]
  if (!provider) return false

  const configured = provider.isConfigured
  return typeof configured === 'function'
    ? await Promise.resolve(configured())
    : configured
}

/**
 * Create an STT session for the configured provider
 *
 * @param {Object} config - Session configuration
 * @param {string} config.roomId - Room identifier
 * @param {string} config.sourceLang - Source language ('en-US', 'fr-CA', or 'auto')
 * @param {string[]} config.autoDetectLangs - Candidate languages for auto-detect
 * @param {string[]} config.targetLangs - Target languages for translation
 * @param {string[]} config.phraseHints - Custom vocabulary/keywords
 * @param {string} [config.provider] - Optional provider override (client selection)
 * @param {Object} processor - SegmentProcessor instance
 * @param {Function} broadcast - Function to broadcast patches
 * @param {Object} logger - Logger instance
 * @returns {Object|null} STT session or null if provider is client-side
 */
async function createSttSession(config, processor, broadcast, logger) {
  // Use client-specified provider if valid, otherwise fall back to env default
  let providerName = config.provider && PROVIDERS[config.provider] ? config.provider : STT_PROVIDER

  // Check if primary provider is available
  const primaryAvailable = await isProviderAvailable(providerName)

  if (!primaryAvailable) {
    logger.warn(`[SttFactory] Primary provider '${providerName}' unavailable, trying fallback '${STT_FALLBACK_PROVIDER}'`)

    const fallbackAvailable = await isProviderAvailable(STT_FALLBACK_PROVIDER)
    if (fallbackAvailable) {
      providerName = STT_FALLBACK_PROVIDER
      logger.info(`[SttFactory] Using fallback provider: ${providerName}`)
    } else {
      logger.error(`[SttFactory] No STT provider available (tried: ${STT_PROVIDER}, ${STT_FALLBACK_PROVIDER})`)
      throw new Error('No STT provider available')
    }
  }

  const provider = PROVIDERS[providerName]

  // Client-side providers don't need a server session
  if (!provider.isServerSide) {
    logger.info(`[SttFactory] Provider '${providerName}' is client-side, no server session needed`)
    return null
  }

  if (!provider.createSession) {
    throw new Error(`Provider '${providerName}' has no createSession implementation`)
  }

  logger.info(`[SttFactory] Creating ${providerName} STT session for room ${config.roomId}`)
  return provider.createSession(config, processor, broadcast, logger)
}

/**
 * Get the name of the active provider
 */
function getActiveProvider() {
  return STT_PROVIDER
}

/**
 * Check if the active provider requires server-side streaming
 */
function isServerSideProvider(providerName = STT_PROVIDER) {
  return PROVIDERS[providerName]?.isServerSide ?? false
}

module.exports = {
  createSttSession,
  getProviderConfig,
  isProviderAvailable,
  getActiveProvider,
  isServerSideProvider,
  PROVIDERS,
  STT_PROVIDER,
  STT_FALLBACK_PROVIDER,
}
