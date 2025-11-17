import React, { useEffect, useRef, useState } from 'react'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Button } from '../components/ui/button'

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
  return body as { token: string; region: string }
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
  const [srcLang, setSrcLang] = useState('en-US')
  const [targets, setTargets] = useState('fr-CA')
  const [status, setStatus] = useState('Idle')
  const [roomMeta, setRoomMeta] = useState<any>(null)
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([])  // Store recent transcriptions
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const recogRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const lastSoftAt = useRef(0)
  const lastSoftText = useRef('')
  const unitIndex = useRef(0)
  const version = useRef(0)
  const sessionId = useRef(crypto.randomUUID())
  const isAutoDetect = useRef(false)  // Track if using auto-detect mode

  // Set page title
  useEffect(() => {
    document.title = 'Simo'
  }, [])

  // Language stability tracking (for auto-detect mode)
  const langStability = useRef({
    current: '',  // Currently active language
    detectedAt: 0,  // Timestamp when language was locked
    switchCandidate: null as string | null,  // Candidate new language
    switchCount: 0  // Consecutive detections of candidate
  })

  function unitId() { return `${sessionId.current}|${srcLang}|${unitIndex.current}` }

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

    // Lock language for 15 seconds after detection (configurable via SPEECH_LANG_STABILITY_SEC)
    const lockDurationMs = 15000  // TODO: Make configurable
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

  async function postPatch(patch: any) {
    const payload = { roomId: room, targets: targets.split(',').map(s=>s.trim()).filter(Boolean), patch }
    try { await fetch('/api/segments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) } catch {}
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

  async function start() {
    try {
      setStatus('Loading Speech SDK…')
      const SDK = await loadSpeechCdn()
      setStatus('Fetching token…')
      const { token, region } = await fetchToken()
      const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(token, region)
      speechConfig.outputFormat = SDK.OutputFormat.Detailed

      // Load room metadata to configure fixed vs. auto-detect languages
      let meta: any = null
      try {
        const r = await fetch(`/api/rooms/${encodeURIComponent(room)}`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({} as any))
        if (r.ok && j?.ok && j?.room) meta = j.room
        if (meta) setRoomMeta(meta)
      } catch {}

      // Use selected device or default microphone
      const audioConfig = selectedDeviceId
        ? SDK.AudioConfig.fromMicrophoneInput(selectedDeviceId)
        : SDK.AudioConfig.fromDefaultMicrophoneInput()
      let recognizer: any = null

      // Helper to read detected language from SDK result
      function detectedLangFrom(result: any): string | undefined {
        try {
          if (SDK.AutoDetectSourceLanguageResult?.fromResult) {
            const det = SDK.AutoDetectSourceLanguageResult.fromResult(result)
            if (det?.language) return String(det.language)
          }
          const propId = SDK.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
          const raw = result?.properties?.getProperty?.(propId)
          if (raw) return String(raw)
        } catch {}
        return undefined
      }

      // Configure recognizer from room meta
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
        const delta = text.length - lastSoftText.current.length
        const timeOk = now - lastSoftAt.current > 1000
        const charOk = delta > 18
        const punct = /[.?!]\s*$/.test(text)
        if ((punct || charOk) && timeOk) {
          lastSoftText.current = text
          lastSoftAt.current = now
          version.current += 1
          const rawDetected = detectedLangFrom(e.result)
          const fallback = (meta?.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang)
          const stableLang = getStableLanguage(rawDetected, fallback)
          await postPatch({ unitId: unitId(), stage: 'soft', op: 'replace', version: version.current, text, srcLang: stableLang, ts: timestamps(e.result) })
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
          await postPatch({ unitId: unitId(), stage: 'hard', op: 'replace', version: version.current, text, srcLang: stableLang, ts: timestamps(e.result) })
          unitIndex.current += 1
          version.current = 0
          lastSoftText.current = ''
          lastSoftAt.current = Date.now()
        }
      }

      recognizer.sessionStarted = () => setStatus('Session started')
      recognizer.sessionStopped = () => setStatus('Session stopped')
      recognizer.canceled = (_s: any, e: any) => setStatus('Canceled')
      recognizer.startContinuousRecognitionAsync()
    } catch (e: any) {
      setStatus('Error: ' + (e?.message || 'unknown'))
    }
  }

  function stop() {
    try { wsRef.current?.close() } catch {}
    const r = recogRef.current
    if (r) {
      try { r.stopContinuousRecognitionAsync(()=>{},()=>{}) } catch {}
      try { r.close() } catch {}
    }
    recogRef.current = null
    setStatus('Idle')
    setTranscriptHistory([])  // Clear transcript history when stopping
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
        // Auto-select default device
        if (audioInputs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(audioInputs[0].deviceId)
        }
      } catch (err) {
        console.error('Failed to enumerate devices:', err)
      }
    }
    getDevices()
  }, [])

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

  return (
    <main className="container mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Speaker</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div>
          <Label className="mb-1 block">Room</Label>
          <Input value={room} onChange={(e)=>setRoom(e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block">Source language</Label>
          {roomMeta?.sourceLang === 'auto' ? (
            <Input value={`auto (${(roomMeta.autoDetectLangs||[]).slice(0,4).join(',')})`} readOnly />
          ) : (
            <Input value={srcLang} onChange={(e)=>setSrcLang(e.target.value)} />
          )}
        </div>
        <div>
          <Label className="mb-1 block">Targets</Label>
          <Input value={targets} onChange={(e)=>setTargets(e.target.value)} />
        </div>
      </div>

      {/* Audio device selector */}
      <div className="mb-4">
        <Label className="mb-1 block">Audio Input Device</Label>
        <select
          value={selectedDeviceId}
          onChange={(e) => setSelectedDeviceId(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-slate-800 text-slate-100 px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&>option]:bg-slate-800 [&>option]:text-slate-100"
        >
          {audioDevices.map(device => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `Device ${device.deviceId.substring(0, 8)}...`}
            </option>
          ))}
        </select>
        {audioDevices.length === 0 && (
          <p className="text-xs text-slate-500 mt-1">No audio devices found. Allow microphone access to see devices.</p>
        )}
      </div>
      <div className="flex items-center gap-2 mb-3">
        <Button onClick={start}>Start</Button>
        <Button variant="outline" onClick={stop}>Stop</Button>
        <span className="text-sm text-slate-400">{status}</span>
      </div>

      {/* Live Transcription Monitor */}
      {transcriptHistory.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Live Transcription (Original)</h2>
          <div className="bg-slate-800/50 rounded-lg p-4 space-y-1 max-h-48 overflow-y-auto">
            {transcriptHistory.map((text, idx) => (
              <div key={idx} className="text-sm text-slate-200">
                {text}
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1">Showing last {transcriptHistory.length} sentence{transcriptHistory.length !== 1 ? 's' : ''}</p>
        </div>
      )}

      {/* Debug Info */}
      {status.startsWith('Error') && (
        <div className="mt-4 p-3 bg-red-900/20 border border-red-500/30 rounded-md">
          <p className="text-sm text-red-300">
            {status.includes('Token failed') ?
              'Failed to get Azure Speech token. Please check your SPEECH_KEY and SPEECH_REGION in .env file.' :
              status}
          </p>
        </div>
      )}
    </main>
  )
}
