// ============================================================================
// /api/state — shared storage for Daily boards, assignments and snoozes
// ============================================================================
// Backend is chosen from whichever env vars are present, in this order:
//
//   1. DATABASE_URL                        -> Neon Postgres   (preferred)
//   2. KV_REST_API_URL + KV_REST_API_TOKEN -> Vercel KV
//   3. neither                             -> module memory (dev only)
//
// Memory is per-instance and resets, so it is NOT shared. The `shared` flag in
// every response says which case you are in, and the UI shows an amber banner
// when it is false rather than silently pretending to sync.
//
// ---------------------------------------------------------------------------
// NEON SETUP
//   1. Vercel -> Storage -> Create Database -> Neon, connect to this project.
//      That injects DATABASE_URL automatically.
//   2. Nothing else. The table is created on first use:
//
//        create table if not exists pl_state (
//          key        text primary key,
//          value      jsonb        not null,
//          updated_at timestamptz  not null default now()
//        );
//
//      pl_state also holds the revision counter under key 'pl:v1:rev', so the
//      client can skip a poll when nothing has changed.
// ---------------------------------------------------------------------------
// GET  /api/state   -> { daily:{iso:board}, assign, snooze, rev, shared, backend }
// POST /api/state   -> { section, key?, data }
//        section: "daily" | "assign" | "snooze"
//        key:     required for daily — the ISO shift date
// ---------------------------------------------------------------------------

import { neon } from '@neondatabase/serverless';

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOK = process.env.KV_REST_API_TOKEN;

const BACKEND = DB_URL ? 'neon' : (KV_URL && KV_TOK) ? 'kv' : 'memory';
const SHARED  = BACKEND !== 'memory';

const PREFIX  = 'pl:v1:';
const DAILY_P = PREFIX + 'daily:';
const IDX_KEY = PREFIX + 'daily:index';
const REV_KEY = PREFIX + 'rev';

const mem = new Map();
const sql = DB_URL ? neon(DB_URL) : null;

// ---------------------------------------------------------------------------
// Neon
// ---------------------------------------------------------------------------
let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await sql`
    create table if not exists pl_state (
      key        text primary key,
      value      jsonb        not null,
      updated_at timestamptz  not null default now()
    )`;
  ensured = true;
}

async function pgReadAll() {
  await ensureTable();
  const rows = await sql`select key, value from pl_state`;
  const out = { daily: {}, assign: {}, snooze: {}, hedone: {}, rev: 0 };
  for (const r of rows) {
    if (r.key === REV_KEY) out.rev = Number(r.value) || 0;
    else if (r.key === PREFIX + 'assign') out.assign = r.value || {};
    else if (r.key === PREFIX + 'snooze') out.snooze = r.value || {};
    else if (r.key === PREFIX + 'hedone') out.hedone = r.value || {};
    else if (r.key.startsWith(DAILY_P)) out.daily[r.key.slice(DAILY_P.length)] = r.value || {};
  }
  return out;
}

async function pgWrite(key, value) {
  await ensureTable();
  // NOTE: jsonb cannot be cast straight to int in Postgres — `value::int` is a
  // syntax error. `value #>> '{}'` extracts the scalar as text first, which is
  // the supported route for a bare jsonb number.
  await sql`
    insert into pl_state (key, value, updated_at)
    values (${key}, ${JSON.stringify(value)}::jsonb, now())
    on conflict (key) do update
      set value = excluded.value, updated_at = now()`;
  const [row] = await sql`
    insert into pl_state (key, value, updated_at)
    values (${REV_KEY}, '1'::jsonb, now())
    on conflict (key) do update
      set value = to_jsonb(((pl_state.value #>> '{}')::int) + 1), updated_at = now()
    returning value as rev`;
  return Number(row && row.rev) || 0;
}

// ---------------------------------------------------------------------------
// Vercel KV
// ---------------------------------------------------------------------------
async function kv(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`kv ${res.status}`);
  return (await res.json()).result;
}

function parse(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvReadAll() {
  const [a, s, hd, rev, days] = await Promise.all([
    kv(['GET', PREFIX + 'assign']),
    kv(['GET', PREFIX + 'snooze']),
    kv(['GET', PREFIX + 'hedone']),
    kv(['GET', REV_KEY]),
    kv(['SMEMBERS', IDX_KEY]),
  ]);
  const daily = {};
  await Promise.all((days || []).map(async (iso) => {
    const b = parse(await kv(['GET', DAILY_P + iso]), null);
    if (b) daily[iso] = b;
  }));
  return { daily, assign: parse(a, {}), snooze: parse(s, {}),
           hedone: parse(hd, {}), rev: Number(rev || 0) };
}

async function kvWrite(key, value, isDaily, dayKey) {
  await kv(['SET', key, JSON.stringify(value)]);
  if (isDaily) await kv(['SADD', IDX_KEY, dayKey]);
  return Number(await kv(['INCR', REV_KEY])) || 0;
}

// ---------------------------------------------------------------------------
// Memory (dev only)
// ---------------------------------------------------------------------------
function memReadAll() {
  const daily = {};
  for (const [k, v] of mem) if (k.startsWith(DAILY_P)) daily[k.slice(DAILY_P.length)] = v;
  return {
    daily,
    assign: mem.get(PREFIX + 'assign') || {},
    snooze: mem.get(PREFIX + 'snooze') || {},
    hedone: mem.get(PREFIX + 'hedone') || {},
    rev: mem.get(REV_KEY) || 0,
  };
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const data = BACKEND === 'neon' ? await pgReadAll()
                 : BACKEND === 'kv'   ? await kvReadAll()
                 : memReadAll();
      res.status(200).json({ ...data, shared: SHARED, backend: BACKEND });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const section = body.section, key = body.key, data = body.data;

      let storeKey;
      if (section === 'daily') {
        if (!key) { res.status(400).json({ error: 'daily needs a key (ISO date)' }); return; }
        storeKey = DAILY_P + key;
      } else if (section === 'assign' || section === 'snooze' || section === 'hedone') {
        storeKey = PREFIX + section;
      } else {
        res.status(400).json({ error: 'unknown section' });
        return;
      }

      let rev = 0;
      if (BACKEND === 'neon') {
        rev = await pgWrite(storeKey, data || {});
      } else if (BACKEND === 'kv') {
        rev = await kvWrite(storeKey, data || {}, section === 'daily', key);
      } else {
        mem.set(storeKey, data || {});
        rev = (mem.get(REV_KEY) || 0) + 1;
        mem.set(REV_KEY, rev);
      }

      res.status(200).json({ ok: true, rev, shared: SHARED, backend: BACKEND });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    // Never hard-fail the UI — the client keeps its local copy and retries.
    res.status(200).json({ error: String(err.message || err), shared: SHARED, backend: BACKEND });
  }
}
