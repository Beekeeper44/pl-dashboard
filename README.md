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
