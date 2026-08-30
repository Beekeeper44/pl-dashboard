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
  // Card Type — Data and Data Verify are separate saved questions.
  'cardtype:data':   { env: 'METABASE_CARDTYPE_DATA_CARD_ID',   fallback: '34552' },
  'cardtype:verify': { env: 'METABASE_CARDTYPE_VERIFY_CARD_ID', fallback: '34618' },
  // Review — pre-graded and premium/raw are separate saved questions.
  'recomp:zone':      { env: 'METABASE_HOT_COLD_ZONE_CARD_ID',     fallback: '34849' },
  // Orders — order-level rows.
  'orders:all':       { env: 'METABASE_ORDERS_CARD_ID',            fallback: '35872' },
  // Card Queue — card-level rows behind the orders.
  'orders:queue':     { env: 'METABASE_CARD_QUEUE_CARD_ID',         fallback: '35905' },
  // Value Tracker — high-end comps. Tier + date are filtered client-side.
  'recomp:highend':   { env: 'METABASE_VALUE_TRACKER_CARD_ID',     fallback: '3213' },
  'review:pregraded': { env: 'METABASE_REVIEW_PREGRADED_CARD_ID', fallback: '34684' },
  'review:raw':       { env: 'METABASE_REVIEW_RAW_CARD_ID',       fallback: '34685' },
};

const TEXT_VARS = {
  'cards':        ['grain', 'source', 'card_type'],
  'recomp:total': ['grain'],
  'recomp:age':   ['grain', 'sport', 'pack_category'],
  'cardtype:data':   ['grain'],
  'cardtype:verify': ['grain'],
  'recomp:zone':      ['grain', 'sport'],
  'recomp:highend':   [],   // no grain; see SINGLE_DATE
  'orders:all':       [],   // see NO_PARAMS
  'orders:queue':     [],
  'review:pregraded': ['grain'],
  'review:raw':       ['grain'],
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
  const out = { map: {}, ok: false, note: '', source: null };

  try {
    const r = await fetch(`${host}/api/card/${cardId}`, {
      headers: { 'X-API-KEY': apiKey },
    });
    if (!r.ok) {
      out.note = `GET /api/card/${cardId} returned ${r.status}.`;
      tagIdCache.set(cardId, out);
      return out;
    }

    const card = await r.json();

    // Metabase versions keep template tags in different places, and a card
    // saved from a dashboard may expose them only via `parameters`.
    const objSources = [
      ['dataset_query.native.template-tags', card?.dataset_query?.native?.['template-tags']],
      ['dataset_query.native.template_tags', card?.dataset_query?.native?.template_tags],
      ['dataset_query.template-tags',        card?.dataset_query?.['template-tags']],
      ['native.template-tags',               card?.native?.['template-tags']],
      ['template-tags',                      card?.['template-tags']],
    ];

    for (const [path, tags] of objSources) {
      if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
        const map = {};
        for (const [name, tag] of Object.entries(tags)) {
          if (tag?.id) map[name] = { id: tag.id, type: tag.type };
        }
        if (Object.keys(map).length) {
          out.map = map; out.ok = true; out.source = path;
          out.note = `Read ${Object.keys(map).length} ids from ${path}: ${Object.keys(map).join(', ')}`;
          break;
        }
      }
    }

    // The card's `parameters` array is authoritative on modern Metabase
    // (mbql/query "stages" format has no dataset_query.native.template-tags).
    // Entries are keyed by DISPLAY name — "Start Date", not "start_date" — so
    // normalize before matching, and carry each declared type: text variables
    // are "string/=", not "category".
    if (!out.ok && Array.isArray(card?.parameters) && card.parameters.length) {
      const norm = (n) =>
        String(n || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      const map = {};
      for (const p of card.parameters) {
        const key = norm(p?.slug || p?.name);
        if (key && p?.id) map[key] = { id: p.id, type: p.type };
      }
      if (Object.keys(map).length) {
        out.map = map;
        out.ok = true;
        out.source = 'parameters[]';
        out.note =
          `Read ${Object.keys(map).length} ids from parameters[]: ` +
          Object.entries(map).map(([k, v]) => `${k}(${v.type})`).join(', ');
      }
    }

    if (!out.ok) {
      out.note =
        `Card "${card?.name || cardId}" exposed no template tags. ` +
        `Top-level keys: ${Object.keys(card || {}).sort().join(', ').slice(0, 300)}. ` +
        `Call /api/card?id=${cardId} for the full structure.`;
    }
  } catch (e) {
    out.note = `GET /api/card/${cardId} threw: ${e.message}`;
  }

  tagIdCache.set(cardId, out);
  return out;
}

// Cards that take a SINGLE date rather than a start/end range. The Value
// Tracker (3213) declares `Single Date`, `Min Estimated Value Usd` and
// `Max Estimated Value Usd`; sending it start_date/end_date/grain — tags it does
// not declare — made Metabase reject the run and left the tab on LOADING.
const SINGLE_DATE = new Set(['recomp:highend']);

// Cards whose filters are all optional — we pull the set and filter in the
// browser, so sending nothing is both valid and cheaper than guessing.
const NO_PARAMS = new Set(['orders:all', 'orders:queue']);

// Numeric template tags, sent only when the client provides a value.
const NUM_VARS = {
  'recomp:highend': ['min_estimated_value_usd', 'max_estimated_value_usd'],
};

function buildParameters(query, key, tagIds, noParams) {
  const parameters = [];
  if (noParams || NO_PARAMS.has(key)) return parameters;

  if (SINGLE_DATE.has(key)) {
    const value = query.single_date;
    if (!value) throw new Error('Missing required filter: single_date');
    if (!ISO_DATE.test(value)) throw new Error('single_date must be YYYY-MM-DD');
    parameters.push({
      id: tagIds['single_date']?.id || 'single_date',
      type: tagIds['single_date']?.type || 'date/single',
      value,
      target: ['variable', ['template-tag', 'single_date']],
    });

    for (const name of (NUM_VARS[key] || [])) {
      const v = query[name];
      if (v === undefined || v === '') continue;   // optional — omit to drop the clause
      if (!/^\d+(\.\d+)?$/.test(String(v))) {
        throw new Error(`${name} must be a number`);
      }
      parameters.push({
        id: tagIds[name]?.id || name,
        type: tagIds[name]?.type || 'number/=',
        value: Number(v),
        target: ['variable', ['template-tag', name]],
      });
    }
    return parameters;
  }

  for (const name of ['start_date', 'end_date']) {
    const value = query[name];
    if (!value) throw new Error(`Missing required filter: ${name}`);
    if (!ISO_DATE.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
    parameters.push({
      id: tagIds[name]?.id || name,
      type: tagIds[name]?.type || 'date/single',
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
          id: tagIds['grain']?.id || 'grain',
          type: tagIds['grain']?.type || 'string/=',
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
      id: tagIds[name]?.id || name,
      type: tagIds[name]?.type || 'string/=',
      value,
      target: ['variable', ['template-tag', name]],
    });
  }

  return parameters;
}

// `opts.cardId` runs an arbitrary question id, and `opts.noParams` sends no
// parameters with it — used by /api/debug?id=NNN to identify an unknown card
// before it is wired to a tab.
export async function runQuery(key, query, opts) {
  opts = opts || {};
  const host   = (process.env.METABASE_HOST || HOST_DEFAULT).replace(/\/+$/, '');
  const apiKey = process.env.METABASE_API_KEY;

  if (!apiKey) {
    const err = new Error('METABASE_API_KEY is not set on this deployment.');
    err.status = 500;
    throw err;
  }

  const spec = opts.cardId ? { env: null, fallback: opts.cardId } : CARDS[key];
  if (!spec) {
    const err = new Error(`Unknown tab/view: ${key}`);
    err.status = 400;
    throw err;
  }

  const cardId = (spec.env ? process.env[spec.env] : null) || spec.fallback;
  const tagInfo = await getTagIds(host, apiKey, cardId);
  const tagIds = tagInfo.map;
  const parameters = buildParameters(query, key, tagIds, opts.noParams);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  // Metabase instances differ in how they accept parameters on the export
  // endpoints. Rather than assume, try each transport in turn and use the
  // first that works. `via` in the response header reports the winner.
  //
  // A 200 is not sufficient — /api/card/:id/query returns 200 with
  // status:"failed" when parameters were dropped, so each strategy must
  // confirm the query actually ran parameterized.
  // Form-encoding is not viable: Metabase receives `parameters` as a string
  // and rejects it with "invalid type, received: \"[{...". Both remaining
  // strategies send a proper JSON array.
  const strategies = [
    {
      name: 'query/json',
      url: `${host}/api/card/${cardId}/query/json`,
    },
    {
      name: 'query',
      url: `${host}/api/card/${cardId}/query`,
      shape: 'cols',
    },
  ];

  const attempts = [];

  for (const s of strategies) {
    let res, text;
    try {
      res = await fetch(s.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
        body: JSON.stringify({ parameters }),
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
      return { rows: objs, cardId, via: s.name, attempts, tagInfo, parameters };
    }

    if (!Array.isArray(payload)) {
      attempts.push(`${s.name}: unexpected shape`);
      continue;
    }

    clearTimeout(timeout);
    return { rows: payload, cardId, via: s.name, attempts, tagInfo, parameters };
  }

  clearTimeout(timeout);
  const err = new Error(`All Metabase transports failed for question ${cardId}`);
  err.status = 502;
  err.tagInfo = tagInfo;
  err.parameters = parameters;
  err.detail =
    (tagInfo.ok ? '' : 'TEMPLATE-TAG IDS UNAVAILABLE — ' + tagInfo.note + '\n\n') +
    attempts.join('\n\n');
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
  // Tabs whose saved question depends on the selected pill.
  const VIEWED = new Set(['recomp', 'cardtype', 'review']);
  const key  = VIEWED.has(tab) ? `${tab}:${view}` : tab;

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
