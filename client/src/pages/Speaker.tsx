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

export function SpeakerApp() {
  const [room, setRoom] = useState('demo-room')
  const [srcLang, setSrcLang] = useState('en-US')
  const [targets, setTargets] = useState('fr-CA')
  const [status, setStatus] = useState('Idle')
  const recogRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const lastSoftAt = useRef(0)
  const lastSoftText = useRef('')
  const unitIndex = useRef(0)
  const version = useRef(0)
  const sessionId = useRef(crypto.randomUUID())

  function unitId() { return `${sessionId.current}|${srcLang}|${unitIndex.current}` }

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
      } catch {}

      const audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput()
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
          const detected = detectedLangFrom(e.result) || (meta?.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang)
          await postPatch({ unitId: unitId(), stage: 'soft', op: 'replace', version: version.current, text, srcLang: detected, ts: timestamps(e.result) })
        }
      }

      recognizer.recognized = async (_s: any, e: any) => {
        if (!e?.result) return
        if (e.result.reason === SDK.ResultReason.RecognizedSpeech) {
          const text = e.result.text.trim()
          if (!text) return
          version.current += 1
          const detected = detectedLangFrom(e.result) || (meta?.sourceLang && meta.sourceLang !== 'auto' ? meta.sourceLang : srcLang)
          await postPatch({ unitId: unitId(), stage: 'hard', op: 'replace', version: version.current, text, srcLang: detected, ts: timestamps(e.result) })
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
  }

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
          <Input value={srcLang} onChange={(e)=>setSrcLang(e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block">Targets</Label>
          <Input value={targets} onChange={(e)=>setTargets(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <Button onClick={start}>Start</Button>
        <Button variant="outline" onClick={stop}>Stop</Button>
        <span className="text-sm text-slate-400">{status}</span>
      </div>
    </main>
  )
}
