// api/debug.js — reports which Metabase transport this instance accepts,
// and what each rejected one said. Use when /api/ticker returns 400/502.

import { runQuery } from './ticker.js';

export default async function handler(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const back = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const q = { start_date: back, end_date: today, grain: 'day' };

  const out = { checkedAt: new Date().toISOString(), range: `${back} .. ${today}` };

  try {
    const r = await runQuery('cards', q);
    out.result = 'OK';
    out.transport = r.via;
    out.cardId = r.cardId;
    out.rowCount = r.rows.length;
    out.sampleColumns = r.rows.length ? Object.keys(r.rows[0]) : [];
    out.rejectedStrategies = r.attempts?.length ? r.attempts : ['none — first strategy worked'];
  } catch (err) {
    out.result = 'FAILED';
    out.error = err.message;
    out.attempts = err.detail ? String(err.detail).split('\n\n') : [];
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
