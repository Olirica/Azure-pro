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

export function ListenerApp() {
  const [room, setRoom] = useState(getRoomFromUrl())
  const [lang, setLang] = useState('fr-CA')
  const [tts, setTts] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [roomMeta, setRoomMeta] = useState<any>(null)
  const [userInteracted, setUserInteracted] = useState(false)  // Track user interaction for autoplay
  const wsRef = useRef<WebSocket | null>(null)
  const [patches, setPatches] = useState<Map<string, Patch>>(new Map())
  const audioRef = useRef<HTMLAudioElement | null>(null)

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

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio()
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

  // Auto-connect on page load after initial room metadata is fetched
  useEffect(() => {
    if (roomMeta && status === 'Idle') {
      // Small delay to ensure all state is ready
      const timer = setTimeout(() => {
        connect()
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [roomMeta])

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

          setPatches((prev) => {
            const map = new Map(prev)
            const cur = map.get(p.unitId)
            if (!cur || p.version >= cur.version) {
              map.set(p.unitId, p)
            }
            return map
          })
        } else if (msg?.type === 'tts' && msg?.payload) {
          const { audio, format } = msg.payload as { audio: string; format?: string }
          const mime = format || 'audio/mpeg'
          const src = `data:${mime};base64,${audio}`
          const el = audioRef.current
          if (el) {
            el.src = src
            el.play().catch(() => {})
          }
        }
      } catch {}
    }
  }

  function disconnect() {
    try { wsRef.current?.close() } catch {}
    setStatus('Idle')
  }

  function handleUserInteraction() {
    setUserInteracted(true)
    // Prime the audio element for playback on mobile
    if (audioRef.current) {
      audioRef.current.play().catch(() => {})
      audioRef.current.pause()
    }
  }

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
        {status === 'Closed' && (
          <Button size="sm" onClick={connect} variant="outline">
            Reconnect
          </Button>
        )}
      </div>

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

