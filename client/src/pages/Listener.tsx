// Listener page for real-time translation captions
// Aurora Glass Design System
import React, { useEffect, useMemo, useRef, useState } from 'react'
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
    return (r && r.trim()) ? r.trim().toLowerCase() : 'demo-room'
  } catch {
    return 'demo-room'
  }
}

function getLangFromUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null
    const url = new URL(window.location.href)
    const l = url.searchParams.get('lang')
    return (l && l.trim()) ? l.trim() : null
  } catch {
    return null
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

// Aurora Glass Design System
const glassPanel = "relative backdrop-blur-xl bg-white/[0.03] border border-white/[0.08] rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)]"
const glassInput = "w-full bg-white/[0.03] backdrop-blur border border-white/[0.1] rounded-xl px-4 py-3 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all duration-200"
const btnPrimary = "relative px-6 py-3 rounded-xl font-semibold text-sm tracking-wide transition-all duration-200 bg-gradient-to-br from-cyan-500/80 to-teal-600/80 text-white shadow-[0_4px_20px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] hover:shadow-[0_6px_24px_rgba(20,184,166,0.4),inset_0_1px_0_rgba(255,255,255,0.3)] hover:translate-y-[-1px] active:translate-y-[1px] active:shadow-[0_2px_12px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.1)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0"
const btnSecondary = "px-5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 bg-white/[0.03] border border-white/[0.1] text-white/70 hover:bg-white/[0.06] hover:border-white/[0.15] hover:text-white/90 disabled:opacity-40 disabled:cursor-not-allowed"

const StatusDot = ({ active, color = 'emerald' }: { active: boolean; color?: 'emerald' | 'amber' | 'cyan' }) => {
  const colors = {
    emerald: { bg: 'bg-emerald-400', glow: 'bg-emerald-400/20' },
    amber: { bg: 'bg-amber-400', glow: 'bg-amber-400/20' },
    cyan: { bg: 'bg-cyan-400', glow: 'bg-cyan-400/20' }
  }
  const c = colors[color]
  return (
    <div className={`relative w-2.5 h-2.5 rounded-full ${active ? c.bg : 'bg-white/20'}`}>
      {active && <div className={`absolute inset-0 rounded-full ${c.bg} animate-ping opacity-50`} />}
      {active && <div className={`absolute inset-[-3px] rounded-full ${c.glow} blur-sm`} />}
    </div>
  )
}

export function ListenerApp() {
  const PATCH_TTL_MS = 5 * 60 * 1000
  const [room, setRoom] = useState(getRoomFromUrl())
  const [roomInput, setRoomInput] = useState('')
  const [roomUnlocked, setRoomUnlocked] = useState(false)
  const [unlockError, setUnlockError] = useState('')
  const urlLang = useRef(getLangFromUrl())
  const [lang, setLang] = useState(getLangFromUrl() || 'fr-CA')
  const [tts, setTts] = useState(true)
  const [status, setStatus] = useState('Idle')
  const [roomMeta, setRoomMeta] = useState<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [patches, setPatches] = useState<Map<string, Patch>>(new Map())
  const patchesRef = useRef<Map<string, Patch>>(new Map())
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [showDeviceSelector, setShowDeviceSelector] = useState(false)
  const [audioOutputError, setAudioOutputError] = useState('')

  // TTS queue
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsQueueRef = useRef<{ src: string; mime: string; unitId?: string; version?: number | null }[]>([])
  const lastTtsVersionRef = useRef<Map<string, number>>(new Map())
  const lastTtsAudioRef = useRef<Map<string, string>>(new Map())
  const [ttsEvents, setTtsEvents] = useState<TtsEvent[]>([])
  const isPlayingRef = useRef(false)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const userDisconnectedRef = useRef(false)

  function playNextTts() {
    const el = audioRef.current
    if (!el) return
    const next = ttsQueueRef.current.shift()
    if (!next) {
      isPlayingRef.current = false
      return
    }
    if (!next.src || next.src.length < 20) {
      console.warn('[TTS] Skipping invalid/empty src:', next.src?.substring(0, 50))
      playNextTts()
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
    const latestByRoot = new Map<string, Patch>()
    const pendingSoft = new Map<string, Patch>()
    for (const p of patches.values()) {
      const root = rootFromUnitId(p.unitId)
      if (p.stage === 'hard') {
        const prev = latestByRoot.get(root)
        if (!prev || (p.version ?? 0) > (prev.version ?? 0) || (p.receivedAt ?? 0) > (prev.receivedAt ?? 0)) {
          latestByRoot.set(root, p)
        }
        pendingSoft.delete(root)
      } else {
        if (!latestByRoot.has(root)) {
          const prev = pendingSoft.get(root)
          if (!prev || (p.version ?? 0) >= (prev.version ?? 0)) {
            pendingSoft.set(root, p)
          }
        }
      }
    }

    const combined: Patch[] = [...latestByRoot.values(), ...pendingSoft.values()]
    const sorted = combined.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0))

    const acc: Paragraph[] = []
    let lastText = ''
    let lastAt = 0

    for (const patch of sorted) {
      const text = (patch.text || '').trim()
      if (!text) continue
      const now = patch.receivedAt || Date.now()

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

    return acc.slice(-20).reverse()
  }, [patches])

  useEffect(() => { document.title = 'Simo · Listener' }, [])

  useEffect(() => {
    patchesRef.current = patches
  }, [patches])

  const debugMode = useMemo(() => {
    try { return new URLSearchParams(window.location.search).get('debug') === 'true' } catch { return false }
  }, [])

  const getLangName = (code: string): string => {
    const l = LANGS.find(x => x.code.toLowerCase() === code.toLowerCase())
    return l?.name || code
  }

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

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const sinkSetter = (audio as any).setSinkId
    if (typeof sinkSetter !== 'function') {
      setAudioOutputError('Browser does not support selecting an audio output device; using system default.')
      return
    }
    const target = selectedDeviceId || 'default'
    sinkSetter
      .call(audio, target)
      .then(() => setAudioOutputError(''))
      .catch((err: any) => {
        console.error('Failed to set audio output device:', err)
        setAudioOutputError('Failed to switch audio output; using system default.')
      })
  }, [selectedDeviceId])

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

  useEffect(() => {
    if (!roomUnlocked) return
    if (status === 'Connected' || status === 'Connecting') {
      disconnect()
    }
  }, [lang, roomUnlocked])

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
      // Only set lang from room defaults if not specified in URL
      if (!urlLang.current && Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
        setLang(meta.defaultTargetLangs[0])
      }
    } catch (err) {
      setUnlockError('Failed to validate room code. Please try again.')
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
          // Only set lang from room defaults if not specified in URL
          if (!urlLang.current && Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
            setLang(meta.defaultTargetLangs[0])
          }
        }
      } catch {}
    }
    load()
    return () => { cancelled = true }
  }, [room])

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

  useEffect(() => {
    if (!roomUnlocked) return
    if (userDisconnectedRef.current) return  // Don't auto-reconnect after user disconnect
    lastAutoConnectKeyRef.current = null
    if (status === 'Connected' || status === 'Connecting') {
      disconnect(false)  // Not user-initiated
      setTimeout(() => connect(), 60)
    } else if (status === 'Idle') {
      connect()
    }
  }, [lang, roomUnlocked])

  function connect() {
    userDisconnectedRef.current = false  // Allow auto-reconnect again
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
          if (!p.text || !p.text.trim()) {
            return
          }
          const base = (code?: string) => (code ? code.split('-')[0].toLowerCase() : '')
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

  function disconnect(userInitiated = true) {
    if (userInitiated) userDisconnectedRef.current = true
    try { wsRef.current?.close() } catch {}
    wsRef.current = null
    lastAutoConnectKeyRef.current = null
    patchBufferRef.current = []
    if (rafFlushRef.current != null) {
      cancelAnimationFrame(rafFlushRef.current)
      rafFlushRef.current = null
    }
    // Don't clear patches on user disconnect - keep history visible
    if (!userInitiated) setPatches(new Map())
    ttsQueueRef.current = []
    setTtsEvents([])
    isPlayingRef.current = false
    if (audioRef.current) {
      try { audioRef.current.pause() } catch {}
      audioRef.current.src = ''
    }
    setStatus('Idle')
  }

  // Access gate - Aurora Glass unlock screen
  if (!roomUnlocked) {
    return (
      <>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap');
          @keyframes aurora { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
          @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
          .aurora-bg { background: linear-gradient(-45deg, #0a0f1c, #1a1f3c, #0f172a, #1e1b4b, #0c1929); background-size: 400% 400%; animation: aurora 20s ease infinite; }
          .font-display { font-family: 'Outfit', system-ui, sans-serif; }
          .font-body { font-family: 'DM Sans', system-ui, sans-serif; }
        `}</style>
        <main className="aurora-bg min-h-screen flex items-center justify-center p-6 font-body text-white">
          <div className="w-full max-w-md">
            <div className="text-center mb-8">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-violet-500/20 to-pink-500/20 border border-violet-400/30 flex items-center justify-center shadow-[0_0_40px_rgba(139,92,246,0.3)] animate-[float_4s_ease-in-out_infinite]">
                <svg className="w-10 h-10 text-violet-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
              </div>
              <h1 className="font-display text-4xl font-semibold text-white mb-2 tracking-tight">Listener Access</h1>
              <p className="text-white/50 text-lg">Enter your room code to begin</p>
            </div>
            <form onSubmit={unlockRoom} className={`${glassPanel} p-8 space-y-6`}>
              <div>
                <label className="block text-sm font-medium text-white/60 mb-2">Room Code</label>
                <input
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  placeholder="Enter your room code"
                  className={`${glassInput} text-center text-lg tracking-widest uppercase`}
                  autoFocus
                />
              </div>
              <button type="submit" className={`${btnPrimary} w-full`}>
                Access Room
              </button>
              {unlockError && (
                <p className="text-sm text-center text-rose-400">{unlockError}</p>
              )}
            </form>
          </div>
        </main>
      </>
    )
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap');
        @keyframes aurora { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
        .aurora-bg { background: linear-gradient(-45deg, #0a0f1c, #1a1f3c, #0f172a, #1e1b4b, #0c1929); background-size: 400% 400%; animation: aurora 20s ease infinite; }
        .font-display { font-family: 'Outfit', system-ui, sans-serif; }
        .font-body { font-family: 'DM Sans', system-ui, sans-serif; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(255,255,255,0.03); border-radius: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
      `}</style>
      <main className="aurora-bg min-h-screen px-4 py-8 font-body text-white">
        <div className="container mx-auto max-w-4xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="font-display text-4xl font-semibold text-white mb-1 tracking-tight">Listener</h1>
              <p className="text-white/40">Receive live translations in real-time</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-xs text-white/30 mb-1">Room</div>
                <code className="text-sm text-cyan-300/80 bg-cyan-400/10 px-3 py-1.5 rounded-lg border border-cyan-400/20">{room}</code>
              </div>
              <div className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium',
                status === 'Connected' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' :
                status === 'Connecting' ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300' :
                status === 'Error' ? 'border-rose-400/30 bg-rose-400/10 text-rose-300' :
                'border-white/10 bg-white/[0.03] text-white/50'
              )}>
                <StatusDot active={status === 'Connected'} color={status === 'Connected' ? 'emerald' : status === 'Connecting' ? 'cyan' : 'emerald'} />
                <span>{status}</span>
              </div>
              <div className="relative" data-device-selector>
                <button
                  type="button"
                  onClick={() => setShowDeviceSelector(!showDeviceSelector)}
                  className={btnSecondary}
                  title="Audio output settings"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                {showDeviceSelector && (
                  <div className={`${glassPanel} absolute right-0 top-full mt-2 w-72 p-4 z-10`}>
                    <div className="mb-3 text-sm font-medium text-white/80">Audio Output Device</div>
                    <select
                      value={selectedDeviceId}
                      onChange={(e) => setSelectedDeviceId(e.target.value)}
                      className={glassInput}
                    >
                      {audioDevices.map(device => (
                        <option key={device.deviceId} value={device.deviceId} className="bg-slate-900">
                          {device.label || `Device ${device.deviceId.substring(0, 8)}...`}
                        </option>
                      ))}
                      <option value="" className="bg-slate-900">System default</option>
                    </select>
                    {audioDevices.length === 0 && (
                      <p className="text-xs text-white/30 mt-2">No audio output devices found</p>
                    )}
                    {audioOutputError && (
                      <p className="text-xs text-amber-400/80 mt-2">{audioOutputError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className={`${glassPanel} p-6 mb-6`}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-sm font-medium text-white/60 mb-2">Translation Language</label>
                <select
                  className={glassInput}
                  value={lang}
                  onChange={(e)=> setLang(e.target.value)}
                >
                  {(roomMeta?.defaultTargetLangs && Array.isArray(roomMeta.defaultTargetLangs) && roomMeta.defaultTargetLangs.length > 0
                    ? LANGS.filter(l => roomMeta.defaultTargetLangs.includes(l.code))
                    : LANGS
                  ).map(l => (
                    <option key={l.code} value={l.code} className="bg-slate-900">{l.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tts}
                    onChange={(e)=> setTts(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white/60 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500/50 peer-checked:after:bg-cyan-300"></div>
                </label>
                <span className="text-sm text-white/70">Text-to-Speech</span>
              </div>
              <div className="flex items-center gap-2 justify-end">
                {audioBlocked && (
                  <button
                    type="button"
                    onClick={unlockAudio}
                    className="px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 bg-amber-500/20 border border-amber-400/30 text-amber-300 hover:bg-amber-500/30"
                  >
                    Enable audio
                  </button>
                )}
                <button
                  type="button"
                  onClick={connect}
                  disabled={status === 'Connected'}
                  className={btnPrimary}
                >
                  Connect
                </button>
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={status !== 'Connected'}
                  className={btnSecondary}
                >
                  Disconnect
                </button>
              </div>
            </div>
          </div>

          {/* Live Captions */}
          <div className={`${glassPanel} p-6`}>
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-white/[0.06]">
              <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center">
                <svg className="w-4 h-4 text-violet-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                </svg>
              </div>
              <h2 className="font-display text-xl font-semibold text-white/90">Live Captions</h2>
              <span className="text-xs text-white/40 ml-auto px-2 py-1 rounded-md bg-white/[0.03] border border-white/[0.06]">{getLangName(lang)}</span>
            </div>
            <ul className="space-y-3 max-h-[60vh] overflow-y-auto custom-scrollbar">
              {paragraphs.map(p => (
                <li
                  key={p.id}
                  data-stage={p.stage}
                  className={cn(
                    'rounded-xl border p-4 transition-all duration-300 hover:translate-x-1',
                    p.stage === 'hard'
                      ? 'border-white/[0.06] bg-white/[0.02]'
                      : 'border-amber-400/30 bg-amber-400/10'
                  )}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <StatusDot active={true} color={p.stage === 'hard' ? 'emerald' : 'amber'} />
                    <span className="text-xs text-white/30 ml-auto">
                      {p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString() : ''}
                    </span>
                  </div>
                  <div className="text-lg text-white/90 whitespace-pre-wrap leading-relaxed">{p.text}</div>
                </li>
              ))}
              {paragraphs.length === 0 && (
                <li className="text-center py-16">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
                    <svg className="w-8 h-8 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </div>
                  <p className="text-white/50 font-medium">Waiting for translations...</p>
                  <p className="text-sm text-white/30 mt-1">Connect to start receiving live transcripts</p>
                </li>
              )}
            </ul>
          </div>
        </div>
      </main>
    </>
  )
}
