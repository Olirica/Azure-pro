import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'

type Patch = {
  unitId: string
  version: number
  stage: 'soft' | 'hard'
  text: string
  srcLang?: string
}

export function ListenerApp() {
  const [room, setRoom] = useState('demo-room')
  const [lang, setLang] = useState('fr-CA')
  const [tts, setTts] = useState(false)
  const [status, setStatus] = useState('Idle')
  const wsRef = useRef<WebSocket | null>(null)
  const [patches, setPatches] = useState<Map<string, Patch>>(new Map())
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio()
    }
  }, [])

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

  const items = useMemo(() => Array.from(patches.values()).sort((a,b)=>a.unitId.localeCompare(b.unitId)), [patches])

  return (
    <main className="container mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Listener</h1>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <div>
          <Label className="mb-1 block">Room</Label>
          <Input value={room} onChange={(e)=>setRoom(e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block">Language</Label>
          <Input value={lang} onChange={(e)=>setLang(e.target.value)} />
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm"><input type="checkbox" className="mr-2" checked={tts} onChange={(e)=>setTts(e.target.checked)} />TTS</label>
        </div>
        <div className="flex items-end gap-2">
          <Button onClick={connect}>Connect</Button>
          <Button variant="outline" onClick={disconnect}>Disconnect</Button>
        </div>
      </div>
      <div className="text-sm text-slate-400 mb-2">Status: {status}</div>
      <ul className="space-y-2">
        {items.map((p)=> (
          <li key={p.unitId} className={`rounded-md border px-3 py-2 ${p.stage==='hard' ? 'border-sky-500/50 bg-slate-800/60' : 'border-slate-600/50 bg-slate-800/30'}`}>
            <div className="text-xs uppercase tracking-wide opacity-70">{p.stage} v{p.version}</div>
            <div>{p.text}</div>
          </li>
        ))}
      </ul>
    </main>
  )
}

