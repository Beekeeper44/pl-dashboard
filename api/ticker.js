// api/ticker.js — server-side proxy to Metabase.
//
// Metabase sends no CORS headers, so the browser cannot call it directly.
// This function holds the API key and forwards filter values as native-query
// parameters. The key never reaches the client.

const HOST_DEFAULT = 'https://arena-club.metabaseapp.com';

// Each tab/sub-tab maps to its own saved question. Env vars override the
// defaults so IDs can be changed without a redeploy.
const CARDS = {
  'cards':        { env: 'METABASE_CARD_ID',        fallback: '34321' },
  'recomp:total': { env: 'METABASE_RECOMP_CARD_ID', fallback: '34354' },
  'recomp:age':   { env: 'METABASE_EV_AGE_CARD_ID', fallback: '34387' },
};

const TEXT_VARS = {
  'cards':        ['grain', 'source', 'card_type'],
  'recomp:total': ['grain'],
  'recomp:age':   ['grain', 'sport', 'pack_category'],
};

const ALLOWED = {
  grain:     ['day', 'week', 'month'],
  source:    ['customer', 'slab_pack', 'unattributed'],
  card_type: ['raw', 'pre_graded'],
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Metabase requires a non-blank `id` on every parameter object. For a native
// question that id is the template tag's UUID, which lives on the card
// definition. Fetched once per warm instance and cached.
const tagIdCache = new Map();

async function getTagIds(host, apiKey, cardId) {
  if (tagIdCache.has(cardId)) return tagIdCache.get(cardId);
  let map = {};
  try {
    const r = await fetch(`${host}/api/card/${cardId}`, {
      headers: { 'X-API-KEY': apiKey },
    });
    if (r.ok) {
      const card = await r.json();
      const tags = card?.dataset_query?.native?.['template-tags'] || {};
      for (const [name, tag] of Object.entries(tags)) {
        if (tag?.id) map[name] = tag.id;
      }
    }
  } catch {
    // fall through — the name is an acceptable id for most instances
  }
  tagIdCache.set(cardId, map);
  return map;
}

function buildParameters(query, key, tagIds) {
  const parameters = [];

  for (const name of ['start_date', 'end_date']) {
    const value = query[name];
    if (!value) throw new Error(`Missing required filter: ${name}`);
    if (!ISO_DATE.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
    parameters.push({
      id: tagIds[name] || name,
      type: 'date/single',
      value,
      target: ['variable', ['template-tag', name]],
    });
  }

  for (const name of (TEXT_VARS[key] || ['grain'])) {
    const value = query[name];

    if (!value) {
      // grain has no [[ ]] wrapper in the SQL, so it must always be sent
      if (name === 'grain') {
        parameters.push({
          id: tagIds['grain'] || 'grain',
          type: 'category',
          value: 'day',
          target: ['variable', ['template-tag', 'grain']],
        });
      }
      continue; // optional filters: omit so Metabase drops the clause entirely
    }

    if (ALLOWED[name] && !ALLOWED[name].includes(value)) {
      throw new Error(`${name} must be one of: ${ALLOWED[name].join(', ')}`);
    }

    parameters.push({
      id: tagIds[name] || name,
      type: 'category',
      value,
      target: ['variable', ['template-tag', name]],
    });
  }

  return parameters;
}

export async function runQuery(key, query) {
  const host   = (process.env.METABASE_HOST || HOST_DEFAULT).replace(/\/+$/, '');
  const apiKey = process.env.METABASE_API_KEY;

  if (!apiKey) {
    const err = new Error('METABASE_API_KEY is not set on this deployment.');
    err.status = 500;
    throw err;
  }

  const spec = CARDS[key];
  if (!spec) {
    const err = new Error(`Unknown tab/view: ${key}`);
    err.status = 400;
    throw err;
  }

  const cardId = process.env[spec.env] || spec.fallback;
  const tagIds = await getTagIds(host, apiKey, cardId);
  const parameters = buildParameters(query, key, tagIds);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  // Metabase instances differ in how they accept parameters on the export
  // endpoints. Rather than assume, try each transport in turn and use the
  // first that works. `via` in the response header reports the winner.
  //
  // A 200 is not sufficient — /api/card/:id/query returns 200 with
  // status:"failed" when parameters were dropped, so each strategy must
  // confirm the query actually ran parameterized.
  const form = new URLSearchParams();
  form.set('parameters', JSON.stringify(parameters));

  const strategies = [
    {
      name: 'query/json+json',
      url: `${host}/api/card/${cardId}/query/json`,
      init: {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters }),
      },
    },
    {
      name: 'query/json+form',
      url: `${host}/api/card/${cardId}/query/json`,
      init: {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
    },
    {
      name: 'query+json',
      url: `${host}/api/card/${cardId}/query`,
      init: {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters }),
      },
      shape: 'cols',
    },
    {
      name: 'query+form',
      url: `${host}/api/card/${cardId}/query`,
      init: {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      shape: 'cols',
    },
  ];

  const attempts = [];

  for (const s of strategies) {
    let res, text;
    try {
      res = await fetch(s.url, {
        method: 'POST',
        headers: { ...s.init.headers, 'X-API-KEY': apiKey },
        body: s.init.body,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      if (e.name === 'AbortError') {
        clearTimeout(timeout);
        const err = new Error('Metabase query timed out');
        err.status = 504;
        throw err;
      }
      attempts.push(`${s.name}: ${e.message}`);
      continue;
    }

    if (!res.ok) {
      attempts.push(`${s.name}: HTTP ${res.status} ${text.slice(0, 180)}`);
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      attempts.push(`${s.name}: non-JSON response`);
      continue;
    }

    // 200 + status:"failed" means the query ran but parameters were dropped.
    if (payload && !Array.isArray(payload) && payload.status === 'failed') {
      attempts.push(`${s.name}: ${String(payload.error || 'failed').slice(0, 200)}`);
      continue;
    }

    if (s.shape === 'cols') {
      const cols = (payload?.data?.cols || []).map((c) => c.display_name || c.name);
      const objs = (payload?.data?.rows || []).map((r) => {
        const o = {};
        cols.forEach((name, i) => { o[name] = r[i]; });
        return o;
      });
      clearTimeout(timeout);
      return { rows: objs, cardId, via: s.name, attempts };
    }

    if (!Array.isArray(payload)) {
      attempts.push(`${s.name}: unexpected shape`);
      continue;
    }

    clearTimeout(timeout);
    return { rows: payload, cardId, via: s.name, attempts };
  }

  clearTimeout(timeout);
  const err = new Error(`All Metabase transports failed for question ${cardId}`);
  err.status = 502;
  err.detail = attempts.join('\n\n');
  throw err;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q    = req.query || {};
  const tab  = String(q.tab  || 'cards').toLowerCase();
  const view = String(q.view || 'total').toLowerCase();
  const key  = tab === 'recomp' ? `recomp:${view}` : tab;

  try {
    const { rows, cardId, via } = await runQuery(key, q);
    const ttl = Number(process.env.TICKER_CACHE_SECONDS || 30);
    res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=60`);
    res.setHeader('X-Metabase-Card-Id', cardId);
    res.setHeader('X-Metabase-Transport', via);
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message,
      detail: err.detail,
    });
  }
}
