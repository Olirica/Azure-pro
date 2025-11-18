import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { LANGS } from '../data/languages'

type Patch = {
  unitId: string
  version: number
  stage: 'soft' | 'hard'
  text: string
  srcLang?: string
  ts?: { t0: number; t1: number }
  receivedAt?: number
}

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

type TtsEvent = {
  timestamp: number
  type: 'received' | 'playing' | 'played' | 'error'
  format?: string
  audioSize?: number
  error?: string
}

export function ListenerApp() {
  const [room] = useState(getRoomFromUrl())
  const [lang, setLang] = useState('fr-CA')
  const [tts, setTts] = useState(true)
  const [status, setStatus] = useState('Idle')
  const [roomMeta, setRoomMeta] = useState<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [patches, setPatches] = useState<Map<string, Patch>>(new Map())

  // TTS queue
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsQueueRef = useRef<{ src: string; mime: string; unitId?: string }[]>([])
  const [ttsEvents, setTtsEvents] = useState<TtsEvent[]>([])
  const isPlayingRef = useRef(false)

  function playNextTts() {
    const el = audioRef.current
    if (!el) return
    const next = ttsQueueRef.current.shift()
    if (!next) {
      isPlayingRef.current = false
      return
    }
    try {
      el.src = next.src
      const p = el.play()
      isPlayingRef.current = true
      if (p && typeof (p as any).catch === 'function') {
        ;(p as any).catch((err: any) => {
          console.error('[TTS] Play failed:', err)
          setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'error', error: err?.message || 'Play failed' }])
          playNextTts()
        })
      }
    } catch (err: any) {
      console.error('[TTS] Play threw:', err)
      setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'error', error: err?.message || 'Play threw' }])
      playNextTts()
    }
  }

  // Batch patches per animation frame
  const patchBufferRef = useRef<Patch[]>([])
  const rafFlushRef = useRef<number | null>(null)
  function flushPatchBuffer() {
    setPatches(prev => {
      const map = new Map(prev)
      for (const p of patchBufferRef.current) {
        const cur = map.get(p.unitId)
        if (!cur || p.version >= cur.version) {
          map.set(p.unitId, p)
        }
      }
      patchBufferRef.current = []
      return map
    })
    rafFlushRef.current = null
  }
  function schedulePatchFlush() {
    if (rafFlushRef.current == null) {
      rafFlushRef.current = requestAnimationFrame(flushPatchBuffer)
    }
  }

  // Set page title
  useEffect(() => { document.title = 'Simo' }, [])

  // Debug toggle via ?debug=true
  const debugMode = useMemo(() => {
    try { return new URLSearchParams(window.location.search).get('debug') === 'true' } catch { return false }
  }, [])

  const getLangName = (code: string): string => {
    const l = LANGS.find(x => x.code.toLowerCase() === code.toLowerCase())
    return l?.name || code
  }

  // Setup audio element
  useEffect(() => {
    if (audioRef.current) return
    const audio = new Audio()
    audioRef.current = audio
    audio.addEventListener('loadstart', () => console.log('[TTS] Load started'))
    audio.addEventListener('canplay', () => console.log('[TTS] Can play'))
    audio.addEventListener('play', () => setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'playing' }]))
    audio.addEventListener('ended', () => {
      setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'played' }])
      isPlayingRef.current = false
      playNextTts()
    })
    audio.addEventListener('error', () => {
      const msg = audio.error ? `Error code: ${audio.error.code}, message: ${audio.error.message}` : 'Unknown error'
      console.error('[TTS] Audio error:', msg)
      setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'error', error: msg }])
      isPlayingRef.current = false
      playNextTts()
    })
  }, [])

  // Fetch room meta
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
          if (Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
            setLang(meta.defaultTargetLangs[0])
          }
        }
      } catch {}
    }
    load()
    return () => { cancelled = true }
  }, [room])

  // Auto-connect immediately when ready
  const lastAutoConnectKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (roomMeta && lang && status === 'Idle') {
      const key = `${room}|${lang}`
      if (lastAutoConnectKeyRef.current !== key) {
        lastAutoConnectKeyRef.current = key
        connect()
      }
    }
  }, [roomMeta, lang, status])

  function connect() {
    try { wsRef.current?.close() } catch {}
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?role=listener&room=${encodeURIComponent(room)}&lang=${encodeURIComponent(lang)}&tts=${tts}`
    if (debugMode) console.log('[Listener] Connecting:', { url, room, lang, tts })
    const ws = new WebSocket(url)
    wsRef.current = ws
    setStatus('Connecting')
    ws.onopen = () => setStatus('Connected')
    ws.onclose = () => setStatus('Idle')
    ws.onerror = () => setStatus('Error')
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg?.type === 'patch' && msg?.payload) {
          const p: Patch = { ...msg.payload, receivedAt: Date.now() }
          patchBufferRef.current.push(p)
          schedulePatchFlush()
        } else if (msg?.type === 'tts' && msg?.payload && tts) {
          const base64 = String(msg.payload.audio || '')
          if (base64 && base64.length > 0) {
            const fmt = String(msg.payload.format || 'audio/mpeg')
            const src = `data:${fmt};base64,${base64}`
            ttsQueueRef.current.push({ src, mime: fmt, unitId: msg.payload.unitId })
            setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'received', format: fmt, audioSize: base64.length }])
            if (!isPlayingRef.current) playNextTts()
          }
        } else if (msg?.type === 'reset') {
          setPatches(new Map())
        }
      } catch (e) {
        if (debugMode) console.warn('[Listener] Bad message', e)
      }
    }
  }

  function disconnect() {
    try { wsRef.current?.close() } catch {}
    setStatus('Idle')
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Listener</h1>
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span className="px-2 py-0.5 rounded-full border border-slate-600">{status}</span>
        </div>
      </div>

      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div>
            <Label className="mb-1 block">Language</Label>
            <select className="w-full rounded-md bg-slate-900/50 border border-slate-700 px-2 py-1.5" value={lang} onChange={(e)=> setLang(e.target.value)}>
              {LANGS.map(l => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input id="tts" type="checkbox" className="h-4 w-4" checked={tts} onChange={(e)=> setTts(e.target.checked)} />
            <Label htmlFor="tts">Enable TTS</Label>
          </div>
          <div className="flex items-center gap-2 justify-end">
            <Button type="button" onClick={connect} disabled={status === 'Connected'}>Connect</Button>
            <Button type="button" variant="outline" onClick={disconnect} disabled={status !== 'Connected'}>Disconnect</Button>
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="text-lg font-semibold mb-2">Transcript</h2>
        <ul className="space-y-2">
          {Array.from(patches.values()).sort((a,b)=> (a.receivedAt||0) - (b.receivedAt||0)).map(p => (
            <li key={p.unitId} data-stage={p.stage} className="rounded-md border border-slate-700 p-2">
              <div className="text-xs text-slate-400 mb-1">{p.stage.toUpperCase()} · {getLangName(lang)}{p.srcLang ? ` (src: ${p.srcLang})` : ''}</div>
              <div className="whitespace-pre-wrap">{p.text}</div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}

