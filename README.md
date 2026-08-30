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
| `METABASE_ORDERS_CARD_ID` | no | `35872` — Orders → Orders |
| `METABASE_CARD_QUEUE_CARD_ID` | no | `35905` — Orders → Card Queue |
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

## Total column fallback

`normalizeGrader` looks up the total under a list of aliases (`total_comps`,
`total tasks`, `total verifies`, `total`, `count`, …). If none match it
**derives** the total instead of leaving it at 0:

```
total = sum(hour buckets) + outside
```

This exists because a missed alias fails silently — `pick()` returns 0 rather
than erroring — which renders as a full set of empty grader bars with a healthy
shift rail above them. That was the symptom on Data Verify (34618): hour columns
and shift total resolved, but every grader bar read 0.

The derived figure is exact whenever the hour buckets plus `outside window`
account for all rows, which is how these questions are built. If a future
question drops `outside window`, the derived total will undercount by whatever
falls outside 2 PM - 3 AM, so prefer adding a real total alias to the SQL.

## Review tab

Fourth tab, with two pills — **Review (Pre-Graded)** and
**Review Premium (Raw)**.

```
'review:pregraded': { env: 'METABASE_REVIEW_PREGRADED_CARD_ID', fallback: '34684' },
'review:raw':       { env: 'METABASE_REVIEW_RAW_CARD_ID',       fallback: '34685' },
```

Like Card Type, it reuses the shared grader panel (KPIs, shift rail, grader
chart, grader table). `TABS.review.unit` is `"reviews"`, so the panel reads
"Total reviews by grader", "N reviews in extra time", and so on.

It uses `CARDTYPE_ROSTER` for the grader dropdown, since review is done by the
PL floor rather than the smaller recomp group. If review is actually a
restricted group, add a `REVIEW_ROSTER` array and extend `rosterFor()`.

### Colour by pill

Review is split by card condition, so each pill gets its own in-shift colour
and the two read as different series at a glance:

| pill | in-shift bars |
|---|---|
| Review (Pre-Graded) | `#8B5CF6` purple |
| Review Premium (Raw) | `#38BDF8` blue |

Recomp and Card Type stay neon green; extra time is grey everywhere.
`shiftColor()` is the single source — it feeds the shift rail, the grader chart
segments, and the legend swatch, so switching pills recolours the whole tab
consistently rather than leaving a stale swatch behind.

### Note on routing

Server-side, tabs whose question depends on the pill are listed in one
`VIEWED` set rather than chained `||` checks. Client-side, `usesGraderPanel(t)`
is the single predicate for "renders through the grader panel" — it's used by
`setTab`, the timezone toggle, and the load handler. Adding a fifth tab of this
shape means touching those two lists plus the markup, not hunting every
`TAB === "recomp"` comparison.

## Shape guard (false positive fix)

The load handler checks the returned columns against the shape the active view
expects, so a question wired to the wrong tab surfaces as a banner instead of a
silently empty dashboard.

Two bugs as more tabs were added:

1. **`SUB` persists across tabs.** It only means anything on Recomp, but the
   guard consulted it everywhere — so leaving Recomp on "Avg EV Age" and
   switching to Review made the guard expect the EV-age shape and flag
   perfectly good data. `SUB` is now only read when `TAB === "recomp"`.

2. **Three tabs share the grader shape.** Recomp, Card Type and Review all
   legitimately return `grader` columns, so the old `recomp-total` label was
   misleading. The shape is now called `grader`, and it's only wrong on Cards
   or on Recomp's age view.

The env var named in the warning is resolved per tab *and* pill, so it points at
the actual variable to check (e.g. `METABASE_REVIEW_PREGRADED_CARD_ID`) rather
than always naming the recomp one.

## Hot/Cold Zone (Recomp pill)

Third pill on Recomp, backed by question 34849:

```
'recomp:zone': { env: 'METABASE_HOT_COLD_ZONE_CARD_ID', fallback: '34849' },
```

Layout: a single **Total cards** KPI, then a per-sport grid of top-3 players.
Selecting a sport scopes the KPI to that sport and reveals a top-5 leaderboard
below, headed by that sport's logo.

Rows are rank / thumbnail / name / count with **no progress bars** — the counts
carry the comparison and the row reads cleaner without them. The colour cue
comes from the initials circle, tinted in the sport's accent.

### Aggregation is client-side

`normalizeZone()` flattens the response and `zTop(sport, n)` ranks in the
browser, so the sport filter re-ranks in place with no refetch. That is why the
sport `<select>` short-circuits to `renderZone()` instead of calling `load()`.

### Sports

`ZSPORTS` holds 15 sports. The five carrying `main:true` (basketball, baseball,
football, pokemon, one_piece) are the grid on "All". The other ten — soccer,
hockey, yugioh, dragon_ball, combat, marvel, dc, disney, golf, tennis — are
selectable from the dropdown and render as a single card plus the top-5
leaderboard. Showing all fifteen at once buried the ones carrying the volume.

The five main sports have logo files; the rest render an accent tile with a
short mark (`SOC`, `YGO`, `CMB`…). Drop a PNG in `public/logos/` and add `logo:`
to that entry to switch any of them over.

`SPORT_ALIAS` + `canonSport()` normalise source values on ingest — `futbol` and
`Soccer` → `soccer`, `Yu-Gi-Oh` → `yugioh`, `dragonball` → `dragon_ball`,
`UFC` / `boxing` / `MMA` / `wrestling` → `combat`. Unknown values fall through
with spaces and hyphens converted to underscores. Add a line to the map if a
sport shows no data despite rows existing.

### Column tolerance

The player field is read from any of `player_name`, `player`, `character`,
`name`; the count from `cards`, `total_cards`, `card_count`, `count`. The sport
value is lowercased and `onepiece` / `one piece` normalise to `one_piece`.
If 34849 uses none of these, the rail renders empty rather than erroring — add
the alias to `normalizeZone`.

### Logos

`public/logos/*.png` — supplied by the user, black plate knocked out to
transparent, trimmed and normalised to 72px tall so they sit on the panel
without a box.

Pokemon and One Piece are **wordmarks** (the logo already contains the name), so
they carry `wordmark:true` and the text label is suppressed to avoid printing
the name twice. NBA/MLB/NFL are pictorial marks and keep their text label.

⚠ These are third-party trademarks. Fine for an internal ops screen; do not
reuse this build for anything customer-facing or public without checking.

### Player thumbnails

`zThumb()` renders `<img class="zthumb">` when a row carries an image URL
(`image_url`, `image`, `card_image_url`, `front_image_url`) and **initials**
otherwise, tinted in the sport's accent colour.

`initials()` drops middle initials and name suffixes, so Monkey D. Luffy is
`ML` not `MD`, Ronald Acuna Jr. is `RA` not `RJ`, and single-name characters
like Charizard become `CH`.

The `<img>` carries an `onerror` that swaps back to the initials markup, so a
dead URL degrades quietly instead of showing a broken-image glyph on a wall
display nobody is watching.

**Nothing populates the image field yet.** The intended source is Arena Club's
own card scans — no hotlink blocking, no licensed press or marketplace imagery
on a company screen, and the actual slab is more informative than a headshot.
Adding one image column to 34849 turns the circles on with no further code. If
`admin.cards` stores a path or S3 key rather than a full URL, prefix logic goes
in `normalizeZone`.

## Player images via /api/playerimage

Rows without an image URL are resolved server-side (no CORS, shared cache).

### Source routing

One source doesn't cover everything — **"Nami" on Wikipedia is a river in
Korea**, not the navigator, and Wikipedia headshots of athletes are usually
crowd photos rather than portraits.

| sport | sources, in order |
|---|---|
| basketball / baseball / football | **ESPN**, then Wikipedia |
| one_piece | onepiece.fandom.com |
| pokemon | bulbapedia, then pokemon.fandom.com |

**ESPN** gives real transparent-PNG headshots of the right athlete:

```
https://a.espncdn.com/i/headshots/{league}/players/full/{id}.png
```

League slugs `nba` / `mlb` / `nfl`. Athlete ids come from the keyless search
endpoint `site.web.api.espn.com/apis/search/v2?query=...&sport=...`, and the
CDN URL is HEAD-checked before being returned, because missing ids 404 and a
broken `<img>` should never reach a tile.

To pin an athlete, read the id off their ESPN profile URL
(`espn.com/nba/player/_/id/110/kobe-bryant` -> `110`) and add it to
**`ESPN_IDS`**. Do *not* add athletes to `OVERRIDES` — that map is consulted
before the ESPN branch and would block the real headshot.

Retired players often have no headshot on file (Michael Jordan, Mickey Mantle),
which is exactly why Wikipedia stays in the chain behind ESPN.

⚠ ESPN retired its public API in 2014; these endpoints are undocumented and can
change without notice. Every failure falls through to Wikipedia and then to
initials, so breakage degrades rather than breaks.

### Resolution order

1. **`OVERRIDES`** — hand-pinned exact page titles for names known to
   misresolve. Add an entry whenever a tile shows the wrong picture; it is the
   cheapest fix and short-circuits everything below. `null` skips the lookup
   entirely (e.g. `'ian f'`, which isn't a real person).
2. **Exact title** — `titles=<name>`. Reliable when the name is the page title,
   which it usually is.
3. **Search** — `generator=search` plus a sport hint. Fuzzy last resort.

Each step tries `pageimages` first, then falls back to `prop=images` +
`imageinfo`, since PageImages isn't guaranteed on every wiki. The image picker
skips logos, icons, placeholders and nav graphics.

### Image proxy (mode=img)

Tiles point at `api/playerimage?mode=img&name=...&sport=...`, which resolves the
name then **streams the picture through this origin**. This is the piece that
makes it work in production: ESPN and the wikis can refuse hotlinks by
`Referer`, and a browser loading `a.espncdn.com` directly from your page may get
nothing. A server-side fetch has no such problem, and the browser then loads
from the dashboard's own domain.

It also removes the JSON round-trip — the `<img>` src *is* the endpoint, so
there's no fetch/parse/re-render cycle and no CORS surface at all.

A resolution failure returns **404** so the `<img>`'s `onerror` fires and the
tile falls back to initials. Responses carry
`Cache-Control: public, max-age=86400, s-maxage=604800`, so Vercel's edge cache
absorbs the repeat traffic from a 60s auto-refresh.

`?mode=img` omitted returns JSON metadata instead (`image`, `title`,
`attribution`) — useful with `&debug=1` for checking what a name resolves to.

### Caching

Server: module-scope `Map`, 24h TTL, bounded at 500; misses cached too so a
name with no article isn't retried every refresh. Client: `imgCache` per
session — switching sports or a 60s auto-refresh never re-requests a resolved
name.

`?debug=1` bypasses the server cache when testing an override.

### Failure

A miss, an error, or a dead URL all fall through to the initials circle. The
route never returns non-200 for a lookup failure. Kill switch:
`ZONE_LOOKUP_IMAGES = false` in `index.html`.

### Not used, deliberately

**Yahoo Sports** — Getty/AP licensed press photos, no public API,
hotlink-blocked; breaks in production. **TCGplayer** — has an API but image
rights are affiliate-only; if Arena Club holds a partner key, prefer it for
pokemon and one_piece.

⚠ Wiki images carry per-file licences (mostly CC-BY-SA, some fair-use). Fine
internally. The route returns an `attribution` field — surface it if this ever
faces customers.

**Still the best source:** Arena Club's own card scans. No licensing question,
no disambiguation guesswork, and the real slab beats a headshot on a grading
dashboard.

## Bundled Pokemon portraits

`public/portraits/*.png` — official artwork from the PokeAPI sprite set,
trimmed, squared (so the circular crop doesn't lop off a wing or tail) and
resized to 160px.

`LOCAL_PORTRAIT` in `index.html` maps a name to a bundled file and **wins over
the proxy lookup**. Pokemon tiles therefore render with zero third-party
dependency — no ESPN, no wiki, no network beyond your own origin.

Adding more is a two-step: drop the PNG in `public/portraits/` and add the
lowercased name to `LOCAL_PORTRAIT`. This is also the pattern to use once Arena
Club's own card scans are available — point the map at scan URLs and the
external lookups become a fallback rather than the primary path.

Source (Pokemon national dex id, e.g. Charizard = 6):
`raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{id}.png`

## Hot/Cold Zone — 34849 shape notes

Two things about the live question that the view now handles:

**1. The TOTAL row.** 34849 emits `* TOTAL - 12217 players` alongside the
individual players. Counting it as a player double-counts every card — that's
why the KPI read 199,772 instead of 99,886. `isZoneTotalRow()` detects it (leading
`*`, or `TOTAL - <n>`), holds it aside, and uses its figure for the KPI, which is
authoritative. The player rows are ranked without it.

**2. There is no `sport` column.** With nothing to group by, the five sport cards
were all empty. When `zoneHasSport` is false the view falls back to a single
combined top-12 leaderboard and says so in the hint. Add a sport column and the
per-sport cards light up automatically — no code change.

To enable the sport breakout, add to 34849:

```sql
ac.sport                                   -- basketball | baseball | football | pokemon | one_piece
```

grouped alongside `player`. Values are lowercased and `one piece` / `onepiece`
normalise to `one_piece`.

**Extra columns are surfaced.** `available`, `in packs` and `recomped cards`
render as the row subtitle. They are summed through `zTop()` alongside the card
count, so they stay correct when rows aggregate.

## Rail reconciliation warning

The shift rail compares `SUM(hour columns)` against `SUM(total)` and, when they
disagree, prints an amber warning next to the extra-time note:

> ⚠ 589 of 3,502 recomps fall outside the 2 PM–3 AM PT window — counted in the
> total, not in any hour column

This exists because the failure it catches is otherwise invisible. On 2026-08-24
the dashboard showed TOTAL 3,502 / SHIFT 2,677 / OUTSIDE 236 — the hour columns
summed to 2,677 exactly and 236 sat in the 11 PM bucket, leaving **589 rows in
the total that no hour column accounted for**. The rail looked plausible while
under-representing the day by 17%.

Two things cause it:

1. **The question's total isn't windowed the same way the hour columns are** —
   `COUNT(*)` over the whole date range while the `SUM(CASE WHEN shift_hour…)`
   columns only cover 2 PM–3 AM. Rows at, say, 9 AM land in the total and
   nowhere else.
2. **The upper bound clips at midnight**, so post-midnight work is missing from
   both. The symptom is a hard cliff: a busy 11 PM followed by exact zeros at
   12/1/2 AM.

`08_recomp_aligned_to_cards.sql` handles both — it filters to the window in
`filtered` *before* computing `total_comps`, so the total and the buckets always
describe the same set:

```sql
AND ol.finished_at::timestamp < DATEADD(hour, 3, DATEADD(day, 1, {{end_date}}::timestamp))
DATEADD(hour, -3, ol.finished_at::timestamp)::date AS shift_date
```

If the warning appears, the query feeding the tab is not that one.

## Done / snooze on Hot-Cold Zone

Clicking a player row selects it — accent-tinted background plus a coloured left
bar — and reveals a **DONE** pill. Clicking DONE hides that player for
**5 days**, and the list re-ranks so the next highest moves up. Clicking the row
again, or anywhere off it, collapses the selection without action.

Hidden players appear as chips under the grid (`Kobe Bryant 5d`); clicking a
chip restores them immediately, which matters when someone taps DONE by mistake
on a wall display.

Selection and re-rank work in both the top-3 cards and the top-5 leaderboard,
since both render through `zRow()`.

`SNOOZE_DAYS` at the top of the block changes the window. Expired entries are
dropped on read, so the store self-cleans rather than growing forever.

### ⚠ Storage is per-browser

State lives in `localStorage` under `pl_zone_snooze_v1`. That means:

- Marking DONE on your laptop does **not** clear it on the wall display
- Clearing site data loses the list
- There is no audit trail of who marked what, or when

For a shared operational signal — which is what this is — it belongs
server-side. The app already proxies through `/api/*`, so a small
`/api/snooze` route (GET list, POST name) backed by any store would make it
shared, durable, and attributable. `markDone()` / `unsnooze()` / `loadSnooze()`
are the only three functions that would need to change.

## Filter scoping

Each view shows only its own filters:

| view | filters |
|---|---|
| Cards | date range, grain, source/type |
| Recomp / Total | Grader |
| Recomp / Avg EV Age | Sport (`#sport`), Pack category |
| Recomp / Hot-Cold Zone | Sport (`#zsport`) |
| Card Type, Review | Grader |

**Zone has its own `#zsport` select, deliberately.** It originally shared
`#sport` with Avg EV Age, but `refreshZoneSportFilter()` rewrites that element's
options with the 15 configured zone sports — so after visiting Zone, the Avg EV
Age tab's sport filter listed sports its query knows nothing about. Two views,
two option sets, two elements.

`#zsport` re-ranks in place via `renderZone()` rather than calling `load()`,
since Zone aggregates client-side.

## Assign modal + Assignments pill

Clicking any Hot/Cold Zone row opens a modal: player header with thumbnail,
sport and card count; the 17-name `RECOMP_ROSTER` as toggles; an optional note;
then **Assign N**, **Mark done**, **Cancel**. Escape or a scrim click dismisses.

Assigned rows stay highlighted and carry a badge — the assignee count in the
compact cards, first names on the wide leaderboard where there's room.

Each job row carries the **player's thumbnail**, captured onto the assignment
record at assign time, so a card is scannable by face rather than by reading
every name. Falls back to initials tinted in the assignee's colour.

**Daily lines are folded in.** `dailyJobsByWho()` walks every stored day and
every column, pulling out lines that carry assignees, and merges them with the
zone assignments. One panel therefore answers "what is this person working on"
instead of two half-answers — a recomp assigned from Hot/Cold Zone and a line
assigned on Daily both count toward the same "N active".

Daily rows carry their **column's** colour (Today's Tags green, Next Up orange…)
rather than the person's, so which board a line came from stays readable, and
the subtitle shows the column and day (`Today's Tags · today`).

Opening the Assignments pill loads the Daily store if it hasn't been touched
this session — otherwise lines assigned on a previous visit would be invisible
until someone opened Daily.

The **Assignments** pill inverts player→assignees into assignee→players and
lists **every** roster member, including idle ones. Idle capacity is as useful
to see as busy capacity when deciding who to hand the next recomp to. Cards sort
busiest-first, then alphabetically.

`Mark done` reuses the existing 5-day snooze **and clears the assignment**.
Without that, marking a player done left everyone who was assigned to them still
reading "1 active" for finished work — five people showing a stale assignment
for a recomp nobody was doing any more. The work ending ends the assignment.

### ⚠ Storage — read before relying on this

`ASSIGN_REMOTE = false` means assignments live in `localStorage`. For snooze
that was a tolerable limitation; **for assignments it is actively misleading** —
assigning Aaron on your laptop shows him working on your screen and idle on the
wall display and on his own. Two people can assign the same player and neither
will know.

The code is already structured for the fix: `loadAssign()` / `saveAssign()`
switch to `GET`/`POST api/assignments` the moment `ASSIGN_REMOTE = true`. What's
missing is the route and somewhere to put the rows. Worth adding before this
goes in front of the team.

## Assignment colours + removal

**Per-person colour.** `personColor(name)` assigns by **roster index**, not by
hashing the name. Hashing over a fixed palette collided constantly — Alan Bailey
and Anjello Bumanglag both landed on the same green. Index-based spacing gives
every one of the 17 a distinct hue:

```
hue   = (index * 360/rosterLength + 14) % 360
light = index % 2 ? 72% : 58%
```

Hues land 21° apart and alternating lightness pushes neighbours further apart
than hue alone would. Verified 17 unique colours across 17 people, and it scales
automatically if the roster grows. Names not on the roster fall back to a hash so
they still get a stable colour.

The colour is used for the modal avatar and row tint, the assignment card border
and avatar, and the strip on each job row — the same person reads identically
everywhere, with nothing stored.

**Removing an assignment** works two ways:
- **✕ on any job row** in Assignments removes just that person from that player.
  The record is deleted entirely when the last assignee is removed, so no empty
  shells linger.
- **Unassign all** in the modal, which only appears when a record already
  exists. Clears every assignee for that player at once.

Unticking everyone and pressing Assign does the same thing, but the explicit
buttons make removal discoverable rather than a side effect.

### Fixed: literal `\u2026` in the note placeholder

The placeholder was double-escaped during a patch and rendered
`Prioritise the Prizm parallels\u2026` on screen. HTML attributes don't process
JS escapes — the character has to be literal or a proper HTML entity.

## Daily — cert workflow columns

**Each day has its own board.** A Mon–Sun strip sits above the columns,
defaulting to today. Each day button shows a line count so you can see at a
glance which days are already planned. `‹` / `›` step weeks, the date input
jumps anywhere, and **Today** returns.

Storage is keyed by date (`pl_daily_v2`):
`dailyStore["2026-08-26"] = { today_tags:[…], next_tags:[…], … }`. Empty days
are dropped on save so clicking through a week doesn't accumulate blank boards.

Dates use local `getFullYear/Month/Date`, **not** `toISOString()` — the latter
converts to UTC and would roll the day backwards for anyone west of GMT, which
is everyone on this team.

Five columns left to right, each seeded with three empty lines:

`Today's Tags` · `Next Day Tags` · `Today's Workflow` · `Next Up` · `Additional`

Each has its own accent on the top border and count. Below 1200px they reflow
to two columns rather than crushing to unreadable widths.

- **Click any line to edit** in a centred modal — header shows which column and
  the line's position, a textarea for the text, then Save / Clear / Cancel.
  Enter saves, Shift+Enter keeps the newline, Escape cancels.
- **+ Add line** appends and opens the editor on the new line immediately.
- **✕** removes a line.
- **Drag** by the row (or its ≡ grip) to reorder within a column or move to
  another. Drop above whichever line you're hovering, or into empty space to
  append. The target column outlines in its own accent.
- The header count shows only lines with text, so blanks don't inflate it.

Edits commit **on blur rather than per keystroke** — re-rendering mid-word would
otherwise yank the caret to the start.

### ⚠ Storage

`localStorage` under `pl_daily_v1`, same limitation as snooze and assignments:
per browser, not shared. For workflow notes the whole team reads, this needs the
same server-side treatment.

### Fixed: `var` hoisting killed init

`loadDaily()` was called at boot but `DAILY_COLS` is declared further down the
file. `var` hoists the *name*, not the value, so it read `undefined` and threw
`Cannot read properties of undefined (reading 'forEach')` — which aborted the
rest of the init block and left the Daily pill at zero width. Now loaded lazily
on first open, guarded by `loadDaily.done`.

## Modal placement

The assign modal is **anchored beside the content** rather than centred over it.
The single-sport view only occupies ~760px, so on a wide screen a centred card
covers the list while acres of empty space sit to the right.

`anchorModal(modal, xEl, yEl)`:
- **Horizontal** — 24px to the right of the panel the row belongs to
  (`.zcard` or `#zexpanded`).
- **Vertical** — top edge flush with the panel, so the card reads as a second
  column beside the list rather than floating at an arbitrary height. Every row
  in a card opens the modal at the same place.
- Falls back to centring on the clicked row only when the panel has scrolled
  above the viewport, which would otherwise pin the card to the top edge.

⚠ Anchor on the **`.zcard`**, not the `#zsports` container — the container spans
the full section width, so there is never room beside it and the modal silently
falls back to centred.
- **Clamped** to a 20px viewport margin so it never runs off an edge.
- **Falls back to centred** when the gap is too narrow for the card — a squeezed
  card beside the content is worse than a centred one. Verified at 1180px wide.

Re-anchors on window resize. The scrim lightened from 72% to 55% since the list
stays visible beside the card and shouldn't be buried.

## Assignments grid sizing

Assignments uses its own `.agrid` rather than sharing `.zgrid` with the sport
cards. They solve different problems — a sport card holds three short rows, an
assignment card holds a full name, a status and a job list — and sharing one
breakpoint meant widening either broke the other.

`minmax(360px, 1fr)` with an 18px gap gives four across at 1600px instead of
five at 272px. Long names like "Aaron Adrianne Joaquin" and "Ian Benedict Banua"
now fit on one line rather than wrapping to two.

## Daily — line assignment + Clear all

**Assigning a line.** The line editor now carries the same 17-name
`RECOMP_ROSTER` as the Hot/Cold Zone assign modal, as toggleable chips. Assigned
lines take that person's colour on their left edge and show initials pips —
`personColor()` is shared, so Aaron is the same red on a Daily line, in the
assign modal, and on his Assignments card.

Assignees are stored on the line (`{id, text, who:[]}`) and travel with it when
dragged between columns.

**Clear all** wipes every line for the day currently selected, confirming first
with the count. Other days are untouched.

## ⚠ The demo must never reach the deploy

`vercel.json` sets `outputDirectory: "public"`, so **everything in `public/` is
served** — `demo.html` included. Deployed, it would be live at `/demo.html`:
a page that looks exactly like the dashboard and is entirely fabricated. On a
wall display that's worse than an outage, because nobody can tell.

Two locks:

1. **`.vercelignore`** lists `public/demo.html`, so it isn't uploaded at all.
2. **A host guard at the top of the mock.** Even if the file is copied
   somewhere it shouldn't be, the mock installs nothing unless the hostname is
   local — `file://` / `srcdoc` / `blob:` (empty hostname), `localhost`,
   loopback, `*.local`, or a private LAN range. On anything else it returns
   before overriding `fetch`, logs a console warning, and repaints the amber
   banner red reading *"Demo mock DISABLED on this host — showing live data."*
   `?demo=1` overrides deliberately.

`index.html` itself contains **zero** demo code — verified by grep on every
build, not assumed.

## Demo build (`public/demo.html`)

`demo.html` is `index.html` plus a mock layer that intercepts `/api/*`, so the
whole dashboard runs with no Metabase, no Neon and no deploy. Everything on it
is fabricated. Deleting that one `<script>` block gives the production file
back.

Seeded so the assignment paths are actually exercisable rather than merely
populated:

| seed | why |
|---|---|
| 50 of 58 people have skills | the other 8 stay idle, so idle capacity is visible |
| baseball / basketball / football / pokemon / one_piece have deep primary coverage | that's where the volume is |
| **star_wars has no primary holder, only 2nd-option holders** | fires auto-assign's "went to a second skill" fallback |
| **combat has nobody at all** | fires the "skipped — nobody has that category" path |
| Adrian Carlo is stored as a **legacy flat array** | proves the migration against real data, not just a unit test |
| 26 cards pre-assigned, unevenly | least-loaded auto-assign has an existing load to correct against |
| **queue cards are built FROM the order rows** | an order number read off the Orders tab actually exists on Card Queue |
| 2 Daily lines + 1 zone assignment | Recomp Assignments isn't empty on open |

Card-queue rows are **memoized**, because the seeded assignments are keyed on
`order|ac|card_status` — regenerating rows per request would orphan every one
of them. Orders are memoized for the same reason *and* because the queue is
generated from them: each card inherits its order's number, status, due date
and category. Before that, both tabs invented independent random order numbers,
so no order number existed on both and the find-an-order workflow couldn't be
tested at all.

### ⚠ Interception must not depend on `new URL()`

The first demo build loaded, printed its console banner, and then let every
request through to the real network — the app showed *"The API route isn't live
yet"* while the mock sat there apparently working.

`new URL(relative, base)` **throws** when `location.href` is opaque: `srcdoc`
iframes, `blob:` and `about:` documents. The fallback kept the raw string as the
path, query string still attached, so `/\/api\/ticker$/` never matched
`/api/ticker?tab=cards` and the request escaped.

`parseReq()` now splits path and query by hand and only *upgrades* to `new URL`
inside a try. `isRoute()` matches `(^|/)api/<name>/?$`, tolerating a leading
slash, a relative path, a trailing slash, an absolute URL and a fragment.

The lesson generalises: a mock that fails open is worse than one that fails
loudly, because the symptom points at the server rather than at the mock.

A seeded PRNG means a reload gives identical numbers, so a bug you spot is
still there when you look again. `LAT` adds 260ms of fake latency so spinners
are visible.

Two things the demo cannot show: shared state is per-tab memory, so cross-screen
sync needs a real deploy, and `/api/playerimage` returns 404 so athlete tiles
fall back to initials (bundled Pokemon portraits still resolve).

## Global Refresh button

Sits in the top control bar next to **Auto 60s**, so it's on every tab.

Two independent things go stale on any tab: the **Metabase query** behind it,
and the **shared board** (assignments, skills, daily lines). Refreshing only one
leaves half the screen out of date, so the button does both — fired in parallel,
since they hit different endpoints and neither depends on the other.

It reports the **worse** of the two outcomes, and names which half failed:

| result | label |
|---|---|
| both succeeded | `Updated` |
| query failed | `Data failed` |
| shared board failed | `Board failed` |
| both failed | `Offline` |

"The numbers are stale" and "someone else's edits are missing" need different
responses from whoever is watching the wall, so a single green `Updated` while
the query silently failed would be a lie.

`load()` now **returns its promise** and resolves with `ok` / `error` (it used
to return nothing, so a caller couldn't tell when the data had landed). It
resolves rather than rejects on failure — the error branch already reports to
the user, and rejecting would be a second channel for the same news.

### What `force` does and does not waive### What `force` does and does not waive

`pullState(initial, force)`:

```js
var fresh = (d.rev > stateRev) || (force && d.rev === stateRev);
if(!initial && (pendingWrites > 0 || !fresh)) return "skipped";
```

- **Waived: equality.** The poll ignores an equal revision because nothing
  changed. On an explicit click, re-adopting the same revision is a no-op and
  lets the button give a real answer rather than silently doing nothing.
- **Not waived: a lower revision.** A reset store or stale replica returning
  rev 3 against our rev 70 would wipe saved work — that is the failure that cost
  70 auto-assigned cards and the rule stays absolute.
- **Not waived: an in-flight write.** That guard protects unsaved edits, and a
  click shouldn't override it. Clicking mid-write returns `skipped`; the flush
  step means this is rare in practice.

`pullState` now **resolves with a status** (`ok` / `skipped` / `error`) rather
than rejecting. The boot call is `pullState(true).then(startStatePolling)` — a
rejection there would leave the dashboard running with no polling at all.

Refresh also fixed a routing bug: **Assignments and Team render from `qRows`**
(the card queue) plus shared state, not from the order-level question. Pressing
Refresh on those subtabs used to fetch Orders and leave the cards stale, and
going Orders -> Assignments without ever opening Card Queue showed an empty
panel, because nothing had fetched the queue. `ordersWantsQueue()` now decides:
queue for every Orders subtab except Orders itself.

## Daily / Assignments do not call Metabase

Both views are entirely local — there is no saved question behind either.
`setSub()` short-circuits before `load()` for them, so selecting Daily no longer
produces:

> Could not load data. Unknown tab/view: recomp:daily

The error was harmless but looked like a broken deployment. The footer now reads
"Local — not backed by Metabase" on these two views rather than showing a stale
Metabase source line.

Note the banner is cleared with `banner("")`, not `[hidden]` — it toggles via a
`.hide` class, so setting the attribute does nothing.

## Daily sizing

Sized for a wall display:

| | before | after |
|---|---|---|
| Day button | 74×~60px | 100×99px |
| Day number | 16px | 24px |
| Column min-height | 150px | 340px |
| Column title | 14px | 17px |
| Column count | 13px | 17px |

Columns are `flex-column` with `+ Add line` pushed to the bottom, so all five
stay the same height regardless of how many lines each holds.

## Daily line text sizing

Line text is **15.5px**, up from 14px. 17px was tried first and broke
`sd_ereader_pack` mid-word — mono at that size doesn't fit a fifth-width column.

Assignee pips moved **below** the text rather than sitting inline: an inline pip
plus the ✕ cost ~60px of a ~250px line, which is what forced tag names to wrap
in the first place. Text now gets the full width, and `overflow-wrap:anywhere`
(instead of `word-break:break-word`) means it only breaks a token when there is
genuinely no alternative.

Result: `sd_auto_pack`, `sd_ereader_pack` and `sd_wemby_grail` all sit on one
line with room to spare.

## Daily and the timezone toggle

Boards are keyed by the **Pacific shift date** — that is the canonical identity
of a shift. Flipping the toggle changes the **label only**; nothing moves, so
notes never appear to jump days.

The shift starts 14:00 PT. In Manila that's 14 + 15 = 29h, i.e. 5 AM the *next*
calendar day, so the Manila label reads one day later:

| Pacific | Manila |
|---|---|
| Wednesday, Aug 26 PT | Thursday, Aug 27 PHT |

`dailyDayShift()` computes the offset from `TZOFF` rather than hardcoding +1,
since the gap is +16h under PST — the arithmetic still lands on +1 day, but it
would not if the shift start moved earlier.

`displayISO()` / `keyISO()` convert between the two. The week strip's
`data-day` stays canonical while its label, the date input, and the header all
render through `displayISO()`, and the date input converts back on change. The
"today" highlight compares canonical dates, so it stays on the real current
shift in either timezone.

## Daily — marking a line done

Every line carries a check toggle on its left. Ticking it:

- strikes the text through and drops the row to 50% opacity — the line stays
  visible for the rest of the shift rather than disappearing
- removes it from the **column count**, the **day badge** in the week strip, and
  the **header line count**
- removes it from **Assignments**, since finished work isn't active work

The modal has a matching **Mark done / Reopen** button, which also saves any
text and assignee edits in the same click.

Stored as `line.done`, so it survives reloads and travels with the line when
dragged between columns.

### Two handler traps this hit

The check sits inside `.dline[data-open]`, which opens the editor. Both are
delegated listeners on the **same element**, so `stopPropagation()` in the check
handler does not stop the sibling — the open handler has to exclude `.dcheck`
explicitly, the same way it already excludes `.dkill` and `.dadd`.

Three separate places count lines — `boardCount()` for the week badge, `filled`
for the header, and the per-column `n`. Only two were updated at first, so the
column header read 2 while the day badge read 1.

## High End pill

Sixth Recomp pill, backed by the Value Tracker question:

```
'recomp:highend': { env: 'METABASE_VALUE_TRACKER_CARD_ID', fallback: '3213' },
```

**Two tiers**, filtered client-side on `estimated_value_usd`:
`$2,500 – $4,999` (default) and `$5,000 +`.

**One day at a time**, defaulting to **yesterday**. Yesterday / Today buttons
plus a single date input; day matching is on `finished_at`.

Rows sort by estimated value descending and show: player portrait (via
`/api/playerimage`, same proxy as Hot/Cold Zone), grader pip in their
Assignments colour, set · parallel · company + grade, current EV with the prior
comp beneath it, a percent-change chip (green up, amber down), days since the
last comp, and the Click Me link from the `url` column. The left border is the
sport.

KPIs: comp count, total EV, average change across rows that have a prior comp,
and the biggest mover.

### Timestamp parsing

3213 renders `finished_at` as **"Aug 25, 2026, 6:33 PM"**, not ISO. `heDayOf()`
takes a leading `yyyy-mm-dd` when present, otherwise falls back to `Date` parse,
and returns `""` rather than `"NaN-NaN-NaN"` on failure — a bad row then simply
matches no day instead of poisoning the filter.

## Panel isolation

`showRecompPanel(id, opts)` hides **all** recomp panels and shows one, plus the
KPI strip and the three toggles.

Before this, every branch hid its own siblings by hand — so each new pill had to
remember every older one. High End didn't, and returned before the line that
hides Daily, leaving both stacked on screen. That class of bug recurs every time
a pill is added; a single hide-all-show-one call removes it.

Datasets are wiped on every switch too (`grows`, `rrows`, `zrows`, `heRows`,
`zoneTotal`, `zoneHasSport`) in `setSub`, `setTab`, `setCtSub` and `setRvSub`.
Hiding a panel isn't enough on its own — the arrays persist, so a stale recomp
table could still paint under a new view before its own fetch resolved.

Verified across nine transitions (Total → Daily → High End → Daily → Zone →
High End → Assignments → Avg EV Age → Total): exactly one panel visible at
every step.

## Shared state — /api/state

Daily boards, assignments and snoozes are stored server-side so every screen
agrees. Previously each browser kept its own copy in `localStorage`, which meant
nothing typed on one machine was visible anywhere else.

### Setup (one step)

Provision **Vercel KV** on the project. It injects `KV_REST_API_URL` and
`KV_REST_API_TOKEN`, and the route picks them up automatically — no package to
install, since it talks to KV over its REST API with plain `fetch`. Any Upstash
Redis works too.

Without those vars the dashboard still runs, but each browser keeps its own copy
and an amber **"Local only — changes are not shared"** banner appears at the top.
The banner is driven by the `shared` flag the API returns, so it can't
silently lie about whether syncing is on.

### How it behaves

- **Writes are debounced 400ms**, so typing a line is one request, not one per
  keystroke.
- **Reads poll every 10s.** Another person's edit appears within that window.
- **Daily is keyed per shift date** (`pl:v1:daily:2026-08-26`), so two people
  working on different days can't overwrite each other. Within one section it is
  still last-write-wins.
- **A poll never clobbers an in-flight edit** — `pendingWrites` blocks adoption
  while a save is outstanding, and a poll is skipped entirely when the server
  revision hasn't changed.
- **localStorage is kept as an offline mirror** so the UI paints immediately on
  load, before the first server round-trip returns.
- **Failures are silent and non-destructive.** The API returns 200 with an
  `error` field rather than a status code, and the client keeps its local copy
  and retries on the next poll.

### Verified

Two independent browser contexts against one store: a line typed on A (with an
assignee) appeared on B after one poll, complete with the assignee pip; an
assignment made on A showed on B's Assignments panel; and an edit made on B
appeared back on A. Both directions, no errors.

### Known limits

Last-write-wins within a section. Two people editing the *same* Daily column at
the same time can overwrite each other — the per-day keying narrows this but
doesn't eliminate it. If that becomes a real problem, the fix is per-line
records rather than a per-day blob.

## Neon backend

`/api/state` picks its backend from env, preferring Neon:

| present | backend | shared |
|---|---|---|
| `DATABASE_URL` | Neon Postgres | yes |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Vercel KV | yes |
| neither | module memory | **no** — amber banner |

`GET /api/state` reports which one is live in its `backend` field.

### Setup

Vercel → Storage → Create Database → **Neon** → connect to this project. That
injects `DATABASE_URL`. Nothing else to do — the table is created on first use:

```sql
create table if not exists pl_state (
  key        text primary key,
  value      jsonb        not null,
  updated_at timestamptz  not null default now()
);
```

This adds the one dependency the project has, `@neondatabase/serverless`, which
Vercel installs on deploy.

### ⚠ jsonb cannot be cast straight to int

The revision counter lives in the same table as a bare jsonb number, and
`value::int` is a **syntax error** in Postgres. The increment uses
`(value #>> '{}')::int`, which extracts the scalar as text first. Worth knowing
before anyone "simplifies" that expression.

### Testing status

The backend selection, response shape and emitted SQL were verified against a
stubbed driver, and the KV and memory fallbacks were confirmed. **The Neon path
has not been run against a live Postgres** — there was none available in the
build environment. First deploy is the real test: open `/api/state` and confirm
`"backend":"neon"` and `"shared":true`, then type a Daily line and reload to
confirm it persists.

## High End — parameters and the LOADING hang

`buildParameters()` unconditionally sent `start_date`, `end_date` and `grain` on
every card. Question **3213 declares none of those**, so Metabase rejected the
run, the promise never resolved, and the tab sat on LOADING with an empty panel.

3213 declares `Single Date`, `Min Estimated Value Usd`, `Max Estimated Value
Usd`, `User Name`, `Vendor Name` and `Sport`. The route now sends:

| tier | params sent |
|---|---|
| $2,500 – $4,999 | `single_date`, `min=2500`, `max=4999` |
| $5,000 + | `single_date`, `min=5000` (max omitted, so the clause drops) |

**One calendar day, any time on it.** There is no shift window on this view —
unlike the throughput tabs, a comp at 2 AM and one at 11 PM both belong to the
same day. Filtering happens server-side, so the browser never sees rows it
would then discard.

The client no longer re-filters by date locally either. A second date check
would throw rows away whenever our timestamp parse disagreed with Metabase's
format — the tier check is cheap and safe, a date check on top of a
server-scoped query is not. Changing tier or date refetches.

The view also no longer waits on the network to draw itself:

- The shell (tier pills, date, KPIs) paints the moment the pill is clicked,
  showing **"Loading comps…"**.
- A failed load prints the reason **inside the panel** — a banner above the fold
  is easy to miss when the view itself just looks empty.
- The empty state distinguishes "nothing matched" from "nothing came back":
  *No comps in this tier for today. The query returned 13 rows for other days or
  tiers.* That difference is the first thing you need when a filter looks broken.

## High End — column layout

Twelve fixed columns so every row lines up:

`image · URL · sport · company · grade · set · player · parallel · est. value ·
last comp · change · user`

- **Est. value** green at 21px, **last comp** grey at 14px — the live number is what people scan for, so it outsizes everything else in the row.
- **Change** green when positive, **red** when negative. Red rather than amber:
  a price drop is different news from a warning.
- Sport carries a coloured dot plus the left border; user carries their
  Assignments colour.
- Set / player / parallel flex, everything else is fixed width. Below 1500px the
  columns tighten rather than wrap.

### ⚠ percent_change_from_last is a RATIO

Metabase *displays* that column as a percent, but the API returns **0.1 for
10%**. Rendering it directly gave `+0%` for a card that had moved +10% — visible
on screen and completely wrong.

It is now derived from the two values we already have:

```js
pct = (ev - last) / last * 100
```

Checked against Metabase's own rendering: 3050←3100 → −2%, 2850←2600 → +10%,
9775←865 → +1030%, 4980←5500 → −9%. All match. The raw column is only used when
there is no prior comp to derive from, and is scaled by 100 when it looks like a
ratio.

## High End — reviewed check

A check circle leads every row. Ticking it strikes the row through and drops it
to 45% opacity — the comp stays on screen but stops competing for attention,
same behaviour as a done line on Daily. The header shows `2 of 8 reviewed`.

**Shared across screens** via `/api/state` section `hedone`, so one person
working the list is visible to everyone else within a poll. Verified with two
browser contexts: ticking rows 1 and 3 on one machine produced `10100000` on
both, and unticking propagated back.

### Row identity

A comp has no id of its own, so the key is composite:

```
url | finished_at | player | set | parallel | ev | last_comp
```

The URL alone is **not** safe. If the query ever returns a shared or templated
link, every row ticks together — which is exactly what happened in testing when
all mock rows carried the same URL. The extra fields also separate genuine
near-duplicates: the live data has two Rome Odunze rows at the same $3,960 that
differ only in their previous comp value.

## Date defaults

| view | opens on |
|---|---|
| Cards, Recomp, Card Type, Review | **today** (`start_date = end_date = today`) |
| High End | **yesterday**, by design |

The global range used to default to the last 14 days, so every tab loaded two
weeks of history nobody asked for — the ops question is almost always "today".
Widen the range by hand for a trend.

High End is the deliberate exception: a day's comps aren't complete until the
day is over, so it opens on yesterday. The Yesterday / Today buttons switch it.

## Orders tab

Fifth top-level tab, after Review. Backed by:

```
'orders:all': { env: 'METABASE_ORDERS_CARD_ID', fallback: '35872' },
```

Question **35872**. The env var overrides it if the question is ever replaced.

Columns: `URL · number · status · customer · kind · due · category · in process ·
raw · pre-graded`, sorted by days in process, longest first. Status is a
coloured chip and sets the row's left border. Days is the large number, since
"how long has this been sitting" is the question the tab answers.

Sends no parameters — the card's filters are all optional, so the set is pulled
once and filtered in the browser.

### Categories

Canonical set (`ORDER_CATEGORIES`):

```
baseball · basketball · football · pokemon · one_piece · combat
dc · disney · hockey · marvel · soccer · star_wars
```

`cleanCategory()` strips a trailing tier token (`pN`) plus the separator it
leaves behind, then runs the rest through `canonSport()`:

| source | key | shown |
|---|---|---|
| `baseball - p3` | `baseball` | Baseball |
| `one piece` | `one_piece` | One Piece |
| `star wars - p3` | `star_wars` | Star Wars |
| `ufc - p2` | `combat` | Combat |
| `special - goat p1` | `special_goat` | Special Goat |

Only a **trailing** `pN` is stripped, so `special - goat p1` keeps "goat".
Anything outside the canonical list still renders (title-cased) and is appended
to the dropdown, so a new category shows up rather than vanishing. The raw value
stays in the cell's `title` for hover.

Labels and the colour dot come from the existing `sportLabel()` / `sportColor()`
helpers — already verified against a 290-row sample. A second lookup for the
same twelve values would only drift.

The dropdown lists them in canonical order, not alphabetically.

### ⚠ fillSelect was already taken

The file already had a `fillSelect()` for the sport/pack filters, further down.
Function declarations hoist, so the later one won and every Orders dropdown
rendered raw values (`one_piece` instead of "One Piece") while still filtering
correctly — a silent, display-only failure. The Orders version is now
`fillOrderSelect()`.

### Filters

Status is **multi-select**; Category and Kind are single. All three use the dashboard's own
`.filters` / `.fld` markup and run through `enhanceSelect()`, so they get the
same custom menu as the top bar rather than raw native selects.

Options come from the data that actually returned, so no selection ever yields
nothing. They compose, a choice survives a refresh when the value still exists,
and **Clear filters** resets all three.

**⚠ `syncLabel` only fired on click or on an options change.** Setting `.value`
in code — which is what Clear filters does — left the button showing the old
choice while the table underneath had already reset. `enhanceSelect` now also
listens for `change`, so a programmatic update resyncs the label. This affects
every enhanced select, not just Orders.

### The days column is in-process days

Header reads **In process** and each value carries a small `d` suffix; the KPI
is **Avg in process**. It was labelled "Days", which read like a date.

### ⚠ Panel placement

`#opanel` must be a **sibling** of `#panel-recomp`, not a child. It was nested
inside initially, and since the Orders tab hides `#panel-recomp`, the panel
rendered its 40 rows into a zero-height box — data present in the DOM, nothing
on screen. `panel-recomp` is a `<div>`, not a `<section>`.

## Order status colours

Specified by Alan, shared by Orders and — when it lands — Cards, so a status
reads the same wherever it appears. Defined once in `OSTATUS_COLOR`; the value
drives the chip text, the chip's tinted background and the row's left border.

| status | colour | hex |
|---|---|---|
| pending_grading | purple | `#A855F7` |
| pending_review | blue | `#38BDF8` |
| pending_release | orange | `#F5A524` |
| pending_rescan | dark red | `#CF5A5A` |
| pending_data_issue | red | `#FF4D4D` |
| pending_authentication | light pink | `#F9A8D4` |
| pending_rejection | medium pink | `#EC4899` |
| pending_scan | light green | `#86EFAC` |
| pending_customer_support | dark purple | `#8A6BE0` |

### The two "dark" shades are lighter than their names

A true dark red or dark purple is unreadable as 12px chip text on a `#0E141B`
panel. `#C64F4F` and `#7C5CD6` were tried first and measured 4.08 and 3.84
against the panel — below the 4.5 minimum for small text. They were lifted to
`#CF5A5A` and `#8A6BE0`, both 4.64, which is the darkest that stays legible.

All nine now clear 4.5. They remain clearly darker than their bright
counterparts — dark red vs red `#FF4D4D`, dark purple vs purple `#A855F7` —
which is the distinction that carries the meaning.

## Orders → Card Queue, Assignments, Team

The Orders tab now carries four pills: **Orders · Card Queue · Assignments · Team**.

```
'orders:queue': { env: 'METABASE_CARD_QUEUE_CARD_ID', fallback: '35905' },
```

Question **35905**. It declares an optional `order_number` filter, which the
proxy leaves blank — `orders:queue` sits in `NO_PARAMS`, so the whole queue is
pulled once and filtered in the browser, same as Orders.

### Card Queue

Card-level rows: card link, task link, task status, order number, order status,
due date, AC number, card status, pre-graded, category, and an **Assignee**
column immediately after pre-graded.

- **Per-row dropdown** assigns anyone. People who don't hold that category are
  still listed but marked `· no skill`, so a manual override is possible but
  never accidental.
- **Checkboxes + Bulk assign** for a selection. The prompt only offers people
  skilled in *every* category in that selection.
- **Auto-assign by skill** places every unassigned card in the current filter.
- Filters: category, card status, assignee (including **Unassigned**).

### Team — the skills model

Each roster member holds categories at **two tiers**: **primary** (their main
work) and **2nd skill** (they can cover it, but shouldn't be first pick).
Adrian, for example: primary One Piece / Pokemon / Disney / Marvel, second
Basketball.

#### The mode pills

Two pills sit directly under the name: **PRIMARY** and **2ND OPTION**, each
carrying its own count. They're sized larger than the category chips below,
because the chips are modal and the mode has to be readable in the same glance
as the thing it governs. The active pill is neon for primary, blue for 2nd; the
chip row picks up a matching top border, so the mode is legible from the row
itself and not only from the pill.

**The chip row is scoped to the active tier.** In 2nd Option mode the lit chips
are that person's 2nd options — their primaries are still saved, they're just
not what this row is showing. Switch back and they're all there. Showing both
tiers lit at once made the row look like it hadn't registered the mode change.

A category held in the *other* tier renders dim with a small `1st` / `2nd` tag
rather than as untouched. It has to: a category lives in exactly one tier, so
clicking it **moves** it, and an unmarked chip would make that look like a free
add.

Click a pill to arm a tier, then click categories to file them there:

- category not held -> added to the active tier
- category held in the *other* tier -> moved to the active tier, no need to
  clear it first
- category held in the *active* tier -> removed. The same click always undoes
  itself.

Mode is **per person** and lives in `teamMode`, which is local only. It's a
cursor position, not data — pushing it to `/api/state` would make one person's
mode jump on someone else's screen.

Tiers are told apart by fill, not hue, so the chip still reads as its category:
primary is filled with a solid border, 2nd is a dashed outline with almost no
fill plus a small `2` tag. The tag matters — border style alone is a weak cue
at wall-display distance.

The counts live on the pills, so there's no separate summary row.

#### Search

An input above the grid filters the roster. It reuses `graderMatches()` from
the Recomp grader filter, so "rod" finds Rodel and "jay sal" finds Jay-R
Salili. Escape or **Clear** resets. The count reads "N matches", or "no match
on the roster" in amber so an empty grid is explained rather than blank.

Note the matcher works on whole tokens: `Jay-R` normalises to two tokens, so
"jayr" finds nothing while "jay-r" and "jay" both work. Pre-existing behaviour,
shared with the grader filter.

#### Clearing skills

**Per person** — a `Clear` button appears in a card's header only when that
person actually has skills set; an always-present button on 58 idle cards is
noise. Armed like every other destructive control: first click reads
`Clear 3?`, second click empties both tiers. Each card keeps its own timer, so
arming one doesn't disturb another.

**Whole roster** — `Clear all skills` sits at the right of the search bar,
apart from the search controls and coloured warm rather than neutral. It's the
most destructive control on the page: with no skills set, auto-assign has
nothing to match on and stops placing cards entirely. So it names what it's
about to destroy (`Wipe 12 people? Click again`), and its banner says the
consequence out loud rather than reporting a bland success.

The button is disabled when nothing is set, rather than arming and then
reporting "no skills are set".

#### Storage shape and migration

`teamSkills[person]` is `{primary:[], secondary:[]}`. It used to be a flat
array. Other surfaces and older browsers can still write that shape at any
point in the session, so **every read goes through `normSkills()`** rather than
migrating once at boot — a poll can hand back a legacy record long after load.
A flat array becomes all-primary. A category appearing in both tiers resolves
to primary, keeping the two lists disjoint.

##### ⚠ Normalise once, in place

`skillRec()` repairs a record only when it isn't already canonical, and
canonical includes *disjointness*, not just field types.

Normalising unconditionally returned a **new object on every call**, which broke
every edit: the click handler does `var rec = skillRec(p)` and then calls
`tierOf(p, c)` on the next line — which calls `skillRec` again, replaces the
stored object, and leaves `rec` pointing at a detached copy. The pushes and
splices all landed on the orphan. Nothing threw; the chips simply never changed.
Caught by a unit test on the handler, not by reading it.

### Auto-assign

For each unassigned card in the current filter, it takes everyone whose skills
include that card's category and gives it to whoever has the **shortest queue**.
Least-loaded rather than round-robin, so it self-corrects when someone is
already carrying work from an earlier run.

**Tier gates the pool before load does.** Primary holders are considered first;
secondary holders only when *nobody* holds that category as primary. A primary
holder with six cards still beats an idle secondary — otherwise the tier would
be advisory only, and one busy day would quietly route everything to whoever
happened to be free. Verified: with a primary holder and an idle secondary, all
six pokemon cards went to the primary.

The banner reports the fallback separately from the skips: *"2 auto-assigned. 1
went to a second skill — nobody holds that category as primary."*

Bulk assign shows the two shortlists as separate blocks (`PRIMARY` /
`2ND SKILL`) rather than merging them, and the per-row dropdown marks people
`· 2nd` or `· no skill`.

Cards whose category nobody holds are **skipped and reported**, not silently
dropped: *"12 skipped — nobody has that category as a skill."* Running it with
no skills set says so plainly rather than appearing to do nothing.

### Assignments

Groups assigned cards by **person** or by **category** — a Group by dropdown
switches. Person view shows each queue with the order number and category;
category view shows who holds each card. Idle team members stay visible.

### ⚠ Only adopt a strictly newer revision

`pullState` used to adopt whenever `d.rev !== stateRev`. A server returning a
*lower* rev — a reset store, a stale replica — would then overwrite work this
browser had already saved. Caught in testing: 70 auto-assigned cards vanished on
the next 10-second poll. It now adopts only when `d.rev > stateRev`.

## ⚠ Fixed: three localStorage mirrors never worked

`heDone`, `teamSkills` and `cardAssign` were loaded from localStorage around
line 1875, but declared with `var` some 1,600 lines further down. `var` hoists
the *name*, not the assignment — so the load ran, and then
`var teamSkills = {}` executed later and reset it to empty.

The offline mirror for those three was dead. Only the server pull restored
them, so the UI painted blank until the first round-trip and stayed blank
whenever `/api/state` was unreachable — which reads as "my skills didn't save"
rather than as a sync failure.

They now load at their declarations via `loadLocal(key)`. `zAssign` and
`zSnooze` were never affected; both are declared before they load.

This is the same class of bug as the `DAILY_COLS` hoisting failure noted above.
Worth checking the pattern before adding a fourth store.

## Order # filter (Orders and Card Queue)

First control in both filter rows. **Substring, not prefix or exact**: order
numbers get read off a screen or a packing slip, and the digits people actually
remember are usually the tail — so "2522" finds 17622522. Non-digits are
stripped from the query, so a pasted `#17622522` or `order 17622522` still
matches, and a query of only punctuation behaves as empty rather than matching
nothing.

Filters as you type (the selects beside it only fire on change). Escape clears
it, as does **Clear filters**. The border turns neon while it holds a value —
a filter that silently hides 219 of 220 rows has to be visible from across the
room.

Note substring means `2522` also matches `17252200`. That's intended; use more
digits to narrow.

### Empty results say WHICH filter emptied them

"No orders match these filters" is the least useful half of the message. When a
filtered view comes back empty, `emptyReason()` re-runs the set with each filter
dropped in turn and reports what it finds:

- **A filter that matches nothing at all** → *"order # 16568979 matches nothing
  in this data."* Checked **first**: a dead filter also brings rows back when
  removed, so it would otherwise be reported as an ordinary culprit — true, but
  the wrong news.
- **One filter is uniquely to blame** → *"Nothing matches once category is
  applied — clear it and 1 row comes back."*
- **Several filters each hide what the others keep** → named, with no false
  claim that clearing one fixes it.

Applies to both Orders and Card Queue.

## Select 5 / 10 -> choose a person -> Bulk assign

The Card Queue filter row now carries **Select 5 · 10 · None**, an **Assign to**
dropdown, and the existing **Bulk assign** button, in that order.

`pickN()` takes the first N **unassigned** cards in the current filter, in
display order. Unassigned rather than "first N rows": picking cards that already
carry a name means the next assign quietly overwrites someone else's work.

It **adds** to the selection rather than replacing it, so 5 then 5 gives 10. If
fewer than N remain it takes what it can and says so, rather than silently
under-picking; if none remain it explains whether that's because everything is
assigned or because the filter is empty.

### Why the ticks aren't always the first five rows

Because it skips assigned cards, the picks are frequently **non-contiguous** —
rows 1, 5, 6, 7, 8 rather than 1-5 — and some can sit below the fold. With only
a 16px checkbox marking them, that reads as "the button half-worked". Three
things address it:

- Selected rows carry a **full-row highlight** (`.qrow.sel`), visible without
  hunting for checkboxes.
- The first pick is **scrolled into view**, so an entirely off-screen selection
  can't look like nothing happened.
- The banner **names the skips**: *"Picked 5 — skipped 3 already-assigned cards
  along the way."*

A running `N selected` count sits beside the Select buttons. That total used to
live in the panel heading, which was removed; the Bulk assign label alone is
easy to miss at the far end of the row.

The pick buttons carry `user-select:none` — they get clicked repeatedly, and
without it a fast second click selects the label text instead of firing.

### The Assign to combobox

**Typeable.** A real `<input>`, not a `<select>` — so text editing, mobile
keyboards and selection all behave normally, and `enhanceSelect` (which only
grabs `.filters select`) leaves it alone. Type to filter with the same matcher
as everywhere else, arrow keys to move, Enter takes the top match, Escape closes
then clears, blur snaps back to the confirmed pick so half-typed text can't
strand the box.

The menu is bound on **mousedown, not click** — blur fires first on click and
would close the menu before the button ever saw the event.

#### ⚠ Coverage, not all-or-nothing

The old rule required a person to hold **every** category in the selection or
they were labelled "no skill". Select 5 cards spanning marvel, hockey and soccer
and that tagged the *entire roster* unskilled — both useless and false, since
most of them can take most of the cards.

Coverage is a count instead, so it degrades sensibly:

| selection | label |
|---|---|
| one category | `primary` / `2nd option` / `no skill` |
| all covered, all primary | `primary · all 3` |
| all covered, mixed tiers | `covers all 3` |
| some covered | `covers 2/3` |
| none | `no skill` |

Sorted by coverage desc, then primaries ahead of second options at equal
coverage, then least-loaded, then alphabetical. Coverage never yields to load: a
fully-skilled person with nine cards still outranks an idle one who can't do the
work.

A zero-length category list is guarded explicitly — without it `pri === total`
is `0 === 0` and the whole roster gets tagged `primary · all 0`, which is
confidently wrong rather than merely unhelpful.

Picking someone not skilled for the selection is **allowed but flagged** — the
banner reads *"Assigned 5 cards to Dee. 4 outside their skills."* in the error
colour. The queue still has to clear on a short-staffed day, and a silent
mismatch is worse than an explicit one.

Leaving the dropdown on the placeholder and clicking Bulk assign falls back to
the old typed prompt, so that path still works.

#### Three things the enhanced-select wrapper forced

`enhanceSelect()` replaces every `.filters select` with a custom button and
menu, which constrains anything built dynamically:

1. **No `<optgroup>`.** The menu builder walks `sel.options`, which flattens
   groups and drops their labels — the grouping would vanish from the only
   dropdown users actually see. The tier goes in each option's text instead.
2. **Style the button, not the select.** `.csel select` is `opacity:0` and
   zero-sized, so the armed state is `.csel.armed .cselbtn`.
3. **Don't set `disabled` on the select.** The visible control is the button,
   which stays clickable regardless. The wrapper gets an `armed` class and the
   placeholder option carries the message.

A `MutationObserver` on `childList` already rebuilds the menu when options are
repopulated, so rewriting `innerHTML` is safe.

## Due dates render like Metabase

`2026-07-06` shows as **Jul 6, 2026**, matching the question's own rendering.

`fmtDue()` parses the string **by hand** rather than via `new Date(str)`. A bare
`YYYY-MM-DD` is parsed as UTC midnight and then printed in local time, so
anywhere west of Greenwich every date lands a day early — on a Pacific wall
display "due Jul 6" silently becomes "Jul 5" for the entire table. There's a
test asserting the naive approach really does shift it and that `fmtDue`
doesn't.

Anything that isn't a plain ISO date passes through untouched (including month
`00` or `13`), because a mangled date is worse than an unstyled one. The stored
value stays ISO — only the display changes — which is what lets date sorting
stay a plain string compare.

## Sortable columns (Orders and Card Queue)

Click any header to sort; click it again to flip. Arrow keys work too
(`role="button"`, Enter/Space).

**One metadata list drives both the header and the comparator** (`OCOLS`,
`QCOLS`), so a header can't end up sorting by a different field than it names.
Each column declares a `type`:

- `num` — real numbers
- `numstr` — numeric strings like order numbers, because a text sort puts `9`
  after `17622522`
- `date` — ISO strings, which compare correctly as text
- `text` — everything else, compared with `numeric:true` collation

Three behaviours worth keeping:

- **Missing values sink in both directions.** Flipping to find the oldest due
  date shouldn't surface a wall of blanks first. Zero is a value, not a blank.
- **A new column starts in the direction that's useful first** — biggest for
  numbers, earliest for dates, A-Z for text. Re-clicking the active column
  flips it.
- **`sortRows` copies before sorting.** For the queue, the array it's handed is
  the live `qRows`; sorting in place would reorder the underlying data.

**Both tables now open sorted by due date, oldest first** — the queue is worked
in due order, so the row to pick up next is at the top. Orders previously opened
on days-in-process descending, which answers a different question ("what is most
stuck") and is still one header click away. The arrow is always present so columns don't
shift width when the active one changes — it just dims when inactive.

The queue's select-all checkbox now lives in `QCOLS` as a `raw` cell rather than
being spliced into the generated header with a string replace, which would have
broken the moment a column's styling changed.

## ⚠ The Orders grid had one track too many

`--ocols` declared **eleven** tracks for **ten** columns. Every cell from "in
process" rightward sat in the wrong track, and Pre-graded landed in the 74px
meant for Raw — which is why its header wrapped onto two lines. Both the wide
and narrow declarations were wrong.

There's now a test that parses `OCOLS`/`QCOLS`, counts the cells the row
actually emits, counts the tracks in *every* `--ocols`/`--qcols` declaration
including the media-query overrides, and fails if the three disagree. This class
of bug is invisible in a syntax check and easy to miss by eye — the table still
renders, just misaligned.

## In-process days on the Card Queue

The queue question doesn't carry `in_process_days`; it's on the order question.
The Card Queue now uses the same cached `order -> days` lookup the Assignments
panel does (`ensureOrderDays`, 5-minute cache), and the column is sortable via a
`__ipd` synthetic key.

A dash means the join hasn't landed or failed, **not** zero days — same rule and
same severity colours as the Orders table.

## "Grey" row text was never grey

Both tables already set `color:#FFFFFF` with no dimming rule anywhere — sampling
the screenshots confirms peak text pixels at **250 and 255**. What reads as grey
is **stroke antialiasing**: at `font-weight:400` most pixels of a thin glyph are
partial coverage (~rgb(170)) and only the stroke centre reaches white, so a row
looks grey next to a bold order number.

Changing the colour would have been a literal no-op. The fix is weight:
`.orow`, `.qrow` and `.acell` now carry `font-weight:500` with an explicit
`color:var(--tx)`, and row links went to 500 too so they aren't the thin ones
instead. Row font sizes went up half a step (14.5 / 14px).

The `.z` zero state keeps its dimming on purpose — a zero is an absence, not a
value competing for attention.

### Same fix on the Team page

Skill chips had `opacity:.78` on top of 12.5px/400 text, which lands around
rgb(150). They're now `opacity:1`, 13px, weight 500.

**Set vs unset survives without dimming**: a selected chip carries a coloured
border *and* a fill, and an other-tier chip carries a coloured border plus its
`1st`/`2nd` tag. That was always a stronger signal than faded text — the fade
was doing nothing except making the label hard to read. Hover now shifts the
border instead of the opacity.

Also lifted: the mode pills (`.6` -> `.85`, weight 500), the per-person Clear
button (`.4` -> `.7`), and the tier tag (9.5px -> 10.5px at weight 600).

**Three inline `opacity:.5` dims** were hiding from the stylesheet — the "idle"
count on Team cards, the "no cards" count on Assignments cards, and the same on
the zone panel. All three now stay secondary by *colour and size* rather than by
fading the glyphs. A test asserts none are left.

## Table headers

`.ohead`, `.qhead` and `.hhead` all moved from 10.5px to 12.5px with tighter
letter-spacing, and stay at one shared level across the three tabs.

## Orders table — days-in-process severity

`In process` carries a colour band instead of being one more grey number, so
the eye lands on the worst rows without reading any of them:

| days | class | colour |
|---|---|---|
| < 7 | `d-ok` | normal text |
| 7-13 | `d-warn` | amber |
| 14-29 | `d-bad` | red |
| 30+ | `d-crit` | red, semibold |

**7 is the same line the `7+ DAYS` KPI draws**, so the number above the table
and the colours inside it can't disagree — there's a test asserting the KPI
count equals the coloured-row count. 14 and 30 split what's left: with a 28-day
average almost every row clears 7, and a single red would colour the whole
screen and say nothing.

`null` days render blank and uncoloured; `0` is a real value, not a missing one.

## Orders / Card Queue — headings removed

The `<h2>Orders — 140 of 140 orders` and `<h2>Card queue — 220 of 220 cards`
lines are gone. Both counts duplicated the KPI card directly beneath them
(`ORDERS 140 all`, `CARDS 220 all`), and the subtab pill above already names
the panel. The Card Queue hint also carried "N selected", which still shows on
the Bulk assign button ("Bulk assign 5"), so nothing was lost.

Two things this needed beyond deleting the markup:

- **Guard the writers.** `$()` is `getElementById`, which returns `null`, so
  `$("ohint").textContent = …` would throw and abort the whole render. Both
  writes are now `if($("ohint"))`, left in place rather than deleted so the
  heading can be restored by putting the markup back with no JS change.
- **Replace the spacing.** There is no `.panel` CSS rule at all — `class="panel"`
  is unstyled — and `.subtabs` has `padding-bottom:0` while `.ofilters` zeroes
  its own padding. The `<h2>` was the only thing holding the filter row off the
  pills. `.ofilters` now carries `margin:18px 0 16px`.

Assignments and Team still have their headings, so the four Orders subtabs are
no longer consistent with each other.

## Category colours

One map (`SPORT_COLORS` -> `sportColor()`) drives category colour on **every**
surface — Assignments rows, the Card Queue table, the Team skill chips, the
per-card picker and both modals all call it, so a change lands everywhere at
once.

| category | colour | |
|---|---|---|
| baseball | blue | `#1E88E5` |
| basketball | orange | `#F5822A` |
| football | brown | `#8B5A2B` |
| pokemon | yellow | `#FFD84D` |
| one piece | grey | `#9CA3AF` |
| soccer | sky blue | `#8ED8FF` |
| disney | purple | `#A855F7` |
| marvel | red | `#E23636` |

### The unspecified ones

Chosen for semantic fit, then measured:

| category | colour | why |
|---|---|---|
| hockey | ice cyan `#22D3EE` | reads as ice |
| dc | indigo `#4338CA` | DC is blue, but blue sits between baseball and soccer |
| star wars | green `#4ADE80` | lightsaber; grey went to one piece |
| combat / ufc | deep crimson `#9F1239` | fight-sport red, kept much darker than marvel |
| wrestling | teal green `#14B8A6` | |
| yu-gi-oh | magenta `#E879F9` | |
| multi sports | dark slate `#64748B` | not one piece grey |
| grail | gold `#FACC15` | |

Blue and sky blue are the same hue by definition, so **baseball and soccer are
separated by lightness** (`l=0.51` vs `l=0.78`) rather than hue.

### Every pair is distance-checked

A test measures hue, lightness *and* saturation distance between every distinct
colour in the map — not hue alone, since two blues differing only in lightness
are still tellable apart. It caught four collisions that would otherwise have
shipped:

- baseball vs soccer, 1 degree apart
- marvel red vs the first combat pink, 19 apart
- basketball orange vs the first wrestling amber, 8 apart
- disney purple vs the first yu-gi-oh violet, 18 apart

Closest surviving pair is baseball vs hockey at 20. `combat` and `ufc` share a
colour deliberately — they're the same thing.

Unselected Team chips moved from `opacity:.55` to `.78`: the lower value dimmed
the category dot along with the chip and made the colours hard to read.

## Raw = blue, pre-graded = purple

One colour pair for this distinction everywhere it appears:

| | colour | var |
|---|---|---|
| Raw | `#38BDF8` blue | `--raw` |
| Pre-graded | `#8B5CF6` purple | `--pre` |

**These are not new colours.** The Review tab already drew exactly this
distinction in exactly these two values (`REVIEW_RAW_COLOR` /
`REVIEW_PREGRADED_COLOR`); they're now promoted to CSS vars so Orders, Card
Queue and Cards reuse the same convention instead of inventing a second one.

Applied to:

- **Orders** — the Raw and Pre-graded columns and their headers, plus both
  halves of the `RAW / PRE-GRADED` KPI (`kpiHTML` injects `v` as HTML, so the
  two numbers carry their own colours around a dimmed slash).
- **Card Queue** — the Pre-graded column reads yes/no, so it carries *both*
  colours: purple for yes, blue for no. It previously used neon green for yes,
  which collided with the "selected" meaning green carries elsewhere.
- **Cards** — the `Raw / shift` and `Pre-graded / shift` KPIs.

A zero gets `.z` (plain text at 35%) rather than the full colour: a zero is an
absence, not a quantity, and colouring it as loudly as a real count makes empty
columns compete with full ones. Nulls render blank and also carry `.z`.

### What was deliberately left alone

The Cards tab's **group cards** (`renderGroups`) already use a per-source pair —
each source's own colour for raw and a darker variant for pre-graded
(`cust`/`cust2`, `slab`/`slab2`). Recolouring those to blue/purple would make
every source look identical and erase the distinction those cards exist to
draw. The aggregate KPIs above them are safe to recolour because they're summed
across sources.

## Contrast pass

- Table headers (`.ohead`, `.qhead`, `.hhead`) moved from `opacity:.55` to
  `.8` and now share one level across all three tabs.
- `.o-num`, `.o-raw`, `.o-pre` lost their `opacity:.8` — they're data, and there
  was no hierarchy reason for them to be dimmer than the row they sit in.
- The Order # placeholder is styled explicitly (`var(--tx)` at `.5`) rather
  than left to the browser's mid-grey, which was the lowest-contrast text on
  the page.
- Inactive tab labels keep their `.55` — that dimming is what marks the
  selected tab, so lifting it would cost more than it gained.

## Filter row spacing

Labels sat 5px above their controls with 14px between columns, so the headers
read as one run of text rather than as captions. Now 9px below the label and
20px between columns — more gap below a label than between the words in it, and
more between columns than within one.

## Assignments — find a team member

A **Find** box sits first in the Assignments filter row, before Group by. Same
matcher as the Team and grader filters (`graderMatches`), so "rod" finds Rodel
and "jay sal" finds Jay-R Salili. Filters as you type; Escape clears it.

**The search is always about a person, whichever grouping is showing.** Grouped
by person it matches the card's own name. Grouped by category it keeps the
categories that person actually has cards in — "what is Bea working on?" is the
question worth asking there, and matching a category name nobody typed would be
a different feature. Typing "marvel" therefore matches nothing; that's
deliberate.

The hint reports `2 of 4 categories match "abagael"` or `nobody matches "zzz"`,
and a no-match search renders an explicit empty state rather than an empty grid,
which would read as a broken panel.

## Per-card Assign button

The Assignee column is a **button**, not a `<select>`. With 58 people a native
dropdown is a scroll-hunt: no search, no skill tier, no way to see who is
already buried. The button shows the current assignee (or `Assign…`, or
`Assign · no skill match` when nobody holds the category) and opens the same
ranked, typeable picker the bulk control uses, scoped to that one card.

The picker shows the card's AC number, category, status and player at the top,
then every roster member ordered **primary -> 2nd option -> no skill**, and
least-loaded first inside each tier, with each person's current queue size.
Type to filter, arrows to move, Enter takes the top match, Escape or the
backdrop closes.

When the card is already assigned, an **Unassign — currently X** row sits at the
top of the list, and the current person is highlighted.

A category nobody holds still lists everyone, all tagged `no skill` — assigning
is allowed but flagged, because the queue still has to clear on a short-staffed
day. Opening the picker with a stale card key closes cleanly instead of showing
a blank dialog.

## Names are data, not controls

The base `button` rule sets `text-transform:uppercase`, which is right for
controls and wrong for names. The Assign to options, the per-card assign button
and the picker rows are all `<button>`s, so every roster name rendered as
`ABRAHAM SALISI`.

Those three now opt out (`text-transform:none`, no letter-spacing, normal
weight) and sit at 15px rather than 13.5px. A name renders as it was typed.

## Name typeahead on all three search boxes

`attachNameSuggest(inputId, render)` wraps an existing text input and adds a
suggestion menu: type to filter, arrows to move, Enter to take the highlighted
name, Escape to close, click to pick. Each entry shows the person's avatar and
current queue size.

Attached to **Assignments → Find** and **Team → Search**, so all three name
fields behave the same way instead of only the Assign to combobox.

Details worth keeping:

- It's **additive**. The input still works as free-text filtering if the menu
  never opens; nothing about the existing behaviour changed.
- The list is **capped at 12** — 58 names would run off the screen.
- Bound on **mousedown**, not click: blur fires first and would close the menu
  before the option saw the event.
- An `_suggest` flag makes a second attach a no-op, and both call sites sit
  inside `bindQueue()` which is already `.done`-guarded.
- Team search's own Escape handler now checks `defaultPrevented`, so Escape
  closes the menu first and only clears the box on a second press.

## Focus mode — clicking a name

Clicking a group name on Assignments **filters to that person in place**: it
fills the Find box and re-renders. When the filter leaves exactly one group, the
card goes full width and lists **every** card rather than the first 8, with the
full row detail and a per-row `×` to unassign.

That replaces the modal as the primary path — one view instead of two showing
the same thing differently. The modal is still reachable from the **avatar**,
for when you want it floating over the grid.

The per-row `×` only appears in focus mode: in the grid the cards are too narrow
to carry another control without squeezing the order number out.

`.agrid.focus` switches to a single column. Without it the grid's
`auto-fit, minmax(360px, 1fr)` would keep the focused card at 360px and defeat
the point.

## Idle people are hidden by default

54 empty "no cards" tiles push the handful that matter off the screen. Idle
people are now hidden unless you toggle **Show idle**, and the hint says
`· idle hidden` so the roster doesn't look like it shrank.

The filter is skipped while searching: if you typed a name you want that card
whether or not they're currently holding anything.

## Assignment card rows

Each row is **one line, five columns**, with a header above the list:

```
URL        ORDER       CATEGORY                 DUE     IN PROC
Click Me   17938811    ● Pokemon        Aug 6, 2024         41d
```

The row and the header share **one grid template**, so labels stay over their
columns at every card width instead of drifting as the card resizes. A unit test
counts the grid children on both and fails if they diverge — a mismatch there
silently shifts every column right of it.

`78px 108px minmax(120px,190px) 1fr 58px`. The first three tracks are fixed and
narrow so URL, Order and Category pack against the left edge and read as one
group. The `1fr` sits on **Due**, which pushes Due and In proc to the right
where a date and an age belong. An earlier version put the `1fr` first, which
stretched the order cell and shoved everything else into the middle of the card.

Order number sits at 17px in full white with tabular figures — it's what gets
cross-referenced against Metabase, and a column of them lines up.

**No dimmed data.** Order, URL, category, due and days are all things people
read off the screen, so none of them carry reduced opacity; the header sits at
85% rather than 60%. The only faded things left in these rows are *absences* —
`no task`, `no cards`, `+ N more` — which aren't data.

**No player name.** It isn't guaranteed to come back from the queue question, so
it's gone from the row rather than rendering an empty cell.

The person modal used `r.player || "—"`, which would have put a bare dash where
a name used to be on every row. It now leads with `Order <number>` when the
player is absent, and drops the now-redundant `order N ·` prefix from the meta
line beneath it. With a player name present, nothing changed.

**Click Me** is a plain blue link, no button chrome. It repeats on every row and
a border on each turns the card into a wall of boxes.

Rows that aren't data — `no cards`, `+ N more` — span the row instead of using
the grid.

#### ⚠ These columns are `ac-` prefixed, not `c-`

High End already owns `.c-player`, `.c-set`, `.c-ev` and friends as **global**
classes, including a `.hrow2.done .c-player{text-decoration:line-through}` rule.
A bare `.c-player` here would have inherited the strikethrough whenever a High
End row was marked done — a bug that only shows up on a different tab, after an
unrelated action.

### Ordered by due date

Cards in an assignment card, and in the person modal, are sorted **oldest due
date first** — a queue is worked in due order, so the row to pick up next is at
the top. This also means the `+ N more` cut keeps the 8 most urgent rather than
whatever the question happened to return first.

Undated rows **sink to the bottom**. Sorting `""` as an ordinary string would
put them first, ahead of everything genuinely overdue, which is exactly backwards.

ISO strings compare correctly as text, so there's no parsing and no timezone to
get wrong — the same reason the table's `date` sort type needs no `Date` object.

`cardsFor()` sorts its own result and `groups[n]` is sliced before sorting, so
`qRows` is never reordered underneath the rest of the app.

### Days-in-process needs a join

`in_process_days` is on the **order** question (35872), not the card queue
(35905). The Assignments panel fetches the order list once and caches
`order number -> days` for 5 minutes — well inside how fast a day-counter
moves, and it stops a wall display refetching on every poll.

A row shows `—` when the join hasn't landed or failed, **not** `0d`: "not
loaded" and "zero days" are different facts and shouldn't look the same. The
dash carries no severity colour for the same reason. A failed join leaves the
rows rendering normally with dashes in that column rather than blanking the
panel.

The severity bands are the same `daysClass()` the Orders table uses, so a card
that's red there is red here.

## Breakdown pill

A fifth Orders subtab. Two views of one number:

- **Category totals** across the top, as bars — pokemon 500, basketball 456,
  baseball 345. Bars scale to the *biggest category*, not to the grand total:
  with a dozen categories, scaling to the total makes every bar a sliver.
- **A team table** below, sorted most-to-least, each row showing rank, name,
  a chip per category they worked with its own count, and their total.

Both come from one `completedTotals()` call, so the two halves can never
disagree about what the numbers are. There's a test asserting the category
totals and the person totals both sum to the same grand total.

### What counts as "done"

**Opening a card's Click Me card-type link.** That's the signal already used to
take a card off someone's queue, so counting it costs no extra interaction.

The manual `×` unassign does **not** count — it's a reassignment, not work
completed, and counting it would let anyone inflate a tally by shuffling cards.
**Undo decrements**, so a misclick doesn't permanently credit someone for work
they didn't do.

Counts never go below zero, and a person whose count reaches zero drops off the
table rather than sitting there as a `0` row.

### Storage

`completed = {by: {person: {category: n}}, since: "YYYY-MM-DD"}` in a new shared
`completed` state section. Nested rather than flat because both breakdowns fall
out of one structure — sum a row for a person's total, sum a column for a
category's.

It is **cumulative** and does *not* clear at the 22:00 Manila rollover; that
resets assignments, which is a different thing from a tally of work done. The
header shows what it's counting since, and **Reset counts** (armed, like every
destructive control) restamps it to today.

### ⚠ Also fixed: a dead button

The focus-mode per-row `×` on assignment cards rendered but had **no handler at
all** — clicking it did nothing. Found while tracing which paths needed to feed
the tally. It now unassigns with an undo, and correctly does not count as a
completion.

## Person modal — the AC numbers in a queue

Clicking a name (or a category) on the Assignments pill opens a modal listing
that queue's cards. **AC number leads each row** — it's the number read off the
slab, and the reason for opening the thing — followed by player, then a meta
line of order, category, card status, card-type status and due date, then two
links and a `×` to unassign that one card.

**Card** goes to the card; **Card type** goes to the card-type task. Two
different destinations, so they carry different colours rather than sitting
there as two identical blue links. Either is omitted when the row has no URL
for it. The card-type task's own status shows in the meta line as
`type: pending`, so you don't have to open the link to find out. The full task
URL is the link's `title`, so it's visible on hover and copyable by right-click
without a 60-character link wrapping the row.

### Opening the card-type task removes the card

Clicking **Card type** opens the task *and* takes the card off that person's
queue — opening it means they're working it. The click is not
`preventDefault`ed, so the link still opens in its new tab; the removal happens
alongside.

That's a destructive side effect on a link, so it comes with a **one-step
undo**: an amber strip appears at the top of the list naming the AC number, with
an Undo button. Without it a misclick silently costs someone their card and
there is no way back — the assignment is gone from shared state the moment it
saves. The `×` button uses the same path and gets the same undo, minus the
"card-type task opened" wording.

The undo offer belongs to the queue it was made in. Opening a different person's
list clears it, so you can't undo into a card you never touched.

Text throughout the modal is sized up: AC number 20px, player 17px, meta 14.5px,
links 14.5px.

### ⚠ The link never rendered at all

The modal checked `r.url`. That's the **Orders** row shape; queue rows carry
`cardUrl` and `taskUrl`, so the condition was always false and no link was ever
drawn. Nothing errored — the element just silently wasn't there.

The modal was also printing raw ISO due dates (`due 2024-08-05`) while both
tables showed `Aug 5, 2024`. It runs through `fmtDue` now.

Keyboard-reachable (`role="button"`, Enter/Space), closes on `×`, backdrop
click or Escape. Unassigning repaints the modal in place so the list doesn't
vanish under the cursor.

It lists only cards still present in `qRows`: an assignment whose card has left
the queue is finished work, not a row.

## Auto-clearing finished cards

After a successful Card Queue load, `pruneFinished()` drops any assignment whose
card no longer comes back from the queue question — the card is done, so the
person's count falls on its own.

This deletes shared state that other screens can see, so it has two hard guards:

- **Only after a load that succeeded.** An errored or aborted load leaves
  `qRows` empty or stale, and pruning against that wipes the board.
- **Only when the queue returned rows.** A question that legitimately returns
  zero is indistinguishable here from one that broke, and the cost of guessing
  wrong is every queue at once.

This also fixes a quieter bug: `queueSizeOf()` counts `cardAssign` without
checking the queue, so finished cards were inflating everyone's counts. The
Assignments cards hid this (they filter by `qRows`), but the Team pill and
auto-assign's least-loaded ordering both used the inflated number.

### ⚠ Prune matches identity, not `cardKey`

`cardKey` is `order|ac|cardStatus`. A card moving `pending_data` ->
`pending_verify` therefore gets a **new key**, and pruning on the full key would
read that as finished and delete the assignment of a card still sitting in the
queue. `cardIdent()` (`order|ac`) is used instead — identity is the card, not
the stage it's at.

The related issue is NOT fixed: assignments are still *stored* under the
status-bearing key, so when a card advances a stage it appears unassigned in the
queue while the old assignment lingers under the old key. Prune no longer
deletes it, but it doesn't follow the card either. Fixing that means changing
`cardKey` to `order|ac` and migrating existing shared state.

## Daily reset — 22:00 Manila

Card assignments belong to one work day and clear when the next one starts.

**The boundary is 22:00 in Asia/Manila, not local midnight.** The PL floor is in
the Philippines; a reset keyed to the viewer's clock would fire at a different
moment on every screen, and the Portland wall display would clear the Manila
team's board mid-shift.

`CLEAR_TZ` and `CLEAR_HOUR_MNL` are the whole behaviour — moving the rollover
means changing those two and nothing else.

`assignDayKey()` returns the work day a moment belongs to. Subtracting the
boundary hour means 21:59 Manila is still the previous day and 22:00 starts the
next, so comparisons are a plain string compare. Date and hour come from a
single `formatToParts` call on the same instant, so the two can't disagree
across a boundary.

The stamp lives in shared state as a new `assignday` section, so all screens
agree on which day is current and only the first one to notice does the
clearing.

### Guards

Same class of hazard as `pruneFinished` — it deletes shared state nobody clicked
a button for:

- **A stamp we've never seen is recorded, not acted on.** A fresh browser must
  not wipe a board just because it has nothing to compare against.
- **It only moves forward.** A stale replica returning an older day must not
  read as a rollover; a *newer* one must not either.
- Clearing an already-empty board is silent — no banner, no write.
- Repeated calls are idempotent, which matters because it runs both after every
  queue load and on a 60s timer (a wall display can sit untouched across the
  boundary, so a load-only check would miss it).

When it does fire: *"New work day in Manila — cleared 12 card assignments from
the previous day."*

### Manual clear is independent

**Clear all assignments** (and the per-group `×`, and the per-card unassign)
stay available at any time and do **not** touch the day stamp. The 22:00
boundary owns the day, not the button:

- Clearing manually at 3pm doesn't "use up" the day. Cards assigned afterwards
  are still cleared at 22:00.
- Auto-clear on an already-empty board is silent — no second banner — but the
  stamp still advances so it doesn't retry every minute for the rest of the day.

Both paths write to shared state, so either one propagates to every screen.

Verified across the 21:59/22:00 boundary, month end, year end, a leap day, and
from a non-Manila viewer timezone.

## Clearing assignments

**Clear all assignments** sits next to Group by on the Assignments pill, and
each group card carries a `×` to unassign just that person or category. Auto-
assign fills the board in one click, so starting over had to be one click too —
otherwise it's 191 dropdown changes on the Card Queue.

### ⚠ window.confirm() is why this looked broken

`Clear all assignments` did nothing when clicked. The handler was bound and
firing — but **`window.confirm()` returns `false`, silently, inside a sandboxed
iframe without `allow-modals`**, which is how the demo build and any embedded
view run. The guard bailed on every click and nothing changed on screen. Same
family as the `new URL()` failure in the mock: the API doesn't throw, it just
quietly reports "no".

All four blocking dialogs are gone. Destructive buttons now **arm**: first click
swaps the label to `Clear 191? Click again` and turns the button amber, second
click within 4s runs it, no second click and it disarms itself. No modal, so it
works everywhere — and it's faster than a dialog for something done often.

`armAction(btn, label, fn)` / `disarmAction(btn)` handle this. Each button keeps
its own timer, so arming one group's `×` doesn't disturb another's. Clearing an
already-empty Daily board skips the arming step — there's nothing to lose.

The Bulk assign `prompt()` fallback is gone for the same reason. If no one is
picked in **Assign to**, the button now says so and focuses that dropdown
instead of opening a dialog that may never appear.

Both clear paths clear **only assignments whose card is still
in the loaded queue**. Wiping `cardAssign` wholesale would also discard
assignments for cards outside the current filter window — someone else's work,
invisible from this screen. The confirm counts live keys for the same reason.

## Multi-select status filters

Status is the one filter people genuinely want to combine — "everything except
released", "grading plus rescan" — so Orders **Status** and Card Queue **Card
status** use a checkbox dropdown instead of a single-choice select.

`msel(id, {label, color, onchange})` builds one; `mselValues()` repopulates it
from the data; `mselSelected()` returns the chosen values. An **empty selection
means All**, which reads better than forcing every option on by default.

- The button shows the single choice by name, or `N selected` with a count chip.
- Each option carries its status colour in the tick box.
- **The menu stays open while you pick** — closing after each click would make
  choosing three statuses a three-trip job. Click elsewhere or press Escape to
  close.
- Selections that no longer exist in refreshed data are dropped silently.

The app's own `enhanceSelect` is single-choice only, so this is a separate
component rather than an extension of it. Category, Kind and Assignee still use
`enhanceSelect`, since picking one value is the right interaction there.

## Two rosters

| roster | size | used by |
|---|---|---|
| `RECOMP_ROSTER` | 17 | Recomp grader filter, Hot/Cold Zone assign modal, Daily line assignees, Recomp Assignments |
| `ORDERS_ROSTER` | 58 | Orders → Card Queue assignee, Team skills, Card Assignments, bulk/auto assign |

They overlap on three names only: Anjello Bumanglag, Charles Pellas, Raquel
Valdecantos. (Benedict Bueno is *not* an overlap — the recomp roster has Ian
Benedict Banua, a different person.)

`PERSON_INDEX` is built from **both** rosters concatenated, deduped, so all 58
Orders names get their own spaced hue rather than falling back to the hash and
colliding. Verified: 58 unique avatar colours across 58 people. `PERSON_SLOTS`
replaces the old `RECOMP_ROSTER.length` so the hue spacing matches the real
total.

### ⚠ Four names to confirm

Read off a bar chart where the labels were cramped: **Ian F**, **Kean Sta.**,
**One David**, **Ludpitka Huerta**. The first three look truncated in the
source. Correct them in `ORDERS_ROSTER` when you have the real spellings —
skills and assignments key on the exact string, so a rename after people have
been assigned will orphan their queues.
