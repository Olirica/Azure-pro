import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { cn } from '../lib/utils'

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
  const [status, setStatus] = useState('')
  const [rooms, setRooms] = useState<any[]>([])
  const [health, setHealth] = useState<{ redis?: { configured?: boolean; up?: boolean; error?: string } } | null>(null)

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

  useEffect(() => {
    if (!slug && title) setSlug(slugify(title))
  }, [title])

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
      slug: slug || slugify(title),
      title,
      startsAt: toMillis(startsAt),
      endsAt: toMillis(endsAt),
      sourceLang,
      autoDetectLangs,
      defaultTargetLangs: parseList(defaultTargets)
    } as any
    return out
  }, [slug, title, startsAt, endsAt, languages, defaultTargets])

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    setStatus('')
    const finalSlug = payload.slug
    if (!finalSlug) {
      setStatus('Slug or Title required.')
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
      <main className="container mx-auto max-w-md p-6">
        <h1 className="text-2xl font-semibold mb-4">Admin Login</h1>
        <form onSubmit={login} className="rounded-lg border border-slate-700 bg-slate-800/60 p-6 shadow space-y-3">
          <div>
            <Label className="mb-1 block">Admin token</Label>
            <Input type="password" value={token} onChange={(e)=>setToken(e.target.value)} placeholder="••••••" />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit">Continue</Button>
            <span className={cn('text-sm', status.startsWith('Error') ? 'text-red-400' : 'text-slate-400')}>{status}</span>
          </div>
        </form>
      </main>
    )
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">Room Admin</h1>
      {(
        <div className="mb-4 rounded-md border p-3 "
          style={{
            borderColor: health?.redis?.up ? 'rgba(34,197,94,0.4)' : 'rgba(248,113,113,0.4)',
            background: health?.redis?.up ? 'rgba(34,197,94,0.1)' : 'rgba(248,113,113,0.08)'
          }}>
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="font-medium">Redis:</span>{' '}
              {!health?.redis?.configured && <span className="opacity-80">not configured (using memory)</span>}
              {health?.redis?.configured && health?.redis?.up && <span className="text-emerald-400">up</span>}
              {health?.redis?.configured && health?.redis && health.redis.up === false && (
                <span className="text-red-400">down</span>
              )}
              {health?.redis?.error && (
                <span className="ml-2 text-xs opacity-80">{health.redis.error}</span>
              )}
            </div>
            <Button type="button" variant="outline" onClick={loadHealth}>Check</Button>
          </div>
        </div>
      )}
      <form onSubmit={onSave} className="rounded-lg border border-slate-700 bg-slate-800/60 p-6 shadow space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-400">Authenticated</div>
          <Button type="button" variant="outline" onClick={async ()=>{ try { await fetch('/api/admin/logout', { method: 'POST' }); } catch {} setAuthed(false); }}>Log out</Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="mb-1 block">Slug</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g., launch-2025" />
            <p className="mt-1 text-xs text-slate-400">Leave blank to auto-generate from Title.</p>
          </div>
          <div>
            <Label className="mb-1 block">Title (display)</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Conference or session name" />
          </div>
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
          <Label className="mb-1 block">Languages</Label>
          <Input value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="e.g., en-US or en-US,fr-FR,es-ES" />
          <p className="mt-1 text-xs text-slate-400">One = fixed source; multiple = auto-detect across the list.</p>
        </div>

        <div>
          <Label className="mb-1 block">Default Target Languages</Label>
          <Input value={defaultTargets} onChange={(e) => setDefaultTargets(e.target.value)} placeholder="e.g., fr-CA,es-ES" />
        </div>

        <p className="text-xs text-slate-400">Join codes: listener = <code>slug</code>, speaker = <code>slug-speaker</code>.</p>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit">Save Room</Button>
          <span className={cn('text-sm', status.startsWith('Error') ? 'text-red-400' : 'text-slate-400')}>{status}</span>
          <Button type="button" variant="outline" onClick={loadRooms}>Refresh</Button>
        </div>
      </form>

      <section className="mt-6 rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Rooms</h2>
          <span className="text-sm text-slate-400">{rooms.length} total</span>
        </div>
        <div className="space-y-2">
          {rooms.map((r) => (
            <div key={r.slug} className="rounded-md border border-slate-700 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">{r.title || r.slug}</div>
                <code className="text-xs opacity-80">{r.slug}</code>
              </div>
              <div className="text-sm text-slate-300 mt-1">
                <span className="opacity-70">Source:</span> {r.sourceLang || '—'}; <span className="opacity-70">Auto:</span> {(r.autoDetectLangs || []).join(', ') || '—'}; <span className="opacity-70">Targets:</span> {(r.defaultTargetLangs || []).join(', ') || '—'}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                <span className="opacity-70">Window:</span> {r.startsAt ? new Date(r.startsAt).toLocaleString() : '—'} → {r.endsAt ? new Date(r.endsAt).toLocaleString() : '—'}
              </div>
            </div>
          ))}
          {!rooms.length && (
            <div className="text-sm text-slate-400">No rooms yet.</div>
          )}
        </div>
      </section>
    </main>
  )
}
