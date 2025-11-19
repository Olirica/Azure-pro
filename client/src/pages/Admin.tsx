import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { cn } from '../lib/utils'
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

function slugify(input: string): string {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function parseList(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function AdminApp() {
  // Default to NOT authed; show login until server confirms
  const [authed, setAuthed] = useState<boolean>(false)
  const [token, setToken] = useState('')
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [languages, setLanguages] = useState('')
  const [defaultTargets, setDefaultTargets] = useState('')
  const [langSuggestions, setLangSuggestions] = useState<{ type: 'src' | 'tgt'; q: string; items: { code: string; name: string }[]; index?: number } | null>(null)
  const [quickLangs, setQuickLangs] = useState<string[]>([])
  const [langsUnknown, setLangsUnknown] = useState<string[]>([])
  const [targetsUnknown, setTargetsUnknown] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [rooms, setRooms] = useState<any[]>([])
  const [health, setHealth] = useState<{
    redis?: { configured?: boolean; up?: boolean; error?: string }
    db?: { configured?: boolean; up?: boolean; error?: string }
    roomsActive?: number
    roomsDb?: number | null
  } | null>(null)

  useEffect(() => {
    // Check auth on mount
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
      defaultTargetLangs: parseList(defaultTargets)
    } as any
    return out
  }, [slug, startsAt, endsAt, languages, defaultTargets])

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
    // If ends with comma, just append token
    if (/[,]$/.test(trimmed)) return `${trimmed} ${token}`
    // If last token is partial, replace it
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
    // Ensure codes exist in our curated list; fall back to the same code even if not listed
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
    // Seed quick picks on first load if empty
    const existing = loadLangUsage()
    if (existing.size === 0) {
      const seeds = new Set<string>([
        'en-US', 'fr-CA', 'es-MX', 'es-ES', 'pt-BR', 'de-DE', 'it-IT', 'ja-JP', 'zh-CN', 'ko-KR'
      ])
      // Add browser preferred locales if they match our curated list
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
    // Validate language codes before saving
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
      // As a fallback, allow header token when not authenticated (dev convenience)
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

  if (!authed) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent mb-2">Admin Access</h1>
            <p className="text-slate-400">Enter your admin token to continue</p>
          </div>
          <form onSubmit={login} className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-8 shadow-2xl space-y-4">
            <div>
              <Label className="mb-2 block text-slate-300">Admin Token</Label>
              <Input
                type="password"
                value={token}
                onChange={(e)=>setToken(e.target.value)}
                placeholder="Enter your token"
                className="bg-slate-900/50 border-slate-700 focus:border-blue-500 transition-colors"
              />
            </div>
            <div className="pt-2">
              <Button type="submit" className="w-full bg-gradient-to-r from-blue-500 to-violet-500 hover:from-blue-600 hover:to-violet-600 transition-all">
                Continue
              </Button>
              {status && (
                <p className={cn('text-sm mt-3 text-center', status.startsWith('Error') ? 'text-red-400' : 'text-emerald-400')}>{status}</p>
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
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">Room Admin</h1>
            <p className="text-slate-400 mt-1">Configure and manage translation rooms</p>
          </div>
          <Button type="button" variant="outline" onClick={async ()=>{ try { await fetch('/api/admin/logout', { method: 'POST' }); } catch {} setAuthed(false); }} className="border-slate-700 hover:bg-slate-800">
            Log out
          </Button>
        </div>

        {/* Infrastructure Status */}
        <div className="mb-6 rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-6 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-lg font-semibold text-slate-200 mb-1">Infrastructure</div>
              <div className="flex items-center gap-4 text-sm text-slate-400">
                <span>Rooms: <span className="text-blue-400 font-medium">{health?.roomsDb ?? rooms.length}</span></span>
                {typeof health?.roomsActive === 'number' && (
                  <span>Active: <span className="text-emerald-400 font-medium">{health?.roomsActive}</span></span>
                )}
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={()=>{ loadHealth(); loadRooms(); }} className="border-slate-700 hover:bg-slate-800">
              Refresh
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-lg border p-4 transition-colors" style={{
              borderColor: health?.db?.up ? 'rgba(59,130,246,0.5)' : 'rgba(248,113,113,0.5)',
              background: health?.db?.up ? 'rgba(59,130,246,0.1)' : 'rgba(248,113,113,0.1)'
            }}>
              <div className="flex items-center gap-2">
                <div className={cn('w-2 h-2 rounded-full', health?.db?.up ? 'bg-blue-400' : 'bg-red-400')}></div>
                <span className="font-semibold text-slate-200">Postgres</span>
              </div>
              <div className="text-sm mt-1 text-slate-400">
                {!health?.db?.configured && <span>Not configured</span>}
                {health?.db?.configured && health?.db?.up && <span className="text-emerald-400">Connected</span>}
                {health?.db?.configured && health?.db && health.db.up === false && (
                  <span className="text-red-400">Disconnected</span>
                )}
                {health?.db?.error && (
                  <div className="mt-1 text-xs text-slate-500">{health.db.error}</div>
                )}
              </div>
            </div>
            {health?.redis?.configured && (
              <div className="rounded-lg border p-4 transition-colors" style={{
                borderColor: health?.redis?.up ? 'rgba(59,130,246,0.5)' : 'rgba(248,113,113,0.5)',
                background: health?.redis?.up ? 'rgba(59,130,246,0.1)' : 'rgba(248,113,113,0.1)'
              }}>
                <div className="flex items-center gap-2">
                  <div className={cn('w-2 h-2 rounded-full', health?.redis?.up ? 'bg-blue-400' : 'bg-red-400')}></div>
                  <span className="font-semibold text-slate-200">Redis</span>
                </div>
                <div className="text-sm mt-1 text-slate-400">
                  {health?.redis?.configured && health?.redis?.up && <span className="text-emerald-400">Connected</span>}
                  {health?.redis?.configured && health?.redis && health.redis.up === false && (
                    <span className="text-red-400">Disconnected</span>
                  )}
                  {health?.redis?.error && (
                    <div className="mt-1 text-xs text-slate-500">{health.redis.error}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Room Form */}
        <form onSubmit={onSave} className="rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-8 shadow-xl space-y-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-700/50">
            <h2 className="text-xl font-semibold text-slate-200">Room Configuration</h2>
          </div>

        <div>
          <Label className="mb-1 block">Code</Label>
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g., launch-2025" />
          <p className="mt-1 text-xs text-slate-400">Unique room identifier. Leave blank to auto-generate.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="mb-1 block">Starts At</Label>
            <Input type="datetime-local" step={60} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block">Ends At</Label>
            <Input type="datetime-local" step={60} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </div>
        </div>

        <div>
          <Label className="mb-1 block">Speaker page languages input</Label>
          <div className="relative">
            <Input
              value={languages}
              onChange={(e) => onTypeLanguages(e.target.value)}
              onKeyDown={(e)=>{
                if (!langSuggestions || (langSuggestions.type !== 'src')) return
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
              placeholder="Type to search… e.g., en-US or en-US,fr-FR,es-ES"
            />
            {langSuggestions?.type === 'src' && (langSuggestions.items?.length || 0) > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-600 bg-slate-900/95 shadow">
                {langSuggestions.items.map((l, i) => (
                  <button
                    type="button"
                    key={l.code}
                    className={cn('flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-800', i === (langSuggestions.index ?? -1) ? 'bg-slate-800' : '')}
                    onMouseEnter={() => setLangSuggestions({ ...langSuggestions, index: i })}
                    onClick={() => applySuggestion(l.code)}
                  >
                    <span>{l.name}</span>
                    <code className="text-xs opacity-80">{l.code}</code>
                  </button>
                ))}
              </div>
            )}
          </div>
          {langsUnknown.length > 0 && (
            <p className="mt-1 text-xs text-amber-400">Unknown codes: {langsUnknown.join(', ')}</p>
          )}
          {quickLangs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {quickLangs.slice(0, 8).map((code) => (
                <button type="button" key={'src-'+code} className="rounded border border-slate-600 px-2 py-0.5 text-xs hover:bg-slate-800"
                  title={(LANGS.find(l=>l.code===code)?.name)||code}
                  onClick={() => {
                    setLanguages((cur) => appendToken(cur, code))
                    recordLangUse(code)
                  }}>
                  <code>{code}</code>
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-slate-400">One = fixed source; multiple = auto-detect across the list.</p>
        </div>

        <div>
          <Label className="mb-1 block">Default Target Languages</Label>
          <div className="relative">
            <Input
              value={defaultTargets}
              onChange={(e) => onTypeTargets(e.target.value)}
              onKeyDown={(e)=>{
                if (!langSuggestions || (langSuggestions.type !== 'tgt')) return
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
              placeholder="Type to search… e.g., fr-CA,es-ES"
            />
            {langSuggestions?.type === 'tgt' && (langSuggestions.items?.length || 0) > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-600 bg-slate-900/95 shadow">
                {langSuggestions.items.map((l, i) => (
                  <button
                    type="button"
                    key={l.code}
                    className={cn('flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-800', i === (langSuggestions.index ?? -1) ? 'bg-slate-800' : '')}
                    onMouseEnter={() => setLangSuggestions({ ...langSuggestions, index: i })}
                    onClick={() => applySuggestion(l.code)}
                  >
                    <span>{l.name}</span>
                    <code className="text-xs opacity-80">{l.code}</code>
                  </button>
                ))}
              </div>
            )}
          </div>
          {targetsUnknown.length > 0 && (
            <p className="mt-1 text-xs text-amber-400">Unknown codes: {targetsUnknown.join(', ')}</p>
          )}
          {quickLangs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {quickLangs.slice(0, 8).map((code) => (
                <button type="button" key={'tgt-'+code} className="rounded border border-slate-600 px-2 py-0.5 text-xs hover:bg-slate-800"
                  title={(LANGS.find(l=>l.code===code)?.name)||code}
                  onClick={() => {
                    setDefaultTargets((cur) => appendToken(cur, code))
                    recordLangUse(code)
                  }}>
                  <code>{code}</code>
                </button>
              ))}
            </div>
          )}
        </div>

        <p className="text-xs text-slate-400">Join codes: listener = <code>slug</code>, speaker = <code>slug-speaker</code>.</p>

        <div className="flex items-center gap-3 pt-4 border-t border-slate-700/50">
          <Button type="submit" className="bg-gradient-to-r from-blue-500 to-violet-500 hover:from-blue-600 hover:to-violet-600 transition-all">
            Save Room
          </Button>
          <Button type="button" variant="outline" onClick={loadRooms} className="border-slate-700 hover:bg-slate-800">
            Refresh List
          </Button>
          {status && (
            <span className={cn('text-sm', status.startsWith('Error') ? 'text-red-400' : 'text-emerald-400')}>{status}</span>
          )}
        </div>
      </form>

      {/* Rooms List */}
      <section className="mt-8 rounded-xl border border-slate-700/50 bg-slate-800/40 backdrop-blur-sm p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-700/50">
          <div>
            <h2 className="text-xl font-semibold text-slate-200">Rooms</h2>
            <p className="text-sm text-slate-400 mt-1">{rooms.length} room{rooms.length !== 1 ? 's' : ''} configured</p>
          </div>
        </div>
        <div className="space-y-3">
          {rooms.map((r) => (
            <div key={r.slug} className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-4 hover:bg-slate-900/50 transition-colors">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-blue-500/30 flex items-center justify-center">
                    <span className="text-blue-400 font-bold text-sm">{(r.title || r.slug).substring(0, 2).toUpperCase()}</span>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-200">{r.title || r.slug}</div>
                    <code className="text-xs text-slate-500 bg-slate-800/50 px-2 py-0.5 rounded">{r.slug}</code>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" className="border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
                    onClick={()=>{
                      setSlug(r.slug)
                      setStartsAt(r.startsAt ? new Date(r.startsAt).toISOString().slice(0, 16) : '')
                      setEndsAt(r.endsAt ? new Date(r.endsAt).toISOString().slice(0, 16) : '')
                      setLanguages((r.sourceLang && r.sourceLang !== 'auto' ? r.sourceLang : (r.autoDetectLangs || []).join(', ')))
                      setDefaultTargets((r.defaultTargetLangs || []).join(', '))
                      window.scrollTo({ top: 0, behavior: 'smooth' })
                    }}>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="text-red-400 border-red-500/50 hover:bg-red-500/10"
                    onClick={async ()=>{
                      try {
                        const res = await fetch(`/api/admin/rooms/${encodeURIComponent(r.slug)}`, { method: 'DELETE', credentials: 'include' })
                        const body = await res.json().catch(()=>({}))
                        if (!res.ok || !body?.ok) throw new Error(body?.error || 'Delete failed')
                        setStatus('Deleted.')
                        loadRooms()
                        loadHealth()
                      } catch (err:any) {
                        setStatus('Error: ' + (err?.message || 'unknown'))
                      }
                    }}>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div className="rounded-md bg-slate-800/50 p-2">
                  <div className="text-xs text-slate-500 mb-1">Source</div>
                  <div className="text-slate-300">{r.sourceLang || '—'}</div>
                </div>
                <div className="rounded-md bg-slate-800/50 p-2">
                  <div className="text-xs text-slate-500 mb-1">Auto-detect</div>
                  <div className="text-slate-300">{(r.autoDetectLangs || []).join(', ') || '—'}</div>
                </div>
                <div className="rounded-md bg-slate-800/50 p-2">
                  <div className="text-xs text-slate-500 mb-1">Targets</div>
                  <div className="text-slate-300">{(r.defaultTargetLangs || []).join(', ') || '—'}</div>
                </div>
              </div>
              {(r.startsAt || r.endsAt) && (
                <div className="mt-2 text-xs text-slate-500 bg-slate-800/30 rounded px-2 py-1">
                  {r.startsAt ? new Date(r.startsAt).toLocaleString() : '—'} → {r.endsAt ? new Date(r.endsAt).toLocaleString() : '—'}
                </div>
              )}
            </div>
          ))}
          {!rooms.length && (
            <div className="text-center py-12">
              <div className="text-slate-500 mb-2">
                <svg className="w-12 h-12 mx-auto opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <p className="text-slate-400">No rooms configured yet</p>
              <p className="text-sm text-slate-500 mt-1">Create your first room above</p>
            </div>
          )}
        </div>
      </section>
      </div>
    </main>
  )
}
