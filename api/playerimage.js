// ============================================================================
// /api/playerimage — resolve a player or character name to a thumbnail
// ============================================================================
// Routes per sport, because one source does not cover all of them well:
//
//   athletes            -> en.wikipedia.org
//   One Piece           -> onepiece.fandom.com   (Wikipedia has no character pages)
//   Pokemon             -> bulbapedia, then pokemon.fandom.com
//
// This matters: "Nami" on Wikipedia is a river in Korea, not the navigator.
// Character names only resolve correctly against a franchise wiki.
//
// Strategy per source, in order — first hit wins:
//   1. OVERRIDES     exact page title, hand-pinned for names known to misresolve
//   2. exact title   titles=<name> — reliable when the name IS the page title
//   3. search        generator=search with a sport hint — the fuzzy fallback
//
// Each of those tries pageimages first, then falls back to prop=images +
// imageinfo, since the PageImages extension isn't guaranteed on every wiki.
//
// NOT USED, deliberately:
//   Yahoo Sports  — Getty/AP licensed, no public API, hotlink-blocked.
//   TCGplayer     — API exists but image rights are affiliate-only. If Arena
//                   Club holds a partner key, prefer it for pokemon/one_piece.
//
// STILL THE BEST SOURCE: Arena Club's own card scans. No licensing question,
// no disambiguation guesswork, and the real slab beats a headshot on a grading
// dashboard. Treat this route as the fallback for names scans don't cover.
// ============================================================================

const UA = 'ArenaClub-PL-Dashboard/1.0 (internal ops dashboard)';

// ESPN: headshot CDN is https://a.espncdn.com/i/headshots/{league}/players/full/{id}.png
// (league slugs nba, mlb, nfl, nhl, soccer). Athlete IDs come from the keyless
// search endpoint. Both are UNDOCUMENTED — ESPN retired its public API in 2014
// — so treat breakage as expected, not exceptional. Everything falls through to
// Wikipedia and then to initials.
const ESPN_LEAGUE = { basketball: 'nba', baseball: 'mlb', football: 'nfl', hockey: 'nhl', soccer: 'soccer' };
const ESPN_SPORT  = { basketball: 'basketball', baseball: 'baseball', football: 'football', hockey: 'hockey', soccer: 'soccer' };

// Pinned ESPN athlete IDs. Read them off the profile URL:
// espn.com/nba/player/_/id/110/kobe-bryant  ->  110
const ESPN_IDS = {
  'kobe bryant': 110,
};

const SOURCES = {
  wikipedia: { api: 'https://en.wikipedia.org/w/api.php',        label: 'Wikipedia' },
  onepiece:  { api: 'https://onepiece.fandom.com/api.php',       label: 'One Piece Wiki' },
  bulbapedia:{ api: 'https://bulbapedia.bulbagarden.net/w/api.php', label: 'Bulbapedia' },
  pokefandom:{ api: 'https://pokemon.fandom.com/api.php',        label: 'Pokemon Wiki' },
};

// Which sources to try, in order, for each sport.
const CHAIN = {
  one_piece: ['onepiece'],
  pokemon:   ['bulbapedia', 'pokefandom'],
  _default:  ['wikipedia'],
};

// ESPN headshot, straight from an athlete id. HEAD-checked because missing ids
// return 404 and we don't want a broken <img> reaching the tile.
async function espnHeadshot(league, id) {
  const url = `https://a.espncdn.com/i/headshots/${league}/players/full/${id}.png`;
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    return res.ok ? url : null;
  } catch (_) { return null; }
}

// Name -> ESPN athlete. Returns a headshot URL or null.
async function tryEspn(name, sport) {
  const league = ESPN_LEAGUE[String(sport || '').toLowerCase()];
  if (!league) return null;

  // Pinned id first — no search, no ambiguity.
  const pinned = ESPN_IDS[name.toLowerCase().trim()];
  if (pinned) {
    const img = await espnHeadshot(league, pinned);
    if (img) return { image: img, title: name, attribution: `ESPN — ${name}` };
  }

  try {
    const sportParam = ESPN_SPORT[String(sport || '').toLowerCase()] || '';
    const url = 'https://site.web.api.espn.com/apis/search/v2?' + new URLSearchParams({
      query: name, limit: '8', ...(sportParam ? { sport: sportParam } : {}),
    });
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();

    // The payload nests differently across sports, so walk it rather than
    // assuming a fixed path.
    const items = [];
    (function walk(node, depth) {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
      if (typeof node !== 'object') return;
      if (node.type === 'player' || node.type === 'athlete') items.push(node);
      Object.values(node).forEach(v => walk(v, depth + 1));
    })(data, 0);

    for (const it of items) {
      // Prefer an image ESPN handed us directly.
      const direct = it.image || it.imageUrl ||
        (Array.isArray(it.images) && it.images[0] && (it.images[0].url || it.images[0].href));
      if (typeof direct === 'string' && /espncdn|headshot/i.test(direct)) {
        return { image: direct, title: it.displayName || name, attribution: `ESPN — ${it.displayName || name}` };
      }
      // Otherwise derive the id from the link and build the CDN URL.
      const link = it.link?.web || it.link || it.uid || '';
      const m = String(link).match(/\/id\/(\d+)|a:(\d+)/);
      const id = it.id || (m && (m[1] || m[2]));
      if (id) {
        const img = await espnHeadshot(league, id);
        if (img) return { image: img, title: it.displayName || name, attribution: `ESPN — ${it.displayName || name}` };
      }
    }
  } catch (_) { /* fall through to wikipedia */ }
  return null;
}

// Search hints, only used by the fuzzy fallback.
const HINT = {
  basketball: 'basketball player',
  baseball:   'baseball player',
  football:   'American football player',
  soccer:     'footballer',
  hockey:     'ice hockey player',
  pokemon:    '',
  one_piece:  '',
};

// Hand-pinned wiki page titles for names that misresolve. Key is lowercased.
// Add here whenever a tile shows the wrong picture — cheapest possible fix.
//
// NOTE: only for characters and non-ESPN sports. Do NOT add athletes here with
// a wikipedia source — this map is consulted before the ESPN branch, so it
// would prevent the real headshot from ever being fetched. To pin an athlete,
// add their id to ESPN_IDS instead.
const OVERRIDES = {
  'nami':               { source: 'onepiece',  title: 'Nami' },
  'monkey d. luffy':    { source: 'onepiece',  title: 'Monkey D. Luffy' },
  'roronoa zoro':       { source: 'onepiece',  title: 'Roronoa Zoro' },
  'sanji':              { source: 'onepiece',  title: 'Sanji' },
  'portgas d. ace':     { source: 'onepiece',  title: 'Portgas D. Ace' },
  'boa hancock':        { source: 'onepiece',  title: 'Boa Hancock' },
  'charizard':          { source: 'bulbapedia', title: 'Charizard (Pokémon)' },
  'pikachu':            { source: 'bulbapedia', title: 'Pikachu (Pokémon)' },
  'umbreon':            { source: 'bulbapedia', title: 'Umbreon (Pokémon)' },
  'mew':                { source: 'bulbapedia', title: 'Mew (Pokémon)' },
  'rayquaza':           { source: 'bulbapedia', title: 'Rayquaza (Pokémon)' },
  'eevee':              { source: 'bulbapedia', title: 'Eevee (Pokémon)' },
  'ian f':              null,   // not a real person — skip the lookup entirely
};

const cache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

function cacheGet(k) {
  const h = cache.get(k);
  if (!h) return null;
  if (Date.now() - h.at > TTL_MS) { cache.delete(k); return null; }
  return h.value;
}
function cacheSet(k, v) {
  if (cache.size > 500) cache.clear();
  cache.set(k, { at: Date.now(), value: v });
}

async function api(base, params) {
  const url = `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${base} ${res.status}`);
  return res.json();
}

function thumbFromPages(data) {
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;
  if (page.thumbnail?.source) return { image: page.thumbnail.source, title: page.title };
  return null;
}

// Fallback for wikis without PageImages: take the first non-icon file on the
// page and ask for a thumbnail of it.
async function firstImageOnPage(base, title) {
  const list = await api(base, { action: 'query', prop: 'images', titles: title, imlimit: '20' });
  const page = list?.query?.pages?.[0];
  if (!page?.images?.length) return null;

  const skip = /(logo|icon|wiki|edit|placeholder|stub|spoiler|nav|ambox|\.svg$)/i;
  const file = page.images.map(i => i.title).find(t => !skip.test(t));
  if (!file) return null;

  const info = await api(base, {
    action: 'query', prop: 'imageinfo', titles: file,
    iiprop: 'url', iiurlwidth: '200',
  });
  const ip = info?.query?.pages?.[0]?.imageinfo?.[0];
  const url = ip?.thumburl || ip?.url;
  return url ? { image: url, title } : null;
}

async function tryTitle(sourceKey, title) {
  const src = SOURCES[sourceKey];
  if (!src) return null;
  try {
    const data = await api(src.api, {
      action: 'query', prop: 'pageimages', piprop: 'thumbnail',
      pithumbsize: '200', titles: title, redirects: '1',
    });
    const hit = thumbFromPages(data);
    if (hit) return { ...hit, attribution: `${src.label} — ${hit.title}` };

    const alt = await firstImageOnPage(src.api, title);
    if (alt) return { ...alt, attribution: `${src.label} — ${alt.title}` };
  } catch (_) { /* fall through to the next strategy */ }
  return null;
}

async function trySearch(sourceKey, name, sport) {
  const src = SOURCES[sourceKey];
  if (!src) return null;
  const hint = HINT[String(sport || '').toLowerCase()] || '';
  try {
    const data = await api(src.api, {
      action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '200',
      generator: 'search', gsrsearch: hint ? `${name} ${hint}` : name,
      gsrlimit: '1', redirects: '1',
    });
    const hit = thumbFromPages(data);
    if (hit) return { ...hit, attribution: `${src.label} — ${hit.title}` };
  } catch (_) { /* no-op */ }
  return null;
}

async function resolve(name, sport) {
  const key = name.toLowerCase().trim();

  if (key in OVERRIDES) {
    const ov = OVERRIDES[key];
    if (ov === null) return null;              // explicitly skip
    const hit = await tryTitle(ov.source, ov.title);
    if (hit) return hit;
  }

  // Athletes: ESPN first — real headshots, right person, transparent PNGs.
  // Retired players (Jordan, Mantle) often have no headshot on file, so
  // Wikipedia still backs it up.
  if (ESPN_LEAGUE[String(sport || '').toLowerCase()]) {
    const espn = await tryEspn(name, sport);
    if (espn) return espn;
  }

  const chain = CHAIN[String(sport || '').toLowerCase()] || CHAIN._default;

  for (const s of chain) {
    const hit = await tryTitle(s, name);
    if (hit) return hit;
  }
  for (const s of chain) {
    const hit = await trySearch(s, name, sport);
    if (hit) return hit;
  }
  return null;
}

// Stream the image through our own origin. ESPN and the wikis can refuse
// hotlinks by Referer; a server-side fetch has no such problem, and the browser
// then loads from the dashboard's own domain. This is what makes the tiles work
// in production regardless of who is blocking whom.
async function proxyImage(url, res) {
  const upstream = await fetch(url, {
    headers: {
      'User-Agent': UA,
      // Some CDNs 403 an empty Referer but accept their own site.
      Referer: new URL(url).origin + '/',
      Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
    },
  });
  if (!upstream.ok) return false;

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
  res.status(200).send(buf);
  return true;
}

export default async function handler(req, res) {
  const name  = String(req.query.name  || '').trim();
  const sport = String(req.query.sport || '').trim();
  const debug = req.query.debug === '1';
  // mode=img streams the picture itself; default returns JSON metadata.
  const asImage = req.query.mode === 'img';

  if (!name) { res.status(400).json({ error: 'name required' }); return; }

  const key = `${sport}::${name}`.toLowerCase();
  let value = debug ? null : cacheGet(key);

  try {
    if (!value) {
      value = (await resolve(name, sport)) || { image: null, title: null, attribution: null };
      cacheSet(key, value);
    }
  } catch (err) {
    value = { image: null, error: String(err.message || err) };
  }

  if (asImage) {
    // 404 so the <img> onerror fires and the tile shows initials.
    if (!value.image) { res.status(404).end(); return; }
    try {
      if (await proxyImage(value.image, res)) return;
    } catch (_) { /* fall through */ }
    res.status(404).end();
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).json({ ...value, cached: !debug });
}
