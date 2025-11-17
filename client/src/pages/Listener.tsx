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

  function connect() {
    try { wsRef.current?.close() } catch {}
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?role=listener&room=${encodeURIComponent(room)}&lang=${encodeURIComponent(lang)}&tts=${tts}`
    const ws = new WebSocket(url)
    wsRef.current = ws
    setStatus('Connecting')
    ws.onopen = () => setStatus('Connected')
    ws.onclose = () => setStatus('Closed')
    ws.onerror = () => setStatus('Error')
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        if (msg?.type === 'patch' && msg?.payload) {
          const p = msg.payload as Patch
          p.receivedAt = Date.now()  // Add timestamp when received
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

  // Group patches into natural paragraphs based on pauses, sentences, and length
  const paragraphs = useMemo(() => {
    // Sort patches by receivedAt (newest first) then by unitId for stable ordering
    const items = Array.from(patches.values()).sort((a, b) => {
      // If both have receivedAt, sort by that (newest first)
      if (a.receivedAt && b.receivedAt) {
        return b.receivedAt - a.receivedAt
      }
      // Fallback to unitId comparison
      return b.unitId.localeCompare(a.unitId)
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

    // Sort paragraphs by latest time (newest first)
    return paragraphGroups.sort((a, b) => b.latestTime - a.latestTime)
  }, [patches])

  return (
    <main className="container mx-auto max-w-3xl p-6">
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
      <div className="text-sm text-slate-400 mb-2">Status: {status}</div>

      {/* Paragraph-based display with natural breaks - newest first */}
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

