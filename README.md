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

## Metabase API notes

**Every parameter needs an `id`.** Metabase rejects parameters without a
non-blank `id`. `api/ticker.js` reads each question's template-tag UUIDs once
via `GET /api/card/:id` and caches them per warm instance, falling back to the
tag name if that endpoint is restricted.

**Transport differs by instance.** Metabase versions disagree on whether the
export endpoints take a JSON body or a form field. The proxy tries four
transports in order and uses the first that genuinely works:

1. `POST /query/json` with a JSON body
2. `POST /query/json` form-encoded
3. `POST /query` with a JSON body (~2000 row cap)
4. `POST /query` form-encoded

A 200 is not treated as success on its own — `/api/card/:id/query` returns 200
with `status:"failed"` when parameters were dropped, so each strategy confirms
the query actually ran before its result is accepted. The winner is reported in
the `X-Metabase-Transport` response header.

**`/api/debug`** runs the chain and reports which transport won, or what each
one returned if all failed.

## Notes

- On Redshift-PROD, `admin.cards` runs roughly 3 hours behind. Repoint at db364
  for a genuinely live wall display.
- Adding a tab: one entry in `TABS` (`index.html`) and one in `CARDS`
  (`api/ticker.js`).

## Timezone toggle (Pacific / Manila)

The button to the right of the header switches all hour labels between Pacific
and Manila. It is **purely presentational** — no refetch, no change to which
rows are counted, and the Metabase questions are untouched. Only the hour and
block labels and the header's shift-window text move.

- **Pacific** (default) — neon green border, US flag, `PT` suffix
- **Manila** — blue border, Philippine flag, `PHT` suffix

**Why the offset is computed, not hardcoded.** Manila is UTC+8 year-round;
Pacific is UTC−7 (PDT) / UTC−8 (PST). The gap is +15h in summer and +16h in
winter. `computeTzOff()` derives it via `Intl.DateTimeFormat` from the first
row's own `period` date, so historical ranges spanning the DST boundary label
correctly. A fixed `+15` would be wrong half the year.

**What the windows become:**

| View | Pacific | Manila |
|---|---|---|
| Cards (`pending_release`) | 2 PM – 3 AM | 5 AM – 6 PM |
| Recomp shift | 3 PM – 11 PM | 6 AM – 2 PM |

Note the Cards window straddles midnight in Pacific and does not in Manila —
the `-3h` shift-date rollback in the SQL exists only because of that Pacific
midnight crossing.

**Where it hooks in:** `TZ` / `TZOFF` state near `slotOf()`; `h12()` and
`blockOf()` do the formatting; `slotLabel()` / `ghLabel()` / `ghBlock()` route
through them; `fillTz()` rewrites `{W<start>-<end>}` and `{TZ}` tokens in the
`TABS[].subtitle` strings. Subtitle template hours are always **Pacific**.

## End of shift / extra time

Two slot-indexed constants sit next to `SLOTS`:

```
var SHIFT_LAST  = 9;    // boundary bar -- END OF SHIFT label goes here
var EXTRA_START = 9;    // first extra-time bar (band starts at its left edge)
```

| | Pacific | Manila |
|---|---|---|
| Last scheduled bar | 10 PM | 1 PM |
| Extra time | 11 PM, 12 AM, 1 AM, 2 AM | 2 PM, 3 PM, 4 PM, 5 PM |

The shift ends at 11 PM PT / 2 PM Manila, so the 11 PM bar is the first hour
past the schedule. The END OF SHIFT label is centered over it and the amber band
starts at its left edge. Extra-time bars are dimmed to 62% with tinted axis
labels; the rail note reads "from 11 PM PT" rather than "after", since the
boundary bar is itself counted.

Both constants are slot indices, not clock times, so the boundary is
timezone-invariant -- slot 9 is 11 PM PT and 2 PM Manila, landing in the same
place in either view. There is no dashed rule; the shading carries the divide.

Keeping them as two constants means the label and the shading can move
independently if the schedule changes.

## Bar gradients & shift palette

Stacked segments use a vertical gradient: lightened at the top, base colour at
55%, slightly darkened at the bottom. Applied via `gradFor(color)` next to
`colorFor()`, and used by the shift rail, the cards chart, and both recomp
charts. Legend swatches and table pills stay flat.

Stops are derived with `color-mix()` from the existing CSS var, so each series
keeps one source of truth — change `--slab` and the gradient follows. The helper
emits `background:<flat>;background-image:<gradient>` so a browser without
`color-mix()` support falls back to the flat fill rather than rendering nothing.

⚠ **Known trade-off.** The palette encodes four categories in two hue families
(customer blue light/dark, slab pack purple light/dark), distinguished by
lightness — the same channel the gradient uses. Where a light segment's darkened
base meets a dark segment's lightened top, the boundary softens, and thin
segments can blur into their neighbours at distance. If that becomes a problem
on the wall display, the fix is either a 1px separator on `.seg` or switching to
the top-sheen variant (highlight on the top 22% only, flat below).

## Recomp shift rail

Identical to the cards rail: same 2 PM - 2 AM span, gradient bars, END OF SHIFT
at 11 PM, amber EXTRA TIME band on the right, same note styling.

`GHOURS` now runs 2 PM through 2 AM with `shift:true` through 10-11pm. The
boundary is derived from the first `shift:false` entry, so changing the
schedule means flipping flags and nothing else.

### Shift-date attribution

A shift starting 2 PM Aug 21 runs past midnight. Work at 12 AM, 1 AM, and 2 AM
on Aug 22 belongs to the **Aug 21** shift. Both queries handle this with
`DATEADD(hour, -3, completed_at)::date`:

| clock time | -3h | shift_date |
|---|---|---|
| Aug 21 2:00 PM | Aug 21 11:00 AM | Aug 21 |
| Aug 21 11:00 PM | Aug 21 8:00 PM | Aug 21 |
| Aug 22 1:00 AM | Aug 21 10:00 PM | **Aug 21** |
| Aug 22 2:59 AM | Aug 21 11:59 PM | **Aug 21** |
| Aug 22 3:00 AM | Aug 22 12:00 AM | Aug 22 |

The `+3h` on the upper date bound keeps the final shift's 12-3 AM tail from
being clipped.

### Column names must match

`normalizeGrader` looks up each `GHOURS[].k` in the API response and falls back
to **0 on a missing key rather than erroring**. A renamed SQL alias therefore
shows up as an empty rail and all-grey grader bars, not an error. The matching
query is `08_recomp_aligned_to_cards.sql`; its aliases are `2-3pm` ... `2-3am`
plus `shift_total` and `extra_time`.

## Card Type tab

Third tab alongside Cards and Recomp, with two pills — **Data** and
**Data Verify** — matching the Recomp sub-tab pattern.

It reuses the Recomp "Total" panel wholesale (KPIs, shift rail, grader chart,
grader table) because the column shape is the same. Only the data source, the
pills, and the unit noun differ. `unit()` reads `TABS[TAB].unit`, so the shared
panel says "recomps" on Recomp and "tasks" on Card Type.

### Question IDs

```
'cardtype:data':   { env: 'METABASE_CARDTYPE_DATA_CARD_ID',   fallback: '34552' },
'cardtype:verify': { env: 'METABASE_CARDTYPE_VERIFY_CARD_ID', fallback: '' },
```

Both are wired. Env vars override the fallbacks so IDs can change without a
redeploy.

The shift-window label ("59% in 2 PM-11 PM PT") is derived from the GHOURS
`shift` flags via `shiftWindowLabel()`, so it tracks both the schedule and the
Pacific/Manila toggle instead of being hardcoded.

### Column naming

The Card Type question names hour columns `2 pm`, `3 pm` … `2 am`, while the
recomp question uses `2-3pm` … `2-3am`. `normalizeGrader` now tries both forms,
so one normalizer serves both tabs. It also accepts `total tasks`,
`shift total (2pm-11pm)`, `extra time (11pm-3am)`, and `outside window`.

Lookups fall back to **0 on a missing key rather than erroring**, so a renamed
alias shows up as an empty rail, not an error message.


### Shift palette (Recomp + Card Type)

```
var GRADER_COLOR  = "#39FF14";   // in shift  -> neon green
var OUTSIDE_COLOR = "#5C6B7A";   // outside / extra time -> grey
```

Both tabs share this, so Data and Data Verify read the same as Recomp.

### Gradient coverage

Every bar in the app is now gradient-filled. Two helpers, same stops:

- `gradFor(c)` — vertical, for bars that grow bottom-up (shift rails, stacked
  charts, grader/task charts)
- `gradForX(c)` — horizontal, for bars that grow left-to-right (the raw /
  pre-graded split bars on the Cards tab, the EV-age table fill bars)

Rotating rather than reusing the vertical version matters: a horizontal bar
filled with a top-to-bottom gradient reads as a different material than the
vertical bars beside it.

Legend swatches, pills, and the source-type chips stay flat so they still
match a single named colour.

## Grader filter (typeahead)

The Grader control is a combobox (`<input list>` + `<datalist>`) rather than a
plain select, so the full PL roster is browsable *and* typing narrows it.
It appears on Recomp (Total) and on Card Type (both Data and Data Verify).

- Rosters are **per tab**, since Card Type is graded by the full PL floor
  (61 names, `CARDTYPE_ROSTER`) while Recomp is a smaller trained group
  (16 names, `RECOMP_ROSTER`). `rosterFor()` picks by active tab.
- Seeding means the list is populated before any query returns, and someone
  with zero rows in the window is still selectable — their entry is labelled
  "no rows in window", so a grader who logged nothing is visible rather than
  silently absent.
- `refreshGraderFilter()` merges the roster with whoever actually appears in the
  response, so a new hire shows up without editing the array.
- Switching tabs clears the selection and rebuilds the datalist, so a name from
  one team never lingers as a filter on the other.
- `gData()` matches fuzzily via `graderMatches()`, which tries progressively
  looser rules and stops at the first hit:
  1. exact (after normalising case, punctuation and whitespace)
  2. name contains the query — typing "rod" finds Rodel / Rodelyne / Rodjie
  3. **query contains the name** — this is the one that matters, because the
     roster label and the value the query returns don't always agree. The
     Metabase filter lists "Aaron Adrianne Joaquin" while
     `first_name || ' ' || last_name` returns "Aaron Adrianne". One-directional
     substring matching returns nothing here; bidirectional finds it.
  4. token prefixes — every typed token must prefix some token in the name, so
     "josh sac" finds Joshua Sacramento
- A match count sits under the field ("1 match", "2 matches"). An unmatched
  query reads "no match in this window" in amber, so an empty chart is
  explained rather than just blank.
- `oninput` re-renders as you type; **Escape** clears the filter.

Sorting is case-insensitive so lowercase entries like `dominic bediones` and
`nelzon litrero` file alphabetically rather than at the end.
