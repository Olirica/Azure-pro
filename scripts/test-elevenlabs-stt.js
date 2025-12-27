#!/usr/bin/env node
/**
 * ElevenLabs STT Test Harness
 *
 * Tests ElevenLabs Scribe Realtime v2 with a bilingual audio file.
 * Usage: node scripts/test-elevenlabs-stt.js [audio-file.wav]
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v2_realtime'

if (!ELEVENLABS_API_KEY) {
  console.error('Error: ELEVENLABS_API_KEY not set in environment')
  process.exit(1)
}

// Default test file - use raw PCM if available
const rawFile = path.join(__dirname, '../tests/Bilingual_1min_16k_mono.raw')
const wavFile = path.join(__dirname, '../tests/Bilingual_1min.wav')
const audioFile = process.argv[2] || (fs.existsSync(rawFile) ? rawFile : wavFile)
const isRawPcm = audioFile.endsWith('.raw')

if (!fs.existsSync(audioFile)) {
  console.error(`Error: Audio file not found: ${audioFile}`)
  process.exit(1)
}

console.log(`\n=== ElevenLabs Scribe Realtime v2 Test ===`)
console.log(`Model: ${ELEVENLABS_STT_MODEL}`)
console.log(`Audio: ${audioFile}`)
console.log('')

// Results collection
const results = {
  mode: 'elevenlabs-scribe',
  transcripts: [],
  segments: [],
  stats: {
    total: 0,
    english: 0,
    french: 0,
    other: 0
  }
}

// Text-based language detection patterns
const FRENCH_PATTERNS = [
  /\b(je|tu|il|elle|nous|vous|ils|elles|on)\b/i,
  /\b(le|la|les|un|une|des|du|de|au|aux)\b/i,
  /\b(est|sont|était|être|avoir|fait)\b/i,
  /\b(que|qui|quoi|dont|où|quand|comment|pourquoi)\b/i,
  /\b(ne|pas|plus|jamais|rien)\b/i,
  /\b(mais|donc|car|parce|alors|ainsi)\b/i,
  /\b(avec|sans|pour|dans|sur|sous|entre)\b/i,
  /\b(bonjour|merci|c'est|n'est|j'espère|aujourd'hui)\b/i,
  /[àâäéèêëïîôùûüç]/i,
]

const ENGLISH_PATTERNS = [
  /\b(I|you|he|she|it|we|they)\b/,
  /\b(the|a|an|this|that|these|those)\b/i,
  /\b(is|are|was|were|be|been|being|have|has|had)\b/i,
  /\b(do|does|did|will|would|could|should|can|may)\b/i,
  /\b(what|who|where|when|why|how|which)\b/i,
  /\b(not|no|never|nothing)\b/i,
  /\b(and|but|or|so|because|if|then)\b/i,
  /\b(hello|thanks|everyone|doing|week|team)\b/i,
]

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

  if (frenchScore > englishScore && frenchScore >= 2) return 'fr'
  if (englishScore > frenchScore && englishScore >= 2) return 'en'
  return null
}

// Language detection helper
function classifyLanguage(lang) {
  if (!lang) return 'unknown'
  const l = lang.toLowerCase()
  if (l.startsWith('en')) return 'english'
  if (l.startsWith('fr')) return 'french'
  return 'other'
}

async function runTest() {
  return new Promise((resolve, reject) => {
    const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${ELEVENLABS_STT_MODEL}`

    console.log(`Connecting to: ${wsUrl}`)

    const ws = new WebSocket(wsUrl, {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    })

    let startTime = null
    let audioBuffer = null
    let audioOffset = 0
    let chunkInterval = null

    ws.on('open', () => {
      console.log('WebSocket connected!\n')
      startTime = Date.now()

      // Read the audio file
      const fileBuffer = fs.readFileSync(audioFile)

      // For raw PCM, use directly; for WAV, skip header
      if (isRawPcm) {
        audioBuffer = fileBuffer
      } else {
        const dataOffset = findDataChunk(fileBuffer)
        audioBuffer = fileBuffer.slice(dataOffset)
      }

      console.log(`Audio size: ${audioBuffer.length} bytes (${(audioBuffer.length / 32000).toFixed(1)}s at 16kHz)`)
      console.log('Starting audio stream...\n')

      // Stream audio in 100ms chunks (16000 * 2 bytes/sec * 0.1 = 3200 bytes)
      const chunkSize = 3200
      let chunkCount = 0
      const commitIntervalChunks = 30  // Commit every 30 chunks (~3 seconds)

      chunkInterval = setInterval(() => {
        if (audioOffset >= audioBuffer.length) {
          clearInterval(chunkInterval)
          console.log('\n--- Audio stream complete ---')

          // Send final commit
          ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: '',
            sample_rate: 16000,
            commit: true
          }))

          // Wait a bit for final transcripts then close
          setTimeout(() => {
            ws.close()
          }, 5000)
          return
        }

        const chunk = audioBuffer.slice(audioOffset, audioOffset + chunkSize)
        audioOffset += chunkSize
        chunkCount++

        // Commit every N chunks to get partial results
        const shouldCommit = chunkCount % commitIntervalChunks === 0

        const message = {
          message_type: 'input_audio_chunk',
          audio_base_64: chunk.toString('base64'),
          sample_rate: 16000,
          commit: shouldCommit
        }

        ws.send(JSON.stringify(message))

        if (shouldCommit) {
          const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`\n[${elapsedSec}s] Sent commit signal...`)
        }
      }, 100)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

        const msgType = msg.message_type || msg.type

        switch (msgType) {
          case 'partial_transcript':
            const partialText = msg.text || msg.transcript || ''
            if (partialText.trim()) {
              process.stdout.write(`\r[${elapsed}s] PARTIAL: ${partialText.substring(0, 60)}...`)
            }
            break

          case 'final_transcript':
          case 'transcript':
          case 'committed_transcript': {
            // ElevenLabs uses 'committed_transcript' for final segments
            const text = msg.text || msg.transcript || ''
            // Use API language or detect from text
            let lang = msg.language || msg.detected_language
            if (!lang && text.trim()) {
              lang = detectLanguageFromText(text)
            }
            const langDisplay = lang || 'N/A'

            if (text.trim()) {
              console.log(`\n[${elapsed}s] FINAL (${langDisplay}): "${text}"`)

              results.transcripts.push(text)
              results.segments.push({
                elapsed,
                stage: 'hard',
                text: text.trim(),
                srcLang: lang || 'unknown'
              })

              results.stats.total++
              const langClass = classifyLanguage(lang)
              if (langClass === 'english') results.stats.english++
              else if (langClass === 'french') results.stats.french++
              else results.stats.other++
            } else {
              // Log full message to see structure if no text
              console.log(`\n[${elapsed}s] ${msgType} (no text):`, JSON.stringify(msg, null, 2).substring(0, 200))
            }
            break
          }

          case 'session_started':
            console.log(`[${elapsed}s] Session started:`, msg.session_id || '')
            break

          case 'speech_started':
            console.log(`[${elapsed}s] Speech started`)
            break

          case 'speech_ended':
            console.log(`[${elapsed}s] Speech ended`)
            break

          case 'input_error':
            console.error(`[${elapsed}s] Input error:`, msg.error || msg.message || JSON.stringify(msg))
            break

          case 'error':
            console.error(`[${elapsed}s] ERROR:`, msg.error || msg)
            break

          default:
            console.log(`[${elapsed}s] Unknown (${msgType}):`, JSON.stringify(msg).substring(0, 150))
        }
      } catch (err) {
        console.error('Failed to parse message:', err)
      }
    })

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message)
      if (chunkInterval) clearInterval(chunkInterval)
      reject(err)
    })

    ws.on('close', (code, reason) => {
      console.log(`\nWebSocket closed: ${code} ${reason}`)
      if (chunkInterval) clearInterval(chunkInterval)

      // Print summary
      console.log('\n=== Results Summary ===')
      console.log(`Total segments: ${results.stats.total}`)
      console.log(`English: ${results.stats.english}`)
      console.log(`French: ${results.stats.french}`)
      console.log(`Other/Unknown: ${results.stats.other}`)

      console.log('\n--- Full Transcript ---')
      console.log(results.transcripts.join(' '))

      // Save results
      const outputPath = path.join(__dirname, '../elevenlabs-bilingual-test.json')
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
      console.log(`\nResults saved to: ${outputPath}`)

      resolve(results)
    })
  })
}

// Find the 'data' chunk in a WAV file
function findDataChunk(buffer) {
  // Standard WAV header is 44 bytes, but let's search for 'data' marker
  for (let i = 0; i < Math.min(buffer.length, 1000); i++) {
    if (buffer[i] === 0x64 && buffer[i + 1] === 0x61 &&
        buffer[i + 2] === 0x74 && buffer[i + 3] === 0x61) {  // 'data'
      // Skip 'data' marker (4 bytes) + size (4 bytes)
      return i + 8
    }
  }
  // Fallback to standard header size
  return 44
}

runTest()
  .then(() => {
    console.log('\nTest completed!')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Test failed:', err)
    process.exit(1)
  })
