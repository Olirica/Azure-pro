import React, { useEffect, useRef, useState } from 'react'

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

function getRoomFromUrl(): string {
  try {
    if (typeof window === 'undefined') return 'demo-room'
    const url = new URL(window.location.href)
    const r = url.searchParams.get('room')
    return (r && r.trim()) ? r.trim().toLowerCase() : 'demo-room'
  } catch {
    return 'demo-room'
  }
}

// ============================================================================
// Aurora Glass Design System
// ============================================================================
const glassPanel = "relative backdrop-blur-xl bg-white/[0.03] border border-white/[0.08] rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)]"
const glassInput = "w-full bg-white/[0.03] backdrop-blur border border-white/[0.1] rounded-xl px-4 py-3 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all duration-200"
const glassSelect = "w-full bg-white/[0.03] backdrop-blur border border-white/[0.1] rounded-xl px-4 py-3 text-white/90 focus:outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all duration-200 appearance-none cursor-pointer"
const glassTextarea = "w-full bg-white/[0.03] backdrop-blur border border-white/[0.1] rounded-xl px-4 py-3 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all duration-200 resize-none"
const btnPrimary = "relative px-6 py-3 rounded-xl font-semibold text-sm tracking-wide transition-all duration-200 bg-gradient-to-br from-cyan-500/80 to-teal-600/80 text-white shadow-[0_4px_20px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] hover:shadow-[0_6px_24px_rgba(20,184,166,0.4),inset_0_1px_0_rgba(255,255,255,0.3)] hover:translate-y-[-1px] active:translate-y-[1px] active:shadow-[0_2px_12px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.1)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0"
const btnSecondary = "px-5 py-3 rounded-xl text-sm font-medium transition-all duration-200 bg-white/[0.03] border border-white/[0.1] text-white/70 hover:bg-white/[0.06] hover:border-white/[0.15] hover:text-white/90 disabled:opacity-40 disabled:cursor-not-allowed"
const btnDanger = "px-5 py-3 rounded-xl text-sm font-medium transition-all duration-200 bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 hover:border-red-500/40 hover:text-red-200 disabled:opacity-40 disabled:cursor-not-allowed"

const StatusDot = ({ active, color = 'emerald' }: { active: boolean; color?: 'emerald' | 'amber' | 'cyan' | 'red' }) => {
  const colors = {
    emerald: { bg: 'bg-emerald-400', glow: 'bg-emerald-400/20' },
    amber: { bg: 'bg-amber-400', glow: 'bg-amber-400/20' },
    cyan: { bg: 'bg-cyan-400', glow: 'bg-cyan-400/20' },
    red: { bg: 'bg-red-400', glow: 'bg-red-400/20' }
  }
  const c = colors[color]
  return (
    <div className={`relative w-2.5 h-2.5 rounded-full ${active ? c.bg : 'bg-white/20'}`}>
      {active && <div className={`absolute inset-0 rounded-full ${c.bg} animate-ping opacity-50`} />}
      {active && <div className={`absolute inset-[-3px] rounded-full ${c.glow} blur-sm`} />}
    </div>
  )
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
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([])
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [glossary, setGlossary] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [sttProvider, setSttProvider] = useState<'azure' | 'deepgram' | 'elevenlabs' | 'local-whisper'>('azure')
  const [availableProviders, setAvailableProviders] = useState<{name: string, available: boolean, isServerSide: boolean}[]>([])
  const [sttLimitations, setSttLimitations] = useState<{feature: string, message: string}[]>([])
  const recogRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const lastSoftAt = useRef(0)
  const lastSoftText = useRef('')
  const unitIndex = useRef(0)
  const version = useRef(0)
  const sessionId = useRef(crypto.randomUUID())
  const isAutoDetect = useRef(false)
  const currentUnitLang = useRef('')
  const micStreamRef = useRef<MediaStream | null>(null)
  const speechConfigRef = useRef<any>(null)
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Deepgram streaming mode refs
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioWorkletRef = useRef<AudioWorkletNode | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const deepgramWsRef = useRef<WebSocket | null>(null)

  // Fast-finals state machine
  const sttState = useRef({
    lastText: '',
    committedPrefix: '',
    lastEmitAt: 0,
  })

  useEffect(() => {
    document.title = 'Simo'
  }, [])

  useEffect(() => {
    async function fetchConfig() {
      try {
        const res = await fetch('/api/config')
        const config = await res.json()

        // Set available providers
        if (config.sttProviders && Array.isArray(config.sttProviders)) {
          setAvailableProviders(config.sttProviders)
        }

        // Restore preference from localStorage or use server default
        const saved = localStorage.getItem('stt-provider-preference')
        const available = config.sttProviders?.find((p: any) => p.name === saved && p.available)
        if (available) {
          setSttProvider(saved as typeof sttProvider)
        } else if (config.sttProvider) {
          setSttProvider(config.sttProvider as typeof sttProvider)
        }
      } catch {
        setSttProvider('azure')
      }
    }
    fetchConfig()
  }, [])

  useEffect(() => {
    return () => {
      if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current)
      if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current)
      if (audioSourceRef.current) {
        audioSourceRef.current.disconnect()
        audioSourceRef.current = null
      }
      if (audioWorkletRef.current) {
        audioWorkletRef.current.disconnect()
        audioWorkletRef.current = null
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
        audioContextRef.current = null
      }
      if (deepgramWsRef.current) {
        deepgramWsRef.current.close()
        deepgramWsRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !room) return
    try {
      const saved = localStorage.getItem(glossaryStorageKey(room))
      if (saved !== null) setGlossary(saved)
    } catch {}
  }, [room])

  useEffect(() => {
    if (typeof window === 'undefined' || !roomUnlocked || !room) return
    try {
      localStorage.setItem(glossaryStorageKey(room), glossary)
    } catch {}
  }, [roomUnlocked, room, glossary])

  const langStability = useRef({
    current: '',
    detectedAt: 0,
    switchCandidate: null as string | null,
    switchCount: 0
  })

  function unitId(lang: string) { return `${sessionId.current}|${lang}|${unitIndex.current}` }
  const glossaryStorageKey = (roomId: string) => `simo-glossary-${roomId}`

  function getProviderLabel(name: string) {
    switch (name) {
      case 'azure': return 'Azure Speech (Browser)'
      case 'deepgram': return 'Deepgram'
      case 'elevenlabs': return 'ElevenLabs Scribe'
      case 'local-whisper': return 'Local Whisper'
      default: return name
    }
  }

  function handleProviderChange(newProvider: typeof sttProvider) {
    setSttProvider(newProvider)
    localStorage.setItem('stt-provider-preference', newProvider)
  }

  function longestCommonPrefix(a: string, b: string): string {
    const max = Math.min(a.length, b.length)
    let i = 0
    while (i < max && a[i] === b[i]) i++
    return a.slice(0, i)
  }

  function getStableLanguage(detected: string | undefined, fallback: string): string {
    if (!isAutoDetect.current || !detected) return fallback
    const now = Date.now()
    const stability = langStability.current
    if (!stability.current) {
      stability.current = detected
      stability.detectedAt = now
      return detected
    }
    const timeSinceLock = now - stability.detectedAt
    const lockDurationMs = 8000
    if (timeSinceLock < lockDurationMs) return stability.current
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

  function timestamps(result: any) {
    if (!result) return undefined
    const offsetMs = Math.floor(result.offset / 10000)
    const durationMs = Math.floor(result.duration / 10000)
    return { t0: offsetMs, t1: offsetMs + durationMs }
  }

  function snapToWordBoundary(text: string, charPos: number): number {
    if (charPos >= text.length) return text.length
    if (charPos === 0 || /\s/.test(text[charPos])) return charPos
    const lastSpace = text.lastIndexOf(' ', charPos - 1)
    if (lastSpace > 0) return lastSpace
    return charPos
  }

  async function postPatch(patch: any) {
    const payload = { roomId: room, targets: targets.split(',').map(s=>s.trim()).filter(Boolean), patch }
    try { await fetch('/api/segments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch {}
  }

  async function buildAudioConfig(SDK: any, deviceId?: string) {
    try {
      if (navigator.permissions) {
        const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName })
        if (permissionStatus.state === 'denied') {
          console.error('[Speaker] Microphone permission DENIED')
        }
      }
    } catch {}

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    }
    if (deviceId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach(t => t.stop())
        }
        micStreamRef.current = stream
        return SDK.AudioConfig.fromStreamInput(stream)
      } catch {
        // fallback
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

  // ============================================================================
  // Deepgram Streaming Mode
  // ============================================================================
  async function startDeepgram(deviceOverride?: string) {
    try {
      setStatus('Connecting…')
      const deviceToUse = deviceOverride || selectedDeviceId
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceToUse ? { deviceId: { exact: deviceToUse } } : {})
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      micStreamRef.current = stream

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const wsUrl = `${proto}://${window.location.host}/ws?role=speaker&room=${encodeURIComponent(room)}&stt=stream&provider=${encodeURIComponent(sttProvider)}`
      const ws = new WebSocket(wsUrl)
      deepgramWsRef.current = ws

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)
        ws.onopen = () => { clearTimeout(timeout); resolve() }
        ws.onerror = (err) => { clearTimeout(timeout); reject(err) }
      })

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'stt:ready') {
            setStatus('Listening')
            if (msg.payload?.limitations?.length > 0) {
              setSttLimitations(msg.payload.limitations)
            } else {
              setSttLimitations([])
            }
          }
          if (msg.type === 'stt:error') setStatus('Error: ' + (msg.payload?.error || 'STT error'))
          if (msg.type === 'patch' && msg.payload) {
            const patch = msg.payload
            // Show both soft and hard patches (Deepgram produces many interim results)
            if (patch.text && !patch.targetLang) {
              setTranscriptHistory(prev => {
                // For soft patches, update the last entry if same unitId
                if (patch.stage === 'soft' && prev.length > 0) {
                  const updated = [...prev]
                  updated[updated.length - 1] = patch.text
                  return updated
                }
                // For hard patches, add new entry
                return [...prev, patch.text].slice(-7)
              })
            }
          }
        } catch {}
      }

      ws.onclose = () => {
        if (isRecording) {
          setStatus('Disconnected')
          setIsRecording(false)
        }
      }

      const audioCtx = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioCtx

      // Resume if suspended (browser autoplay policy)
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume()
      }

      await audioCtx.audioWorklet.addModule('/pcm-worklet.js')

      const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor')
      audioWorkletRef.current = worklet
      const source = audioCtx.createMediaStreamSource(stream)
      audioSourceRef.current = source  // Prevent GC
      source.connect(worklet)
      // Connect to destination to keep audio graph alive (output is silent)
      worklet.connect(audioCtx.destination)

      worklet.port.onmessage = (e) => {
        if (ws.readyState === WebSocket.OPEN && e.data instanceof ArrayBuffer) {
          ws.send(e.data)
        }
      }

      ws.send(JSON.stringify({
        type: 'stt:start',
        payload: {
          targetLangs: targets.split(',').map(s => s.trim()).filter(Boolean),
          phraseHints: glossary.split(/\n|,|;/).map(p => p.trim()).filter(Boolean)
        }
      }))

      setStatus('Listening')
    } catch (err: any) {
      setStatus('Error: ' + (err?.message || 'unknown'))
      setIsRecording(false)
      if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
      if (audioSourceRef.current) { audioSourceRef.current.disconnect(); audioSourceRef.current = null }
      if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null }
      if (deepgramWsRef.current) { deepgramWsRef.current.close(); deepgramWsRef.current = null }
    }
  }

  async function stopDeepgram() {
    setStatus('Stopping…')
    if (deepgramWsRef.current?.readyState === WebSocket.OPEN) {
      deepgramWsRef.current.send(JSON.stringify({ type: 'stt:stop', payload: {} }))
    }
    if (audioSourceRef.current) { audioSourceRef.current.disconnect(); audioSourceRef.current = null }
    if (audioWorkletRef.current) { audioWorkletRef.current.disconnect(); audioWorkletRef.current = null }
    if (audioContextRef.current) { await audioContextRef.current.close(); audioContextRef.current = null }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
    if (deepgramWsRef.current) { deepgramWsRef.current.close(); deepgramWsRef.current = null }
    setStatus('Idle')
    setTranscriptHistory([])
    setIsRecording(false)
  }

  // ============================================================================
  // Azure STT Mode
  // ============================================================================
  async function startAzure(deviceOverride?: string) {
    try {
      setStatus('Loading SDK…')
      const SDK = await loadSpeechCdn()
      setStatus('Fetching token…')
      const { token, region, expiresInSeconds } = await fetchToken()
      const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(token, region)
      speechConfigRef.current = speechConfig
      speechConfig.outputFormat = SDK.OutputFormat.Detailed
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_PostProcessingOption, 'TrueText') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_ContinuousLanguageIdPriority, 'Accuracy') } catch {}
      try { speechConfig.enableDictation() } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_StablePartialResultThreshold, '2') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_RequestSentenceBoundary, 'true') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_RequestWordBoundary, 'true') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceResponse_RequestPunctuationBoundary, 'true') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_EnableAudioProcessing, 'true') } catch {}
      try { speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '5000') } catch {}

      const refreshMs = ((expiresInSeconds || 600) - 60) * 1000
      if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current)
      const scheduleTokenRefresh = () => {
        tokenRefreshTimerRef.current = setTimeout(async () => {
          try {
            const fresh = await fetchToken()
            if (recogRef.current) recogRef.current.authorizationToken = fresh.token
            scheduleTokenRefresh()
          } catch {
            tokenRefreshTimerRef.current = setTimeout(scheduleTokenRefresh, 30000)
          }
        }, refreshMs)
      }
      scheduleTokenRefresh()

      let meta: any = null
      try {
        const r = await fetch(`/api/rooms/${encodeURIComponent(room)}`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({} as any))
        if (r.ok && j?.ok && j?.room) meta = j.room
        if (meta) setRoomMeta(meta)
      } catch {}

      const deviceToUse = deviceOverride || selectedDeviceId
      const audioConfig = await buildAudioConfig(SDK, deviceToUse)
      let recognizer: any = null

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

      if (meta && meta.sourceLang === 'auto' && Array.isArray(meta.autoDetectLangs) && meta.autoDetectLangs.length) {
        const candidates: string[] = meta.autoDetectLangs.slice(0, 4)
        isAutoDetect.current = true
        if (candidates.length >= 2) {
          speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous')
        }
        const autoCfg = SDK.AutoDetectSourceLanguageConfig.fromLanguages(candidates)
        recognizer = SDK.SpeechRecognizer.FromConfig(speechConfig, autoCfg, audioConfig)
        if ((!targets || !targets.trim()) && Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
          setTargets(meta.defaultTargetLangs.join(','))
        }
      } else {
        isAutoDetect.current = false
        const fixed = meta && meta.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang
        speechConfig.speechRecognitionLanguage = fixed
        recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig)
        if ((!targets || !targets.trim()) && Array.isArray(meta?.defaultTargetLangs) && meta.defaultTargetLangs.length) {
          setTargets(meta.defaultTargetLangs.join(','))
        }
      }

      recogRef.current = recognizer
      const phrases = glossary.split(/\n|,|;/).map((p) => p.trim()).filter(Boolean)
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
        if (isAutoDetect.current && e.result?.duration) {
          const audioDurationMs = e.result.duration / 10000
          if (audioDurationMs < 2000) return
        }
        const now = Date.now()
        const text = e.result.text.trim()
        if (!text) return

        if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current)
        flushTimeoutRef.current = setTimeout(async () => {
          const uncommitted = sttState.current.lastText
          const alreadyCommitted = sttState.current.committedPrefix
          if (uncommitted && uncommitted.length > alreadyCommitted.length) {
            const toFlush = uncommitted.trim()
            if (toFlush.length > alreadyCommitted.length) {
              version.current += 1
              const langForUnit = currentUnitLang.current || srcLang
              await postPatch({
                unitId: unitId(langForUnit),
                stage: 'hard',
                op: 'replace',
                version: version.current,
                text: toFlush,
                srcLang: langForUnit,
                ttsFinal: true,
                ts: { offset: 0, duration: 0 }
              })
              sttState.current.committedPrefix = toFlush
              sttState.current.lastEmitAt = Date.now()
            }
          }
        }, 4000)

        const prev = sttState.current.lastText
        const prefix = longestCommonPrefix(prev, text)
        if (prefix.length > sttState.current.committedPrefix.length) {
          const extension = prefix.slice(sttState.current.committedPrefix.length)
          const extensionChars = extension.length
          const timeSinceEmit = now - sttState.current.lastEmitAt
          const hasNewSentence = /[.?!]\s/.test(extension)
          const prefixEndsSentence = /[.?!]\s*$/.test(prefix)
          const enoughNewChars = extensionChars >= 45
          const timeOk = timeSinceEmit >= 800

          if ((hasNewSentence || prefixEndsSentence || enoughNewChars) && timeOk) {
            const guardChars = 10
            const total = prefix.length
            let guardedLen = Math.max(sttState.current.committedPrefix.length, total - guardChars)
            if (prefixEndsSentence && guardedLen < total) {
              guardedLen = total
            } else if (guardedLen < total) {
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
                stage: 'hard',
                op: 'replace',
                version: version.current,
                text: candidate,
                srcLang: langForUnit,
                ttsFinal: candidateIsSentence,
                ts: timestamps(e.result),
              })
              sttState.current.committedPrefix = candidate
              sttState.current.lastEmitAt = now
            }
          }
        }
        sttState.current.lastText = text

        const delta = text.length - lastSoftText.current.length
        const softTimeOk = now - lastSoftAt.current > 700
        const softCharOk = delta > 12
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
          setTranscriptHistory(prev => [...prev, text].slice(-7))
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
            ttsFinal: true,
            ts: timestamps(e.result)
          })
          unitIndex.current += 1
          version.current = 0
          lastSoftText.current = ''
          lastSoftAt.current = Date.now()
          currentUnitLang.current = ''
          sttState.current = { lastText: '', committedPrefix: '', lastEmitAt: 0 }
          if (flushTimeoutRef.current) {
            clearTimeout(flushTimeoutRef.current)
            flushTimeoutRef.current = null
          }
        }
      }

      recognizer.sessionStarted = () => setStatus('Listening')
      recognizer.sessionStopped = () => { setStatus('Idle'); setIsRecording(false); currentUnitLang.current = '' }
      recognizer.canceled = () => { setStatus('Canceled'); setIsRecording(false); currentUnitLang.current = '' }
      recognizer.startContinuousRecognitionAsync()
    } catch (e: any) {
      setStatus('Error: ' + (e?.message || 'unknown'))
      try { wsRef.current?.close() } catch {}
      setIsRecording(false)
    }
  }

  async function stopAzure() {
    setStatus('Stopping…')
    if (tokenRefreshTimerRef.current) { clearTimeout(tokenRefreshTimerRef.current); tokenRefreshTimerRef.current = null }
    if (flushTimeoutRef.current) { clearTimeout(flushTimeoutRef.current); flushTimeoutRef.current = null }
    speechConfigRef.current = null
    try { wsRef.current?.close() } catch {}
    wsRef.current = null
    const r = recogRef.current
    if (r) {
      try {
        await new Promise<void>((resolve) => {
          try { r.stopContinuousRecognitionAsync(()=>resolve(), ()=>resolve()) } catch { resolve() }
        })
      } catch {}
      try { r.close() } catch {}
    }
    recogRef.current = null
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
    setStatus('Idle')
    setTranscriptHistory([])
    setIsRecording(false)
    currentUnitLang.current = ''
  }

  // ============================================================================
  // Dispatcher
  // ============================================================================
  async function start(deviceOverride?: string) {
    if (isRecording) return
    setIsRecording(true)
    sessionId.current = crypto.randomUUID()
    unitIndex.current = 0
    version.current = 0
    currentUnitLang.current = ''
    langStability.current = { current: '', detectedAt: 0, switchCandidate: null, switchCount: 0 }
    lastSoftText.current = ''
    lastSoftAt.current = 0
    sttState.current = { lastText: '', committedPrefix: '', lastEmitAt: 0 }

    // Check if selected provider is server-side
    const provider = availableProviders.find(p => p.name === sttProvider)
    const isServerSide = provider?.isServerSide ?? (sttProvider !== 'azure')

    if (isServerSide) {
      // All server-side providers use same WebSocket streaming
      await startDeepgram(deviceOverride)
    } else {
      await startAzure(deviceOverride)
    }
  }

  async function stop() {
    const provider = availableProviders.find(p => p.name === sttProvider)
    const isServerSide = provider?.isServerSide ?? (sttProvider !== 'azure')

    if (isServerSide) {
      await stopDeepgram()
    } else {
      await stopAzure()
    }
  }

  async function handleDeviceChange(deviceId: string) {
    setSelectedDeviceId(deviceId)
    if (isRecording) {
      setStatus('Switching…')
      try {
        if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
      } catch {}
      await stop()
      await start(deviceId)
    }
  }

  useEffect(() => {
    async function getDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true })
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioInputs = devices.filter(d => d.kind === 'audioinput')
        setAudioDevices(audioInputs)
        const stillExists = audioInputs.find(d => d.deviceId === selectedDeviceId)
        if (!stillExists) {
          if (audioInputs.length > 0) setSelectedDeviceId(audioInputs[0].deviceId)
          else setSelectedDeviceId('')
        }
      } catch {}
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

  async function unlockRoom(e: React.FormEvent) {
    e.preventDefault()
    setUnlockError('')
    const code = roomInput.trim()
    if (!code) { setUnlockError('Please enter a room code'); return }
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, { cache: 'no-store' })
      const body = await res.json().catch(() => ({} as any))
      if (!res.ok || !body?.ok || !body?.room) {
        setUnlockError('Invalid room code')
        return
      }
      const meta = body.room
      setRoom(code)
      setRoomMeta(meta)
      setRoomUnlocked(true)
      if (meta.sourceLang && meta.sourceLang !== 'auto') setSrcLang(meta.sourceLang)
      if (Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
        setTargets(meta.defaultTargetLangs.join(','))
      }
    } catch {
      setUnlockError('Failed to validate room code')
    }
  }

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
          if (meta.sourceLang && meta.sourceLang !== 'auto') setSrcLang(meta.sourceLang)
          if (Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
            setTargets(meta.defaultTargetLangs.join(','))
          }
        }
      } catch {}
    }
    load()
    return () => { cancelled = true }
  }, [room])

  // ============================================================================
  // Render: Room Unlock Screen
  // ============================================================================
  if (!roomUnlocked) {
    return (
      <>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap');
          @keyframes aurora { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
          @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
          .aurora-bg { background: linear-gradient(-45deg, #0a0f1c, #1a1f3c, #0f172a, #1e1b4b, #0c1929); background-size: 400% 400%; animation: aurora 20s ease infinite; }
          .float-animation { animation: float 6s ease-in-out infinite; }
        `}</style>
        <main className="aurora-bg min-h-screen flex items-center justify-center p-6" style={{ fontFamily: "'DM Sans', sans-serif" }}>
          <div className="w-full max-w-md">
            {/* Logo & Title */}
            <div className="text-center mb-8">
              <div className="float-animation w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-teal-500/20 border border-cyan-400/20 flex items-center justify-center shadow-[0_0_40px_rgba(6,182,212,0.15)]">
                <svg className="w-10 h-10 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
              <h1 className="text-3xl font-semibold text-white/90 mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>Speaker Access</h1>
              <p className="text-white/40 text-sm">Enter your room code to begin broadcasting</p>
            </div>

            {/* Unlock Form */}
            <form onSubmit={unlockRoom} className={`${glassPanel} p-8`}>
              <div className="mb-6">
                <label className="block text-white/50 text-xs font-medium uppercase tracking-wider mb-2">Room Code</label>
                <input
                  type="text"
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  placeholder="Enter room code"
                  className={`${glassInput} text-center text-lg tracking-widest`}
                  autoFocus
                />
              </div>
              <button type="submit" className={`${btnPrimary} w-full flex items-center justify-center gap-2`}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                Access Room
              </button>
              {unlockError && (
                <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                  <p className="text-sm text-red-300 text-center">{unlockError}</p>
                </div>
              )}
            </form>
          </div>
        </main>
      </>
    )
  }

  // ============================================================================
  // Render: Main Speaker Interface
  // ============================================================================
  const isListening = status === 'Listening' || status === 'Session started'
  const hasError = status.startsWith('Error')

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap');
        @keyframes aurora { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
        @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
        @keyframes pulse-ring { 0% { transform: scale(0.95); opacity: 1; } 50% { transform: scale(1.1); opacity: 0.5; } 100% { transform: scale(0.95); opacity: 1; } }
        .aurora-bg { background: linear-gradient(-45deg, #0a0f1c, #1a1f3c, #0f172a, #1e1b4b, #0c1929); background-size: 400% 400%; animation: aurora 20s ease infinite; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
        .pulse-ring { animation: pulse-ring 2s ease-in-out infinite; }
      `}</style>
      <main className="aurora-bg min-h-screen px-4 py-8" style={{ fontFamily: "'DM Sans', sans-serif" }}>
        <div className="container mx-auto max-w-3xl">
          {/* Header */}
          <header className="mb-8">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-3xl font-semibold text-white/90 mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Speaker</h1>
                <p className="text-white/40 text-sm">Configure and start your broadcast</p>
              </div>
              <div className={`${glassPanel} px-4 py-2`}>
                <div className="text-white/40 text-[10px] uppercase tracking-wider mb-0.5">Room</div>
                <code className="text-cyan-400 text-sm font-medium">{room}</code>
              </div>
            </div>
          </header>

          {/* Main Control Panel */}
          <div className={`${glassPanel} p-6 mb-6`}>
            {/* Language Configuration */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-white/50 text-xs font-medium uppercase tracking-wider mb-2">Source Language</label>
                {roomMeta?.sourceLang === 'auto' ? (
                  <input
                    value={`auto (${(roomMeta.autoDetectLangs||[]).slice(0,4).join(', ')})`}
                    readOnly
                    className={`${glassInput} opacity-60`}
                  />
                ) : (
                  <input
                    value={srcLang}
                    onChange={(e)=>setSrcLang(e.target.value)}
                    className={glassInput}
                    placeholder="e.g., en-US"
                  />
                )}
              </div>
              <div>
                <label className="block text-white/50 text-xs font-medium uppercase tracking-wider mb-2">Target Languages</label>
                <input
                  value={targets}
                  onChange={(e)=>setTargets(e.target.value)}
                  className={glassInput}
                  placeholder="e.g., fr-CA, es-ES"
                />
              </div>
            </div>

            {/* Audio Device */}
            <div className="mb-6">
              <label className="block text-white/50 text-xs font-medium uppercase tracking-wider mb-2">Audio Input</label>
              <div className="relative">
                <select
                  value={selectedDeviceId}
                  onChange={(e) => handleDeviceChange(e.target.value)}
                  className={glassSelect}
                  style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23ffffff40'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '20px' }}
                >
                  {audioDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId} className="bg-slate-900 text-white">
                      {device.label || `Device ${device.deviceId.substring(0, 8)}...`}
                    </option>
                  ))}
                </select>
              </div>
              {audioDevices.length === 0 && (
                <p className="text-white/30 text-xs mt-2">No audio devices found. Allow microphone access.</p>
              )}
            </div>

            {/* STT Provider */}
            {availableProviders.length > 0 && (
              <div className="mb-6">
                <label className="block text-white/50 text-xs font-medium uppercase tracking-wider mb-2">Speech Recognition</label>
                <div className="relative">
                  <select
                    value={sttProvider}
                    onChange={(e) => handleProviderChange(e.target.value as typeof sttProvider)}
                    disabled={isRecording}
                    className={glassSelect}
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23ffffff40'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '20px' }}
                  >
                    {availableProviders.map(p => (
                      <option key={p.name} value={p.name} disabled={!p.available} className="bg-slate-900 text-white">
                        {getProviderLabel(p.name)}{!p.available ? ' (unavailable)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {isRecording && (
                  <p className="text-white/30 text-xs mt-2">Stop recording to change provider</p>
                )}
                {sttLimitations.length > 0 && (
                  <div className="mt-2 flex items-start gap-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/30">
                    <span className="text-yellow-400 text-sm mt-0.5">⚠</span>
                    <div className="text-yellow-200/80 text-xs">
                      {sttLimitations.map((l, i) => (
                        <p key={i}>{l.message}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Glossary */}
            <div className="mb-6">
              <label className="block text-white/50 text-xs font-medium uppercase tracking-wider mb-2">Glossary / Phrase Hints</label>
              <textarea
                value={glossary}
                onChange={(e)=> setGlossary(e.target.value)}
                placeholder="Product names, acronyms, people names... one per line"
                className={`${glassTextarea} h-24`}
              />
              <p className="text-white/30 text-xs mt-2">
                These hints improve recognition accuracy for domain-specific terms.
              </p>
            </div>

            {/* Control Bar */}
            <div className="flex items-center gap-3 pt-4 border-t border-white/[0.06]">
              <button
                onClick={() => start()}
                disabled={isRecording}
                className={btnPrimary}
              >
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Start Recording
                </span>
              </button>
              <button
                onClick={stop}
                disabled={!isRecording && status === 'Idle'}
                className={btnDanger}
              >
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  Stop
                </span>
              </button>
              <div className="flex items-center gap-2 ml-auto">
                <StatusDot active={isListening} color={hasError ? 'red' : isListening ? 'emerald' : 'amber'} />
                <span className={`text-sm ${hasError ? 'text-red-400' : isListening ? 'text-emerald-400' : 'text-white/50'}`}>
                  {status}
                </span>
              </div>
            </div>
          </div>

          {/* Live Transcription */}
          {transcriptHistory.length > 0 && (
            <div className={`${glassPanel} p-6`}>
              <div className="flex items-center gap-2 mb-4">
                <div className="relative">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                  <div className="absolute inset-0 rounded-full bg-emerald-400 pulse-ring" />
                </div>
                <h2 className="text-white/80 font-medium" style={{ fontFamily: "'Outfit', sans-serif" }}>Live Transcription</h2>
                <span className="text-white/30 text-xs ml-auto">Source audio</span>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
                {transcriptHistory.map((text, idx) => (
                  <div
                    key={idx}
                    className="text-sm text-white/80 bg-white/[0.02] rounded-xl p-4 border border-white/[0.05] hover:bg-white/[0.04] transition-colors"
                  >
                    {text}
                  </div>
                ))}
              </div>
              <p className="text-white/30 text-xs mt-3">
                Showing last {transcriptHistory.length} utterance{transcriptHistory.length !== 1 ? 's' : ''}
              </p>
            </div>
          )}

          {/* Error Display */}
          {hasError && (
            <div className={`${glassPanel} p-4 mt-6 border-red-500/30`}>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-red-300 text-sm font-medium mb-1">Connection Error</p>
                  <p className="text-red-300/70 text-sm">
                    {status.includes('Token failed') ?
                      'Failed to get Azure Speech token. Check SPEECH_KEY and SPEECH_REGION.' :
                      status.replace('Error: ', '')}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
