const crypto = require('crypto');
const { Pool } = require('pg');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function parseAccessCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return null;
  const isSpeaker = /-speaker$/i.test(raw);
  const slug = raw.replace(/-speaker$/i, '').trim().toLowerCase();
  if (!slug) return null;
  return { slug, role: isSpeaker ? 'speaker' : 'listener' };
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMillis(v) {
  if (!v) return 0;
  const n = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  source_lang TEXT NOT NULL DEFAULT '',
  auto_detect_langs TEXT[] NOT NULL DEFAULT '{}',
  default_target_langs TEXT[] NOT NULL DEFAULT '{}',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
  ends_at TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT status_valid CHECK (status IN ('scheduled','open','expired'))
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rooms_updated_at ON rooms;
CREATE TRIGGER trg_rooms_updated_at
BEFORE UPDATE ON rooms
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS room_codes (
  code_hash TEXT PRIMARY KEY,
  slug TEXT NOT NULL REFERENCES rooms(slug) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT role_valid CHECK (role IN ('speaker','listener')),
  CONSTRAINT unique_room_role UNIQUE (slug, role)
);

CREATE INDEX IF NOT EXISTS idx_room_codes_slug ON room_codes(slug);
CREATE INDEX IF NOT EXISTS idx_room_codes_role ON room_codes(role);
CREATE INDEX IF NOT EXISTS idx_rooms_updated_at ON rooms(updated_at DESC);
`;

function createPgPool({ logger } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  let ssl = null;
  if (/sslmode=require/.test(url) || process.env.PGSSL === 'true') {
    ssl = { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' };
  } else if (/\.proxy\.rlwy\.net/i.test(url)) {
    // Railway public proxy requires TLS
    ssl = { rejectUnauthorized: false };
  }
  const pool = new Pool({ connectionString: url, ...(ssl ? { ssl } : {}) });
  pool.on('error', (err) => logger?.error?.({ component: 'pg', err: err?.message }, 'Postgres pool error.'));
  return pool;
}

function createRoomRegistryPg({ logger } = {}) {
  const EARLY_JOIN_MIN = parseNumber(process.env.ROOM_EARLY_JOIN_MINUTES, 15);
  const GRACE_MIN = parseNumber(process.env.ROOM_GRACE_MINUTES, 60);
  const pool = createPgPool({ logger });
  if (!pool) return null;

  async function migrate() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(MIGRATION_SQL);
      await client.query('COMMIT');
      logger?.info?.({ component: 'room-registry', store: 'pg' }, 'Postgres schema migrated.');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  function windowState(meta, now = Date.now()) {
    if (!meta) return { state: 'open' };
    const early = EARLY_JOIN_MIN * 60 * 1000;
    const grace = GRACE_MIN * 60 * 1000;
    const notYet = meta.startsAt && now + early < meta.startsAt;
    const expired = meta.endsAt && now > meta.endsAt + grace;
    if (notYet) return { state: 'early' };
    if (expired) return { state: 'expired' };
    return { state: 'open' };
  }

  function cleanMeta(meta) {
    if (!meta) return null;
    const { speakerCodeHash, listenerCodeHash, ...clean } = meta;
    return clean;
  }

  async function upsert(meta, { speakerCode, listenerCode } = {}) {
    const slug = String(meta?.slug || '').trim().toLowerCase();
    if (!slug) throw new Error('Invalid room meta');
    const title = String(meta?.title || '').trim();
    const sourceLang = String(meta?.sourceLang || '').trim();
    const autoDetectLangs = Array.isArray(meta?.autoDetectLangs) ? meta.autoDetectLangs : [];
    const defaultTargetLangs = Array.isArray(meta?.defaultTargetLangs) ? meta.defaultTargetLangs : [];
    const startsAtMs = toMillis(meta?.startsAt);
    const endsAtMs = toMillis(meta?.endsAt);
    const status = String(meta?.status || 'scheduled');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO rooms (slug, title, source_lang, auto_detect_langs, default_target_langs, starts_at, ends_at, status)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6/1000.0), to_timestamp($7/1000.0), $8)
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title,
           source_lang = EXCLUDED.source_lang,
           auto_detect_langs = EXCLUDED.auto_detect_langs,
           default_target_langs = EXCLUDED.default_target_langs,
           starts_at = EXCLUDED.starts_at,
           ends_at = EXCLUDED.ends_at,
           status = EXCLUDED.status` ,
        [slug, title, sourceLang, autoDetectLangs, defaultTargetLangs, startsAtMs, endsAtMs, status]
      );

      // Intentionally skip writing room_codes by default.
      // Codes are deterministic (listener=slug, speaker=slug+'-speaker').
      // For backward compatibility we keep the room_codes table and resolveCode() can still read it if present.
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }

    return cleanMeta({
      slug,
      title,
      sourceLang,
      autoDetectLangs,
      defaultTargetLangs,
      startsAt: startsAtMs,
      endsAt: endsAtMs,
      status
    });
  }

  async function remove(slug) {
    const id = String(slug || '').trim().toLowerCase();
    if (!id) return false;
    const { rowCount } = await pool.query('DELETE FROM rooms WHERE slug=$1', [id]);
    return rowCount > 0;
  }

  async function get(slug) {
    const id = String(slug || '').trim();
    if (!id) return null;
    const { rows } = await pool.query(
      `SELECT slug, title, source_lang, auto_detect_langs, default_target_langs,
              EXTRACT(EPOCH FROM starts_at)*1000 AS starts_at_ms,
              EXTRACT(EPOCH FROM ends_at)*1000 AS ends_at_ms,
              status,
              EXTRACT(EPOCH FROM created_at)*1000 AS created_at_ms,
              EXTRACT(EPOCH FROM updated_at)*1000 AS updated_at_ms
       FROM rooms WHERE LOWER(slug) = LOWER($1) LIMIT 1`,
      [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      slug: r.slug,
      title: r.title || '',
      sourceLang: r.source_lang || '',
      autoDetectLangs: Array.isArray(r.auto_detect_langs) ? r.auto_detect_langs : [],
      defaultTargetLangs: Array.isArray(r.default_target_langs) ? r.default_target_langs : [],
      startsAt: toMillis(r.starts_at_ms),
      endsAt: toMillis(r.ends_at_ms),
      status: r.status || 'scheduled',
      createdAt: toMillis(r.created_at_ms),
      updatedAt: toMillis(r.updated_at_ms)
    };
  }

  async function list(limit = 200) {
    const take = Number.isFinite(Number(limit)) ? Math.max(Number(limit), 1) : 200;
    const { rows } = await pool.query(
      `SELECT slug, title, source_lang, auto_detect_langs, default_target_langs,
              EXTRACT(EPOCH FROM starts_at)*1000 AS starts_at_ms,
              EXTRACT(EPOCH FROM ends_at)*1000 AS ends_at_ms,
              status,
              EXTRACT(EPOCH FROM created_at)*1000 AS created_at_ms,
              EXTRACT(EPOCH FROM updated_at)*1000 AS updated_at_ms
       FROM rooms
       ORDER BY updated_at DESC
       LIMIT $1`,
      [take]
    );
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title || '',
      sourceLang: r.source_lang || '',
      autoDetectLangs: Array.isArray(r.auto_detect_langs) ? r.auto_detect_langs : [],
      defaultTargetLangs: Array.isArray(r.default_target_langs) ? r.default_target_langs : [],
      startsAt: toMillis(r.starts_at_ms),
      endsAt: toMillis(r.ends_at_ms),
      status: r.status || 'scheduled',
      createdAt: toMillis(r.created_at_ms),
      updatedAt: toMillis(r.updated_at_ms)
    }));
  }

  async function count() {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM rooms');
    return Number(rows?.[0]?.c || 0);
  }

  async function resolveCode(code) {
    const parsed = parseAccessCode(code);
    if (parsed) {
      const { slug, role } = parsed;
      const { rows } = await pool.query(`SELECT slug FROM rooms WHERE LOWER(slug)=LOWER($1) LIMIT 1`, [slug]);
      if (rows.length) return { slug: rows[0].slug, role };
    }
    // Backward compatibility: if deterministic fails, try hashed table
    try {
      const hash = sha256(String(code || ''));
      const { rows } = await pool.query(`SELECT slug, role FROM room_codes WHERE code_hash = $1 LIMIT 1`, [hash]);
      if (rows.length) return { slug: rows[0].slug, role: rows[0].role };
    } catch {}
    return null;
  }

  async function dbStatus() {
    try {
      await pool.query('SELECT 1');
      return { configured: true, up: true };
    } catch (err) {
      return { configured: true, up: false, error: err?.message };
    }
  }

  async function close() {
    try { await pool.end(); } catch {}
  }

  return {
    upsert,
    get,
    list,
    remove,
    count,
    cleanMeta,
    resolveCode,
    windowState,
    close,
    migrate,
    dbStatus,
    EARLY_JOIN_MIN,
    GRACE_MIN
  };
}

module.exports = {
  createRoomRegistryPg
};
