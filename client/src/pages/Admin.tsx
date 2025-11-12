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

function useAdminToken() {
  const [token, setToken] = useState('')
  useEffect(() => {
    try {
      const u = new URL(window.location.href)
      const urlToken = u.searchParams.get('token') || ''
      const stored = sessionStorage.getItem('adminToken') || ''
      const chosen = urlToken || stored
      if (chosen) {
        setToken(chosen)
        sessionStorage.setItem('adminToken', chosen)
      }
    } catch {}
  }, [])
  return [token, setToken] as const
}

export function AdminApp() {
  const [token, setToken] = useAdminToken()
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [languages, setLanguages] = useState('')
  const [defaultTargets, setDefaultTargets] = useState('')
  const [status, setStatus] = useState('')

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
    if (!token) {
      setStatus('Admin token required.')
      return
    }
    try {
      const res = await fetch('/api/admin/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify(payload)
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.ok) throw new Error(body?.error || 'Save failed')
      setStatus('Saved.')
    } catch (err: any) {
      setStatus('Error: ' + (err?.message || 'unknown'))
    }
  }

  function applyToken() {
    if (!token) return
    try {
      sessionStorage.setItem('adminToken', token)
      const u = new URL(window.location.href)
      u.searchParams.set('token', token)
      window.history.replaceState(null, '', u.toString())
    } catch {}
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">Room Admin</h1>
      <form onSubmit={onSave} className="rounded-lg border border-slate-700 bg-slate-800/60 p-6 shadow space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-slate-400">Access requires ADMIN_TOKEN; append ?token=... to the URL.</div>
          <div className="flex items-center gap-2">
            <Input placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} className="w-64" />
            <Button type="button" onClick={applyToken}>Use Token</Button>
          </div>
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
        </div>
      </form>
    </main>
  )
}
