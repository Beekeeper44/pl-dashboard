# Precision Labeling — Dashboard

Card release ticker and recomp throughput, backed by Metabase.

## Deploy

1. Push this folder to a Git repo and import it in Vercel, **or** run `vercel`
   from this directory.
2. Framework preset: **Other**. No build step, no dependencies.
3. Set one environment variable — `METABASE_API_KEY`. Everything else has a
   working default (see below).
4. Deploy, then open **`/api/verify`** before anything else.

### `/api/verify`

Runs all three questions over the last 7 days and reports whether each returns
the columns its tab expects. Statuses:

| Status | Meaning |
|---|---|
| `OK` | Wired correctly. |
| `MISMATCH` | Question belongs to a different tab — it names the two env vars to swap. |
| `PARTIAL` | Right question, but a required column is missing or renamed. |
| `EMPTY` | Ran fine, no rows in the last 7 days. Shape unverifiable — widen the range. |
| `UNRECOGNIZED` | Columns match nothing expected. |
| `ERROR` | Metabase rejected it. The SQL error text is passed through in `detail`. |

The dashboard also self-checks on every load: if a tab receives the wrong
shape, it says so and names the env vars, rather than rendering blank.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `METABASE_API_KEY` | **yes** | — |
| `METABASE_HOST` | no | `https://arena-club.metabaseapp.com` |
| `METABASE_CARD_ID` | no | `34321` — Cards tab |
| `METABASE_RECOMP_CARD_ID` | no | `34354` — Recomp → Total Recomps |
| `METABASE_EV_AGE_CARD_ID` | no | `34387` — Recomp → Avg EV Age |
| `TICKER_CACHE_SECONDS` | no | `30` |

Question IDs are assumed to map in the order they were provided. `/api/verify`
confirms or corrects this.

## Question requirements

Turn **off** question-level caching in Metabase, or auto-refresh will re-serve a
stale result and the numbers will appear frozen.

### Cards — 34321

Variables: `start_date`, `end_date` (Date, required), `grain` (Text, required),
`source`, `card_type` (Text, optional).

Columns: `period`, `shift_slot`, `shift_hour`, `hour_label`, `hour_block`,
`source`, `card_type`, `series`, `cards`, `shift_days`, `avg_per_shift`.

`shift_slot` (0–12) is the sort key, not `shift_hour` — it keeps 12 AM and 1 AM
at the end of the 2 PM–3 AM shift instead of the beginning.

### Total Recomps — 34354

Variables: `start_date`, `end_date`, `grain`. Grader filtering is client-side,
so the query should return every grader.

Columns: `period`, `grader`, `total comps`, `shift total (3pm-11pm)`,
`12-1pm` … `10-11pm`, `outside 12pm-11pm`.

The `★ TEAM TOTAL` row is detected and **excluded from every aggregation** —
KPIs, rail, chart, and the grader dropdown. It stays pinned atop the table as a
reference row. Without that exclusion every number would double.

This tab's shift window is **3 PM–11 PM**, distinct from the Cards tab's
2 PM–3 AM.

### Avg EV Age — 34387

Variables: `start_date`, `end_date`, `grain`, `sport`, `pack_category`.

Columns: `period`, `pack category`, `sport`, `cards sold`,
`avg ev age (days)`, `median ev age (days)`, `75th pct ev age (days)`,
`90th pct ev age (days)`, `oldest ev age (days)`, `percent over 7/30/90 days`.

Averages and percentages are re-aggregated **weighted by cards sold**, so a
one-card group can't swing the headline the way a 561-card group does.

## Reference data

Pack tiers (`PACKS` in `index.html`) — order drives axis, aging grid, stacking
and dropdown:

`Misc.` · `Silver` · `Gold` · `Ruby` · `Emerald` · `Diamond` · `Legendary` ·
`Crown Jewel` · `Special Series`

Sports (`SPORT_COLORS`) — keyed on raw snake_case values from
`admin.cards.sport`:

`baseball` · `basketball` · `combat` · `dc` · `disney` · `football` · `hockey` ·
`marvel` · `one_piece` · `pokemon` · `soccer` · `star_wars`

Unmapped values get a stable hash color. Display labels are title-cased
(`one_piece` → "One Piece") but the raw value is what reaches the query.

## Metabase API note

The export endpoints (`/api/card/:id/query/json`) take parameters as a
**form field** holding a JSON string, not as a JSON request body. Posting
`Content-Type: application/json` there returns 400 regardless of how correct
the parameters are. `api/ticker.js` sends form-encoded, and falls back to the
interactive `/api/card/:id/query` endpoint (JSON body, ~2000 row cap) if the
export endpoint is unavailable.

## Notes

- On Redshift-PROD, `admin.cards` runs roughly 3 hours behind. Repoint at db364
  for a genuinely live wall display.
- Adding a tab: one entry in `TABS` (`index.html`) and one in `CARDS`
  (`api/ticker.js`).
