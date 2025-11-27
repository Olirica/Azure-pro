import React, { useEffect, useRef, useState } from 'react'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Button } from '../components/ui/button'
import { Textarea } from '../components/ui/textarea'
import { cn } from '../lib/utils'

declare global { interface Window { SpeechSDK?: any } }

async function loadSpeechCdn(): Promise<any> {
  if (window.SpeechSDK) return window.SpeechSDK
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://aka.ms/csspeech/jsbrowserpackageraw'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Speech SDK'))
    document.head.appendChild(s)
  })
  return window.SpeechSDK
}

async function fetchToken() {
  const res = await fetch('/api/speech/token', { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.ok) throw new Error(body?.error || 'Token failed')
  return body as { token: string; region: string; expiresInSeconds?: number }
}

// Helper to read room from URL params
function getRoomFromUrl(): string {
  try {
    if (typeof window === 'undefined') return 'demo-room'
    const url = new URL(window.location.href)
    const r = url.searchParams.get('room')
    return (r && r.trim()) ? r : 'demo-room'
  } catch {
    return 'demo-room'
  }
}

export function SpeakerApp() {
  const [room, setRoom] = useState(getRoomFromUrl())
  const [roomInput, setRoomInput] = useState('')
  const [roomUnlocked, setRoomUnlocked] = useState(false)
  const [unlockError, setUnlockError] = useState('')
  const [srcLang, setSrcLang] = useState('en-US')
  const [targets, setTargets] = useState('fr-CA')
  const [status, setStatus] = useState('Idle')
  const [roomMeta, setRoomMeta] = useState<any>(null)
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([])  // Store recent transcriptions
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [glossary, setGlossary] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const recogRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const lastSoftAt = useRef(0)
  const lastSoftText = useRef('')
  const unitIndex = useRef(0)
  const version = useRef(0)
  const sessionId = useRef(crypto.randomUUID())
  const isAutoDetect = useRef(false)  // Track if using auto-detect mode
  const currentUnitLang = useRef('')
  const micStreamRef = useRef<MediaStream | null>(null)
  const speechConfigRef = useRef<any>(null)
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fast-finals state machine for prefix-based emission
  const sttState = useRef({
    lastText: '',
    committedPrefix: '',   // part we've already emitted as "hard-ish"
    lastEmitAt: 0,
  })

  // Set page title
  useEffect(() => {
    document.title = 'Simo'
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tokenRefreshTimerRef.current) {
        clearTimeout(tokenRefreshTimerRef.current)
      }
    }
  }, [])

  // Load persisted glossary for the current room
  useEffect(() => {
    if (typeof window === 'undefined' || !room) return
    try {
      const saved = localStorage.getItem(glossaryStorageKey(room))
      if (saved !== null) setGlossary(saved)
    } catch {}
  }, [room])

  // Persist glossary per room so it survives sessions
  useEffect(() => {
    if (typeof window === 'undefined' || !roomUnlocked || !room) return
    try {
      localStorage.setItem(glossaryStorageKey(room), glossary)
    } catch {}
  }, [roomUnlocked, room, glossary])

  // Language stability tracking (for auto-detect mode)
  const langStability = useRef({
    current: '',  // Currently active language
    detectedAt: 0,  // Timestamp when language was locked
    switchCandidate: null as string | null,  // Candidate new language
    switchCount: 0  // Consecutive detections of candidate
  })

  function unitId(lang: string) { return `${sessionId.current}|${lang}|${unitIndex.current}` }
  const glossaryStorageKey = (roomId: string) => `simo-glossary-${roomId}`

  // Helper to find longest common prefix between two strings
  function longestCommonPrefix(a: string, b: string): string {
    const max = Math.min(a.length, b.length)
    let i = 0
    while (i < max && a[i] === b[i]) i++
    return a.slice(0, i)
  }

  // Get stable language with persistence (15s lock + 2 consecutive threshold)
  function getStableLanguage(detected: string | undefined, fallback: string): string {
    // If not in auto-detect mode or no detection, use fallback
    if (!isAutoDetect.current || !detected) {
      return fallback
    }

    const now = Date.now()
    const stability = langStability.current

    // Initialize on first detection
    if (!stability.current) {
      stability.current = detected
      stability.detectedAt = now
      return detected
    }

    const timeSinceLock = now - stability.detectedAt

    // Lock language for 8 seconds after detection to avoid flapping
    const lockDurationMs = 8000  // TODO: Make configurable
    if (timeSinceLock < lockDurationMs) {
      return stability.current
    }

    // After lock period, allow switching but require 2 consecutive detections
    if (detected !== stability.current) {
      if (detected === stability.switchCandidate) {
        stability.switchCount++

        // Require 2 consecutive detections before switching (configurable via SPEECH_LANG_SWITCH_THRESHOLD)
        const switchThreshold = 2  // TODO: Make configurable
        if (stability.switchCount >= switchThreshold) {
          // Switch to new language
          stability.current = detected
          stability.detectedAt = now
          stability.switchCandidate = null
          stability.switchCount = 0
          return detected
        }
      } else {
        // New candidate language
        stability.switchCandidate = detected
        stability.switchCount = 1
      }

      // Keep current language while evaluating candidate
      return stability.current
    }

    // Same language detected, reset switch tracking
    stability.switchCandidate = null
    stability.switchCount = 0
    return detected
  }

  function timestamps(result: any) {
    if (!result) return undefined
    const offsetMs = Math.floor(result.offset / 10000)
    const durationMs = Math.floor(result.duration / 10000)
    return { t0: offsetMs, t1: offsetMs + durationMs }
  }

  // Snap a character position to the nearest word boundary (end of complete word)
  // Note: Azure's NBest[0].Words is typically only in 'recognized' events, not partials
  // So for fast-finals (which use 'recognizing' partials), we rely on space-based detection
  function snapToWordBoundary(text: string, charPos: number): number {
    if (charPos >= text.length) return text.length
    // If we're already at a space or end, we're at a boundary
    if (charPos === 0 || /\s/.test(text[charPos])) return charPos
    // Find last space before charPos to snap to end of previous word
    const lastSpace = text.lastIndexOf(' ', charPos - 1)
    if (lastSpace > 0) {
      return lastSpace  // Return position of space (trim will clean it up)
    }
    // No space found - this is a single long word, keep original position
    return charPos
  }

  async function postPatch(patch: any) {
    const payload = { roomId: room, targets: targets.split(',').map(s=>s.trim()).filter(Boolean), patch }
    try { await fetch('/api/segments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch {}
  }

  // Build an AudioConfig pinned to the requested deviceId when provided
  async function buildAudioConfig(SDK: any, deviceId?: string) {
    // Audio constraints for speech recognition (conservative settings for accuracy)
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,      // Remove speaker feedback
      noiseSuppression: true,      // Reduce background noise
      autoGainControl: true,       // Normalize volume levels
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {})
    }
    if (deviceId) {
      try {
        // Prime permissions and validate the device exists
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
        // Close any previous pinned stream
        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach(t => t.stop())
        }
        micStreamRef.current = stream
        // Use SDK's device binding (more stable than direct stream)
        return SDK.AudioConfig.fromMicrophoneInput(deviceId)
      } catch (err) {
        console.warn('[Speaker] Failed to bind mic stream, falling back to SDK mic selection', err)
      }
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop())
      micStreamRef.current = null
    }
    return deviceId
      ? SDK.AudioConfig.fromMicrophoneInput(deviceId)
      : SDK.AudioConfig.fromDefaultMicrophoneInput()
  }

  function startHeartbeat() {
    try { wsRef.current?.close() } catch {}
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?role=speaker&room=${encodeURIComponent(room)}`
    const ws = new WebSocket(url)
    wsRef.current = ws
    const timer = setInterval(()=> {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', payload: { pcm: true } }))
    }, 2500)
    ws.onclose = () => clearInterval(timer)
  }

  async function start(deviceOverride?: string) {
    try {
      if (isRecording) return
      setIsRecording(true)
      sessionId.current = crypto.randomUUID()
      unitIndex.current = 0
      version.current = 0
      currentUnitLang.current = ''
      langStability.current = { current: '', detectedAt: 0, switchCandidate: null, switchCount: 0 }
      lastSoftText.current = ''
      lastSoftAt.current = 0
      sttState.current = { lastText: '', committedPrefix: '', lastEmitAt: 0 }  // Reset fast-finals state
      setStatus('Loading Speech SDK…')
      const SDK = await loadSpeechCdn()
      setStatus('Fetching token…')
      const { token, region, expiresInSeconds } = await fetchToken()
      const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(token, region)
      speechConfigRef.current = speechConfig
      speechConfig.outputFormat = SDK.OutputFormat.Detailed
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_PostProcessingOption, 'TrueText') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_ContinuousLanguageIdPriority, 'Accuracy') } catch {}
      // Dictation mode: better punctuation/capitalization via TrueText processing
      try { speechConfig.enableDictation() } catch {}

      // Accuracy-focused SDK properties (conservative settings, not aggressive VAD)
      // Note: Avoid StablePartialResultThreshold as it may reduce partial frequency needed for fast-finals
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_RequestSentenceBoundary, 'true') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_RequestWordBoundary, 'true') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_RequestPunctuationBoundary, 'true') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_EnableAudioProcessing, 'true') } catch {}
      // Conservative silence timeouts (keep accuracy, don't rush) - affects 'recognized' events only
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '5000') } catch {}
      // Note: Semantic segmentation delays 'recognized' but fast-finals use 'recognizing' partials
      // Keeping default segmentation to avoid delaying finals too much

      // Set up token refresh timer (refresh 1 minute before expiry)
      const refreshMs = ((expiresInSeconds || 600) - 60) * 1000
      if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current)
      const scheduleTokenRefresh = () => {
        tokenRefreshTimerRef.current = setTimeout(async () => {
          try {
            console.log('[Speaker] Refreshing Azure Speech token...')
            const fresh = await fetchToken()
            if (speechConfigRef.current) {
              speechConfigRef.current.authorizationToken = fresh.token
              console.log('[Speaker] Token refreshed successfully')
            }
            scheduleTokenRefresh() // Schedule next refresh
          } catch (err) {
            console.error('[Speaker] Token refresh failed:', err)
            // Retry in 30 seconds if refresh fails
            tokenRefreshTimerRef.current = setTimeout(scheduleTokenRefresh, 30000)
          }
        }, refreshMs)
      }
      scheduleTokenRefresh()

      // Load room metadata to configure fixed vs. auto-detect languages
      let meta: any = null
      try {
        const r = await fetch(`/api/rooms/${encodeURIComponent(room)}`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({} as any))
        if (r.ok && j?.ok && j?.room) meta = j.room
        if (meta) setRoomMeta(meta)
      } catch {}

      // Use selected device or default microphone (with exact device binding when provided)
      const audioConfig = await buildAudioConfig(SDK, deviceOverride || selectedDeviceId)
      let recognizer: any = null

            // Helper to read detected language from SDK result (robust to SDK variants)
      function detectedLangFrom(result: any): string | undefined {
        try {
          if ((result as any)?.language) return String((result as any).language)
          if ((SDK as any).AutoDetectSourceLanguageResult?.fromResult) {
            const det = (SDK as any).AutoDetectSourceLanguageResult.fromResult(result)
            if (det?.language) return String(det.language)
          }
          const propId = (SDK as any).PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
          const raw: any = (result as any)?.properties?.getProperty?.(propId)
          if (raw) {
            try {
              const parsed: any = JSON.parse(raw)
              if (parsed?.language) return String(parsed.language)
            } catch {}
            return String(raw)
          }
        } catch {}
        return undefined
      }

      // Configure recognizer from room meta from room meta
      if (meta && meta.sourceLang === 'auto' && Array.isArray(meta.autoDetectLangs) && meta.autoDetectLangs.length) {
        const candidates: string[] = meta.autoDetectLangs.slice(0, 4)
        isAutoDetect.current = true  // Mark as auto-detect mode
        // If multiple languages, use continuous language ID to allow switching
        if (candidates.length >= 2) {
          speechConfig.setProperty(
            SDK.PropertyId.SpeechServiceConnection_LanguageIdMode,
            'Continuous'
          )
        }
        const autoCfg = SDK.AutoDetectSourceLanguageConfig.fromLanguages(candidates)
        recognizer = SDK.SpeechRecognizer.FromConfig(speechConfig, autoCfg, audioConfig)
        // If targets were not set manually, default from room meta
        if ((!targets || !targets.trim()) && Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
          setTargets(meta.defaultTargetLangs.join(','))
        }
      } else {
        isAutoDetect.current = false  // Fixed language mode
        const fixed = meta && meta.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang
        speechConfig.speechRecognitionLanguage = fixed
        recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig)
        if ((!targets || !targets.trim()) && Array.isArray(meta?.defaultTargetLangs) && meta.defaultTargetLangs.length) {
          setTargets(meta.defaultTargetLangs.join(','))
        }
      }

      recogRef.current = recognizer
      // Apply glossary/phrase list hints to improve domain accuracy
      const phrases = glossary
        .split(/\n|,|;/)
        .map((p) => p.trim())
        .filter(Boolean)
      if (phrases.length) {
        try {
          const phraseList = SDK.PhraseListGrammar.fromRecognizer(recognizer)
          phraseList.clear()
          phrases.forEach((phrase) => phraseList.addPhrase(phrase))
        } catch {}
      }

      startHeartbeat()
      setStatus('Listening')

      recognizer.recognizing = async (_s: any, e: any) => {
        if (!e?.result?.text) return

        // In auto-detect mode, require minimum 2 seconds of audio for accurate detection
        if (isAutoDetect.current && e.result?.duration) {
          const audioDurationMs = e.result.duration / 10000  // Convert from 100ns ticks to ms
          if (audioDurationMs < 2000) {
            return  // Wait for more audio before attempting language detection
          }
        }

        const now = Date.now()
        const text = e.result.text.trim()
        if (!text) return

        // PREFIX-BASED FAST FINALS (Solution 2)
        // Find stable prefix that's consistent across multiple partials
        const prev = sttState.current.lastText
        const prefix = longestCommonPrefix(prev, text)

        // Only consider if prefix grows beyond what we've already committed
        if (prefix.length > sttState.current.committedPrefix.length) {
          const extension = prefix.slice(sttState.current.committedPrefix.length)
          const extensionChars = extension.length
          const timeSinceEmit = now - sttState.current.lastEmitAt

          // Determine if we should emit a fast-final
          const hasNewSentence = /[.?!]\s/.test(extension)   // new boundary in extension
          const prefixEndsSentence = /[.?!]\s*$/.test(prefix)  // prefix ends with punctuation
          const enoughNewChars = extensionChars >= 30   // FASTFINALS_MIN_CHARS (prod: 30)
          const timeOk = timeSinceEmit >= 500               // FASTFINALS_EMIT_THROTTLE_MS (prod: 500)

          if ((hasNewSentence || prefixEndsSentence || enoughNewChars) && timeOk) {
            // Apply tail guard with word boundary snapping
            // BUT: if prefix ends with sentence punctuation, don't guard it off
            const guardChars = 10  // FASTFINALS_TAIL_GUARD_CHARS (prod: 10)
            const total = prefix.length
            let guardedLen = Math.max(
              sttState.current.committedPrefix.length,
              total - guardChars
            )
            // If prefix ends with punctuation, extend to include it
            if (prefixEndsSentence && guardedLen < total) {
              guardedLen = total
            } else if (guardedLen < total) {
              // Snap to word boundary to avoid mid-word cuts
              guardedLen = snapToWordBoundary(prefix, guardedLen)
            }
            const candidate = prefix.slice(0, guardedLen).trim()

            if (candidate.length > sttState.current.committedPrefix.length) {
              version.current += 1
              const rawDetected = detectedLangFrom(e.result)
              const fallback = (meta?.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang)
              const stableLang = getStableLanguage(rawDetected, fallback)
              if (!currentUnitLang.current) currentUnitLang.current = stableLang
              const langForUnit = currentUnitLang.current || stableLang

              const candidateIsSentence = /[.?!]\s*$/.test(candidate)

              await postPatch({
                unitId: unitId(langForUnit),
                stage: 'hard',       // <- fast final "hard"
                op: 'replace',
                version: version.current,
                text: candidate,
                srcLang: langForUnit,
                // Allow TTS when the fast-final ends with terminal punctuation
                ttsFinal: candidateIsSentence,
                ts: timestamps(e.result),
              })

              sttState.current.committedPrefix = candidate
              sttState.current.lastEmitAt = now
            }
          }
        }

        sttState.current.lastText = text

        // ALSO emit soft patches for UI preview (separate from fast-finals)
        const delta = text.length - lastSoftText.current.length
        const softTimeOk = now - lastSoftAt.current > 700  // SOFT_THROTTLE_MS (prod: 700)
        const softCharOk = delta > 12  // SOFT_MIN_DELTA_CHARS (prod: 12)
        const punct = /[.?!]\s*$/.test(text)
        if ((punct || softCharOk) && softTimeOk) {
          lastSoftText.current = text
          lastSoftAt.current = now
          const rawDetected = detectedLangFrom(e.result)
          const fallback = (meta?.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang)
          const stableLang = getStableLanguage(rawDetected, fallback)
          if (!currentUnitLang.current) currentUnitLang.current = stableLang
          const langForUnit = currentUnitLang.current || stableLang
          await postPatch({
            unitId: unitId(langForUnit),
            stage: 'soft',
            op: 'replace',
            version: version.current,
            text,
            srcLang: langForUnit,
            ts: timestamps(e.result)
          })
        }
      }

      recognizer.recognized = async (_s: any, e: any) => {
        if (!e?.result) return
        if (e.result.reason === SDK.ResultReason.RecognizedSpeech) {
          const text = e.result.text.trim()
          if (!text) return

          // Update transcript history (keep last 7 sentences)
          setTranscriptHistory(prev => {
            const updated = [...prev, text]
            return updated.slice(-7)  // Keep only last 7 sentences
          })

          version.current += 1
          const rawDetected = detectedLangFrom(e.result)
          const fallback = (meta?.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang)
          const stableLang = getStableLanguage(rawDetected, fallback)
          if (!currentUnitLang.current) currentUnitLang.current = stableLang
          const langForUnit = currentUnitLang.current || stableLang
          await postPatch({
            unitId: unitId(langForUnit),
            stage: 'hard',
            op: 'replace',
            version: version.current,
            text,
            srcLang: langForUnit,
            ttsFinal: true,   // Only queue TTS on the definitive final
            ts: timestamps(e.result)
          })
          unitIndex.current += 1
          version.current = 0
          lastSoftText.current = ''
          lastSoftAt.current = Date.now()
          currentUnitLang.current = ''
          sttState.current = { lastText: '', committedPrefix: '', lastEmitAt: 0 }  // Reset fast-finals state for next utterance
        }
      }

      recognizer.sessionStarted = () => setStatus('Session started')
      recognizer.sessionStopped = () => { setStatus('Session stopped'); setIsRecording(false); currentUnitLang.current = '' }
      recognizer.canceled = (_s: any, e: any) => { setStatus('Canceled'); setIsRecording(false); currentUnitLang.current = '' }
      recognizer.startContinuousRecognitionAsync()
    } catch (e: any) {
      setStatus('Error: ' + (e?.message || 'unknown'))
      try { wsRef.current?.close() } catch {}
      setIsRecording(false)
    }
  }

  async function stop() {
    setStatus('Stopping…')
    // Clear token refresh timer
    if (tokenRefreshTimerRef.current) {
      clearTimeout(tokenRefreshTimerRef.current)
      tokenRefreshTimerRef.current = null
    }
    speechConfigRef.current = null
    try { wsRef.current?.close() } catch {}
    wsRef.current = null
    const r = recogRef.current
    if (r) {
      try {
        await new Promise<void>((resolve) => {
          try {
            r.stopContinuousRecognitionAsync(()=>resolve(), ()=>resolve())
          } catch {
            resolve()
          }
        })
      } catch {}
      try { r.close() } catch {}
    }
    recogRef.current = null
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop())
      micStreamRef.current = null
    }
    setStatus('Idle')
    setTranscriptHistory([])  // Clear transcript history when stopping
    setIsRecording(false)
    currentUnitLang.current = ''
  }

  // Handle device changes: if currently recording, restart with the new device
  async function handleDeviceChange(deviceId: string) {
    setSelectedDeviceId(deviceId)
    if (isRecording) {
      setStatus('Switching input…')
      try {
        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach(t => t.stop())
          micStreamRef.current = null
        }
      } catch {}
      await stop()
      await start(deviceId)
    }
  }

  // Enumerate audio input devices on mount
  useEffect(() => {
    async function getDevices() {
      try {
        // Request microphone permission first
        await navigator.mediaDevices.getUserMedia({ audio: true })
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioInputs = devices.filter(d => d.kind === 'audioinput')
        setAudioDevices(audioInputs)
        // Preserve selection if still available, otherwise pick first
        const stillExists = audioInputs.find(d => d.deviceId === selectedDeviceId)
        if (!stillExists) {
          if (audioInputs.length > 0) setSelectedDeviceId(audioInputs[0].deviceId)
          else setSelectedDeviceId('')
        }
      } catch (err) {
        console.error('Failed to enumerate devices:', err)
      }
    }
    getDevices()
    const handler = () => { getDevices() }
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', handler)
    }
    return () => {
      if (navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', handler)
      }
    }
  }, [selectedDeviceId])

  // Unlock room with access code
  async function unlockRoom(e: React.FormEvent) {
    e.preventDefault()
    setUnlockError('')
    const code = roomInput.trim()
    if (!code) {
      setUnlockError('Please enter a room code')
      return
    }
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, { cache: 'no-store' })
      const body = await res.json().catch(() => ({} as any))
      if (!res.ok || !body?.ok || !body?.room) {
        setUnlockError('Invalid room code. Please check and try again.')
        return
      }
      const meta = body.room
      setRoom(code)
      setRoomMeta(meta)
      setRoomUnlocked(true)
      // If fixed source, reflect in input
      if (meta.sourceLang && meta.sourceLang !== 'auto') {
        setSrcLang(meta.sourceLang)
      }
      // Default targets from meta
      if (Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
        setTargets(meta.defaultTargetLangs.join(','))
      }
    } catch (err) {
      setUnlockError('Failed to validate room code. Please try again.')
    }
  }

  // When room changes, fetch its meta to populate fields
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        if (!room || !room.trim()) return
        const res = await fetch(`/api/rooms/${encodeURIComponent(room)}`, { cache: 'no-store' })
        const body = await res.json().catch(() => ({} as any))
        if (!cancelled && res.ok && body?.ok && body?.room) {
          const meta = body.room
          setRoomMeta(meta)
          setRoomUnlocked(true)
          // If fixed source, reflect in input
          if (meta.sourceLang && meta.sourceLang !== 'auto') {
            setSrcLang(meta.sourceLang)
          }
          // Default targets from meta
          if (Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
            setTargets(meta.defaultTargetLangs.join(','))
          }
        }
      } catch {}
    }
    load()
    return () => { cancelled = true }
  }, [room])

  // Access gate - show unlock screen if not authenticated
  if (!roomUnlocked) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-blue-500/20 border border-emerald-500/30 flex items-center justify-center">
              <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-emerald-400 to-blue-400 bg-clip-text text-transparent mb-2">Speaker Access</h1>
            <p className="text-slate-400">Enter your room code to begin</p>
          </div>
          <form onSubmit={unlockRoom} className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-8 shadow-2xl space-y-4">
            <div>
              <Label className="mb-2 block text-slate-300">Room Code</Label>
              <Input
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value)}
                placeholder="Enter your room code"
                className="bg-slate-900/50 border-slate-700 focus:border-emerald-500 transition-colors text-center text-lg tracking-wider"
                autoFocus
              />
            </div>
            <div className="pt-2">
              <Button type="submit" className="w-full bg-gradient-to-r from-emerald-500 to-blue-500 hover:from-emerald-600 hover:to-blue-600 transition-all">
                Access Room
              </Button>
              {unlockError && (
                <p className="text-sm mt-3 text-center text-red-400">{unlockError}</p>
              )}
            </div>
          </form>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-8">
      <div className="container mx-auto max-w-4xl">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-emerald-400 to-blue-400 bg-clip-text text-transparent mb-2">Speaker</h1>
              <p className="text-slate-400">Configure your audio input and start translating</p>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500 mb-1">Room</div>
              <code className="text-sm text-slate-300 bg-slate-800/50 px-3 py-1 rounded-lg border border-slate-700/50">{room}</code>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-6 shadow-xl mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <Label className="mb-2 block text-slate-300">Source Language</Label>
            {roomMeta?.sourceLang === 'auto' ? (
              <Input
                value={`auto (${(roomMeta.autoDetectLangs||[]).slice(0,4).join(',')})`}
                readOnly
                className="bg-slate-900/30 border-slate-700 text-slate-400"
              />
            ) : (
              <Input
                value={srcLang}
                onChange={(e)=>setSrcLang(e.target.value)}
                className="bg-slate-900/50 border-slate-700 focus:border-emerald-500 transition-colors"
              />
            )}
          </div>
          <div>
            <Label className="mb-2 block text-slate-300">Target Languages</Label>
            <Input
              value={targets}
              onChange={(e)=>setTargets(e.target.value)}
              className="bg-slate-900/50 border-slate-700 focus:border-emerald-500 transition-colors"
              placeholder="e.g., fr-CA, es-ES"
            />
          </div>
        </div>

        <div className="mb-6">
          <Label className="mb-2 block text-slate-300">Audio Input Device</Label>
          <select
            value={selectedDeviceId}
            onChange={(e) => handleDeviceChange(e.target.value)}
            className="flex h-10 w-full rounded-lg border border-slate-700 bg-slate-900/50 text-slate-100 px-3 py-2 text-sm shadow-sm transition-colors focus:outline-none focus:border-emerald-500 [&>option]:bg-slate-800 [&>option]:text-slate-100"
          >
            {audioDevices.map(device => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Device ${device.deviceId.substring(0, 8)}...`}
              </option>
            ))}
          </select>
          {audioDevices.length === 0 && (
            <p className="text-xs text-slate-500 mt-2">No audio devices found. Allow microphone access to see devices.</p>
          )}
          {audioDevices.length > 0 && (
            <p className="text-xs text-slate-500 mt-2">
              Changing devices while recording will restart capture with the new input.
            </p>
          )}
        </div>

        <div className="mb-6">
          <Label className="mb-2 block text-slate-300">Glossary / Phrase Hints</Label>
          <Textarea
            value={glossary}
            onChange={(e)=> setGlossary(e.target.value)}
            placeholder="Product names, acronyms, people... one per line"
            className="bg-slate-900/50 border-slate-700 focus-visible:ring-emerald-500 text-slate-100 min-h-[110px]"
          />
          <p className="text-xs text-slate-500 mt-2">
            Sent to Azure as a phrase list to improve recognition. Saved locally for this room.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-4 border-t border-slate-700/50">
          <Button
            onClick={start}
            disabled={isRecording}
            className="bg-gradient-to-r from-emerald-500 to-blue-500 hover:from-emerald-600 hover:to-blue-600 transition-all"
          >
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Start Recording
          </Button>
          <Button
            variant="outline"
            onClick={stop}
            disabled={!isRecording && status === 'Idle'}
            className="border-slate-700 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h12v12H6z" />
            </svg>
            Stop
          </Button>
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full',
              status === 'Listening' || status === 'Session started' ? 'bg-emerald-400 animate-pulse' :
              status.startsWith('Error') ? 'bg-red-400' :
              'bg-slate-600'
            )}></div>
            <span className="text-sm text-slate-400">{status}</span>
          </div>
        </div>
      </div>

      {/* Live Transcription Monitor */}
      {transcriptHistory.length > 0 && (
        <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-6 shadow-xl">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
            <h2 className="text-lg font-semibold text-slate-200">Live Transcription</h2>
            <span className="text-xs text-slate-500 ml-auto">Original audio</span>
          </div>
          <div className="bg-slate-900/50 rounded-lg p-4 space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
            {transcriptHistory.map((text, idx) => (
              <div
                key={idx}
                className="text-sm text-slate-200 bg-slate-800/50 rounded-md p-3 border border-slate-700/50 hover:bg-slate-800/70 transition-colors"
              >
                {text}
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Showing last {transcriptHistory.length} sentence{transcriptHistory.length !== 1 ? 's' : ''}
          </p>
        </div>
      )}

      {/* Debug Info */}
      {status.startsWith('Error') && (
        <div className="rounded-xl border border-red-500/50 bg-red-900/20 backdrop-blur-sm p-4 shadow-xl">
          <div className="flex items-center gap-2 mb-2">
            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-semibold text-red-300">Error</span>
          </div>
          <p className="text-sm text-red-200">
            {status.includes('Token failed') ?
              'Failed to get Azure Speech token. Please check your SPEECH_KEY and SPEECH_REGION in .env file.' :
              status}
          </p>
        </div>
      )}
      </div>
    </main>
  )
}
