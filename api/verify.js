// api/verify.js — one-shot check that each question is wired to the right tab.
//
// Visit /api/verify after deploying. It runs all three questions over a short
// date range and reports whether each returns the columns its tab expects.
// A mismatch here means the IDs are mapped to the wrong tabs, which would
// otherwise show up as an empty or nonsensical dashboard rather than an error.

import { runQuery } from './ticker.js';

const EXPECTED = {
  'cards': {
    label: 'Cards',
    env: 'METABASE_CARD_ID',
    required: ['period', 'source', 'card_type', 'cards'],
    signature: ['shift_slot', 'hour_label', 'shift_days'],
  },
  'recomp:total': {
    label: 'Recomp → Total Recomps',
    env: 'METABASE_RECOMP_CARD_ID',
    required: ['period', 'grader'],
    signature: ['total comps', 'shift total (3pm-11pm)', 'outside 12pm-11pm'],
  },
  'recomp:age': {
    label: 'Recomp → Avg EV Age',
    env: 'METABASE_EV_AGE_CARD_ID',
    required: ['period', 'pack category', 'sport'],
    signature: ['cards sold', 'avg ev age (days)', 'percent over 30 days'],
  },
};

const norm = (s) => String(s).toLowerCase().trim();

function scoreShape(cols) {
  const lower = cols.map(norm);
  const out = {};
  for (const [key, spec] of Object.entries(EXPECTED)) {
    const all = [...spec.required, ...spec.signature].map(norm);
    const hits = all.filter((c) => lower.includes(c)).length;
    out[key] = hits / all.length;
  }
  return out;
}

export default async function handler(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const query = { start_date: weekAgo, end_date: today, grain: 'day' };

  const results = [];

  for (const [key, spec] of Object.entries(EXPECTED)) {
    const entry = {
      tab: spec.label,
      envVar: spec.env,
      cardId: process.env[spec.env] || '(default)',
    };

    try {
      const { rows, cardId } = await runQuery(key, query);
      entry.cardId = cardId;
      entry.rowCount = rows.length;

      if (!rows.length) {
        entry.status = 'EMPTY';
        entry.note =
          'Query ran but returned no rows for the last 7 days. Cannot verify shape. ' +
          'Try a wider date range, or confirm the question has data.';
      } else {
        const cols = Object.keys(rows[0]);
        entry.columns = cols;

        const scores = scoreShape(cols);
        const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
        const missing = spec.required.filter(
          (r) => !cols.map(norm).includes(norm(r))
        );

        if (best[0] === key && scores[key] >= 0.5) {
          entry.status = 'OK';
          entry.note = `Shape matches this tab (${Math.round(scores[key] * 100)}% of expected columns present).`;
        } else if (best[1] >= 0.5) {
          entry.status = 'MISMATCH';
          entry.note =
            `This question looks like the "${EXPECTED[best[0]].label}" query, not this one. ` +
            `Swap ${spec.env} with ${EXPECTED[best[0]].env}.`;
        } else {
          entry.status = 'UNRECOGNIZED';
          entry.note =
            'Columns do not match any expected shape. Check the question returns the ' +
            'documented column names. Missing: ' + (missing.join(', ') || 'none');
        }

        if (missing.length && entry.status === 'OK') {
          entry.status = 'PARTIAL';
          entry.note += ` Missing required columns: ${missing.join(', ')}.`;
        }
      }
    } catch (err) {
      entry.status = 'ERROR';
      entry.note = err.message;
      entry.detail = err.detail;
    }

    results.push(entry);
  }

  const allOk = results.every((r) => r.status === 'OK');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    summary: allOk
      ? 'All three questions are wired to the correct tabs.'
      : 'One or more questions need attention — see status on each entry below.',
    checkedAt: new Date().toISOString(),
    results,
  });
}
