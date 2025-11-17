import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { LANGS } from '../data/languages'

type Patch = {
  unitId: string
  version: number
  stage: 'soft' | 'hard'
  text: string
  srcLang?: string
  ts?: { t0: number; t1: number }  // Timestamps in milliseconds
  receivedAt?: number  // When this patch was received (for ordering)
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

type TtsEvent = {
  timestamp: number
  type: 'received' | 'playing' | 'played' | 'error'
  format?: string
  audioSize?: number
  error?: string
}

export function ListenerApp() {
  const [room, setRoom] = useState(getRoomFromUrl())
  const [lang, setLang] = useState('fr-CA')
  const [tts, setTts] = useState(true)  // Default TTS to enabled for listeners
  const [status, setStatus] = useState('Idle')
  const [roomMeta, setRoomMeta] = useState<any>(null)
  const [userInteracted, setUserInteracted] = useState(false)  // Track user interaction for autoplay
  const wsRef = useRef<WebSocket | null>(null)
  const [patches, setPatches] = useState<Map<string, Patch>>(new Map())
  // Batch incoming patches per animation frame to reduce re-renders
  const patchBufferRef = useRef<Patch[]>([])
  const rafFlushRef = useRef<number | null>(null)
  function flushPatchBuffer() {
    setPatches((prev) => {
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
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [ttsEvents, setTtsEvents] = useState<TtsEvent[]>([])  // Track TTS events for monitoring
  const [currentlyPlaying, setCurrentlyPlaying] = useState(false)  // Track if audio is currently playing

  // Set page title
  useEffect(() => {
    document.title = 'Simo'
  }, [])

  // Check for debug mode via URL parameter (?debug=true)
  const debugMode = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      return params.get('debug') === 'true'
    } catch {
      return false
    }
  }, [])

  // Helper to get language name from code
  const getLangName = (code: string): string => {
    const lang = LANGS.find(l => l.code.toLowerCase() === code.toLowerCase())
    return lang?.name || code
  }

  // Setup audio element with comprehensive event listeners
  useEffect(() => {
    if (!audioRef.current) {
      const audio = new Audio()
      audioRef.current = audio

      // Add comprehensive event listeners for monitoring
      audio.addEventListener('loadstart', () => {
        console.log('[TTS Audio] Load started')
      })

      audio.addEventListener('canplay', () => {
        console.log('[TTS Audio] Can play - audio ready')
      })

      audio.addEventListener('play', () => {
        console.log('[TTS Audio] Playback started')
        setCurrentlyPlaying(true)
        setTtsEvents(prev => [...prev, {
          timestamp: Date.now(),
          type: 'playing'
        }])
      })

      audio.addEventListener('playing', () => {
        console.log('[TTS Audio] Playing (after buffering)')
      })

      audio.addEventListener('pause', () => {
        console.log('[TTS Audio] Paused')
        setCurrentlyPlaying(false)
      })

      audio.addEventListener('ended', () => {
        console.log('[TTS Audio] Playback ended')
        setCurrentlyPlaying(false)
        setTtsEvents(prev => [...prev, {
          timestamp: Date.now(),
          type: 'played'
        }])
      })

      audio.addEventListener('error', (e) => {
        const errorMsg = audio.error ? `Error code: ${audio.error.code}, message: ${audio.error.message}` : 'Unknown error'
        console.error('[TTS Audio] Error:', errorMsg, e)
        setCurrentlyPlaying(false)
        setTtsEvents(prev => [...prev, {
          timestamp: Date.now(),
          type: 'error',
          error: errorMsg
        }])
      })

      audio.addEventListener('stalled', () => {
        console.warn('[TTS Audio] Download stalled')
      })

      audio.addEventListener('waiting', () => {
        console.log('[TTS Audio] Waiting for data')
      })
    }
  }, [])

  // Fetch room metadata when room changes
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
          // Auto-select first default target language if available
          if (Array.isArray(meta.defaultTargetLangs) && meta.defaultTargetLangs.length) {
            setLang(meta.defaultTargetLangs[0])
          }
        }
      } catch {}
    }
    load()
    return () => { cancelled = true }
  }, [room])

  // Auto-connect immediately after roomMeta and lang are ready (no artificial delay)
  const lastAutoConnectKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (roomMeta && lang && status === 'Idle') {
      const key = `${room}|${lang}`
      if (lastAutoConnectKeyRef.current !== key) {
        lastAutoConnectKeyRef.current = key
        console.log('[Listener] Auto-connecting with lang:', lang, 'tts:', tts)
        connect()
      }
    }
  }, [roomMeta, lang, status])

  function connect() {
    try { wsRef.current?.close() } catch {}
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?role=listener&room=${encodeURIComponent(room)}&lang=${encodeURIComponent(lang)}&tts=${tts}`

    // Debug log to verify language is being sent
    console.log('[Listener] Connecting to WebSocket:', { room, lang, tts, url })

    const ws = new WebSocket(url)
    wsRef.current = ws
    setStatus('Connecting')
    ws.onopen = () => {
      setStatus('Connected')
      console.log('[Listener] WebSocket connected:', { room, lang, tts })
    }
    ws.onclose = () => setStatus('Closed')
    ws.onerror = () => setStatus('Error')
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        if (msg?.type === 'patch' && msg?.payload) {
          const p = msg.payload as Patch
          p.receivedAt = Date.now()  // Add timestamp when received

          // Debug log to verify translations are being received
          console.log('[Listener] Received patch:', {
            text: p.text?.substring(0, 50),
            srcLang: p.srcLang,
            targetLang: lang,
            stage: p.stage,
            version: p.version
          })

          // Buffer and flush on next animation frame
          patchBufferRef.current.push(p)
          schedulePatchFlush()
        } else if (msg?.type === 'tts' && msg?.payload) {
          const { audio, format } = msg.payload as { audio: string; format?: string }
          const mime = format || 'audio/mpeg'
          const audioSizeKB = audio ? (audio.length * 0.75 / 1024).toFixed(2) : '0'  // Base64 is ~4/3 original size

          console.log('[TTS] Received audio:', {
            format: mime,
            sizeKB: audioSizeKB,
            base64Length: audio?.length || 0
          })

          // Track TTS received event
          setTtsEvents(prev => [...prev, {
            timestamp: Date.now(),
            type: 'received',
            format: mime,
            audioSize: audio?.length || 0
          }])

          const src = `data:${mime};base64,${audio}`
          const el = audioRef.current
          if (el) {
            el.src = src
            el.play().catch((err) => {
              console.error('[TTS] Play failed:', err)
              setTtsEvents(prev => [...prev, {
                timestamp: Date.now(),
                type: 'error',
                error: err?.message || 'Play failed'
              }])
            })
          } else {
            console.error('[TTS] Audio element not available')
          }
        }
      } catch {}
    }
  }

  function disconnect() {
    try { wsRef.current?.close() } catch {}
    setStatus('Idle')
    // Cancel any pending patch flush and clear buffer
    if (rafFlushRef.current != null) {
      try { cancelAnimationFrame(rafFlushRef.current) } catch {}
      rafFlushRef.current = null
    }
    patchBufferRef.current = []
  }

  function handleUserInteraction() {
    setUserInteracted(true)
    // Prime the audio element for playback on mobile
    if (audioRef.current) {
      audioRef.current.play().catch(() => {})
      audioRef.current.pause()
    }
  }

  // Compute TTS metrics for monitoring
  const ttsMetrics = useMemo(() => {
    const received = ttsEvents.filter(e => e.type === 'received').length
    const playing = ttsEvents.filter(e => e.type === 'playing').length
    const played = ttsEvents.filter(e => e.type === 'played').length
    const errors = ttsEvents.filter(e => e.type === 'error').length
    return { received, playing, played, errors }
  }, [ttsEvents])

  // Group patches into natural paragraphs based on pauses, sentences, and length
  const paragraphs = useMemo(() => {
    // Sort patches by receivedAt (oldest first - chronological order) then by unitId for stable ordering
    const items = Array.from(patches.values()).sort((a, b) => {
      // If both have receivedAt, sort by that (oldest first - chronological)
      if (a.receivedAt && b.receivedAt) {
        return a.receivedAt - b.receivedAt
      }
      // Fallback to unitId comparison
      return a.unitId.localeCompare(b.unitId)
    })

    // Group consecutive patches into paragraphs
    const paragraphGroups: { id: string; patches: Patch[]; latestTime: number }[] = []
    let currentGroup: Patch[] = []
    let lastSessionId = ''
    let lastEndTime = 0
    let currentWordCount = 0
    let completeSentences = 0
    let groupStartTime = 0

    items.forEach((patch) => {
      const sessionId = patch.unitId.split('|')[0]
      const wordCount = patch.text.split(/\s+/).length
      const isCompleteSentence = patch.stage === 'hard' && /[.!?]$/.test(patch.text)

      // Track the latest receivedAt for this group
      if (currentGroup.length === 0) {
        groupStartTime = patch.receivedAt || 0
      }

      // Calculate time gap if timestamps available
      const timeGap = patch.ts?.t0 && lastEndTime ? patch.ts.t0 - lastEndTime : 0

      // Start new paragraph if:
      // 1. Different speaker/session
      // 2. Significant pause (3+ seconds)
      // 3. After 2-3 complete sentences
      // 4. Exceeded ~120 words and found a complete sentence
      const shouldBreak =
        sessionId !== lastSessionId ||
        (timeGap > 3000 && currentGroup.length > 0) ||
        (completeSentences >= 2 && isCompleteSentence) ||
        (currentWordCount > 120 && isCompleteSentence)

      if (shouldBreak && currentGroup.length > 0) {
        paragraphGroups.push({
          id: `${lastSessionId}-${paragraphGroups.length}`,
          patches: [...currentGroup],
          latestTime: groupStartTime
        })
        currentGroup = []
        currentWordCount = 0
        completeSentences = 0
        groupStartTime = patch.receivedAt || 0
      }

      currentGroup.push(patch)
      currentWordCount += wordCount
      if (isCompleteSentence) completeSentences++

      lastSessionId = sessionId
      if (patch.ts?.t1) lastEndTime = patch.ts.t1
    })

    // Add remaining patches
    if (currentGroup.length > 0) {
      paragraphGroups.push({
        id: `${lastSessionId}-${paragraphGroups.length}`,
        patches: currentGroup,
        latestTime: groupStartTime
      })
    }

    // Sort paragraphs by latest time (oldest first - chronological order)
    return paragraphGroups.sort((a, b) => a.latestTime - b.latestTime)
  }, [patches])

  return (
    <main className="container mx-auto max-w-3xl p-6 relative">
      {/* Tap-to-start overlay for mobile autoplay */}
      {tts && !userInteracted && (
        <div
          className="fixed inset-0 bg-slate-900/95 z-50 flex items-center justify-center cursor-pointer"
          onClick={handleUserInteraction}
        >
          <div className="text-center p-8">
            <div className="text-6xl mb-4">🔊</div>
            <h2 className="text-2xl font-semibold mb-2">Tap to Enable Audio</h2>
            <p className="text-slate-400">Tap anywhere to start listening with text-to-speech</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 mb-4">
        <div>
          <Label className="mb-1 block">Room</Label>
          <Input value={room} onChange={(e)=>setRoom(e.target.value)} />
        </div>

        {/* Language selector buttons */}
        {roomMeta && Array.isArray(roomMeta.defaultTargetLangs) && roomMeta.defaultTargetLangs.length > 0 && (
          <div>
            <Label className="mb-2 block">Select Language</Label>
            <div className="flex flex-wrap gap-2">
              {roomMeta.defaultTargetLangs.map((code: string) => (
                <Button
                  key={code}
                  type="button"
                  variant={lang === code ? "default" : "outline"}
                  onClick={() => setLang(code)}
                >
                  {getLangName(code)}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Fallback to input if no room metadata */}
        {(!roomMeta || !Array.isArray(roomMeta.defaultTargetLangs) || roomMeta.defaultTargetLangs.length === 0) && (
          <div>
            <Label className="mb-1 block">Language (code)</Label>
            <Input value={lang} onChange={(e)=>setLang(e.target.value)} placeholder="e.g., fr-CA" />
          </div>
        )}

        <div className="flex items-center gap-4">
          <label className="flex items-center text-sm cursor-pointer">
            <input type="checkbox" className="mr-2" checked={tts} onChange={(e)=>setTts(e.target.checked)} />
            Enable Text-to-Speech
          </label>
          <div className="flex gap-2 ml-auto">
            <Button onClick={connect}>Connect</Button>
            <Button variant="outline" onClick={disconnect}>Disconnect</Button>
          </div>
        </div>
      </div>
      <div className="text-sm text-slate-400 mb-2 flex items-center gap-4">
        <span>Status: {status}</span>
        {status === 'Connected' && (
          <span className="text-green-400">
            Receiving: {getLangName(lang)} ({lang})
          </span>
        )}
        {currentlyPlaying && (
          <span className="text-blue-400 flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse"></span>
            Playing audio
          </span>
        )}
        {status === 'Closed' && (
          <Button size="sm" onClick={connect} variant="outline">
            Reconnect
          </Button>
        )}
      </div>

      {/* TTS Monitor - always visible when TTS is enabled */}
      {tts && (
        <div className="mb-4 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
          <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">
            TTS Audio Monitor
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-slate-500 text-xs">Received</div>
              <div className="text-slate-100 font-semibold">{ttsMetrics.received}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs">Played</div>
              <div className="text-green-400 font-semibold">{ttsMetrics.played}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs">Playing</div>
              <div className="text-blue-400 font-semibold">{ttsMetrics.playing}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs">Errors</div>
              <div className={`font-semibold ${ttsMetrics.errors > 0 ? 'text-red-400' : 'text-slate-500'}`}>
                {ttsMetrics.errors}
              </div>
            </div>
          </div>
          {ttsMetrics.received > 0 && ttsMetrics.played === 0 && ttsMetrics.errors === 0 && (
            <div className="mt-2 text-xs text-yellow-400">
              ⚠️ Audio received but not playing. Check browser console for details.
            </div>
          )}
          {ttsMetrics.errors > 0 && (
            <div className="mt-2 text-xs text-red-400">
              ❌ Audio playback errors detected. Check browser console for details.
            </div>
          )}
          {debugMode && ttsEvents.length > 0 && (
            <div className="mt-3 pt-3 border-t border-slate-700">
              <div className="text-xs text-slate-500 mb-1">Recent TTS Events:</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {ttsEvents.slice(-10).reverse().map((event, idx) => (
                  <div key={idx} className="text-xs text-slate-400 font-mono">
                    <span className={
                      event.type === 'received' ? 'text-blue-300' :
                      event.type === 'playing' ? 'text-green-300' :
                      event.type === 'played' ? 'text-green-500' :
                      'text-red-400'
                    }>
                      {event.type.toUpperCase()}
                    </span>
                    {' '}
                    {event.format && `[${event.format}]`}
                    {event.audioSize && ` ${(event.audioSize * 0.75 / 1024).toFixed(1)}KB`}
                    {event.error && ` - ${event.error}`}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Paragraph-based display with natural breaks - chronological order (oldest first, newest at bottom) */}
      <div className="space-y-3">
        {paragraphs.map(({ id, patches: paragraphPatches }) => (
          <div key={id} className="text-base leading-relaxed">
            {paragraphPatches.map((p, idx) => (
              <span key={p.unitId}>
                {debugMode && (
                  <span className="text-xs uppercase tracking-wide opacity-40 mr-1">
                    [{p.stage} v{p.version} {p.srcLang && `${p.srcLang}`}]
                  </span>
                )}
                <span className={p.stage === 'hard' ? 'text-slate-100' : 'text-slate-300/70'}>
                  {p.text}
                </span>
                {idx < paragraphPatches.length - 1 && ' '}
              </span>
            ))}
          </div>
        ))}
      </div>
    </main>
  )
}
