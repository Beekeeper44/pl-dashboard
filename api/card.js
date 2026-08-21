// api/card.js — dumps the structure of a card's definition so the correct
// path to its template tags can be found. Structure only; no query is run.
//
//   /api/card            -> Cards question
//   /api/card?id=34354   -> any card id
//   /api/card?full=1     -> include the whole dataset_query

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') {
    if (depth >= 2) return `object{${Object.keys(v).slice(0, 12).join(', ')}}`;
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = shape(val, depth + 1);
    return o;
  }
  return typeof v === 'string' ? `string(${v.slice(0, 40)})` : typeof v;
}

export default async function handler(req, res) {
  const host = (process.env.METABASE_HOST || 'https://arena-club.metabaseapp.com')
    .replace(/\/+$/, '');
  const apiKey = process.env.METABASE_API_KEY;
  const id = req.query?.id || process.env.METABASE_CARD_ID || '34321';

  if (!apiKey) return res.status(500).json({ error: 'METABASE_API_KEY not set' });

  const out = { cardId: id, host };

  try {
    const r = await fetch(`${host}/api/card/${id}`, {
      headers: { 'X-API-KEY': apiKey },
    });
    out.httpStatus = r.status;
    const text = await r.text();

    if (!r.ok) {
      out.body = text.slice(0, 800);
      return res.status(200).json(out);
    }

    let card;
    try { card = JSON.parse(text); }
    catch { out.parseError = true; out.body = text.slice(0, 800); return res.status(200).json(out); }

    out.name = card?.name;
    out.type = card?.type || card?.dataset ? 'model/dataset' : 'question';
    out.queryType = card?.query_type;
    out.topLevelKeys = Object.keys(card || {}).sort();

    // Every place a Metabase version might keep template tags
    const candidates = {
      'dataset_query.native.template-tags': card?.dataset_query?.native?.['template-tags'],
      'dataset_query.native.template_tags': card?.dataset_query?.native?.template_tags,
      'dataset_query.template-tags':        card?.dataset_query?.['template-tags'],
      'native.template-tags':               card?.native?.['template-tags'],
      'template-tags':                      card?.['template-tags'],
      'parameters':                         card?.parameters,
      'parameter_mappings':                 card?.parameter_mappings,
    };

    out.templateTagLocations = {};
    for (const [path, val] of Object.entries(candidates)) {
      if (val === undefined) { out.templateTagLocations[path] = 'absent'; continue; }
      if (Array.isArray(val)) {
        out.templateTagLocations[path] = val.map((p) => ({
          id: p?.id, name: p?.name || p?.slug, type: p?.type,
        }));
      } else if (val && typeof val === 'object') {
        out.templateTagLocations[path] = Object.entries(val).map(([name, tag]) => ({
          name, id: tag?.id, type: tag?.type, required: tag?.required,
        }));
      } else {
        out.templateTagLocations[path] = String(val).slice(0, 100);
      }
    }

    out.datasetQueryShape = shape(card?.dataset_query);
    if (req.query?.full) out.datasetQuery = card?.dataset_query;

  } catch (e) {
    out.error = e.message;
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
