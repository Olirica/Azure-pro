import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { LANGS } from '../data/languages'
import { cn } from '../lib/utils'

type Patch = {
  unitId: string
  version: number
  stage: 'soft' | 'hard'
  text: string
  srcLang?: string
  ts?: { t0: number; t1: number }
  receivedAt?: number
}

type Paragraph = {
  id: string
  text: string
  stage: 'soft' | 'hard'
  updatedAt: number
  unitIds: string[]
  version?: number
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

function lastMeaningfulChar(text: string): string {
  const trimmed = (text || '').trim()
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i]
    if (ch !== ' ' && ch !== '"' && ch !== "'" && ch !== ')' && ch !== ']') {
      return ch
    }
  }
  return ''
}

function endsWithTerminal(text: string): boolean {
  const lastChar = lastMeaningfulChar(text)
  return lastChar === '.' || lastChar === '!' || lastChar === '?'
}

function maybeCapitalize(prevText: string, incoming: string): string {
  if (!incoming) return incoming
  const firstChar = incoming.charAt(0)
  const alreadyUpper = firstChar === firstChar.toUpperCase()
  if (!prevText || endsWithTerminal(prevText)) {
    return alreadyUpper ? incoming : firstChar.toUpperCase() + incoming.slice(1)
  }
  return incoming
}

function rootFromUnitId(id: string | undefined): string {
  if (!id) return ''
  return id.split('#')[0]
}

type TtsEvent = {
  timestamp: number
  type: 'received' | 'playing' | 'played' | 'error'
  format?: string
  audioSize?: number
  error?: string
}

export function ListenerApp() {
  const PATCH_TTL_MS = 5 * 60 * 1000
  const [room, setRoom] = useState(getRoomFromUrl())
  const [roomInput, setRoomInput] = useState('')
  const [roomUnlocked, setRoomUnlocked] = useState(false)
  const [unlockError, setUnlockError] = useState('')
  const [lang, setLang] = useState('fr-CA')
  const [tts, setTts] = useState(true)
  const [status, setStatus] = useState('Idle')
  const [roomMeta, setRoomMeta] = useState<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [patches, setPatches] = useState<Map<string, Patch>>(new Map())
  const patchesRef = useRef<Map<string, Patch>>(new Map())
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [showDeviceSelector, setShowDeviceSelector] = useState(false)

  // TTS queue
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsQueueRef = useRef<{ src: string; mime: string; unitId?: string; version?: number | null }[]>([])
  const lastTtsVersionRef = useRef<Map<string, number>>(new Map())
  const lastTtsAudioRef = useRef<Map<string, string>>(new Map())
  const [ttsEvents, setTtsEvents] = useState<TtsEvent[]>([])
  const isPlayingRef = useRef(false)
  const [audioBlocked, setAudioBlocked] = useState(false)

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
          if (err?.name === 'NotAllowedError') {
            setAudioBlocked(true)
          }
          setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'error', error: err?.message || 'Play failed' }])
          playNextTts()
        })
      }
    } catch (err: any) {
      console.error('[TTS] Play threw:', err)
      if (err?.name === 'NotAllowedError') {
        setAudioBlocked(true)
      }
      setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'error', error: err?.message || 'Play threw' }])
      playNextTts()
    }
  }

  async function unlockAudio() {
    try {
      const el = audioRef.current
      if (!el) return
      // Try playing a silent data URI to satisfy gesture requirements
      const silent = 'data:audio/mp3;base64,/+MYxAAAAANIAAAAAExBTUUzLjk5LjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      el.src = silent
      await el.play().catch(() => {})
      setAudioBlocked(false)
      if (ttsQueueRef.current.length && !isPlayingRef.current) {
        playNextTts()
      }
    } catch (err) {
      console.error('[TTS] Unlock failed:', err)
      setAudioBlocked(true)
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

  const paragraphs = useMemo(() => {
    // Collapse to the latest hard patch per root unit to avoid duplicate/revision noise
    const latestByRoot = new Map<string, Patch>()
    const pendingSoft = new Map<string, Patch>() // soft preview until first hard
    for (const p of patches.values()) {
      const root = rootFromUnitId(p.unitId)
      if (p.stage === 'hard') {
        const prev = latestByRoot.get(root)
        if (!prev || (p.version ?? 0) > (prev.version ?? 0) || (p.receivedAt ?? 0) > (prev.receivedAt ?? 0)) {
          latestByRoot.set(root, p)
        }
        pendingSoft.delete(root) // hard arrived; drop soft preview
      } else {
        // only keep soft if no hard yet
        if (!latestByRoot.has(root)) {
          const prev = pendingSoft.get(root)
          if (!prev || (p.version ?? 0) >= (prev.version ?? 0)) {
            pendingSoft.set(root, p)
          }
        }
      }
    }

    // Combine hards + pending soft previews
    const combined: Patch[] = [...latestByRoot.values(), ...pendingSoft.values()]

    // Sort by arrival time
    const sorted = combined.sort(
      (a, b) => (a.receivedAt || 0) - (b.receivedAt || 0)
    )

    const acc: Paragraph[] = []
    let lastText = ''
    let lastAt = 0

    for (const patch of sorted) {
      const text = (patch.text || '').trim()
      if (!text) continue
      const now = patch.receivedAt || Date.now()

      // Drop rapid duplicates of the exact same text (server hiccups)
      if (text === lastText && now - lastAt < 2000) {
        continue
      }

      const current = acc[acc.length - 1]
      const longPause = current ? now - current.updatedAt > 4500 : true
      const shouldBreak = !current || (longPause && endsWithTerminal(current.text))

      if (shouldBreak) {
        const paragraphText = maybeCapitalize('', text)
        acc.push({
          id: patch.unitId,
          text: paragraphText,
          stage: patch.stage,
          updatedAt: now,
          unitIds: [patch.unitId],
          version: patch.version
        })
      } else {
        const paragraphText = maybeCapitalize(current.text, text)
        acc[acc.length - 1] = {
          ...current,
          text: current.text ? `${current.text} ${paragraphText}` : paragraphText,
          stage: patch.stage,
          updatedAt: now,
          unitIds: [...current.unitIds, patch.unitId],
          version: patch.version
        }
      }

      lastText = text
      lastAt = now
    }

    return acc.slice(-20).reverse() // newest first, cap length
  }, [patches])

  // Set page title
  useEffect(() => { document.title = 'Simo' }, [])

  // Keep ref in sync for message handlers
  useEffect(() => {
    patchesRef.current = patches
  }, [patches])

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
    audio.addEventListener('play', () => {
      setAudioBlocked(false)
      setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'playing' }])
    })
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

  // Prune old patches from view to avoid stale paragraphs
  useEffect(() => {
    const id = setInterval(() => {
      setPatches((prev) => {
        const now = Date.now()
        const next = new Map<string, Patch>()
        for (const [key, value] of prev.entries()) {
          if (!value.receivedAt || now - value.receivedAt <= PATCH_TTL_MS) {
            next.set(key, value)
          }
        }
        return next
      })
    }, 30000)
    return () => clearInterval(id)
  }, [])

  // Enumerate audio output devices
  useEffect(() => {
    async function getDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput')
        setAudioDevices(audioOutputs)
        if (audioOutputs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(audioOutputs[0].deviceId)
        }
      } catch (err) {
        console.error('Failed to enumerate audio devices:', err)
      }
    }
    getDevices()
  }, [])

  // Update audio output device when selected
  useEffect(() => {
    const audio = audioRef.current
    if (audio && selectedDeviceId && (audio as any).setSinkId) {
      (audio as any).setSinkId(selectedDeviceId).catch((err: any) => {
        console.error('Failed to set audio output device:', err)
      })
    }
  }, [selectedDeviceId])

  // Close device selector when clicking outside
  useEffect(() => {
    if (!showDeviceSelector) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-device-selector]')) {
        setShowDeviceSelector(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [showDeviceSelector])

  // Reconnect automatically when translation language changes
  useEffect(() => {
    if (!roomUnlocked) return
    if (status === 'Connected' || status === 'Connecting') {
      disconnect()
    }
  }, [lang, roomUnlocked])  // eslint-disable-line react-hooks/exhaustive-deps

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
      if (Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
        setLang(meta.defaultTargetLangs[0])
      }
    } catch (err) {
      setUnlockError('Failed to validate room code. Please try again.')
    }
  }

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
          setRoomUnlocked(true)
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

  // Ensure language changes always reopen the socket with the new lang
  useEffect(() => {
    if (!roomUnlocked) return
    lastAutoConnectKeyRef.current = null
    if (status === 'Connected' || status === 'Connecting') {
      disconnect()
      setTimeout(() => connect(), 60)
    } else if (status === 'Idle') {
      connect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, roomUnlocked])

  function connect() {
    try { wsRef.current?.close() } catch {}
    patchBufferRef.current = []
    if (rafFlushRef.current != null) {
      cancelAnimationFrame(rafFlushRef.current)
      rafFlushRef.current = null
    }
    setPatches(new Map())
    ttsQueueRef.current = []
    setTtsEvents([])
    isPlayingRef.current = false
    if (audioRef.current) {
      try { audioRef.current.pause() } catch {}
      audioRef.current.src = ''
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?role=listener&room=${encodeURIComponent(room)}&lang=${encodeURIComponent(lang)}&tts=${tts}`
    if (debugMode) console.log('[Listener] Connecting:', { url, room, lang, tts })
    const ws = new WebSocket(url)
    wsRef.current = ws
    lastAutoConnectKeyRef.current = `${room}|${lang}`
    setStatus('Connecting')
    ws.onopen = () => setStatus('Connected')
    ws.onclose = () => setStatus('Idle')
    ws.onerror = () => setStatus('Error')
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg?.type === 'patch' && msg?.payload) {
          const payload = msg.payload

          // Suppression patches hide a segment that was merged into a previous one
          if (payload.op === 'suppress' && payload.unitId) {
            patchBufferRef.current = patchBufferRef.current.filter(p => p.unitId !== payload.unitId)
            setPatches(prev => {
              if (!prev.has(payload.unitId)) return prev
              const next = new Map(prev)
              next.delete(payload.unitId)
              return next
            })
            ttsQueueRef.current = ttsQueueRef.current.filter(item => item.unitId !== payload.unitId)
            lastTtsVersionRef.current.delete(payload.unitId)
            lastTtsAudioRef.current.delete(payload.unitId)
            return
          }

          const emittedAt = typeof payload.emittedAt === 'number' ? payload.emittedAt : null
          if (emittedAt && Date.now() - emittedAt > PATCH_TTL_MS) {
            return
          }
          const p: Patch = { ...payload, receivedAt: Date.now() }
          const base = (code?: string) => (code ? code.split('-')[0].toLowerCase() : '')
          // Filter out patches for other languages
          if (p.targetLang && p.targetLang !== lang) {
            return
          }
          if (!p.targetLang && lang !== 'source' && base(p.srcLang) !== base(lang)) {
            return
          }
          patchBufferRef.current.push(p)
          schedulePatchFlush()
        } else if (msg?.type === 'tts' && msg?.payload && tts) {
          const base64 = String(msg.payload.audio || '')
          if (base64 && base64.length > 0) {
            const fmt = String(msg.payload.format || 'audio/mpeg')
            const src = `data:${fmt};base64,${base64}`
            const incomingVersion = typeof msg.payload.version === 'number' ? msg.payload.version : null
            const unitId = msg.payload.unitId || msg.payload.rootUnitId
            if (unitId && incomingVersion !== null) {
              const last = lastTtsVersionRef.current.get(unitId)
              if (last != null && incomingVersion <= last) {
                return
              }
              lastTtsVersionRef.current.set(unitId, incomingVersion)
              const latestPatch = patchesRef.current.get(unitId)
              if (latestPatch && typeof latestPatch.version === 'number' && latestPatch.version > incomingVersion) {
                return
              }
              ttsQueueRef.current = ttsQueueRef.current.filter(item => {
                if (!item.unitId || item.unitId !== unitId) return true
                if (item.version == null) return false
                return item.version > incomingVersion
              })
            } else if (unitId) {
              const lastSrc = lastTtsAudioRef.current.get(unitId)
              if (lastSrc && lastSrc === src) {
                return
              }
              lastTtsAudioRef.current.set(unitId, src)
            }
            ttsQueueRef.current.push({ src, mime: fmt, unitId, version: incomingVersion })
            setTtsEvents(prev => [...prev, { timestamp: Date.now(), type: 'received', format: fmt, audioSize: base64.length }])
            if (!isPlayingRef.current) playNextTts()
          }
        } else if (msg?.type === 'reset') {
          setPatches(new Map())
          ttsQueueRef.current = []
          lastTtsVersionRef.current.clear()
          lastTtsAudioRef.current.clear()
        }
      } catch (e) {
        if (debugMode) console.warn('[Listener] Bad message', e)
      }
    }
  }

  function disconnect() {
    try { wsRef.current?.close() } catch {}
    wsRef.current = null
    lastAutoConnectKeyRef.current = null
    patchBufferRef.current = []
    if (rafFlushRef.current != null) {
      cancelAnimationFrame(rafFlushRef.current)
      rafFlushRef.current = null
    }
    setPatches(new Map())
    ttsQueueRef.current = []
    setTtsEvents([])
    isPlayingRef.current = false
    if (audioRef.current) {
      try { audioRef.current.pause() } catch {}
      audioRef.current.src = ''
    }
    setStatus('Idle')
  }

  // Access gate - show unlock screen if not authenticated
  if (!roomUnlocked) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-violet-500/20 to-pink-500/20 border border-violet-500/30 flex items-center justify-center">
              <svg className="w-8 h-8 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-violet-400 to-pink-400 bg-clip-text text-transparent mb-2">Listener Access</h1>
            <p className="text-slate-400">Enter your room code to begin</p>
          </div>
          <form onSubmit={unlockRoom} className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-8 shadow-2xl space-y-4">
            <div>
              <Label className="mb-2 block text-slate-300">Room Code</Label>
              <Input
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value)}
                placeholder="Enter your room code"
                className="bg-slate-900/50 border-slate-700 focus:border-violet-500 transition-colors text-center text-lg tracking-wider"
                autoFocus
              />
            </div>
            <div className="pt-2">
              <Button type="submit" className="w-full bg-gradient-to-r from-violet-500 to-pink-500 hover:from-violet-600 hover:to-pink-600 transition-all">
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
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-violet-400 to-pink-400 bg-clip-text text-transparent mb-2">Listener</h1>
            <p className="text-slate-400">Receive live translations in real-time</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-xs text-slate-500 mb-1">Room</div>
              <code className="text-sm text-slate-300 bg-slate-800/50 px-3 py-1 rounded-lg border border-slate-700/50">{room}</code>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm',
              status === 'Connected' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400' :
              status === 'Connecting' ? 'border-blue-500/50 bg-blue-500/10 text-blue-400' :
              status === 'Error' ? 'border-red-500/50 bg-red-500/10 text-red-400' :
              'border-slate-600 bg-slate-800/50 text-slate-400'
            )}>
              <div className={cn(
                'w-2 h-2 rounded-full',
                status === 'Connected' ? 'bg-emerald-400 animate-pulse' :
                status === 'Connecting' ? 'bg-blue-400 animate-pulse' :
                status === 'Error' ? 'bg-red-400' :
                'bg-slate-600'
              )}></div>
              <span>{status}</span>
            </div>
          <div className="relative" data-device-selector>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowDeviceSelector(!showDeviceSelector)}
              title="Audio output settings"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </Button>
            {showDeviceSelector && (
              <div className="absolute right-0 top-full mt-2 w-64 rounded-md border border-slate-600 bg-slate-900/95 shadow-lg z-10 p-3">
                <div className="mb-2 text-sm font-medium">Audio Output Device</div>
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="w-full rounded-md bg-slate-800 border border-slate-700 px-2 py-1.5 text-sm [&>option]:bg-slate-800"
                >
                  {audioDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Device ${device.deviceId.substring(0, 8)}...`}
                    </option>
                  ))}
                </select>
                {audioDevices.length === 0 && (
                  <p className="text-xs text-slate-500 mt-2">No audio output devices found</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-6 shadow-xl mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <Label className="mb-2 block text-slate-300">Translation Language</Label>
            <select
              className="flex h-10 w-full rounded-lg border border-slate-700 bg-slate-900/50 text-slate-100 px-3 py-2 text-sm shadow-sm transition-colors focus:outline-none focus:border-violet-500 [&>option]:bg-slate-800"
              value={lang}
              onChange={(e)=> setLang(e.target.value)}
            >
              {(roomMeta?.defaultTargetLangs && Array.isArray(roomMeta.defaultTargetLangs) && roomMeta.defaultTargetLangs.length > 0
                ? LANGS.filter(l => roomMeta.defaultTargetLangs.includes(l.code))
                : LANGS
              ).map(l => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="tts"
              type="checkbox"
              className="h-4 w-4 rounded border-slate-700 bg-slate-900/50 text-violet-500 focus:ring-violet-500 focus:ring-offset-0"
              checked={tts}
              onChange={(e)=> setTts(e.target.checked)}
            />
            <Label htmlFor="tts" className="text-slate-300 cursor-pointer">Enable Text-to-Speech</Label>
          </div>
          <div className="flex items-center gap-2 justify-end">
            {audioBlocked && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={unlockAudio}
                className="border-amber-500 text-amber-200 hover:bg-amber-500/10"
                title="Enable audio playback"
              >
                Enable audio
              </Button>
            )}
            <Button
              type="button"
              onClick={connect}
              disabled={status === 'Connected'}
              className="bg-gradient-to-r from-violet-500 to-pink-500 hover:from-violet-600 hover:to-pink-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Connect
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={disconnect}
              disabled={status !== 'Connected'}
              className="border-slate-700 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Disconnect
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-6 shadow-xl">
        <div className="flex items-center gap-2 mb-4 pb-4 border-b border-slate-700/50">
          <svg className="w-5 h-5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
          <h2 className="text-xl font-semibold text-slate-200">Live Captions</h2>
          <span className="text-xs text-slate-500 ml-auto">{getLangName(lang)}</span>
        </div>
        <ul className="space-y-3 max-h-[60vh] overflow-y-auto custom-scrollbar">
          {paragraphs.map(p => (
            <li
              key={p.id}
              data-stage={p.stage}
              className={cn(
                'rounded-lg border p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg/20',
                p.stage === 'hard'
                  ? 'border-slate-700/70 bg-slate-900/70'
                  : 'border-amber-400/40 bg-amber-500/10'
              )}
            >
              <div className="flex items-center gap-3 mb-2">
                <div className={cn(
                  'h-2 w-2 rounded-full',
                  p.stage === 'hard' ? 'bg-emerald-400' : 'bg-amber-300 animate-pulse'
                )} />
                <span className="text-xs text-slate-600 ml-auto">
                  {p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString() : ''}
                </span>
              </div>
              <div className="text-lg text-slate-100 whitespace-pre-wrap leading-relaxed">{p.text}</div>
            </li>
          ))}
          {paragraphs.length === 0 && (
            <li className="text-center py-12">
              <div className="text-slate-500 mb-2">
                <svg className="w-12 h-12 mx-auto opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p className="text-slate-400">Waiting for translations...</p>
              <p className="text-sm text-slate-600 mt-1">Connect to start receiving live transcripts</p>
            </li>
          )}
        </ul>
      </div>
      </div>
    </main>
  )
}
