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

function buildParameters(query, key) {
  const parameters = [];

  for (const name of ['start_date', 'end_date']) {
    const value = query[name];
    if (!value) throw new Error(`Missing required filter: ${name}`);
    if (!ISO_DATE.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
    parameters.push({
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
  const parameters = buildParameters(query, key);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  // Metabase's export endpoints (/query/json, /query/csv, /query/xlsx) take
  // parameters as a FORM FIELD holding a JSON string — not as a JSON body.
  // Posting Content-Type: application/json there returns 400 no matter how
  // correct the parameters are. That was the original failure.
  const form = new URLSearchParams();
  form.set('parameters', JSON.stringify(parameters));

  let upstream, text;
  try {
    upstream = await fetch(`${host}/api/card/${cardId}/query/json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-API-KEY': apiKey,
      },
      body: form.toString(),
      signal: controller.signal,
    });
    text = await upstream.text();

    // Fallback: the interactive endpoint does take a JSON body. It caps at
    // ~2000 rows, so it is second choice, but it keeps the app alive if the
    // export endpoint is unavailable on this instance.
    if (!upstream.ok) {
      const alt = await fetch(`${host}/api/card/${cardId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
        body: JSON.stringify({ parameters }),
        signal: controller.signal,
      });
      const altText = await alt.text();
      if (alt.ok) {
        const payload = JSON.parse(altText);
        if (payload?.status === 'failed') {
          const err = new Error(payload.error || 'Metabase query failed');
          err.status = 400;
          err.detail = JSON.stringify(payload).slice(0, 1200);
          throw err;
        }
        const cols = (payload?.data?.cols || []).map(
          (c) => c.display_name || c.name
        );
        const objs = (payload?.data?.rows || []).map((r) => {
          const o = {};
          cols.forEach((name, i) => { o[name] = r[i]; });
          return o;
        });
        clearTimeout(timeout);
        return { rows: objs, cardId, via: 'query' };
      }
    }
  } catch (e) {
    if (e.status) { clearTimeout(timeout); throw e; }
    clearTimeout(timeout);
    const err = new Error(
      e.name === 'AbortError' ? 'Metabase query timed out' : 'Could not reach Metabase'
    );
    err.status = e.name === 'AbortError' ? 504 : 502;
    err.detail = String(e.message || e).slice(0, 300);
    throw err;
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    // Metabase puts the SQL error text here — the single most useful thing
    // when a query breaks, so pass it through rather than swallowing it.
    const err = new Error(`Metabase returned ${upstream.status} for question ${cardId}`);
    err.status = upstream.status;
    err.detail = text.slice(0, 1200);
    throw err;
  }

  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    const err = new Error('Metabase returned a non-JSON response');
    err.status = 502;
    err.detail = text.slice(0, 500);
    throw err;
  }

  if (!Array.isArray(rows)) {
    const err = new Error(rows?.error || 'Unexpected response shape from Metabase');
    err.status = 502;
    err.detail = JSON.stringify(rows).slice(0, 600);
    throw err;
  }

  return { rows, cardId, via: 'query/json' };
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
    const { rows, cardId } = await runQuery(key, q);
    const ttl = Number(process.env.TICKER_CACHE_SECONDS || 30);
    res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=60`);
    res.setHeader('X-Metabase-Card-Id', cardId);
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message,
      detail: err.detail,
    });
  }
}
