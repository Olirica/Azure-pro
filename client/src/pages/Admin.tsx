import React, { useEffect, useMemo, useState } from 'react'
import { LANGS, matchLangs } from '../data/languages'

// Valid Azure locale codes for validation
const VALID_CODES = new Set(LANGS.map(l => l.code.toLowerCase()))

function toMillis(dt: string): number {
  if (!dt) return 0
  try {
    const n = new Date(dt).getTime()
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function parseList(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Glass panel styles
const glassPanel = "relative backdrop-blur-xl bg-white/[0.03] border border-white/[0.08] rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)]"
const glassInput = "w-full bg-white/[0.03] backdrop-blur border border-white/[0.1] rounded-xl px-4 py-3 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all duration-200"
const glassTextarea = "w-full bg-white/[0.03] backdrop-blur border border-white/[0.1] rounded-xl px-4 py-3 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all duration-200 resize-y min-h-[80px]"

// Neumorphic button styles
const btnPrimary = "relative px-6 py-3 rounded-xl font-semibold text-sm tracking-wide transition-all duration-200 bg-gradient-to-br from-cyan-500/80 to-teal-600/80 text-white shadow-[0_4px_20px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] hover:shadow-[0_6px_24px_rgba(20,184,166,0.4),inset_0_1px_0_rgba(255,255,255,0.3)] hover:translate-y-[-1px] active:translate-y-[1px] active:shadow-[0_2px_12px_rgba(20,184,166,0.3),inset_0_1px_0_rgba(255,255,255,0.1)]"
const btnGhost = "relative px-5 py-2.5 rounded-xl font-medium text-sm text-white/70 transition-all duration-200 bg-white/[0.03] border border-white/[0.08] hover:bg-white/[0.06] hover:border-white/[0.12] hover:text-white/90 active:bg-white/[0.02]"
const btnDanger = "relative px-3 py-2 rounded-lg text-xs font-medium text-rose-300/80 transition-all duration-200 bg-rose-500/[0.08] border border-rose-400/20 hover:bg-rose-500/[0.15] hover:border-rose-400/30 hover:text-rose-300 active:bg-rose-500/[0.1]"
const btnEdit = "relative px-3 py-2 rounded-lg text-xs font-medium text-cyan-300/80 transition-all duration-200 bg-cyan-500/[0.08] border border-cyan-400/20 hover:bg-cyan-500/[0.15] hover:border-cyan-400/30 hover:text-cyan-300 active:bg-cyan-500/[0.1]"

// Status indicator
const StatusDot = ({ active }: { active: boolean }) => (
  <div className={`relative w-2.5 h-2.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-rose-400'}`}>
    {active && <div className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-50" />}
    <div className={`absolute inset-[-3px] rounded-full ${active ? 'bg-emerald-400/20' : 'bg-rose-400/20'} blur-sm`} />
  </div>
)

export function AdminApp() {
  const [authed, setAuthed] = useState<boolean>(false)
  const [token, setToken] = useState('')
  const [slug, setSlug] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [languages, setLanguages] = useState('')
  const [defaultTargets, setDefaultTargets] = useState('')
  const [langSuggestions, setLangSuggestions] = useState<{ type: 'src' | 'tgt'; q: string; items: { code: string; name: string }[]; index?: number } | null>(null)
  const [quickLangs, setQuickLangs] = useState<string[]>([])
  const [langsUnknown, setLangsUnknown] = useState<string[]>([])
  const [targetsUnknown, setTargetsUnknown] = useState<string[]>([])
  const [sttPrompt, setSttPrompt] = useState('')
  const [status, setStatus] = useState('')
  const [rooms, setRooms] = useState<any[]>([])
  const [health, setHealth] = useState<{
    redis?: { configured?: boolean; up?: boolean; error?: string }
    db?: { configured?: boolean; up?: boolean; error?: string }
    roomsActive?: number
    roomsDb?: number | null
  } | null>(null)

  useEffect(() => {
    fetch('/api/admin/check')
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false))
  }, [])

  async function loadRooms() {
    try {
      const r = await fetch('/api/admin/rooms', { credentials: 'include' })
      if (!r.ok) return
      const data = await r.json().catch(() => ({}))
      if (data?.rooms && Array.isArray(data.rooms)) setRooms(data.rooms)
    } catch {}
  }

  async function loadHealth() {
    try {
      const r = await fetch('/healthz', { cache: 'no-store' })
      if (!r.ok) return
      const data = await r.json().catch(() => ({}))
      setHealth(data || null)
    } catch {}
  }

  useEffect(() => {
    if (authed) loadRooms()
  }, [authed])

  useEffect(() => {
    loadHealth()
  }, [])

  const payload = useMemo(() => {
    const langs = parseList(languages)
    let sourceLang = ''
    let autoDetectLangs: string[] = []
    if (langs.length <= 1) sourceLang = langs[0] || ''
    else {
      sourceLang = 'auto'
      autoDetectLangs = langs
    }
    const out = {
      slug,
      title: slug,
      startsAt: toMillis(startsAt),
      endsAt: toMillis(endsAt),
      sourceLang,
      autoDetectLangs,
      defaultTargetLangs: parseList(defaultTargets),
      sttPrompt: sttPrompt.trim()
    } as any
    return out
  }, [slug, startsAt, endsAt, languages, defaultTargets, sttPrompt])

  // Suggestion helpers for CSV fields
  function lastToken(value: string): string {
    const idx = value.lastIndexOf(',')
    return idx >= 0 ? value.slice(idx + 1).trim() : value.trim()
  }
  function replaceLastToken(value: string, token: string): string {
    const idx = value.lastIndexOf(',')
    const before = idx >= 0 ? value.slice(0, idx).trim() : ''
    return before ? `${before}, ${token}` : token
  }
  function appendToken(value: string, token: string): string {
    const trimmed = String(value || '').trim()
    if (!trimmed) return token
    if (/[,]$/.test(trimmed)) return `${trimmed} ${token}`
    const lt = lastToken(trimmed)
    if (lt && lt !== trimmed) {
      return replaceLastToken(trimmed, token)
    }
    return `${trimmed}, ${token}`
  }
  function onTypeLanguages(next: string) {
    setLanguages(next)
    const q = lastToken(next)
    setLangSuggestions({ type: 'src', q, items: matchLangs(q), index: 0 })
  }
  function onTypeTargets(next: string) {
    setDefaultTargets(next)
    const q = lastToken(next)
    setLangSuggestions({ type: 'tgt', q, items: matchLangs(q), index: 0 })
  }
  function applySuggestion(code: string) {
    if (!langSuggestions) return
    if (langSuggestions.type === 'src') {
      setLanguages((cur) => replaceLastToken(cur, code))
    } else {
      setDefaultTargets((cur) => replaceLastToken(cur, code))
    }
    setLangSuggestions(null)
    recordLangUse(code)
  }

  // Validation for unknown codes on blur
  function validateCsv(value: string): string[] {
    const raw = String(value || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const unknown: string[] = []
    for (const code of raw) {
      if (!VALID_CODES.has(code.toLowerCase())) unknown.push(code)
    }
    return unknown
  }

  // Persist most-used languages (quick picks)
  function loadLangUsage(): Map<string, number> {
    try {
      const raw = localStorage.getItem('langUsage')
      if (!raw) return new Map()
      const obj = JSON.parse(raw) || {}
      const m = new Map<string, number>()
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(v)
        if (k && Number.isFinite(n)) m.set(k, n)
      }
      return m
    } catch {
      return new Map()
    }
  }
  function saveLangUsage(map: Map<string, number>) {
    const obj: Record<string, number> = {}
    for (const [k, v] of map.entries()) obj[k] = v
    try { localStorage.setItem('langUsage', JSON.stringify(obj)) } catch {}
  }
  function refreshQuickPicks(map: Map<string, number>) {
    const entries = Array.from(map.entries())
    entries.sort((a, b) => b[1] - a[1])
    const top = entries.map(([k]) => k)
    setQuickLangs(top.slice(0, 10))
  }
  function recordLangUse(code: string) {
    const m = loadLangUsage()
    const key = String(code || '').trim()
    if (!key) return
    m.set(key, (m.get(key) || 0) + 1)
    saveLangUsage(m)
    refreshQuickPicks(m)
  }
  useEffect(() => {
    const existing = loadLangUsage()
    if (existing.size === 0) {
      const seeds = new Set<string>([
        'en-US', 'fr-CA', 'es-MX', 'es-ES', 'pt-BR', 'de-DE', 'it-IT', 'ja-JP', 'zh-CN', 'ko-KR'
      ])
      try {
        const prefs: string[] = (navigator as any)?.languages || ((navigator as any)?.language ? [(navigator as any).language] : [])
        for (const p of prefs) {
          const match = LANGS.find(l => l.code.toLowerCase() === String(p).toLowerCase())
          if (match) seeds.add(match.code)
        }
      } catch {}
      for (const code of seeds) {
        existing.set(code, 1)
      }
      saveLangUsage(existing)
    }
    refreshQuickPicks(existing)
  }, [])

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    setStatus('')
    const finalSlug = payload.slug
    if (!finalSlug) {
      setStatus('Code is required.')
      return
    }
    const invalidLangs = validateCsv(languages)
    const invalidTargets = validateCsv(defaultTargets)
    if (invalidLangs.length > 0) {
      setStatus(`Invalid source language codes: ${invalidLangs.join(', ')}`)
      return
    }
    if (invalidTargets.length > 0) {
      setStatus(`Invalid target language codes: ${invalidTargets.join(', ')}`)
      return
    }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (!authed && token) {
        headers['x-admin-token'] = token
      }
      const res = await fetch('/api/admin/rooms', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(payload)
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.ok) throw new Error(body?.error || 'Save failed')
      setStatus('Saved.')
      loadRooms()
    } catch (err: any) {
      setStatus('Error: ' + (err?.message || 'unknown'))
    }
  }

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setStatus('')
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token })
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.ok) throw new Error(body?.error || 'Login failed')
      setAuthed(true)
      setStatus('')
    } catch (err: any) {
      setStatus('Error: ' + (err?.message || 'unknown'))
    }
  }

  // Login screen
  if (!authed) {
    return (
      <>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap');
          .font-display { font-family: 'Outfit', sans-serif; }
          .font-body { font-family: 'DM Sans', sans-serif; }
          @keyframes aurora {
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
          }
          .aurora-bg {
            background: linear-gradient(-45deg, #0a0f1c, #1a1f3c, #0f172a, #1e1b4b, #0c1929);
            background-size: 400% 400%;
            animation: aurora 20s ease infinite;
          }
        `}</style>
        <main className="aurora-bg min-h-screen flex items-center justify-center p-6 font-body">
          <div className="w-full max-w-md">
            <div className="text-center mb-10">
              <h1 className="font-display text-4xl font-semibold text-white/95 tracking-tight mb-3">Simo Admin</h1>
              <p className="text-white/40 text-sm tracking-wide">Enter your credentials to continue</p>
            </div>
            <form onSubmit={login} className={`${glassPanel} p-8 space-y-6`}>
              <div>
                <label className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Admin Token</label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Enter your token"
                  className={glassInput}
                />
              </div>
              <div className="pt-2">
                <button type="submit" className={`${btnPrimary} w-full`}>
                  Continue
                </button>
                {status && (
                  <p className={`text-sm mt-4 text-center ${status.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'}`}>{status}</p>
                )}
              </div>
            </form>
          </div>
        </main>
      </>
    )
  }

  // Main admin panel
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap');
        .font-display { font-family: 'Outfit', sans-serif; }
        .font-body { font-family: 'DM Sans', sans-serif; }
        @keyframes aurora {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        .aurora-bg {
          background: linear-gradient(-45deg, #0a0f1c, #1a1f3c, #0f172a, #1e1b4b, #0c1929);
          background-size: 400% 400%;
          animation: aurora 20s ease infinite;
        }
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        .float-subtle {
          animation: float 6s ease-in-out infinite;
        }
      `}</style>
      <main className="aurora-bg min-h-screen px-4 py-10 font-body">
        <div className="max-w-5xl mx-auto">
          {/* Header */}
          <header className="flex items-center justify-between mb-10">
            <div>
              <h1 className="font-display text-3xl font-semibold text-white/95 tracking-tight">Room Control</h1>
              <p className="text-white/40 text-sm mt-1">Manage translation sessions</p>
            </div>
            <button
              onClick={async () => { try { await fetch('/api/admin/logout', { method: 'POST' }); } catch {} setAuthed(false); }}
              className={btnGhost}
            >
              Sign Out
            </button>
          </header>

          {/* Infrastructure Status */}
          <section className={`${glassPanel} p-6 mb-8`}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="font-display text-lg font-medium text-white/90">Infrastructure</h2>
                <div className="flex items-center gap-6 mt-1.5 text-sm text-white/50">
                  <span>Rooms: <span className="text-cyan-400 font-medium">{health?.roomsDb ?? rooms.length}</span></span>
                  {typeof health?.roomsActive === 'number' && (
                    <span>Active: <span className="text-emerald-400 font-medium">{health?.roomsActive}</span></span>
                  )}
                </div>
              </div>
              <button onClick={() => { loadHealth(); loadRooms(); }} className={btnGhost}>
                Refresh
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={`rounded-xl p-4 bg-white/[0.02] border ${health?.db?.up ? 'border-emerald-500/20' : 'border-rose-500/20'}`}>
                <div className="flex items-center gap-3">
                  <StatusDot active={!!health?.db?.up} />
                  <span className="font-medium text-white/80">Postgres</span>
                </div>
                <div className="text-xs mt-2 text-white/40">
                  {!health?.db?.configured && 'Not configured'}
                  {health?.db?.configured && health?.db?.up && <span className="text-emerald-400">Connected</span>}
                  {health?.db?.configured && health?.db && health.db.up === false && <span className="text-rose-400">Disconnected</span>}
                </div>
              </div>
              {health?.redis?.configured && (
                <div className={`rounded-xl p-4 bg-white/[0.02] border ${health?.redis?.up ? 'border-emerald-500/20' : 'border-rose-500/20'}`}>
                  <div className="flex items-center gap-3">
                    <StatusDot active={!!health?.redis?.up} />
                    <span className="font-medium text-white/80">Redis</span>
                  </div>
                  <div className="text-xs mt-2 text-white/40">
                    {health?.redis?.up && <span className="text-emerald-400">Connected</span>}
                    {health?.redis && health.redis.up === false && <span className="text-rose-400">Disconnected</span>}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Room Form */}
          <form onSubmit={onSave} className={`${glassPanel} p-8 mb-8`}>
            <h2 className="font-display text-xl font-medium text-white/90 mb-6 pb-4 border-b border-white/[0.06]">
              Room Configuration
            </h2>

            <div className="space-y-6">
              {/* Room Code */}
              <div>
                <label className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Room Code</label>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="e.g., launch-2025"
                  className={glassInput}
                />
                <p className="mt-1.5 text-xs text-white/30">Unique room identifier</p>
              </div>

              {/* Date Range */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Starts At</label>
                  <input
                    type="datetime-local"
                    step={60}
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    className={glassInput}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Ends At</label>
                  <input
                    type="datetime-local"
                    step={60}
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    className={glassInput}
                  />
                </div>
              </div>

              {/* Source Languages */}
              <div>
                <label className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Source Languages</label>
                <div className="relative">
                  <input
                    value={languages}
                    onChange={(e) => onTypeLanguages(e.target.value)}
                    onKeyDown={(e) => {
                      if (!langSuggestions || langSuggestions.type !== 'src') return
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        const dir = e.key === 'ArrowDown' ? 1 : -1
                        const len = langSuggestions.items.length
                        const idx = ((langSuggestions.index ?? 0) + dir + len) % len
                        setLangSuggestions({ ...langSuggestions, index: idx })
                      } else if (e.key === 'Enter') {
                        const idx = langSuggestions.index ?? 0
                        const item = langSuggestions.items[idx]
                        if (item) applySuggestion(item.code)
                      } else if (e.key === 'Escape') {
                        setLangSuggestions(null)
                      }
                    }}
                    onBlur={() => setLangsUnknown(validateCsv(languages))}
                    placeholder="Type to search... e.g., en-US, fr-CA"
                    className={glassInput}
                  />
                  {langSuggestions?.type === 'src' && (langSuggestions.items?.length || 0) > 0 && (
                    <div className="absolute z-20 mt-2 w-full rounded-xl border border-white/[0.1] bg-slate-900/95 backdrop-blur-xl shadow-xl overflow-hidden">
                      {langSuggestions.items.map((l, i) => (
                        <button
                          type="button"
                          key={l.code}
                          className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors ${i === (langSuggestions.index ?? -1) ? 'bg-cyan-500/10 text-cyan-300' : 'text-white/70 hover:bg-white/[0.05]'}`}
                          onMouseEnter={() => setLangSuggestions({ ...langSuggestions, index: i })}
                          onClick={() => applySuggestion(l.code)}
                        >
                          <span>{l.name}</span>
                          <code className="text-xs opacity-60">{l.code}</code>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {langsUnknown.length > 0 && (
                  <p className="mt-1.5 text-xs text-amber-400">Unknown codes: {langsUnknown.join(', ')}</p>
                )}
                {quickLangs.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {quickLangs.slice(0, 8).map((code) => (
                      <button
                        type="button"
                        key={'src-' + code}
                        className="rounded-lg bg-white/[0.03] border border-white/[0.08] px-2.5 py-1 text-xs text-white/60 hover:bg-white/[0.06] hover:text-white/80 transition-colors"
                        title={(LANGS.find(l => l.code === code)?.name) || code}
                        onClick={() => {
                          setLanguages((cur) => appendToken(cur, code))
                          recordLangUse(code)
                        }}
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-xs text-white/30">One = fixed source; multiple = auto-detect</p>
              </div>

              {/* Target Languages */}
              <div>
                <label className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">Target Languages</label>
                <div className="relative">
                  <input
                    value={defaultTargets}
                    onChange={(e) => onTypeTargets(e.target.value)}
                    onKeyDown={(e) => {
                      if (!langSuggestions || langSuggestions.type !== 'tgt') return
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        const dir = e.key === 'ArrowDown' ? 1 : -1
                        const len = langSuggestions.items.length
                        const idx = ((langSuggestions.index ?? 0) + dir + len) % len
                        setLangSuggestions({ ...langSuggestions, index: idx })
                      } else if (e.key === 'Enter') {
                        const idx = langSuggestions.index ?? 0
                        const item = langSuggestions.items[idx]
                        if (item) applySuggestion(item.code)
                      } else if (e.key === 'Escape') {
                        setLangSuggestions(null)
                      }
                    }}
                    onBlur={() => setTargetsUnknown(validateCsv(defaultTargets))}
                    placeholder="Type to search... e.g., fr-CA, es-ES"
                    className={glassInput}
                  />
                  {langSuggestions?.type === 'tgt' && (langSuggestions.items?.length || 0) > 0 && (
                    <div className="absolute z-20 mt-2 w-full rounded-xl border border-white/[0.1] bg-slate-900/95 backdrop-blur-xl shadow-xl overflow-hidden">
                      {langSuggestions.items.map((l, i) => (
                        <button
                          type="button"
                          key={l.code}
                          className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors ${i === (langSuggestions.index ?? -1) ? 'bg-cyan-500/10 text-cyan-300' : 'text-white/70 hover:bg-white/[0.05]'}`}
                          onMouseEnter={() => setLangSuggestions({ ...langSuggestions, index: i })}
                          onClick={() => applySuggestion(l.code)}
                        >
                          <span>{l.name}</span>
                          <code className="text-xs opacity-60">{l.code}</code>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {targetsUnknown.length > 0 && (
                  <p className="mt-1.5 text-xs text-amber-400">Unknown codes: {targetsUnknown.join(', ')}</p>
                )}
                {quickLangs.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {quickLangs.slice(0, 8).map((code) => (
                      <button
                        type="button"
                        key={'tgt-' + code}
                        className="rounded-lg bg-white/[0.03] border border-white/[0.08] px-2.5 py-1 text-xs text-white/60 hover:bg-white/[0.06] hover:text-white/80 transition-colors"
                        title={(LANGS.find(l => l.code === code)?.name) || code}
                        onClick={() => {
                          setDefaultTargets((cur) => appendToken(cur, code))
                          recordLangUse(code)
                        }}
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* STT Domain Prompt */}
              <div>
                <label className="block text-xs font-medium text-white/50 uppercase tracking-wider mb-2">STT Domain Prompt</label>
                <textarea
                  value={sttPrompt}
                  onChange={(e) => setSttPrompt(e.target.value)}
                  placeholder="Optional: Provide domain context for better transcription. E.g., 'Medical conference discussing cardiology. Key terms: myocardial infarction, angioplasty, stent.'"
                  rows={3}
                  className={glassTextarea}
                />
                <p className="mt-1.5 text-xs text-white/30">Helps with punctuation style, vocabulary, and domain-specific terms</p>
              </div>

              {/* Join codes info */}
              <p className="text-xs text-white/40 pt-2">
                Join codes: listener = <code className="text-cyan-400/70">slug</code>, speaker = <code className="text-cyan-400/70">slug-speaker</code>
              </p>

              {/* Actions */}
              <div className="flex items-center gap-4 pt-4 border-t border-white/[0.06]">
                <button type="submit" className={btnPrimary}>
                  Save Room
                </button>
                <button type="button" onClick={loadRooms} className={btnGhost}>
                  Refresh List
                </button>
                {status && (
                  <span className={`text-sm ${status.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'}`}>{status}</span>
                )}
              </div>
            </div>
          </form>

          {/* Rooms List */}
          <section className={`${glassPanel} p-6`}>
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-white/[0.06]">
              <div>
                <h2 className="font-display text-xl font-medium text-white/90">Rooms</h2>
                <p className="text-sm text-white/40 mt-1">{rooms.length} room{rooms.length !== 1 ? 's' : ''} configured</p>
              </div>
            </div>
            <div className="space-y-4">
              {rooms.map((r) => (
                <div key={r.slug} className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-5 hover:bg-white/[0.03] transition-colors">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500/20 to-teal-500/20 border border-cyan-500/20 flex items-center justify-center">
                        <span className="font-display font-semibold text-cyan-400 text-sm">{(r.title || r.slug).substring(0, 2).toUpperCase()}</span>
                      </div>
                      <div>
                        <div className="font-medium text-white/90">{r.title || r.slug}</div>
                        <code className="text-xs text-white/40 bg-white/[0.03] px-2 py-0.5 rounded">{r.slug}</code>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={btnEdit}
                        onClick={() => {
                          setSlug(r.slug)
                          setStartsAt(r.startsAt ? new Date(r.startsAt).toISOString().slice(0, 16) : '')
                          setEndsAt(r.endsAt ? new Date(r.endsAt).toISOString().slice(0, 16) : '')
                          setLanguages((r.sourceLang && r.sourceLang !== 'auto' ? r.sourceLang : (r.autoDetectLangs || []).join(', ')))
                          setDefaultTargets((r.defaultTargetLangs || []).join(', '))
                          setSttPrompt(r.sttPrompt || '')
                          window.scrollTo({ top: 0, behavior: 'smooth' })
                        }}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={btnDanger}
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/admin/rooms/${encodeURIComponent(r.slug)}`, { method: 'DELETE', credentials: 'include' })
                            const body = await res.json().catch(() => ({}))
                            if (!res.ok || !body?.ok) throw new Error(body?.error || 'Delete failed')
                            setStatus('Deleted.')
                            loadRooms()
                            loadHealth()
                          } catch (err: any) {
                            setStatus('Error: ' + (err?.message || 'unknown'))
                          }
                        }}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-lg bg-white/[0.02] p-3">
                      <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1">Source</div>
                      <div className="text-white/70">{r.sourceLang || '—'}</div>
                    </div>
                    <div className="rounded-lg bg-white/[0.02] p-3">
                      <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1">Auto-detect</div>
                      <div className="text-white/70">{(r.autoDetectLangs || []).join(', ') || '—'}</div>
                    </div>
                    <div className="rounded-lg bg-white/[0.02] p-3">
                      <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1">Targets</div>
                      <div className="text-white/70">{(r.defaultTargetLangs || []).join(', ') || '—'}</div>
                    </div>
                  </div>
                  {(r.startsAt || r.endsAt) && (
                    <div className="mt-3 text-xs text-white/40 bg-white/[0.02] rounded-lg px-3 py-2">
                      {r.startsAt ? new Date(r.startsAt).toLocaleString() : '—'} → {r.endsAt ? new Date(r.endsAt).toLocaleString() : '—'}
                    </div>
                  )}
                </div>
              ))}
              {!rooms.length && (
                <div className="text-center py-16">
                  <div className="w-16 h-16 mx-auto rounded-2xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-center mb-4">
                    <svg className="w-8 h-8 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                    </svg>
                  </div>
                  <p className="text-white/50">No rooms configured yet</p>
                  <p className="text-sm text-white/30 mt-1">Create your first room above</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </>
  )
}
