// api/debug.js — full diagnostic for the Metabase connection.
//
// Reports the template-tag ids read from the card, the exact parameter payload
// sent, and what each transport returned. Paste the output when the dashboard
// cannot load.

import { runQuery } from './ticker.js';

export default async function handler(req, res) {
  // ?card=<known key>  or  ?id=<any Metabase question id>
  //
  // The id form runs a bare question with no parameters and reports its columns
  // and row count — enough to tell whether a question is the Orders set or the
  // Card Queue set before wiring it to a tab.
  const cardParam = req.query?.card;
  const rawId     = req.query?.id;
  const key = cardParam === 'recomp-total' ? 'recomp:total'
            : cardParam === 'recomp-age'   ? 'recomp:age'
            : cardParam === 'orders'       ? 'orders:all'
            : cardParam === 'queue'        ? 'orders:queue'
            : 'cards';

  const today = new Date().toISOString().slice(0, 10);
  const back  = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const q = { start_date: back, end_date: today, grain: 'day' };

  const out = {
    checkedAt: new Date().toISOString(),
    tab: key,
    range: `${back} .. ${today}`,
    env: {
      METABASE_HOST: process.env.METABASE_HOST || '(default)',
      METABASE_API_KEY: process.env.METABASE_API_KEY ? 'set' : 'MISSING',
      METABASE_CARD_ID: process.env.METABASE_CARD_ID || '(default 34321)',
      METABASE_RECOMP_CARD_ID: process.env.METABASE_RECOMP_CARD_ID || '(default 34354)',
      METABASE_EV_AGE_CARD_ID: process.env.METABASE_EV_AGE_CARD_ID || '(default 34387)',
    },
  };

  if (rawId) {
    if (!/^\d+$/.test(String(rawId))) {
      res.status(400).json({ error: 'id must be a number' });
      return;
    }
    try {
      const r = await runQuery('__adhoc__', q, { cardId: String(rawId), noParams: true });
      const cols = r.rows.length ? Object.keys(r.rows[0]) : [];
      res.status(200).json({
        checkedAt: out.checkedAt,
        questionId: String(rawId),
        result: 'OK',
        transport: r.via,
        rowCount: r.rows.length,
        columns: cols,
        // Best guess at which tab it belongs to, from the columns present.
        looksLike: cols.includes('ac_number') || cols.includes('card_status') ? 'Card Queue'
                 : cols.includes('in_process_days') || cols.includes('full_name') ? 'Orders'
                 : 'unrecognised — check the columns above',
        firstRow: r.rows[0] || null,
      });
    } catch (err) {
      res.status(200).json({
        checkedAt: out.checkedAt, questionId: String(rawId),
        result: 'FAILED', error: String(err.message || err),
      });
    }
    return;
  }

  try {
    const r = await runQuery(key, q);
    out.result = 'OK';
    out.transport = r.via;
    out.cardId = r.cardId;
    out.rowCount = r.rows.length;
    out.templateTags = r.tagInfo;
    out.parametersSent = r.parameters;
    out.sampleColumns = r.rows.length ? Object.keys(r.rows[0]) : [];
    out.rejected = r.attempts?.length ? r.attempts : ['none — first transport worked'];
  } catch (err) {
    out.result = 'FAILED';
    out.error = err.message;
    out.templateTags = err.tagInfo || '(not reached)';
    out.parametersSent = err.parameters || '(not built)';
    out.attempts = err.detail ? String(err.detail).split('\n\n') : [];
    out.hint = !err.tagInfo?.ok
      ? 'The template-tag ids could not be read from the card. Metabase matches ' +
        'parameters by id, so without them every parameter is ignored and the ' +
        'query reports its required variables as missing. Usually a permissions ' +
        'issue: the API key\'s group needs read access to the collection holding ' +
        'this question.'
      : 'Template-tag ids were read successfully, so the ids are not the problem. ' +
        'Compare parametersSent against the question\'s variables — names must ' +
        'match exactly, and a Date variable needs type date/single.';
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
