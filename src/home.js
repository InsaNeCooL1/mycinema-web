'use strict';

// ============ RECOMMENDATIONS ENGINE V2 ============
const GEN_CACHE = 'mycinema.home.general.v7'; /* FIX-GEN-CACHE-BUMP */
const RECS_TTL = 48 * 60 * 60 * 1000;  // 48 годин /* FIX-RECS-CACHE-V2 */
const GEN_TTL = 12 * 60 * 60 * 1000;  // 12 годин

function isExcludedShow(raw, type) {
  if (!raw) return true;
  const gids = raw.genre_ids || (Array.isArray(raw.genres) ? raw.genres.map(g => (typeof g === 'object' ? g.id : g)) : []);
  if ((type === 'tv' || raw.media_type === 'tv') && gids.some(g => EXCLUDED_TV_GENRES.includes(g))) return true;
  if (gids.some(g => g === 10763 || g === 10764 || g === 10767)) return true;
  const title = `${raw.title || raw.name || ''} ${raw.original_title || raw.original_name || ''}`.trim();
  if (/(\b(the oscars|oscars 20\d\d|academy awards|golden globe awards|emmy awards|grammy awards|bafta awards|mtv .* awards|eurovision song contest|saturday night live|tonight show|late night with|late show with|jimmy kimmel|stephen colbert|seth meyers|graham norton)\b|церемоні(я|ї) (вручення|нагородження)|премі(я|ї) «?оскар»?|євробачення)/i.test(title)) {
    return true;
  }
  return false;
}

const META_CACHE_KEY = 'mycinema.metaCache.v2'; /* FIX-META-CACHE-BUMP */
const META_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const META_CACHE_MAX = 220;
const _memSeedRecs = new Map(); /* FIX-MEMSEED-LRU */
function _trimMemSeedRecs() {
  while (_memSeedRecs.size > 200) {
    const fk = _memSeedRecs.keys().next().value;
    _memSeedRecs.delete(fk);
  }
}


function hashString32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(str) {
  let a = hashString32(str) || 1;
  return function() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* [LAYOUT] М'який зсув рекомендацій при оновленні:
   кожна з перших 10 позицій із шансом ≤15% бере званого кандидата,
   чим вище ранг у моделі — тим більша вага; решта лишається порядком моделі. */
const RECS_SHUFFLE_CHANCE = 0.15;
function softShuffleRecs(items, nonce) {
  if (!Array.isArray(items) || items.length < 2) return items;
  const top = Math.min(10, items.length);
  const poolSize = Math.min(items.length, 30);
  const rng = seededRandom(`recs-shuffle|${nonce || 0}`);
  const weights = [];
  for (let i = 0; i < poolSize; i++) weights.push(1 / (1 + i * 0.35));
  const out = items.slice();
  const used = new Set();
  for (let slot = 0; slot < top; slot++) {
    if (rng() >= RECS_SHUFFLE_CHANCE) continue;
    let total = 0;
    const avail = [];
    for (let j = 0; j < poolSize; j++) {
      if (j === slot || used.has(j)) continue;
      avail.push([j, weights[j]]);
      total += weights[j];
    }
    if (!avail.length) break;
    let r = rng() * total;
    let pick = avail[avail.length - 1][0];
    for (const [j, w] of avail) { r -= w; if (r <= 0) { pick = j; break; } }
    const tmp = out[slot]; out[slot] = out[pick]; out[pick] = tmp;
    used.add(slot); used.add(pick);
  }
  return out;
}

function maybeShuffleRecs(data, nonce) {
  if (!data || !Array.isArray(data.items) || !(nonce > 0)) return data;
  const items = softShuffleRecs(data.items, nonce);
  return items === data.items ? data : { ...data, items };
}

function isExcludedFromTaste(x, avg) {
  if (!x) return true;
  if (x.excludeFromProfile === true) return true;
  if (x.excludeFromProfile === false) return false;
  // Порівнюємо з IMDb, якщо він уже підтягнутий; інакше лишається TMDB.
  const ref = (typeof imdbRef === 'function') ? imdbRef(x).rating : (x.tmdbRating || 0);
  if (ref > 0 && avg > 0 && Math.abs(avg - ref) > 3) return true;
  return false;
}

// Одноразовий backfill IMDb для бібліотеки — має завершитися ДО getSeeds().
async function ensureLibraryImdb() {
  if (typeof imdbLoadFor !== 'function') return { ok: false, total: 0 };
  const movies = [], tv = [];
  for (const x of Object.values(lib || {})) {
    if (!x || !x.id) continue;
    // imdbRef реально читається тільки для оцінених/улюблених/сильних сідів.
    // Неоцінені «Планую»/watching не впливають на математику — не шлемо їх.
    const avg = computeItemRating(x).avg;
    const cast = getItemCastRating(x);
    const elo = typeof x.elo === 'number' ? x.elo : ELO_START;
    const highElo = (x.eloGames || 0) > 0 && elo >= 1530;
    if (avg <= 0 && cast <= 0 && !x.favorite && !highElo) continue;

    const t = (x.type === 'tv') ? 'tv' : 'movie';
    if (typeof imdbLookup === 'function' && imdbLookup(t, x.id)) continue;
    if (typeof imdbIsKnownMissing === 'function' && imdbIsKnownMissing(t, x.id)) continue;
    (t === 'tv' ? tv : movies).push(x.id);
  }
  const groups = [];
  for (const [t, arr] of [['movie', movies], ['tv', tv]]) {
    for (let i = 0; i < arr.length; i += 400) groups.push([t, arr.slice(i, i + 400)]);
  }
  // Групи незалежні — паралельно, а не послідовний for ... await.
  const results = await Promise.all(groups.map(([t, arr]) => {
    const p = (t === 'tv') ? imdbLoadFor([], arr) : imdbLoadFor(arr, []);
    return p.catch(() => ({ ok: false }));
  }));
  const ok = results.every(res => res.ok);
  return { ok, total: movies.length + tv.length };
}

function readMetaCacheAll() {
  const raw = typeof mcCacheGet === 'function' ? mcCacheGet(META_CACHE_KEY, {}) : {};
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

function writeMetaCacheAll(cache) {
  try {
    const entries = Object.entries(cache);
    if (entries.length > META_CACHE_MAX) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      cache = Object.fromEntries(entries.slice(0, META_CACHE_MAX));
    }
    if (typeof mcCacheSet === 'function') mcCacheSet(META_CACHE_KEY, cache);
  } catch {}
}

function packCompactMeta(d, type) {
  const dirs = [];
  const seenDir = new Set();
  (d.credits?.crew || []).filter(c => c.job === 'Director' || c.job === 'Creator').forEach(c => {
    if (!seenDir.has(c.id)) { seenDir.add(c.id); dirs.push({ id: c.id, name: c.name }); }
  });
  (d.created_by || []).forEach(c => {
    if (!seenDir.has(c.id)) { seenDir.add(c.id); dirs.push({ id: c.id, name: c.name }); }
  });

  let cast = [];
  if (type === 'tv' && Array.isArray(d.aggregate_credits?.cast) && d.aggregate_credits.cast.length) {
    const rawCast = d.aggregate_credits.cast.slice(0, 12);
    const maxEps = Math.max(...rawCast.map(c => c.total_episode_count || 1), 1);
    cast = rawCast.map(c => ({
      id: c.id,
      name: c.name,
      w: clampNum((c.total_episode_count || 1) / maxEps, 0.15, 1)
    }));
  } else {
    cast = (d.credits?.cast || []).slice(0, 10).map((c, idx) => ({
      id: c.id,
      name: c.name,
      w: 1 / Math.sqrt(1 + (typeof c.order === 'number' ? c.order : idx))
    }));
  }

  const kwList = (d.keywords?.keywords || d.keywords?.results || []).slice(0, 14);
  const kws = kwList.map(k => k.id);
  const genres = (d.genres || []).map(g => g.id);

  return {
    ts: Date.now(),
    colId: d.belongs_to_collection?.id || null,
    netId: d.networks?.[0]?.id || null,
    dirs: dirs.slice(0, 3),
    cast,
    kws,
    kwNames: kwList.map(k => ({ id: k.id, name: k.name })),
    genres,
    /* FIX-RELEASE-PACK-META */
    digitalDate: (typeof extractDigitalDate === 'function') ? extractDigitalDate(d) : null,
    providersUA: (typeof extractProvidersUA === 'function') ? extractProvidersUA(d) : []
  };
}

async function fetchCompactMeta(type, id, needRecs, cacheObj) {
  const key = `${type}-${id}`;
  const now = Date.now();
  const cached = cacheObj[key];
  const cachedRecs = needRecs ? _memSeedRecs.get(key) : null;
  if (cached && (now - (cached.ts || 0)) < META_CACHE_TTL && (!needRecs || cachedRecs)) {
    return { meta: cached, recs: cachedRecs || [] };
  }

  /* FIX-RELEASE-COMPACT-FETCH */
  const parts = [type === 'tv' ? 'credits,aggregate_credits,keywords,watch/providers' : 'credits,keywords,release_dates,watch/providers'];
  if (needRecs) parts.push('recommendations');
  const d = await tmdbFetch(`/${type}/${id}?language=uk-UA&append_to_response=${parts.join(',')}`);
  const meta = packCompactMeta(d, type);
  cacheObj[key] = meta;

  let recs = [];
  if (needRecs) {
    recs = (d.recommendations?.results || []).slice(0, 12);
    _memSeedRecs.set(key, recs);
    _trimMemSeedRecs(); /* FIX-MEMSEED-LRU-2 */
  }
  return { meta, recs };
}

async function mapBatched(items, batchSize, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const res = await Promise.all(chunk.map(fn));
    out.push(...res);
  }
  return out;
}

function getSeeds() {
  const candidates = Object.values(lib)
    .map(x => {
      const avg = computeItemRating(x).avg;
      const isFav = !!x.favorite;
      const elo = typeof x.elo === 'number' ? x.elo : ELO_START;
      const hasHighElo = (x.eloGames || 0) > 0 && elo >= 1530;
      if (!x.id || x.antiSeed || isExcludedFromTaste(x, avg)) return null;
      if (avg < 6.5 && !isFav && !hasHighElo) return null;

      const base = avg > 0 ? avg : (isFav ? 8.6 : 8.2);
      const favBonus = isFav ? 1.2 : 0;
      const eloBonus = elo > ELO_START ? Math.min((elo - ELO_START) / 100, 1.5) : 0;
      const strength = Math.min(10, base + favBonus + eloBonus);

      // Big bang: residual рахуємо від IMDb. Якщо даних немає — TMDB як
      // тимчасовий фольбек (головне, щоб обидва боки були з одного джерела).
      const ref = (typeof imdbRef === 'function') ? imdbRef(x) : null;
      const refVal = ref ? ref.rating : (x.tmdbRating || 0);
      const defaultRef = x.type === 'tv' ? 7.6 : 6.9; // типові IMDb-середні
      const residual = (avg > 0 && refVal > 0)
        ? (avg - refVal)
        : (avg > 0 ? avg - defaultRef : 0.8);
      const resFactor = clampNum(1 + residual / 2, 0.3, 2);
      const decayMult = Math.max(0.1, tasteDecay(x.updated));
      const rankScore = (strength / 10) * resFactor * (0.35 + 0.65 * decayMult);

      return { ...x, avg, isFav, elo, strength, residual, resFactor, decayMult, rankScore };
    })
    .filter(Boolean);

  if (!candidates.length) return [];

  const fresh = [...candidates].sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 3);
  const byResidual = [...candidates].sort((a, b) => b.rankScore - a.rankScore || (b.updated || 0) - (a.updated || 0));

  const picked = [];
  const seen = new Set();
  for (const s of fresh) {
    if (!seen.has(s.key)) { seen.add(s.key); picked.push(s); }
  }
  /* REDUCE_SEED_OVERLOAD */
  for (const s of byResidual) {
    if (picked.length >= 10) break; // Топ-10 сідів дають точний зріз без перевантаження мережі
    if (!seen.has(s.key)) { seen.add(s.key); picked.push(s); }
  }
  return picked;
}

function getAntiSeeds() {
  return Object.values(lib)
    .map(x => ({ ...x, avg: computeItemRating(x).avg }))
    .filter(x => x.id && (x.status === 'dropped' || x.antiSeed === true) && x.excludeFromProfile !== true)
    .sort((a, b) => ((b.antiSeed ? 1 : 0) - (a.antiSeed ? 1 : 0)) || ((b.updated || 0) - (a.updated || 0)))
    .slice(0, 5);
}

function getDominantCriterion(taste) {
  if (!taste || taste.count < 3) return null;
  const vals = RATING_CRITERIA.map(c => ({ key: c.key, label: c.label, v: taste[c.key] || 0 }));
  const sorted = [...vals].sort((a, b) => b.v - a.v);
  const avg = vals.reduce((s, x) => s + x.v, 0) / vals.length;
  if (sorted[0].v - avg >= 0.35) return sorted[0];
  return null;
}

async function buildSmartRecommendations(seeds, mood, mode) {
  mode = mode || 'balance';
  if (!seeds.length) return { items: [], seeds: 0, seedList: [], topGenres: [], topCast: [], topDirectors: [], topKeywords: [], names: {}, collections: [], seedRecs: [], mood, mode };

  const taste = computeTasteVector();
  const domCrit = getDominantCriterion(taste);
  const antiSeeds = getAntiSeeds();
  const metaCache = readMetaCacheAll();

  const seedDetails = (await mapBatched(seeds, 8, async s => {
    try {
      const { meta, recs } = await fetchCompactMeta(s.type, s.id, true, metaCache);
      return { seed: s, meta, recs };
    } catch { return null; }
  })).filter(Boolean);

  const antiDetails = (await mapBatched(antiSeeds, 5, async s => {
    try {
      const { meta } = await fetchCompactMeta(s.type, s.id, false, metaCache);
      return { seed: s, meta };
    } catch { return null; }
  })).filter(Boolean);

  // Групування сідів тільки за колекцією або самим сідом (без мережі)
  const groups = new Map();
  const getGroup = (gKey) => {
    if (!groups.has(gKey)) groups.set(gKey, { directors: {}, cast: {}, genres: {}, keywords: {} });
    return groups.get(gKey);
  };
  const addGrp = (o, id, v) => {
    const e = o[id] || (o[id] = { sum: 0, max: 0 });
    e.sum += v;
    if (v > e.max) e.max = v;
  };
  const combGrp = e => e.max + 0.3 * (e.sum - e.max);

  const dirRes = {};
  const actorRes = {};
  const names = { directors: {}, cast: {}, keywords: {} };

  for (const { seed, meta } of seedDetails) {
    let w = (seed.strength / 10) * seed.resFactor * seed.decayMult;
    if (domCrit) {
      const rr = seed.type === 'tv' ? averagedSeasonRatings(seed) : (seed.ratings || {});
      if ((rr[domCrit.key] || 0) >= 8) w *= 1.15;
    }

    const gKey = meta.colId ? 'col-' + meta.colId : 'seed-' + seed.key;
    const grp = getGroup(gKey);

    (meta.kwNames || []).forEach(k => { if (k.name) names.keywords[k.id] = k.name; });

    (meta.dirs || []).forEach(c => {
      names.directors[c.id] = c.name;
      addGrp(grp.directors, c.id, w * 2.2);
      if (!dirRes[c.id]) dirRes[c.id] = { sum: 0, n: 0 };
      dirRes[c.id].sum += seed.residual;
      dirRes[c.id].n += 1;
    });

    (meta.cast || []).forEach(c => {
      names.cast[c.id] = c.name;
      const adj = typeof getActorAdj === 'function' ? getActorAdj(c.id) : 0;
      const mult = Math.max(0.3, 1 + adj * 0.45);
      addGrp(grp.cast, c.id, w * 2.0 * (c.w || 1) * mult);
      if (!actorRes[c.id]) actorRes[c.id] = { sum: 0, n: 0 };
      actorRes[c.id].sum += seed.residual;
      actorRes[c.id].n += 1;
    });

    const gIds = (meta.genres && meta.genres.length) ? meta.genres : (seed.genres || []);
    gIds.forEach(gid => {
      addGrp(grp.genres, gid, w * 1.4);
    });

    (meta.kws || []).forEach(kid => {
      addGrp(grp.keywords, kid, w * 1.1);
    });
  }

  const signals = { directors: {}, cast: {}, genres: {}, keywords: {} };
  for (const grp of groups.values()) {
    for (const [id, e] of Object.entries(grp.directors)) signals.directors[id] = (signals.directors[id] || 0) + combGrp(e);
    for (const [id, e] of Object.entries(grp.cast)) signals.cast[id] = (signals.cast[id] || 0) + combGrp(e);
    for (const [id, e] of Object.entries(grp.genres)) signals.genres[id] = (signals.genres[id] || 0) + combGrp(e);
    for (const [id, e] of Object.entries(grp.keywords)) signals.keywords[id] = (signals.keywords[id] || 0) + combGrp(e);
  }

  // Згладжування за залишком: sum(residual) / (n + 3)
  for (const [id, stat] of Object.entries(dirRes)) {
    const smooth = stat.sum / (stat.n + 3);
    signals.directors[id] *= clampNum(1 + smooth / 2, 0.5, 1.6);
  }
  for (const [id, stat] of Object.entries(actorRes)) {
    const smooth = stat.sum / (stat.n + 3);
    signals.cast[id] *= clampNum(1 + smooth / 2, 0.5, 1.6);
  }

  // Профіль акторів (Б+В відносно G, без countMod і без подвійного обліку)
  const actorProfiles = typeof computeActorProfiles === 'function'
    ? computeActorProfiles()
    : { globalCastAvg: 7.2, actors: new Map() };
  const anti = { directors: {}, genres: {}, keywords: {}, cast: {} };

  for (const [aid, prof] of actorProfiles.actors.entries()) {
    if (prof.name && !names.cast[aid]) names.cast[aid] = prof.name;
    if (prof.isAnti) {
      if (signals.cast[aid]) signals.cast[aid] = 0;
      anti.cast[aid] = Math.min(1.4, Math.max(0.25, Math.abs(prof.recSignal) * 0.6));
    } else if (prof.ratedCount >= 1 && prof.recSignal > 0.25 && prof.shrunk >= actorProfiles.globalCastAvg) {
      const profBoost = Math.min(2.2, prof.recSignal * 0.95);
      signals.cast[aid] = Math.max(signals.cast[aid] || 0, profBoost);
    }
  }

  // Ручні оцінки акторів (🔥/😞) — без повторного множення поверх recSignal
  for (const [aidStr, adj] of Object.entries(actorAdjust || {})) {
    const aid = parseInt(aidStr);
    if (adj > 0) {
      signals.cast[aid] = Math.max(signals.cast[aid] || 0, adj * 0.85) + adj * 0.30;
      delete anti.cast[aid];
    } else if (adj < 0) {
      if (signals.cast[aid]) signals.cast[aid] = 0;
      anti.cast[aid] = Math.max(anti.cast[aid] || 0, Math.abs(adj) * 0.85);
    }
  }

  // Анти-сигнали (тільки dropped + ручне «не схоже» + сховані + анти-актори)
  for (const { seed, meta } of antiDetails) {
    const aw = seed.antiSeed ? 1.4 : 1.0;
    (meta.dirs || []).forEach(c => { anti.directors[c.id] = (anti.directors[c.id] || 0) + aw; });
    const gIds = (meta.genres && meta.genres.length) ? meta.genres : (seed.genres || []);
    gIds.forEach(gid => { anti.genres[gid] = (anti.genres[gid] || 0) + aw * 0.4; });
    (meta.kws || []).forEach(kid => { anti.keywords[kid] = (anti.keywords[kid] || 0) + aw; });
  }
  for (const d of Object.values(dismissedRecs || {})) {
    (d.genres || []).forEach(gid => { anti.genres[gid] = (anti.genres[gid] || 0) + 0.25; });
  }

  const moodData = mood && MOODS[mood] ? MOODS[mood] : null;
  const topKw = Object.entries(signals.keywords)
    .filter(([id]) => !anti.keywords[id])
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
  const topGenres = Object.entries(signals.genres)
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => parseInt(id));
  const topCast = Object.entries(signals.cast)
    .filter(([id, sc]) => sc > 0 && !anti.cast[id])
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => parseInt(id));
  const topDirectors = Object.entries(signals.directors)
    .filter(([id]) => !anti.directors[id])
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => parseInt(id));

  const unique = new Map();
  const ensureCandidate = (raw, type) => {
    if (!raw || !raw.poster_path) return null;
    if (isExcludedShow(raw, type)) return null;
    const key = `${type}-${raw.id}`;
    const tracked = typeof isTrackedInLib === 'function' ? isTrackedInLib(key) : !!lib[key];
    if (tracked || (typeof isDismissed === 'function' && isDismissed(key))) return null;
    /* FIX-RELEASE-ENSURE — Level 1+2 pre-filter */
    const _today = new Date().toISOString().slice(0, 10);
    const _rel = (raw.release_date || raw.first_air_date || '').slice(0, 10);
    if (settings.digitalOnly && type === 'movie') {
      if (_rel && _rel > _today) return null;  // ще не вийшов — точно немає digital
    }
    if (settings.streamingOnlyUA) {
      if (_rel && _rel > _today) return null;  // streaming точно немає
    }
    let entry = unique.get(key);
    if (!entry) {
      const item = normalizeItem({ ...raw, media_type: type });
      entry = { ...item, _sourceRaw: 0, _eloHits: [], _reasons: [], _seenTags: new Set(), _meta: null };
      unique.set(key, entry);
    }
    return entry;
  };
  const addReason = (entry, tag, text, priority) => {
    if (!entry || entry._seenTags.has(tag)) return;
    entry._seenTags.add(tag);
    if (!entry._reasonTags) entry._reasonTags = [];
    entry._reasonTags.push(tag);
    entry._reasons.push({ priority, text });
  };

  // Джерело 1: Прямі TMDB рекомендації від сідів
  for (const { seed, recs } of seedDetails) {
    const seedRatingLabel = seed.avg > 0 ? ` (${fmtNum(seed.avg)})` : (seed.isFav ? ' ❤️' : '');
    const boost = Math.min(2.2, (seed.strength / 10) * seed.resFactor * seed.decayMult);
    const seedEloNorm = (seed.eloGames || 0) > 0 ? clampNum((seed.elo - 1450) / 250, 0, 1) : 0;

    recs.forEach((r, idx) => {
      const t = r.media_type || seed.type;
      const entry = ensureCandidate(r, t);
      if (!entry) return;
      entry._sourceRaw += boost * (1 - idx * 0.045);
      if (seedEloNorm > 0) entry._eloHits.push(seedEloNorm);
      addReason(entry, 'seed-' + seed.key, `Як «${seed.title}»${seedRatingLabel}`, 10);
    });
  }

  // Джерело 2: Discover + Акторські/Режисерські запити
  const currentYear = new Date().getFullYear();
  const baseDiscover = (type) => {
    const p = new URLSearchParams({ language: 'uk-UA' });
    // TMDB лишається лише каталогом: м'який поріг голосів, ніякого
    // vote_average.gte — справжню якість тепер перевіряє IMDb у pre-score.
    p.set('vote_count.gte', type === 'movie' ? '20' : '10');
    if (mode === 'gems') {
      p.set('sort_by', 'vote_average.desc');
    } else if (mode === 'fresh') {
      p.set('sort_by', 'popularity.desc');
      p.set(type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte', `${currentYear - 2}-01-01`);
    } else {
      p.set('sort_by', 'popularity.desc');
    }
    if (type === 'tv') p.set('without_genres', EXCLUDED_TV_GENRES.join(','));
    return p;
  };

  const fetchPromises = [];
  ['movie', 'tv'].forEach(type => {
    if (topKw.length || topGenres.length) {
      const p = baseDiscover(type);
      p.set('page', '1');
      if (topKw.length) p.set('with_keywords', topKw.join('|'));
      if (topGenres.length) p.set('with_genres', topGenres.slice(0, 3).join('|'));
      fetchPromises.push(tmdbFetch(`/discover/${type}?${p}`).then(d => ({ type, results: d.results || [], source: 'personalized' })).catch(() => ({ type, results: [], source: 'personalized' })));
    }
    if (topGenres.length) {
      const pg = baseDiscover(type);
      pg.set('page', '1');
      pg.set('with_genres', topGenres.slice(0, 3).join('|'));
      fetchPromises.push(tmdbFetch(`/discover/${type}?${pg}`).then(d => ({ type, results: d.results || [], source: 'genres' })).catch(() => ({ type, results: [], source: 'genres' })));
    }
    if (moodData) {
      const pm = baseDiscover(type);
      pm.set('page', '1');
      pm.set('with_genres', (type === 'tv' ? (moodData.tvGenres || moodData.genres) : moodData.genres).join('|'));
      fetchPromises.push(tmdbFetch(`/discover/${type}?${pm}`).then(d => ({ type, results: d.results || [], source: 'mood' })).catch(() => ({ type, results: [], source: 'mood' })));
    }
  });

  topCast.forEach(aid => {
    const p = baseDiscover('movie');
    p.set('with_cast', String(aid));
    p.set('page', '1');
    fetchPromises.push(
      tmdbFetch(`/discover/movie?${p}`)
        .then(d => ({ type: 'movie', results: (d.results || []).slice(0, 12), source: 'cast', actorId: aid }))
        .catch(() => ({ type: 'movie', results: [], source: 'cast' }))
    );
    fetchPromises.push(
      tmdbFetch(`/person/${aid}/tv_credits?language=uk-UA`)
        .then(d => {
          const castList = (d.cast || [])
            .filter(r => r.poster_path && (r.vote_count || 0) >= 10 && !(r.genre_ids || []).some(g => EXCLUDED_TV_GENRES.includes(g)))
            .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
            .slice(0, 10);
          return { type: 'tv', results: castList, source: 'cast', actorId: aid };
        })
        .catch(() => ({ type: 'tv', results: [], source: 'cast' }))
    );
  });

  topDirectors.forEach(did => {
    const p = baseDiscover('movie');
    p.set('with_crew', String(did));
    p.set('page', '1');
    fetchPromises.push(
      tmdbFetch(`/discover/movie?${p}`)
        .then(d => ({ type: 'movie', results: (d.results || []).slice(0, 10), source: 'director', dirId: did }))
        .catch(() => ({ type: 'movie', results: [], source: 'director' }))
    );
  });

  const all = await Promise.all(fetchPromises);
  for (const batch of all) {
    for (const r of batch.results) {
      const entry = ensureCandidate(r, batch.type);
      if (!entry) continue;

      if (batch.source === 'mood') {
        /* FIX-MOOD-SOURCE-LEAK */
        const _mw = moodData.weight || 1.0;
        // Було 2.0 * 3.0 = 6.0 — настрій витісняв усе з pre-score.
        // Тепер не більше REC_MOOD_SOURCE_CAP, як у інших discover-джерел.
        entry._sourceRaw += (typeof REC_MOOD_SOURCE_CAP !== 'undefined')
          ? Math.min(REC_MOOD_SOURCE_CAP, 0.4 * _mw)
          : Math.min(1.2, 0.4 * _mw);
        entry._moodMatch = _mw;
        addReason(entry, 'mood-' + mood, `${moodData.emoji} ${moodData.label}`, 8);
      } else if (batch.source === 'director') {
        entry._sourceRaw += 0.9;
        const dName = names.directors[batch.dirId];
        addReason(entry, 'dir-' + batch.dirId, dName ? `Режисер: ${dName}` : 'Твій режисер', 9);
      } else if (batch.source === 'cast') {
        const adj = typeof getActorAdj === 'function' ? getActorAdj(batch.actorId) : 0;
        if (adj < 0 || anti.cast[batch.actorId]) continue;
        const prof = actorProfiles.actors.get(batch.actorId);
        const profBoost = prof && prof.recSignal > 0 ? Math.min(0.4, prof.recSignal * 0.16) : 0;
        entry._sourceRaw += 0.75 + profBoost;
        const aName = names.cast[batch.actorId];
        addReason(entry, 'cast-' + batch.actorId, aName ? `З ${aName}` : 'Актор з улюблених', 7);
      } else if (batch.source === 'personalized') {
        entry._sourceRaw += 0.9;
      } else if (batch.source === 'genres') {
        entry._sourceRaw += 0.45;
      }
    }
  }

  // Пакетне підтягування IMDb для всього пулу — ДО pre-score,
  // щоб якість оцінювалась за IMDb, а не за «дутими» TMDB-голосами.
  if (typeof imdbLoadFor === 'function') {
    const candMovies = [], candTv = [];
    for (const entry of unique.values()) {
      (entry.type === 'tv' ? candTv : candMovies).push(entry.id);
    }
    try { await imdbLoadFor(candMovies, candTv); }
    catch (e) { console.warn('[MyCinema/IMDb] candidate batch fail:', e); }
  }

  // Насичення жанрів (Lift)
  const poolGenreCounts = {};
  let totalPoolGenres = 0;
  for (const entry of unique.values()) {
    (entry.genres || []).forEach(gid => {
      poolGenreCounts[gid] = (poolGenreCounts[gid] || 0) + 1;
      totalPoolGenres++;
    });
  }
  const userGenreTotal = Object.values(signals.genres).reduce((a, b) => a + b, 0);
  const genreCountDistinct = Math.max(Object.keys(poolGenreCounts).length, 1);
  const genreLift = {};
  for (const gid of Object.keys(poolGenreCounts)) {
    const uShare = ((signals.genres[gid] || 0) + 0.5) / (userGenreTotal + 0.5 * genreCountDistinct);
    const pShare = (poolGenreCounts[gid] + 1) / (totalPoolGenres + genreCountDistinct);
    genreLift[gid] = uShare / pShare;
  }

  // Попередній фільтр по режиму + попередній скор для відбору топ-60 на credits/keywords
  const byType = { movie: [], tv: [] };
  for (const entry of unique.values()) {
    if (mode === 'fresh' && ((parseInt(entry.year) || 0) < currentYear - 2)) continue;

    // ── IMDb як джерело рейтингу й голосів ──────────────────────
    const ref = (typeof imdbRef === 'function') ? imdbRef(entry) : null;
    const refRating = ref ? ref.rating : (entry.tmdbRating || 0);
    const refVotes = ref ? ref.votes : (entry.votes || 0);
    const priors = (typeof recPriorsFor === 'function')
      ? recPriorsFor(ref && ref.source, entry.type)
      : ((typeof recPriors === 'function') ? recPriors(entry.type) : { C: 0.65, m: 200 });

    // Байєс: 8.8 при 200 голосах IMDb < 8.2 при 15 000 голосах.
    const wr = recBayesRating(refRating, refVotes, priors.C, priors.m);
    let modeBonus = 0;

    if (mode === 'gems') {
      if (ref && ref.source === 'imdb') {
        // Справжні перлини: не порожнячки з 10 голосами.
        const minV = entry.type === 'tv' ? 200 : 500;
        if (refVotes < minV || wr < 0.68) continue;
        modeBonus = (typeof recGemBonus === 'function')
          ? recGemBonus(refVotes, wr, entry.type)
          : clampNum((2500 - refVotes) / 2500, 0, 0.3);
      } else {
        // Тимчасовий TMDB-фольбек, поки IMDb даних немає.
        if (entry.votes > 2500 || entry.tmdbRating < 7.0) continue;
        modeBonus = clampNum((2500 - entry.votes) / 2500, 0, 0.3);
      }
    } else if (mode === 'fresh') {
      modeBonus = clampNum(((parseInt(entry.year) || currentYear - 2) - (currentYear - 2)) * 0.15, 0, 0.3);
    } else {
      modeBonus = (typeof recBalanceBonus === 'function')
        ? recBalanceBonus(ref, entry.popularity)
        : Math.min(entry.popularity / 250, 0.2);
    }

    const baseRaw = wr + modeBonus;
    // Чистий IMDb WR і режимний бонус ідуть у b окремо, щоб бонус не
    // забивав різницю між 7.1 і 8.3 через круту сигмоїду.
    entry._b = (typeof recBaseScore === 'function')
      ? recBaseScore(wr, modeBonus, entry.type)
      : undefined;

    let liftSum = 0, liftCnt = 0;
    let bestGenreId = null, bestLift = 0;
    let antiGenre = 0;
    (entry.genres || []).forEach(gid => {
      const lf = genreLift[gid] || 1;
      if (signals.genres[gid] && lf > 1) {
        const boost = Math.min(lf - 1, 1.8);
        liftSum += boost;
        liftCnt++;
        if (lf > bestLift) { bestLift = lf; bestGenreId = gid; }
      }
      if (anti.genres[gid]) antiGenre += anti.genres[gid] * 0.12;
    });
    const genreMatch = liftCnt > 0 ? Math.min(1.4, (liftSum / liftCnt) * Math.sqrt(liftCnt)) : 0;

    entry._baseRaw = baseRaw;
    entry._genreMatch = genreMatch;
    entry._antiGenre = Math.min(0.3, antiGenre);
    entry._eloRaw = entry._eloHits.length
      ? entry._eloHits.reduce((a, b) => a + b, 0) / entry._eloHits.length
      : 0;
    entry._bestGenreId = bestGenreId;

    /* FIX-MOOD-WEIGHT-PRE — mood genre match + source bonus */
    let _moodBoost = 0;
    if (moodData) {
      const _mw2 = moodData.weight || 1.0;
      const _mg = entry.type === 'tv' ? (moodData.tvGenres || moodData.genres) : moodData.genres;
      const _hits = (entry.genres || []).filter(g => _mg.includes(g)).length;
      if (_hits > 0) _moodBoost += Math.min(0.18, _hits * 0.05) * _mw2; /* FIX-MOOD-AGGR-BOOST */
      if (entry._moodMatch) _moodBoost += 0.12 * (entry._moodMatch);
    }
    entry._moodBoost = Math.min(0.6, _moodBoost);

    entry._preScore = entry._baseRaw * 0.35 + Math.min(entry._sourceRaw, 5) * 0.2 /* FIX-MOOD-AGGR-CAP */ + entry._genreMatch * 0.3 - entry._antiGenre + _moodBoost * 0.7; /* FIX-MOOD-AGGR-PRE */

    if (byType[entry.type]) byType[entry.type].push(entry);
  }

  // Топ-30 фільмів + Топ-30 серіалів (разом 60) -> дотягуємо credits + keywords з кешем
  const topMoviesForMeta = [...byType.movie].sort((a, b) => b._preScore - a._preScore).slice(0, 30);
  const topTvForMeta = [...byType.tv].sort((a, b) => b._preScore - a._preScore).slice(0, 30);
  const topCandidates = [...topMoviesForMeta, ...topTvForMeta];

  await mapBatched(topCandidates, 10, async entry => {
    try {
      const { meta } = await fetchCompactMeta(entry.type, entry.id, false, metaCache);
      entry._meta = meta;
    } catch {}
  });
  writeMetaCacheAll(metaCache);

  const todayStr = new Date().toISOString().slice(0, 10);
  const uid = (window.currentUser && window.currentUser.uid) ? window.currentUser.uid : 'guest';
  const rnd = seededRandom(`${uid}|${todayStr}|${state.home.refreshNonce || 0}`);

  const finalizeReasons = (entry) => {
    if (entry._bestGenreId && entry._reasons.length === 0) {
      const g = GENRES.find(x => x.id === entry._bestGenreId);
      if (g) addReason(entry, 'genre-' + g.id, `Твій жанр · ${g.name}`, 3);
    }
    if (domCrit && entry._reasons.length < 2 && ((entry._profileRaw || entry._genreMatch) >= 0.6)) {
      addReason(entry, 'crit-' + domCrit.key, `Під «${domCrit.label}»`, 2);
    }
    entry._reasons = entry._reasons
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 2)
      .map(x => x.text);
  };

  const finalizeType = (list) => {
    if (!list.length) return [];

    /* FIX-RELEASE-FINALIZE — post-filter on enriched (has _meta) */
    const _today = new Date().toISOString().slice(0, 10);
    const filtered = list.filter(x => {
      if (!x._meta) return true;  // без meta не можемо перевірити — пропускаємо
      if (settings.digitalOnly && x.type === 'movie') {
        if (x._meta.digitalDate && x._meta.digitalDate > _today) return false;
      }
      if (settings.streamingOnlyUA) {
        if (!x._meta.providersUA || x._meta.providersUA.length === 0) return false;
      }
      return true;
    });

    const enriched = filtered.filter(x => !!x._meta);
    const rest = filtered.filter(x => !x._meta); /* FIX-RELEASE-FINALIZE-REST */

    if (enriched.length) {
      for (const entry of enriched) {
        let actorMatch = 0;
        let directorMatch = 0;
        let kwMatch = 0;
        let antiDir = 0;
        let antiKw = 0;

        let bestActor = null, bestActorScore = 0;
        let antiCast = 0;
        (entry._meta.cast || []).forEach(c => {
          if (anti.cast[c.id]) {
            antiCast += anti.cast[c.id] * (c.w || 1) * 0.25;
            return;
          }
          const sig = signals.cast[c.id] || 0;
          if (sig > 0) {
            const prof = actorProfiles.actors.get(c.id);
            const leadBoost = prof && prof.shrunk >= actorProfiles.globalCastAvg + 0.5 && (c.w || 0) >= 0.5 ? 1.12 : 1.0;
            const sc = sig * (c.w || 1) * 0.25 * leadBoost;
            actorMatch += sc;
            if (sc > bestActorScore) { bestActorScore = sc; bestActor = c; }
          }
        });
        actorMatch = Math.min(0.80, actorMatch);
        if (bestActor && bestActorScore >= 0.20) {
          addReason(entry, 'cast-' + bestActor.id, `З ${bestActor.name}`, 7);
        }

        let bestDir = null, bestDirScore = 0;
        (entry._meta.dirs || []).forEach(d => {
          const sig = signals.directors[d.id] || 0;
          if (sig > 0) {
            const sc = sig * 0.4;
            directorMatch += sc;
            if (sc > bestDirScore) { bestDirScore = sc; bestDir = d; }
          }
          if (anti.directors[d.id]) antiDir += anti.directors[d.id] * 0.22;
        });
        directorMatch = Math.min(0.8, directorMatch);
        if (bestDir && bestDirScore >= 0.3) {
          addReason(entry, 'dir-' + bestDir.id, `Режисер: ${bestDir.name}`, 9);
        }

        let bestKw = null, bestKwScore = 0;
        (entry._meta.kws || []).forEach(kid => {
          const sc = signals.keywords[kid] || 0;
          if (sc > bestKwScore) { bestKwScore = sc; bestKw = kid; }
          if (sc) kwMatch += sc * 0.12;
          if (anti.keywords[kid]) antiKw += anti.keywords[kid] * 0.12;
        });
        kwMatch = Math.min(0.6, kwMatch);
        if (bestKw && bestKwScore > 0) {
          addReason(entry, 'kw-' + bestKw, `Тема: ${names.keywords[bestKw] || 'ваша тема'}`, 4);
        }

        entry._profileRaw = entry._genreMatch + actorMatch + directorMatch + kwMatch;
        entry._antiPenalty = entry._antiGenre + Math.min(0.4, antiDir) + Math.min(0.35, antiKw) + Math.min(0.35, antiCast);
        finalizeReasons(entry);
      }

      // Абсолютне логістичне нормування (без min-max по поточному пулу),
      // щоб скор не «їхав» при зміні складу кандидатів між оновленнями.
      // Настрій входить один раз як п'ята ознака, а не додається вдруге зверху.
      enriched.forEach((entry) => {
        entry._sortScore = recRankScore(entry, (rnd() - 0.5) * 0.08);
        /* FIX-RELEASE-COPY-META — copy before delete for poster badges */
        entry.digitalReleaseDate = (entry._meta && entry._meta.digitalDate) || null;
        entry.colId = (entry._meta && entry._meta.colId) || null;
        entry.streamingUA = (entry._meta && entry._meta.providersUA) || [];
        delete entry._seenTags;
        delete entry._meta;
        delete entry._moodBoost;
      });

      enriched.sort((a, b) => b._sortScore - a._sortScore);

      // Diversity: м'яке обмеження засилля однієї франшизи, режисера або головного актора
      const colSeen = {};
      const dirSeen = {};
      const leadSeen = {};
      enriched.forEach(entry => {
        const mc = metaCache[entry.key];
        if (!mc) return;
        let colPen = 0, dirPen = 0, leadPen = 0;
        if (mc.colId) {
          colSeen[mc.colId] = (colSeen[mc.colId] || 0) + 1;
          if (colSeen[mc.colId] > 2) colPen = Math.min(0.24, 0.08 * (colSeen[mc.colId] - 2));
        }
        const dirId = mc.dirs?.[0]?.id;
        if (dirId) {
          dirSeen[dirId] = (dirSeen[dirId] || 0) + 1;
          if (dirSeen[dirId] > 2) dirPen = Math.min(0.18, 0.06 * (dirSeen[dirId] - 2));
        }
        const leadId = mc.cast?.[0]?.id;
        if (leadId) {
          leadSeen[leadId] = (leadSeen[leadId] || 0) + 1;
          if (leadSeen[leadId] > 2) leadPen = Math.min(0.15, 0.05 * (leadSeen[leadId] - 2));
        }
        // max, а не dirPen + leadPen: інакше режисер і актор з одного фільму
        // подвійно каралися б за той самий «заліт».
        const divPen = Math.min(0.28, Math.max(colPen, dirPen, leadPen));
        if (divPen > 0) entry._sortScore -= divPen;
      });
      // Фінальне пересортування робимо після злиття з rest (див. нижче).
    }

    for (const entry of rest) {
      finalizeReasons(entry);
      // Ті самі ваги, що й для «збагачених»: інакше кандидат без метаданих
      // завжди опинявся б нижче, навіть якщо він об'єктивно кращий.
      entry._profileRaw = entry._genreMatch || 0;
      entry._antiPenalty = entry._antiGenre || 0;
      entry._sortScore = recRankScore(entry, 0);
      delete entry._seenTags;
      delete entry._meta;
      delete entry._moodBoost;
    }

    return [...enriched, ...rest].sort((a, b) => b._sortScore - a._sortScore).slice(0, 80);
  };

  const collections = [];
  const colSeen = new Set();
  seedDetails.forEach(({ seed, meta }) => {
    if (meta && meta.colId && !colSeen.has(meta.colId)) {
      colSeen.add(meta.colId);
      collections.push({ id: meta.colId, title: seed.title });
    }
  });

  return {
    items: [...finalizeType(byType.movie), ...finalizeType(byType.tv)],
    seeds: seeds.length,
    seedList: seeds.map(s => ({ key: s.key, id: s.id, type: s.type, title: s.title, avg: s.avg, isFav: s.isFav, year: s.year })),
    topGenres,
    topCast,
    topDirectors,
    topKeywords: topKw,
    names,
    collections,
    seedRecs: seedDetails.map(({ seed, recs }) => ({
      key: seed.key,
      items: (recs || []).filter(r => r && r.poster_path).slice(0, 12)
        .map(r => normalizeItem({ ...r, media_type: seed.type }))
    })),
    mood,
    mode
  };
}

function readGeneralCache() {
  try {
    const c = typeof mcCacheGet === 'function' ? mcCacheGet(GEN_CACHE, null) : JSON.parse(localStorage.getItem(GEN_CACHE));
    if (!c || !c.data) return null;
    if (Date.now() - c.ts < GEN_TTL) return c.data;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return c.data;
  } catch {}
  return null;
}
function writeGeneralCache(g) {
  try {
    if (!g) return;
    const hasMovies = (g.trMovies && g.trMovies.length) || (g.newMovies && g.newMovies.length) || (g.topMovies && g.topMovies.length);
    const hasTv = Array.isArray(g.tvStreams) && g.tvStreams.some(st => (st.pop && st.pop.length) || (st.fresh && st.fresh.length));
    if (!hasMovies && !hasTv) return;
    if (typeof mcCacheSet === 'function') mcCacheSet(GEN_CACHE, { ts: Date.now(), data: g });
  } catch {}
}
/* FIX-RECS-CACHE-V3 */
function readRecsCache(sig, critical) {
  try {
    const c = typeof mcCacheGet === 'function' ? mcCacheGet(RECS_CACHE, null) : JSON.parse(localStorage.getItem(RECS_CACHE));
    if (!c) return null;
    const age = Date.now() - c.ts;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false; /* offline-recs-ttl-bypass */
    if (age >= RECS_TTL && !offline) return null;
    if (critical && c.critical !== critical) return null;
    if (c.sig === sig || offline) {
      if (c.data && Array.isArray(c.data.items)) {
        c.data = { ...c.data, items: c.data.items.filter(x => x && !(typeof isTrackedInLib === 'function' ? isTrackedInLib(x.key) : !!lib[x.key])) };
      }
      return c.data;
    }
  } catch {}
  return null;
}
function writeRecsCache(sig, critical, data) { if (typeof mcCacheSet === 'function') mcCacheSet(RECS_CACHE, { sig, critical, ts: Date.now(), data }); } /* FIX-RECS-CACHE-V2 */

// ============ TASTE DNA (SVG & UI) ============
function tasteRadarSVG(taste, size = 240) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 42;
  const n = RATING_CRITERIA.length;
  const pts = RATING_CRITERIA.map((c, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI / n);
    const v = (taste[c.key] || 0) / 10;
    return { x: cx + r * v * Math.cos(angle), y: cy + r * v * Math.sin(angle), ax: cx + r * Math.cos(angle), ay: cy + r * Math.sin(angle), lx: cx + (r + 22) * Math.cos(angle), ly: cy + (r + 22) * Math.sin(angle), label: c.label.split(' ')[0] };
  });
  const grid = [1, 2, 3, 4].map(level => {
    const lr = r * level / 4;
    const gpts = RATING_CRITERIA.map((c, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return `${cx + lr * Math.cos(a)},${cy + lr * Math.sin(a)}`; }).join(' ');
    return `<polygon points="${gpts}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
  }).join('');
  const axes = pts.map(p => `<line x1="${cx}" y1="${cy}" x2="${p.ax}" y2="${p.ay}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`).join('');
  const labels = pts.map(p => `<text x="${p.lx}" y="${p.ly}" text-anchor="middle" dominant-baseline="middle" fill="var(--text-muted)" font-size="9.5" font-family="system-ui">${p.label}</text>`).join('');
  const poly = pts.map(p => `${p.x},${p.y}`).join(' ');
  const dots = pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="var(--accent)"/>`).join('');
  return `<svg viewBox="0 0 ${size} ${size}" style="width:100%;max-width:${size}px;display:block">${grid}${axes}<polygon points="${poly}" fill="rgba(var(--accent-rgb),0.18)" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>${dots}${labels}</svg>`;
}

function renderTasteInsight(taste) {
  if (!taste || taste.count < 3) return null;
  const vals = RATING_CRITERIA.map(c => ({ key: c.key, label: c.label, v: taste[c.key] }));
  const sorted = [...vals].sort((a, b) => b.v - a.v);
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const gap = top.v - bottom.v;
  let desc;
  if (gap < 0.8) desc = `Ти — <em>збалансований глядач</em>. Усі критерії для тебе однаково важливі.`;
  else if (top.key === 'plot') desc = `Ти — <em>наративний глядач</em>. Історія та сюжет для тебе важливіші за форму.`;
  else if (top.key === 'cast') desc = `Ти — <em>персонажний глядач</em>. Ти цінуєш акторів і хімію між ними.`;
  else if (top.key === 'style') desc = `Ти — <em>візуальний глядач</em>. Картинка, атмосфера й стиль для тебе критичні.`;
  else if (top.key === 'emotions') desc = `Ти — <em>емоційний глядач</em>. Головне — що ти відчуваєш під час перегляду.`;
  else if (top.key === 'overall') desc = `Ти — <em>інтуїтивний глядач</em>. Довіряєш загальному враженню більше за деталі.`;
  else desc = `Твій найсильніший критерій — <em>${top.label}</em>.`;
  return { top, bottom, desc };
}

function buildTasteCard(taste) {
  const card = el('div', 'taste-card');
  const header = el('div', 'taste-card-header');
  header.append(el('div', 'taste-card-title', 'Taste DNA'));
  header.append(el('div', 'taste-card-meta', 'піврозпад · 180 днів'));
  card.append(header);

  const body = el('div', 'taste-body');
  const radarWrap = el('div', 'taste-radar-wrap');
  radarWrap.innerHTML = tasteRadarSVG(taste);
  body.append(radarWrap);

  const rows = el('div', 'taste-rows');
  for (const crit of RATING_CRITERIA) {
    const v = taste[crit.key] || 0;
    const row = el('div', 'taste-row');
    const lbl = el('div', 'taste-row-label');
    lbl.append(el('span', '', crit.label));
    lbl.append(el('span', 'taste-row-val', fmtNum(v)));
    row.append(lbl);
    const bar = el('div', 'taste-row-bar');
    const fill = el('i'); fill.style.width = (v / 10 * 100) + '%';
    bar.append(fill);
    row.append(bar);
    rows.append(row);
  }
  body.append(rows);
  card.append(body);

  const insight = renderTasteInsight(taste);
  if (insight) {
    const ins = el('div', 'taste-insight');
    ins.innerHTML = insight.desc;
    card.append(ins);
  }
  return card;
}

// ============ TEMPERATURE AVATAR (Last 10 rated projects + Mood) ============
const AVATAR_MOOD_RULES = {
  fun:        { label: 'Розвага', weights: { 35: 1.0, 12: 0.9, 16: 0.85, 10751: 0.9, 10762: 0.8 } },
  intense:    { label: 'Напруга', weights: { 53: 1.1, 28: 0.95, 80: 0.9, 10768: 1.0, 9648: 0.7 } },
  dark:       { label: 'Похмуре', weights: { 27: 1.35, 80: 0.95, 53: 0.85 } },
  epic:       { label: 'Епічне',  weights: { 878: 1.15, 14: 1.1, 10765: 1.15, 10752: 1.05, 36: 0.8 } },
  chill:      { label: 'Спокій',  weights: { 10749: 1.2, 10402: 1.1, 35: 0.75, 16: 0.75 } },
  thoughtful: { label: 'Роздуми', weights: { 99: 1.35, 18: 0.58, 9648: 0.85 } }
};

/* AVATAR-V2-BASELINE */
function getLastRatedProjects(limit) {
  const entries = [];
  Object.values(lib).forEach(item => {
    if (!item || !item.key) return;
    const isEloUntracked = (item.eloUpdated && item.updated === item.eloUpdated) || (item.eloGames > 0 && !item.ratingUpdated);
    const safeBaseTs = isEloUntracked ? (item.createdAt || item.updated || 0) : (item.updated || item.createdAt || 0);
    if (item.type === 'movie') {
      const avg = computeAverage(item.ratings);
      if (avg > 0) {
        entries.push({
          key: item.key,
          item,
          title: item.title || '',
          avg,
          genres: item.genres || [],
          ts: item.ratingUpdated || safeBaseTs
        });
      }
    } else if (item.type === 'tv') {
      const sr = item.seasonRatings || {};
      const srTs = item.seasonRatingTs || {};
      Object.entries(sr).forEach(([sNum, ratings]) => {
        const avg = computeAverage(ratings);
        if (avg > 0) {
          const tvBase = (item.eloUpdated && item.updated === item.eloUpdated) || (item.eloGames > 0 && !srTs[sNum])
            ? (item.createdAt || item.updated || 0)
            : (item.updated || item.createdAt || 0);
          entries.push({
            key: `${item.key}-s${sNum}`,
            item,
            title: `${item.title} (С${sNum})`,
            avg,
            genres: item.genres || [],
            ts: srTs[sNum] || (tvBase + Number(sNum))
          });
        }
      });
    }
  });
  entries.sort((a, b) => b.ts - a.ts);
  return (limit && limit > 0) ? entries.slice(0, limit) : entries;
}

function computeTempAvatarData() {
  const all = getLastRatedProjects(0);
  if (!all.length) {
    return { empty: true, count: 0, avg: 0, baseline: 0, delta: 0, hasPureHistory: false, tempLevel: 'mild', mood: 'thoughtful', title: 'Ще спить', subtitle: 'Оціни хоча б пару фільмів або сезонів', projects: [] };
  }

  const projects = all.slice(0, 10);
  const history = all.slice(10);
  const avg = projects.reduce((s, p) => s + p.avg, 0) / projects.length;

  // Базове середнє = усі оцінки ДО останніх 10 проєктів (щоб останні 10 не зсували власну базу)
  const fallbackBase = 7.2;
  let baseline = fallbackBase;
  const hasPureHistory = history.length >= 3;
  if (hasPureHistory) {
    baseline = history.reduce((s, p) => s + p.avg, 0) / history.length;
  } else if (history.length > 0) {
    const hSum = history.reduce((s, p) => s + p.avg, 0);
    baseline = (hSum + (3 - history.length) * fallbackBase) / 3;
  }

  const delta = avg - baseline;
  // Пороги: > +0.6 золото (hot) | ±0.6 стабільний кайф (warm) | -0.6..-1.8 прохолодно (mild) | < -1.8 розчарування (cold)
  const tempLevel = delta > 0.6 ? 'hot' : (delta >= -0.6 ? 'warm' : (delta >= -1.8 ? 'mild' : 'cold'));

  const moodScores = {};
  for (const k of Object.keys(AVATAR_MOOD_RULES)) moodScores[k] = 0;

  projects.forEach((p, idx) => {
    const recencyW = 1 - idx * 0.05;
    const enjoymentW = delta >= -1.8 ? Math.max(0.35, (p.avg - 3.5) / 6.5) : 1.0;
    const w = recencyW * enjoymentW;
    for (const [mKey, rule] of Object.entries(AVATAR_MOOD_RULES)) {
      let bestG = 0;
      (p.genres || []).forEach(gid => {
        if (rule.weights[gid] && rule.weights[gid] > bestG) bestG = rule.weights[gid];
      });
      if (bestG > 0) moodScores[mKey] += w * bestG;
    }
  });

  const sortedMoods = Object.entries(moodScores).sort((a, b) => b[1] - a[1]);
  const mood = sortedMoods[0][1] > 0 ? sortedMoods[0][0] : 'thoughtful';

  const PERSONA = {
    fun: {
      hot:  ['Золотий фан', 'Останні комедії й пригоди перевершили навіть твою високу планку'],
      warm: ['Стабільний позитив', 'Легкі тайтли тримають настрій рівно у твоєму тонусі'],
      mild: ['Усмішка без захвату', 'Розважальне кіно трохи не дотягує до твоєї бази'],
      cold: ['Жарти не зайшли', 'Останні комедії чи пригоди відчутно нижче твого смаку']
    },
    intense: {
      hot:  ['Драйв на максимумі', 'Напружені трилери й екшен зайшли помітно вище середнього'],
      warm: ['Стабільний адреналін', 'Гострі сюжети впевнено тримають твій звичний рівень'],
      mild: ['Стриманий пульс', 'Екшен дивився без звичного азарту — оцінки трохи просіли'],
      cold: ['Холодний скептик', 'Останні трилери й бойовики не зачепили й розчарували']
    },
    dark: {
      hot:  ['Похмурий шедевр', 'Темна атмосфера й жорсткі історії влучили краще за все'],
      warm: ['Нуарний кайф', 'Похмурі стрічки стабільно тримають твій улюблений рівень'],
      mild: ['Сірі сутінки', 'Темного вистачило, але без вау-ефекту'],
      cold: ['Передоз мороку', 'Похмурі новинки пішли в мінус проти твоєї бази']
    },
    epic: {
      hot:  ['Золотий космос', 'Фантастика, масштаб і епік зараз на твоєму піку'],
      warm: ['На стабільній орбіті', 'Великі світи й пригоди стабільно тримають планку'],
      mild: ['Півкроку до масштабу', 'Спецефекти норм, але очікував більшого'],
      cold: ['Пафос не спрацював', 'Гучний масштаб не врятував від низьких оцінок']
    },
    chill: {
      hot:  ['Золотий дзен', 'Теплі й атмосферні історії подарували справжнє задоволення'],
      warm: ['Затишний кайф', 'Рівний, приємний ритм переглядів на твоєму рівні'],
      mild: ['Легка втома', 'Спокійне кіно трохи пішло в мінус — хочеться чогось свіжого'],
      cold: ['Заснув на титрах', 'Останній чіл виявився надто прісним для тебе']
    },
    thoughtful: {
      hot:  ['Естетичний захват', 'Глибокі драми й сенси влучили вище твоєї планки'],
      warm: ['Вдумливий баланс', 'Сильні історії стабільно підтримують твій рівень'],
      mild: ['Аналітичний скепсис', 'Цікаві задумом, але оцінки трохи нижчі за твою базу'],
      cold: ['Суворий критик', 'Останні драми не переконали — планка впала вниз']
    }
  };

  const [title, subtitle] = PERSONA[mood]?.[tempLevel] || ['Кіно-настрій', ''];
  return { empty: false, count: projects.length, historyCount: history.length, hasPureHistory, avg, baseline, delta, tempLevel, mood, moodLabel: AVATAR_MOOD_RULES[mood].label, title, subtitle, projects };
}

function buildTempAvatarSVG(data, size = 68) {
  const palettes = {
    hot:  { bg1: '#ffd166', bg2: '#ff7b5c', stroke: '#fff3c4', glow: 'rgba(255,209,102,0.52)' },
    warm: { bg1: '#ffb86c', bg2: '#9de5c3', stroke: '#f2eee9', glow: 'rgba(255,184,108,0.28)' },
    mild: { bg1: '#c5a3ff', bg2: '#6b6485', stroke: '#e5dcff', glow: 'rgba(197,163,255,0.20)' },
    cold: { bg1: '#60a5fa', bg2: '#334155', stroke: '#bfdbfe', glow: 'rgba(96,165,250,0.34)' }
  };
  const pal = palettes[data.tempLevel || 'mild'];
  const uid = 'ta' + Math.random().toString(36).slice(2, 7);
  const ink = data.tempLevel === 'cold' ? '#0f172a' : (data.mood === 'dark' ? '#140f1d' : '#1a1207');
  const lvl = data.tempLevel;

  let eyes = '';
  let mouth = '';
  let extra = '';

  if (data.empty) {
    eyes = `<path d="M22 31 Q26 34 30 31 M42 31 Q46 34 50 31" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    mouth = `<line x1="31" y1="46" x2="41" y2="46" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>`;
  } else if (data.mood === 'fun') {
    if (lvl === 'hot') {
      eyes = `<path d="M20 34 Q26 25 32 34 M40 34 Q46 25 52 34" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      mouth = `<path d="M22 40 Q36 56 50 40 Z" fill="${ink}"/>`;
      extra = `<circle cx="18" cy="40" r="3.6" fill="#ff5c5c" opacity="0.55"/><circle cx="54" cy="40" r="3.6" fill="#ff5c5c" opacity="0.55"/><circle cx="56" cy="16" r="2.2" fill="#fff" opacity="0.9"/>`;
    } else if (lvl === 'warm') {
      eyes = `<circle cx="26" cy="32" r="3.4" fill="${ink}"/><circle cx="46" cy="32" r="3.4" fill="${ink}"/><circle cx="27" cy="30.8" r="1.1" fill="#fff"/><circle cx="47" cy="30.8" r="1.1" fill="#fff"/>`;
      mouth = `<path d="M25 42 Q36 51 47 42" stroke="${ink}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
      extra = `<circle cx="19" cy="40" r="3.2" fill="#ff7b5c" opacity="0.4"/>`;
    } else if (lvl === 'mild') {
      eyes = `<circle cx="28" cy="33" r="2.9" fill="${ink}"/><circle cx="48" cy="33" r="2.9" fill="${ink}"/><path d="M21 27 Q26 25 31 27" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
      mouth = `<path d="M27 45 Q36 47 45 43" stroke="${ink}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    } else {
      eyes = `<path d="M21 29 L30 32 M51 29 L42 32" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/><circle cx="26" cy="35" r="2.7" fill="${ink}"/><circle cx="46" cy="35" r="2.7" fill="${ink}"/>`;
      mouth = `<path d="M27 49 Q36 42 45 49" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      extra = `<circle cx="19" cy="41" r="2.8" fill="#93c5fd" opacity="0.45"/><path d="M16 14 L18 19 L23 19 L19 22 L20 27 L16 24 L12 27 L13 22 L9 19 L14 19 Z" fill="#e0f2fe" opacity="0.8"/>`;
    }
  } else if (data.mood === 'intense') {
    if (lvl === 'hot') {
      eyes = `<rect x="17" y="27" width="16" height="10" rx="3" fill="${ink}"/><rect x="39" y="27" width="16" height="10" rx="3" fill="${ink}"/><line x1="33" y1="31" x2="39" y2="31" stroke="${ink}" stroke-width="2.6"/>`;
      mouth = `<path d="M25 44 Q37 53 49 41" stroke="${ink}" stroke-width="2.9" fill="none" stroke-linecap="round"/>`;
      extra = `<polygon points="57,10 51,21 56,21 53,30 62,18 57,18" fill="#fff3c4" opacity="0.95"/>`;
    } else if (lvl === 'warm') {
      eyes = `<rect x="18" y="28" width="15" height="9" rx="3" fill="${ink}"/><rect x="39" y="28" width="15" height="9" rx="3" fill="${ink}"/><line x1="33" y1="31" x2="39" y2="31" stroke="${ink}" stroke-width="2.4"/>`;
      mouth = `<path d="M27 45 Q37 49 46 43" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      extra = `<polygon points="56,12 52,20 56,20 54,26 60,18 56,18" fill="#fef3c7" opacity="0.75"/>`;
    } else if (lvl === 'mild') {
      eyes = `<rect x="18" y="29" width="15" height="7" rx="2" fill="rgba(26,18,7,0.22)" stroke="${ink}" stroke-width="2"/><rect x="39" y="29" width="15" height="7" rx="2" fill="rgba(26,18,7,0.22)" stroke="${ink}" stroke-width="2"/><line x1="33" y1="32" x2="39" y2="32" stroke="${ink}" stroke-width="2"/><circle cx="26" cy="32.5" r="2" fill="${ink}"/><circle cx="46" cy="32.5" r="2" fill="${ink}"/>`;
      mouth = `<line x1="28" y1="46" x2="44" y2="45" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>`;
    } else {
      eyes = `<g transform="rotate(-6 36 33)"><rect x="18" y="29" width="15" height="8" rx="2" fill="${ink}"/><rect x="39" y="29" width="15" height="8" rx="2" fill="${ink}"/><line x1="33" y1="32" x2="39" y2="32" stroke="${ink}" stroke-width="2.2"/></g><path d="M21 25 L30 27 M51 25 L42 27" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`;
      mouth = `<path d="M27 48 Q36 43 45 48" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M16 14 L18 19 L23 19 L19 22 L20 27 L16 24 L12 27 L13 22 L9 19 L14 19 Z" fill="#e0f2fe" opacity="0.8"/>`;
    }
  } else if (data.mood === 'dark') {
    if (lvl === 'hot') {
      eyes = `<path d="M20 30 L31 33 M52 30 L41 33" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/><circle cx="26" cy="34.5" r="2.9" fill="${ink}"/><circle cx="46" cy="34.5" r="2.9" fill="${ink}"/>`;
      mouth = `<path d="M25 45 Q37 51 48 42" stroke="${ink}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M55 11 A6.5 6.5 0 1 0 62 20 A4.8 4.8 0 1 1 55 11 Z" fill="#fff3c4" opacity="0.92"/>`;
    } else if (lvl === 'warm') {
      eyes = `<path d="M21 31 L30 33 M51 31 L42 33" stroke="${ink}" stroke-width="2.3" stroke-linecap="round"/><circle cx="26" cy="35" r="2.7" fill="${ink}"/><circle cx="46" cy="35" r="2.7" fill="${ink}"/>`;
      mouth = `<path d="M27 45 Q36 49 46 44" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M55 12 A5.5 5.5 0 1 0 61 19 A4.2 4.2 0 1 1 55 12 Z" fill="#fef3c7" opacity="0.72"/>`;
    } else if (lvl === 'mild') {
      eyes = `<line x1="21" y1="32" x2="31" y2="32" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/><line x1="41" y1="32" x2="51" y2="32" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/><circle cx="26" cy="35" r="2.3" fill="${ink}"/><circle cx="46" cy="35" r="2.3" fill="${ink}"/>`;
      mouth = `<line x1="29" y1="46" x2="43" y2="46" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>`;
      extra = `<path d="M55 13 A5 5 0 1 0 60 19 A3.8 3.8 0 1 1 55 13 Z" fill="#e5dcff" opacity="0.5"/>`;
    } else {
      eyes = `<path d="M21 28 L31 32 M51 28 L41 32" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/><circle cx="26" cy="35" r="2.8" fill="${ink}"/><circle cx="46" cy="35" r="2.8" fill="${ink}"/><path d="M22 39 Q26 41 30 39 M42 39 Q46 41 50 39" stroke="${ink}" stroke-width="1.4" fill="none" opacity="0.55"/>`;
      mouth = `<path d="M27 49 Q36 44 45 49" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M16 14 L18 19 L23 19 L19 22 L20 27 L16 24 L12 27 L13 22 L9 19 L14 19 Z" fill="#e0f2fe" opacity="0.75"/>`;
    }
  } else if (data.mood === 'thoughtful') {
    const glasses = `<circle cx="26" cy="33" r="6.5" fill="none" stroke="${ink}" stroke-width="2.2"/><circle cx="46" cy="33" r="6.5" fill="none" stroke="${ink}" stroke-width="2.2"/><line x1="32.5" y1="33" x2="39.5" y2="33" stroke="${ink}" stroke-width="2.2"/>`;
    if (lvl === 'hot') {
      eyes = glasses + `<circle cx="26" cy="33" r="2.6" fill="${ink}"/><circle cx="46" cy="33" r="2.6" fill="${ink}"/><circle cx="23" cy="30" r="1.2" fill="#fff" opacity="0.85"/>`;
      mouth = `<path d="M25 44 Q36 53 47 44" stroke="${ink}" stroke-width="2.7" fill="none" stroke-linecap="round"/>`;
    } else if (lvl === 'warm') {
      eyes = glasses + `<circle cx="26" cy="33" r="2.4" fill="${ink}"/><circle cx="46" cy="33" r="2.4" fill="${ink}"/>`;
      mouth = `<path d="M27 45 Q36 50 45 45" stroke="${ink}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    } else if (lvl === 'mild') {
      eyes = glasses + `<circle cx="26" cy="33" r="2.3" fill="${ink}"/><circle cx="46" cy="33" r="2.3" fill="${ink}"/><path d="M20 24 Q26 21 31 24" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
      mouth = `<line x1="29" y1="46" x2="43" y2="46" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>`;
    } else {
      eyes = glasses + `<path d="M20 24 L30 27 M52 24 L42 27" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/><circle cx="26" cy="34" r="2.3" fill="${ink}"/><circle cx="46" cy="34" r="2.3" fill="${ink}"/>`;
      mouth = `<path d="M28 49 Q36 44 44 49" stroke="${ink}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M16 14 L18 19 L23 19 L19 22 L20 27 L16 24 L12 27 L13 22 L9 19 L14 19 Z" fill="#e0f2fe" opacity="0.75"/>`;
    }
  } else if (data.mood === 'chill') {
    if (lvl === 'hot') {
      eyes = `<path d="M20 34 Q26 27 32 34 M40 34 Q46 27 52 34" stroke="${ink}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
      mouth = `<path d="M26 43 Q36 52 46 43" stroke="${ink}" stroke-width="2.7" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M14 55 Q20 52 26 55 M46 55 Q52 52 58 55" stroke="#fff" stroke-width="2" fill="none" opacity="0.65" stroke-linecap="round"/>`;
    } else if (lvl === 'warm') {
      eyes = `<path d="M21 34 Q26 30 31 34 M41 34 Q46 30 51 34" stroke="${ink}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
      mouth = `<path d="M28 44 Q36 49 44 44" stroke="${ink}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M14 55 Q20 52 26 55" stroke="#fff" stroke-width="2" fill="none" opacity="0.45" stroke-linecap="round"/>`;
    } else if (lvl === 'mild') {
      eyes = `<line x1="21" y1="33" x2="31" y2="33" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/><line x1="41" y1="33" x2="51" y2="33" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>`;
      mouth = `<path d="M30 45 Q36 47 42 45" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
    } else {
      eyes = `<path d="M21 29 L30 32 M51 29 L42 32" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/><line x1="22" y1="35" x2="30" y2="35" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/><line x1="42" y1="35" x2="50" y2="35" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
      mouth = `<circle cx="36" cy="46" r="3.6" fill="none" stroke="${ink}" stroke-width="2.5"/>`;
      extra = `<path d="M16 14 L18 19 L23 19 L19 22 L20 27 L16 24 L12 27 L13 22 L9 19 L14 19 Z" fill="#e0f2fe" opacity="0.8"/>`;
    }
  } else {
    // epic
    if (lvl === 'hot') {
      eyes = `<polygon points="26,26 28,31.5 34,31.5 29.5,35 31,40.5 26,37 21,40.5 22.5,35 18,31.5 24,31.5" fill="${ink}"/><polygon points="46,26 48,31.5 54,31.5 49.5,35 51,40.5 46,37 41,40.5 42.5,35 38,31.5 44,31.5" fill="${ink}"/>`;
      mouth = `<path d="M24 43 Q36 54 48 43" stroke="${ink}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
      extra = `<circle cx="14" cy="17" r="2.6" fill="#fff" opacity="0.9"/><circle cx="58" cy="15" r="2.2" fill="#fff" opacity="0.9"/>`;
    } else if (lvl === 'warm') {
      eyes = `<circle cx="26" cy="33" r="3.3" fill="${ink}"/><circle cx="46" cy="33" r="3.3" fill="${ink}"/><polygon points="26,29 27,32 30,33 27,34 26,37 25,34 22,33 25,32" fill="#fff" opacity="0.65"/>`;
      mouth = `<path d="M26 43 Q36 51 46 43" stroke="${ink}" stroke-width="2.7" fill="none" stroke-linecap="round"/>`;
      extra = `<circle cx="57" cy="17" r="2" fill="#fff" opacity="0.75"/>`;
    } else if (lvl === 'mild') {
      eyes = `<circle cx="26" cy="33" r="2.9" fill="${ink}"/><circle cx="46" cy="33" r="2.9" fill="${ink}"/>`;
      mouth = `<path d="M28 45 Q36 47 44 45" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
      extra = `<polygon points="56,14 57.5,17.5 61,18 58.2,20.2 59,23.5 56,21.5 53,23.5 53.8,20.2 51,18 54.5,17.5" fill="#e5dcff" opacity="0.7"/>`;
    } else {
      eyes = `<path d="M22 31 L30 36 M30 31 L22 36 M42 31 L50 36 M50 31 L42 36" stroke="${ink}" stroke-width="2.3" stroke-linecap="round"/>`;
      mouth = `<path d="M27 48 Q36 43 45 48" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M16 14 L18 19 L23 19 L19 22 L20 27 L16 24 L12 27 L13 22 L9 19 L14 19 Z" fill="#e0f2fe" opacity="0.75"/>`;
    }
  }

  return `<svg viewBox="0 0 72 72" width="${size}" height="${size}" style="display:block;flex-shrink:0;filter:drop-shadow(0 4px 12px ${pal.glow})">
    <defs><linearGradient id="${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${pal.bg1}"/><stop offset="100%" stop-color="${pal.bg2}"/></linearGradient></defs>
    <circle cx="36" cy="36" r="30" fill="url(#${uid})" stroke="${pal.stroke}" stroke-opacity="0.45" stroke-width="2"/>
    ${eyes}${mouth}${extra}
  </svg>`;
}

function buildTempAvatarCard(data) {
  const card = el('div', 'temp-avatar-card');
  const top = el('div', 'temp-avatar-top');
  const face = el('div', 'temp-avatar-face');
  face.innerHTML = buildTempAvatarSVG(data, 64);
  top.append(face);

  const info = el('div', 'temp-avatar-info');
  const head = el('div', 'temp-avatar-head');
  head.append(el('span', 'temp-avatar-title', data.title));
  if (!data.empty) {
    const sign = data.delta >= 0 ? '+' : '−';
    const dStr = `${sign}${fmtNum(Math.abs(data.delta))}`;
    head.append(el('span', 'temp-avatar-badge ' + data.tempLevel, `${fmtNum(data.avg)}/10 (${dStr}) · ${data.moodLabel}`));
  }
  info.append(head);
  info.append(el('div', 'temp-avatar-sub', data.subtitle));
  const metaText = data.empty
    ? 'Потрібно мінімум 1 оцінка'
    : (data.hasPureHistory
        ? `База ${fmtNum(data.baseline)} (до останніх 10) · останні ${data.count} проєктів`
        : `База ${fmtNum(data.baseline)} · останні ${data.count} проєктів (фільми + сезони)`);
  info.append(el('div', 'temp-avatar-meta', metaText));
  top.append(info);
  card.append(top);

  if (data.projects && data.projects.length) {
    const chips = el('div', 'temp-avatar-chips');
    data.projects.forEach(p => {
      const chip = el('button', 'temp-proj-chip');
      chip.type = 'button';
      chip.textContent = `${p.title} · ${fmtNum(p.avg)}`;
      chip.addEventListener('click', () => openCard(p.item));
      chips.append(chip);
    });
    card.append(chips);
  }
  return card;
}

function updateTopTasteButton(taste) {
  const btn = document.getElementById('taste-top-btn');
  if (!btn) return;
  const avatarData = computeTempAvatarData();
  const avatarEl = document.getElementById('taste-top-avatar');
  if (avatarEl) avatarEl.innerHTML = buildTempAvatarSVG(avatarData, 26);

  const moodRgb = {
    fun: '255,196,92', intense: '255,123,92', dark: '197,163,255',
    epic: '120,190,255', chill: '163,230,179', thoughtful: '180,160,255'
  }[avatarData.mood] || '163,230,179';
  btn.style.setProperty('--mood-rgb', moodRgb);

  const labelEl = document.getElementById('taste-top-label');
  if (labelEl) labelEl.textContent = String(avatarData.moodLabel || 'На орбіті').toUpperCase();

  const valEl = document.getElementById('taste-top-value');
  const t = taste || computeTasteVector();
  let summaryVal = '—';
  if (t && t.count >= 3) {
    const vals = RATING_CRITERIA.map(c => t[c.key] || 0).filter(v => v > 0);
    if (vals.length) summaryVal = (Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10).toFixed(1);
  }
  if (valEl) valEl.textContent = summaryVal;

  const deltaEl = document.getElementById('taste-top-delta');
  if (deltaEl) {
    const d = Number(avatarData.delta || 0);
    deltaEl.textContent = (d >= 0 ? '▲ +' : '▼ ') + (Math.round(d * 10) / 10).toFixed(1);
  }
}

function renderTasteSummary(taste) {
  const container = el('div', 'taste-summary-container' + (state.home.tasteExpanded ? ' is-expanded' : ''));
  const hasTaste = taste && taste.count >= 3;
  const avatarData = computeTempAvatarData();

  let summaryVal = '—';
  if (hasTaste) {
    const vals = RATING_CRITERIA.map(c => taste[c.key] || 0).filter(v => v > 0);
    if (vals.length) summaryVal = fmtNum(vals.reduce((a, b) => a + b, 0) / vals.length) + '/10';
  }

  // [LAYOUT] Синхронізуємо блок «Твій смак» на верхній панелі (десктоп).
  if (document.getElementById('taste-top-btn')) {
    const topAvatar = document.getElementById('taste-top-avatar');
    if (topAvatar) topAvatar.innerHTML = buildTempAvatarSVG(avatarData, 26);
    const topValue = document.getElementById('taste-top-value');
    if (topValue) topValue.textContent = summaryVal;
  }

  const btn = el('button', 'taste-summary');
  const iconWrap = el('span', 'taste-summary-avatar');
  iconWrap.innerHTML = buildTempAvatarSVG(avatarData, 32);
  btn.append(iconWrap);
  const labelText = avatarData.empty ? 'Твій смак у цифрах' : `Твій смак · ${avatarData.title}`;
  btn.append(el('span', 'taste-summary-label', labelText));
  btn.append(el('span', 'taste-summary-value', summaryVal));
  const chev = el('span', 'taste-summary-chevron', '▾');
  btn.append(chev);
  if (state.home.tasteExpanded) btn.classList.add('expanded');

  const panel = el('div', 'taste-panel');
  panel.style.display = state.home.tasteExpanded ? 'block' : 'none';
  panel.append(buildTempAvatarCard(avatarData));

  if (hasTaste) {
    panel.append(buildTasteCard(taste));
  } else {
    const empty = el('div', 'taste-card');
    empty.append(el('div', 'taste-empty', 'Оціни хоча б 3 тайтли — і тут з\'явиться радарна карта твого смаку.'));
    panel.append(empty);
  }

  btn.addEventListener('click', () => {
    state.home.tasteExpanded = !state.home.tasteExpanded;
    btn.classList.toggle('expanded', state.home.tasteExpanded);
    container.classList.toggle('is-expanded', state.home.tasteExpanded);
    panel.style.display = state.home.tasteExpanded ? 'block' : 'none';
  });

  container.append(btn, panel);
  return container;
}

function renderMoodPills() {
  const pills = el('div', 'mood-pills');
  const allPill = el('button', 'mood-pill' + (!state.home.mood ? ' active' : ''), '✨ Будь-який');
  allPill.addEventListener('click', () => { state.home.mood = null; state.home.sig = null; refresh(); });
  pills.append(allPill);
  for (const [key, m] of Object.entries(MOODS)) {
    const p = el('button', 'mood-pill' + (state.home.mood === key ? ' active' : ''));
    p.textContent = `${m.emoji} ${m.label}`;
    p.addEventListener('click', () => {
      state.home.mood = state.home.mood === key ? null : key;
      state.home.sig = null;
      refresh();
    });
    pills.append(p);
  }
  return pills;
}

// ============ LOAD & RENDER ============
/* FIX-RECS-CACHE-V2 */
function computeCriticalSig() {
  return `mood:${state.home.mood || 'any'}|mode:${state.home.mode || 'balance'}|dig:${settings.digitalOnly ? 1 : 0}|str:${settings.streamingOnlyUA ? 1 : 0}`;
}

function computeRecsSignature(seeds) {
  const seedSig = seeds.map(s => `${s.key}:${s.strength.toFixed(1)}:${s.resFactor.toFixed(2)}`).join('|');
  const antiSig = getAntiSeeds().map(a => a.key).join(',');
  const exSig = Object.values(lib).filter(x => x.excludeFromProfile !== undefined).map(x => `${x.key}:${x.excludeFromProfile ? 1 : 0}`).join(',');
  const adjSig = Object.entries(actorAdjust || {}).filter(([, v]) => v !== 0).map(([k, v]) => `${k}:${v}`).join(',');
  const castVals = Object.values(lib).map(x => typeof getItemCastRating === 'function' ? getItemCastRating(x) : 0).filter(v => v > 0);
  const castSig = `${castVals.length}:${castVals.reduce((a, b) => a + b, 0).toFixed(1)}`;
  const day = new Date().toISOString().slice(0, 10);
  const moodW = state.home.mood && MOODS[state.home.mood] ? (MOODS[state.home.mood].weight || 1) : 0; /* FIX-MOOD-AGGR-SIG */
  return `v17-rails|${day}|n:${state.home.refreshNonce || 0}|${seedSig}|anti:${antiSig}|ex:${exSig}|adj:${adjSig}|cast:${castSig}|mood:${state.home.mood || 'any'}:${moodW}|mode:${state.home.mode || 'balance'}|dig:${settings.digitalOnly ? 1 : 0}|str:${settings.streamingOnlyUA ? 1 : 0}`; /* FIX-IMDB-SIG */
}

async function loadHome() {
  if (state.tab !== 'home') return;
  if (!state.home.mode) state.home.mode = 'balance';

  const taste = computeTasteVector();
  // Показуємо скелетон до мережевого backfill: інакше екран висить порожнім,
  // навіть коли рекомендації вже лежать у кеші. Якщо стан уже свіжий — не моргаємо.
  const preSig = computeRecsSignature(getSeeds());
  if (!(state.home.recs && state.home.sig === preSig)) renderHomeSkeleton(taste);

  // Спочатку підтягуємо IMDb для бібліотеки, бо getSeeds() і профілі акторів
  // вже рахують residual на його основі. При помилці — тихий TMDB-фольбек.
  try { await ensureLibraryImdb(); } catch (e) { console.warn('[MyCinema/IMDb] library backfill fail:', e); }

  const seeds = getSeeds();
  const sig = computeRecsSignature(seeds);
  const critical = computeCriticalSig(); /* FIX-RECS-CACHE-V2 */

  if (!state.home.general) { const gc = readGeneralCache(); if (gc) state.home.general = gc; }
  /* LAZY_GENERAL_FETCH */
  // Тренди тепер завжди показуються під блоком «Планую» у звичайному вигляді
  // («Для мене»), тож підтягуємо їх незалежно від view. Кеш на 12 годин
  // (GEN_TTL) захищає від повторних важких запитів.
  if (!state.home.general) {
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const twoYearsAgoIso = `${new Date().getFullYear() - 2}-01-01`;
      const exGenres = EXCLUDED_TV_GENRES.join(',');
      const TV_STREAMS_DEF = [
        { id: 'netflix', title: 'Netflix',     net: '213',     logoNet: 213 },
        { id: 'hbo',     title: 'HBO / Max',   net: '49|3186', logoNet: 49 },
        { id: 'apple',   title: 'Apple TV+',   net: '2552',    logoNet: 2552 },
        { id: 'disney',  title: 'Disney+',     net: '2739',    logoNet: 2739 },
        { id: 'prime',   title: 'Prime Video', net: '1024',    logoNet: 1024 }
      ];

      const fetchPages = async (buildPath, pages) => {
        const res = await Promise.all(pages.map(pg => tmdbFetch(buildPath(pg)).catch(() => ({ results: [] }))));
        return res.flatMap(d => d.results || []);
      };

      const cleanGen = (rawList, type, limit = 50) => {
        const seen = new Set();
        const out = [];
        /* FIX-RELEASE-CLEANGEN — Level 1 filter for general sections */
        const _todayIso = new Date().toISOString().slice(0, 10);
        for (const r of rawList) {
          if (!r || !r.poster_path || isExcludedShow(r, type)) continue;
          if ((settings.digitalOnly || settings.streamingOnlyUA) && type === 'movie') {
            const _rd = (r.release_date || '').slice(0, 10);
            if (_rd && _rd > _todayIso) continue;
          }
          const item = normalizeItem({ ...r, media_type: type });
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          item.overview = '';
          out.push(item);
          if (out.length >= limit) break;
        }
        return out;
      };

      const [trM, newM, topM] = await Promise.all([
        fetchPages(pg => `/trending/movie/week?language=uk-UA&page=${pg}`, [1, 2, 3]),
        fetchPages(pg => `/discover/movie?language=uk-UA&sort_by=primary_release_date.desc&primary_release_date.lte=${todayIso}&vote_count.gte=40&page=${pg}`, [1, 2, 3]),
        fetchPages(pg => `/discover/movie?language=uk-UA&sort_by=vote_average.desc&vote_count.gte=1000&page=${pg}`, [1, 2, 3])
      ]);

      const streamRaw = await mapBatched(TV_STREAMS_DEF, 2, async st => {
        const [popRaw, newRaw, netRes] = await Promise.all([
          fetchPages(pg => `/discover/tv?language=uk-UA&sort_by=popularity.desc&vote_count.gte=30&vote_average.gte=6.0&with_networks=${encodeURIComponent(st.net)}&without_genres=${exGenres}&page=${pg}`, [1, 2]),
          fetchPages(pg => `/discover/tv?language=uk-UA&sort_by=first_air_date.desc&first_air_date.gte=${twoYearsAgoIso}&first_air_date.lte=${todayIso}&vote_count.gte=5&with_networks=${encodeURIComponent(st.net)}&without_genres=${exGenres}&page=${pg}`, [1, 2]),
          tmdbFetch(`/network/${st.logoNet}`).catch(() => null)
        ]);
        return {
          id: st.id,
          title: st.title,
          logo: netRes?.logo_path || null,
          pop: cleanGen(popRaw, 'tv', 36),
          fresh: cleanGen(newRaw, 'tv', 20)
        };
      });

      const knownStreamTvIds = new Set();
      streamRaw.forEach(st => {
        st.pop.forEach(x => knownStreamTvIds.add(x.id));
        st.fresh.forEach(x => knownStreamTvIds.add(x.id));
      });

      const [otherPopRaw, otherNewRaw] = await Promise.all([
        fetchPages(pg => `/discover/tv?language=uk-UA&sort_by=popularity.desc&vote_count.gte=50&vote_average.gte=6.2&without_genres=${exGenres}&page=${pg}`, [1, 2, 3]),
        fetchPages(pg => `/discover/tv?language=uk-UA&sort_by=first_air_date.desc&first_air_date.gte=${twoYearsAgoIso}&first_air_date.lte=${todayIso}&vote_count.gte=10&without_genres=${exGenres}&page=${pg}`, [1, 2])
      ]);

      streamRaw.push({
        id: 'other',
        title: 'Інші платформи',
        logo: null,
        pop: cleanGen(otherPopRaw.filter(x => !knownStreamTvIds.has(x.id)), 'tv', 36),
        fresh: cleanGen(otherNewRaw.filter(x => !knownStreamTvIds.has(x.id)), 'tv', 20)
      });

      state.home.general = {
        trMovies: cleanGen(trM, 'movie', 50),
        newMovies: cleanGen(newM, 'movie', 50),
        topMovies: cleanGen(topM, 'movie', 50),
        tvStreams: streamRaw
      };
      writeGeneralCache(state.home.general);
    } catch (e) { console.error(e); }
  }

  if (!seeds.length) {
    state.home.recs = { items: [], seeds: 0, mood: state.home.mood, mode: state.home.mode };
    state.home.sig = sig;
    renderHomeContent(taste);
    return;
  }
  if (state.home.recs && state.home.sig === sig) { renderHomeContent(taste); return; }
  const cached = readRecsCache(sig, critical); /* FIX-RECS-CACHE-V2 */
  if (cached) { /* FIX-CACHE-RESET */ state.home.recs = maybeShuffleRecs(cached, state.home.refreshNonce); state.home.sig = sig; state.home.shown = { movie: 14, tv: 14 } /* FIX-SHOWN-14 */; renderHomeContent(taste); return; }
  if (state.home.loading === sig) return;

  // Поки йшли мережеві запити, користувач міг піти на іншу вкладку.
  // Не малюємо скелетон поверх неї.
  if (state.tab !== 'home') return;

  state.home.loading = sig;
  renderHomeSkeleton(taste);
  try {
    const data = await buildSmartRecommendations(seeds, state.home.mood, state.home.mode);
    if (state.home.loading !== sig) return; // [LOADHOME-RACE-FIX] застарілий запит
    writeRecsCache(sig, critical, data); /* FIX-RECS-CACHE-V2 */
    state.home.recs = maybeShuffleRecs(data, state.home.refreshNonce);
    state.home.sig = sig;
    state.home.shown = { movie: 14, tv: 14 } /* FIX-SHOWN-14 */;
    renderHomeContent(taste);
  } catch (e) {
    if (state.home.loading !== sig) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      state.home.recs = { items: [], seeds: seeds.length, mood: state.home.mood, mode: state.home.mode };
      renderHomeContent(taste);
      showSyncToast('📴 Офлайн-режим');
    } else {
      box.innerHTML = `<div style="text-align:center; padding:40px; color:var(--danger);">Помилка: ${escapeHtml(e.message)}</div>`; /* FIX-HOME-ERR-ESC */
    }
  }
  finally { if (state.home.loading === sig) state.home.loading = false; }
}

function buildRecsControlsBar() {
  /* [LAYOUT] Режими «Баланс/Перлини/Свіже» остаточно прибрано — лишаємо настрої. */
  const controlsBar = el('div', 'recs-controls-bar');
  controlsBar.append(renderMoodPills());
  return controlsBar;
}

function renderHomeSkeleton(taste) {
  box.style.padding = 'var(--mc-home-pad, 0)';
  box.replaceChildren();

  updateTopTasteButton(taste);

  const wrap = el('div', 'home-wrap');
  const sec = el('section', 'home-section');
  const head = el('div', 'section-head');
  head.append(el('h2', 'section-title', '✨ Для тебе'));
  sec.append(head);
  sec.append(buildRecsControlsBar());

  const grid = el('div', 'home-grid');
  for (let i = 0; i < 14; i++) {
    const sk = el('div', 'rec-card skeleton-card');
    sk.append(el('div', 'skeleton-poster'));
    sk.append(el('div', 'skeleton-bar skeleton-line-1'));
    sk.append(el('div', 'skeleton-bar skeleton-line-2'));
    sk.append(el('div', 'skeleton-bar skeleton-line-3'));
    grid.append(sk);
  }
  sec.append(grid);
  wrap.append(sec);

  const plannedSec = buildPlannedByMoodSection();
  if (plannedSec) wrap.append(plannedSec);

  box.append(wrap);
}

function recCard(item, allowDismiss, wide) {
  const c = el('div', 'rec-card' + (wide ? ' rec-card-wide' : ''));
  const wrap = el('div', 'rec-poster-wrap');
  const p = el('img', 'rec-poster');
  const widePath = wide && item.backdrop;
  p.src = TMDB_IMG + (widePath ? 'w780' : 'w342') + (widePath || item.poster || '');
  p.loading = 'lazy'; p.decoding = 'async';
  wrap.append(p);
  if (wide) {
    const titleOverlay = el('div', 'wide-poster-title', item.title || '');
    wrap.append(titleOverlay);
    if (typeof applyTitleLogo === 'function') applyTitleLogo(item, titleOverlay, 'rec-title-logo', true);
  }
  if (allowDismiss && typeof dismissRec === 'function') {
    const disBtn = el('button', 'rec-dismiss', '✕');
    disBtn.type = 'button';
    disBtn.title = 'Не цікавить (сховати)';
    disBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissRec(item);
      c.classList.add('dismissing');
      setTimeout(() => {
        c.remove();
        if (state.home.recs?.items) {
          state.home.recs.items = state.home.recs.items.filter(x => x.key !== item.key);
        }
      }, 180);
      showSyncToast('🙈 Приховано');
    });
    wrap.append(disBtn);
  }
  /* FIX-RELEASE-REC-BADGE — badge on poster */
  if (settings.showStatusBadges !== false) try {
    const _today = new Date().toISOString().slice(0, 10);
    const _rel = (item.releaseDate || (item.year ? item.year + '-01-01' : '')).slice(0, 10);
    const _libItem = (typeof lib !== 'undefined' && lib[item.key]) || {}; /* FIX-RELEASE-REC-BADGE-LIB */
    const _dig = _libItem.digitalReleaseDate || item.digitalReleaseDate || null;
    const _str = (_libItem.streamingUA && _libItem.streamingUA.length ? _libItem.streamingUA : item.streamingUA) || [];
    let _b = null;
    /* FIX-RELEASE-OLD-FALLBACK */
    const _oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (_str && _str.length > 0) _b = { cls: 'stream', txt: '📺 UA' };
    else if (_dig && _dig <= _today) _b = { cls: 'ok', txt: '💾 Цифра' };
    else if (_rel && _rel > _today) _b = { cls: 'wait', txt: '⏳ Скоро' };
    else if (_rel && _rel <= _today && _rel < _oldDate) _b = { cls: 'ok', txt: '💾 Цифра' };
    else if (_rel && _rel <= _today && (!_dig || _dig > _today) && item.type === 'movie') _b = { cls: 'cinema', txt: '🎬 Кіно' };
    if (_b) wrap.append(el('span', 'rec-badge ' + _b.cls, _b.txt));
  } catch (e) {}
  if (typeof item._sortScore === 'number' && item._sortScore > 0) {
    wrap.append(el('span', 'rec-match', Math.round(item._sortScore * 100) + '%'));
  }
  c.append(wrap);
  if (!wide) c.append(el('div', 'row-title', item.title));
  let meta = item.year || '';
  if (item.tmdbRating) meta += (meta ? ' · ' : '') + item.tmdbRating.toFixed(1);
  c.append(el('div', 'row-meta', meta));
  if (item._reasons && item._reasons.length) {
    c.append(el('div', 'rec-why', item._reasons.join(' · ')));
  }
  c._mcItem = item;
  c.addEventListener('click', () => openCard(item));
  return c;
}

function buildPlannedByMoodSection() {
  const allPlanned = Object.values(lib)
    .filter(x => x.status === 'planned' && x.poster)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (!allPlanned.length) return null;

  /* [LAYOUT] Усі заплановані вже відсортовані за датою зміни (спадання). */
  const pool = allPlanned;
  const sec = el('section', 'home-section planned-mood-sec home-recs-panel');
  const head = el('div', 'section-head');
  const titleWrap = el('div', 'planned-head-left');
  titleWrap.append(el('h2', 'section-title', '🎯 З твого «Планую»'));

  const rouletteBtn = el('button', 'roulette-btn', '🎲 Вибрати за мене');
  rouletteBtn.type = 'button';
  rouletteBtn.addEventListener('click', () => {
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) openCard(pick);
  });

  head.append(titleWrap, rouletteBtn);
  sec.append(head);

  /* [LAYOUT] Горизонтальна стрічка зі стрілками — як у блоці «Для тебе». */
  const stripWrap = el('div', 'recs-strip-wrap');
  const strip = el('div', 'home-grid recs-strip');
  pool.forEach(item => strip.append(recCard(item, false)));

  const step = () => {
    const card = strip.querySelector('.rec-card');
    return card ? (card.getBoundingClientRect().width + 12) * 3 : 360;
  };
  const prev = el('button', 'recs-strip-arrow recs-strip-prev');
  const next = el('button', 'recs-strip-arrow recs-strip-next');
  prev.type = 'button'; next.type = 'button';
  prev.title = 'Назад'; next.title = 'Далі';
  prev.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  next.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  prev.addEventListener('click', () => strip.scrollBy({ left: -step(), behavior: 'smooth' }));
  next.addEventListener('click', () => strip.scrollBy({ left: step(), behavior: 'smooth' }));

  stripWrap.append(prev, strip, next);
  sec.append(stripWrap);
  return sec;
}

function buildHomeTypeSwitch(taste) {
  const sw = el('div', 'home-inline-type-switch');
  const mBtn = el('button', 'home-inline-pill' + (state.home.tab === 'movie' ? ' active' : ''), '🎬 Фільми');
  const tBtn = el('button', 'home-inline-pill' + (state.home.tab === 'tv' ? ' active' : ''), '📺 Серіали');
  mBtn.type = 'button'; tBtn.type = 'button';
  mBtn.addEventListener('click', () => {
    if (state.home.tab === 'movie') return;
    state.home.tab = 'movie';
    try { localStorage.setItem('mycinema.home.tab', 'movie'); } catch (e) {}
    state.home.shown.movie = 14;
    renderHomeContent(taste);
  });
  tBtn.addEventListener('click', () => {
    if (state.home.tab === 'tv') return;
    state.home.tab = 'tv';
    try { localStorage.setItem('mycinema.home.tab', 'tv'); } catch (e) {}
    state.home.shown.tv = 14;
    renderHomeContent(taste);
  });
  sw.append(mBtn, tBtn);
  return sw;
}


/* ================= RAILS UI ================= */
const HERO_ROTATE_MS = 18000;
let _heroVisibilityHandler = null;

window.refreshHomeRecs = () => {
  if (typeof mcCacheDel === 'function') mcCacheDel(RECS_CACHE);
  state.home.refreshNonce = (state.home.refreshNonce || 0) + 1;
  state.home.sig = null; state.home.recs = null;
  state.home.shown = { movie: 14, tv: 14 };
  state.home.genShown = {};
  _clearHeroTimer();
  refresh();
  showSyncToast('✨ Оновлено');
};

window.setHomeType = (type) => {
  if (type !== 'movie' && type !== 'tv') return;
  state.home.tab = type;
  try { localStorage.setItem('mycinema.home.tab', type); } catch (e) {}
  state.home.shown[type] = 14;
  setTab('home');
};
function _clearHeroTimer() {
  if (window._mcHeroTimer) { clearInterval(window._mcHeroTimer); window._mcHeroTimer = null; }
  if (_heroVisibilityHandler) {
    document.removeEventListener('visibilitychange', _heroVisibilityHandler);
    _heroVisibilityHandler = null;
  }
}

function getTvStreamItems(st) {
  const popPool = (st.pop || []).filter(x => !(typeof isDismissed === 'function' && isDismissed(x.key)));
  const newPool = (st.fresh || []).filter(x => !(typeof isDismissed === 'function' && isDismissed(x.key)));
  const pref = {};
  Object.values(lib).forEach(x => {
    if (x.type !== 'tv') return;
    const avg = computeItemRating(x).avg;
    if (avg < 7 && !x.favorite) return;
    const w = ((avg || 8) / 10) * Math.max(0.2, tasteDecay(x.updated));
    (x.genres || []).forEach(gid => { pref[gid] = (pref[gid] || 0) + w; });
  });
  const rankedPop = popPool.map((x, idx) => {
    const saved = lib[x.key];
    const seenPenalty = saved && (saved.status === 'watched' || saved.status === 'dropped') ? 100 : 0;
    let gBoost = 0;
    (x.genres || []).forEach(gid => { gBoost += (pref[gid] || 0); });
    return { x, sortVal: idx - Math.min(gBoost, 4) * 1.2 + seenPenalty };
  }).sort((a, b) => a.sortVal - b.sortVal).map(o => o.x);
  const popPick = rankedPop.slice(0, 36);
  const used = new Set(popPick.map(x => x.key));
  const newPick = newPool.filter(x => !used.has(x.key)).slice(0, 20);
  const mixed = [];
  let pi = 0, ni = 0;
  while (mixed.length < 50 && (pi < popPick.length || ni < newPick.length)) {
    if (pi < popPick.length && mixed.length < 50) mixed.push(popPick[pi++]);
    if (pi < popPick.length && mixed.length < 50) mixed.push(popPick[pi++]);
    if (ni < newPick.length && mixed.length < 50) mixed.push(newPick[ni++]);
  }
  return mixed;
}

function renderHomeHero(hero) {
  _clearHeroTimer();
  const sec = el('section', 'home-hero');
  const bgA = el('div', 'home-hero-bg active');
  const bgB = el('div', 'home-hero-bg');
  const inner = el('div', 'home-hero-inner');
  const badge = el('div', 'home-hero-badge', '✨ Для тебе сьогодні');
  const title = el('h1', 'home-hero-title');
  const metaLine = el('div', 'home-hero-meta');
  const why = el('div', 'home-hero-why');
  const actions = el('div', 'home-hero-actions');
  const moreBtn = el('button', 'hero-btn primary', 'Детальніше');
  moreBtn.type = 'button';
  const listBtn = el('button', 'hero-btn', 'У список');
  listBtn.type = 'button';
  const dots = el('div', 'home-hero-dots');
  const arrowPrev = el('button', 'hero-arrow hero-arrow-prev');
  arrowPrev.type = 'button';
  arrowPrev.title = 'Попередній';
  arrowPrev.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const arrowNext = el('button', 'hero-arrow hero-arrow-next');
  arrowNext.type = 'button';
  arrowNext.title = 'Наступний';
  arrowNext.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  actions.append(moreBtn, listBtn);
  inner.append(badge, title, metaLine, why, actions, dots);
  sec.append(bgA, bgB, inner, arrowPrev, arrowNext);

  const slides = [hero.item].concat(hero.slides || []);
  let idx = 0;
  let bgTop = bgA;
  let firstPaint = true;
  const paint = () => {
    const it = slides[idx % slides.length] || {};
    const path = it.backdrop || it.poster;
    const url = path ? `url("${TMDB_IMG}w1280${path}")` : '';
    if (firstPaint) {
      bgTop.style.backgroundImage = url;
      firstPaint = false;
    } else {
      const next = bgTop === bgA ? bgB : bgA;
      next.style.backgroundImage = url;
      next.classList.add('active');
      bgTop.classList.remove('active');
      bgTop = next;
      inner.classList.remove('swap');
      void inner.offsetWidth;
      inner.classList.add('swap');
    }
    title.textContent = it.title || '';
    let meta = it.year || '';
    const rr = (typeof imdbRef === 'function') ? imdbRef(it) : null;
    if (rr && rr.rating > 0) meta += (meta ? ' · ' : '') + 'IMDb ' + rr.rating.toFixed(1);
    if (it.genres && it.genres.length && typeof GENRES !== 'undefined') {
      const g = GENRES.find(x => x.id === it.genres[0]);
      if (g && g.name) meta += (meta ? ' · ' : '') + g.name;
    }
    if (typeof it._sortScore === 'number') meta += (meta ? ' · ' : '') + Math.round(it._sortScore * 100) + '% збіг';
    metaLine.textContent = meta;
    why.textContent = (it._reasons || []).join(' · ');
    [...dots.children].forEach((d, i) => d.classList.toggle('active', i === idx % slides.length));
  };
  moreBtn.onclick = () => openCard(slides[idx % slides.length]);
  listBtn.onclick = () => {
    const it = slides[idx % slides.length];
    if (!it) return;
    updateCore(it, { status: 'planned' });
    showSyncToast('📅 Додано у «Планую»');
  };
  slides.forEach((_, i) => {
    const dot = el('button', 'hero-dot' + (i ? '' : ' active'));
    dot.type = 'button';
    dot.title = `Слайд ${i + 1}`;
    dot.onclick = () => { if (idx % slides.length !== i) go(i - (idx % slides.length)); };
    dots.append(dot);
  });
  paint();
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const advance = () => { idx = (idx + 1) % slides.length; paint(); };
  const start = () => { if (!window._mcHeroTimer && !document.hidden && !reduce) window._mcHeroTimer = setInterval(advance, HERO_ROTATE_MS); };
  const stop = () => { if (window._mcHeroTimer) { clearInterval(window._mcHeroTimer); window._mcHeroTimer = null; } };
  const go = (delta) => {
    idx = (idx + delta + slides.length) % slides.length;
    paint();
    stop();
    start();
  };
  arrowPrev.onclick = () => go(-1);
  arrowNext.onclick = () => go(1);

  /* Touch: гортання слайдів свайпом (стрілки на мобільних сховані CSS) */
  (function attachHeroSwipe() {
    let x0 = 0, y0 = 0, t0 = 0, active = false;
    sec.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a, .home-hero-dots, .hero-dot')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      active = true; x0 = e.clientX; y0 = e.clientY; t0 = Date.now();
    });
    sec.addEventListener('pointerup', (e) => {
      if (!active) return;
      active = false;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      if (Date.now() - t0 > 900) return; /* повільне перетягування — не свайп */
      go(dx < 0 ? 1 : -1);
      stop(); start();
    });
    sec.addEventListener('pointercancel', () => { active = false; });
  })();

  if (slides.length > 1 && !reduce) {
    _heroVisibilityHandler = () => { if (document.hidden) stop(); else start(); };
    document.addEventListener('visibilitychange', _heroVisibilityHandler);
    start();
  } else {
    arrowPrev.style.display = 'none';
    arrowNext.style.display = 'none';
  }
  return sec;
}

function renderRailSection(rail) {
  const sec = el('section', 'home-section rail-section');
  const head = el('div', 'section-head rail-head');
  const h = el('h2', 'section-title', rail.title);
  head.append(h);
  if (rail.subtitle) head.append(el('span', 'section-sub', rail.subtitle));
  const expand = el('button', 'rail-expand', 'Показати все');
  expand.type = 'button';
  head.append(expand);

  const stripWrap = el('div', 'rail-strip-wrap');
  const grid = el('div', 'rail-strip');
  let filled = false;
  const fillRail = () => {
    if (filled) return;
    filled = true;
    const frag = document.createDocumentFragment();
    rail.items.forEach(it => frag.append(recCard(it, true, true)));
    grid.append(frag);
  };
  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((entries) => {
      if (entries.some(x => x.isIntersecting)) { fillRail(); sec.classList.add('revealed'); io.disconnect(); sec._railIO = null; }
    }, { rootMargin: '500px 0px' });
    sec._railIO = io;
    io.observe(sec);
  } else {
    fillRail();
    sec.classList.add('revealed');
  }
  const step = () => {
    const card = grid.querySelector('.rec-card');
    return grid.clientWidth * 0.8 || 380;
  };
  // Колесо/тачпад над стрічкою гортає її горизонтально,
  // а на краях знову віддає скрол сторінці.
  const prev = el('button', 'recs-strip-arrow recs-strip-prev');
  const next = el('button', 'recs-strip-arrow recs-strip-next');
  prev.type = 'button'; next.type = 'button';
  prev.title = 'Назад'; next.title = 'Далі';
  prev.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  next.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  prev.addEventListener('click', () => grid.scrollBy({ left: -step(), behavior: 'smooth' }));
  next.addEventListener('click', () => grid.scrollBy({ left: step(), behavior: 'smooth' }));
  stripWrap.append(prev, grid, next);
  sec.append(head, stripWrap);
  expand.onclick = () => {
    fillRail();
    sec.classList.add('revealed');
    const on = sec.classList.toggle('expanded');
    expand.textContent = on ? 'Згорнути' : 'Показати все';
  };
  return sec;
}


/* ================= СТРІМІНГ-ХАБИ (Серіали) ================= */
const STREAM_HUBS = [
  { id: 'all', label: 'Усі' },
  { id: 'netflix', label: 'NETFLIX', network: 213, logo: '/rK1KljqmbvO9HQa1PBFLILWah72.png', color: '#e50914', tagline: 'Оригінальні хіти й свіжі прем’єри' },
  { id: 'apple', label: 'Apple TV+', network: 2552, logo: '/v9SnyvYt0U3KGgBH3Sbh3z4yODe.png', color: '#f5f5f7', tagline: 'Кінематографічні оригінали' },
  { id: 'hbo', label: 'HBO / Max', network: 49, logo: '/skypuy7SXuugIQeYg0IglmzoKaS.png', color: '#9b6cff', tagline: 'Золота колекція й престижні серіали' },
  { id: 'prime', label: 'Prime Video', network: 1024, logo: '/gMZdpavHmxFNnLpMHwVxfqeux2g.png', color: '#00a8e0', tagline: 'Оригінали й великі каталоги' },
  { id: 'disney', label: 'Disney+', network: 2739, logo: '/5eZ872CghnHFLB1j8grszbrx0dx.png', color: '#3b82f6', tagline: 'Саги, сімейні й Marvel' },
  { id: 'hulu', label: 'Hulu', provider: 15, region: 'US', logo: '/44uAnmSqvA4yBOdbPWN8YgQHjWm.png', color: '#1ce783', tagline: 'Американські прем’єри та ексклюзиви' },
  { id: 'peacock', label: 'Peacock', provider: 386, region: 'US', logo: '/a1UIdq5BrkcAxnxcUhFsNbXnxeu.png', color: '#f5b300', tagline: 'Хіти NBCUniversal' },
  { id: 'sky', label: 'Sky', provider: 29, region: 'GB', logo: '/1Yvl9eP3pmktqChitnFhHJHcBtX.png', color: '#e6b0ff', tagline: 'Британські прем’єри й HBO' }
];
const _hubCache = new Map();

function _hubDiscover(hub, extra) {
  const p = new URLSearchParams({
    language: 'uk-UA',
    with_type: '2|4',
    'vote_count.gte': '120',
    'vote_average.gte': '6.5'
  });
  if (hub.network) p.set('with_networks', String(hub.network));
  if (hub.provider) {
    p.set('with_watch_providers', String(hub.provider));
    p.set('watch_region', hub.region || 'US');
    p.set('with_watch_monetization_types', 'flatrate');
  }
  Object.keys(extra || {}).forEach(k => p.set(k, extra[k]));
  return '/discover/tv?' + p.toString();
}

const HUB_POOL_SIZE = 60;
const HUB_WINDOW = 30;
const HUB_ROTATE_MS = 2 * 24 * 60 * 60 * 1000;

async function fetchHubRails(hubId) {
  const epoch = Math.floor(Date.now() / HUB_ROTATE_MS);
  const cacheKey = hubId + '|' + epoch;
  if (_hubCache.has(cacheKey)) return _hubCache.get(cacheKey);
  try {
    const persisted = typeof mcCacheGet === 'function' ? mcCacheGet('mycinema.hub.' + cacheKey, null) : null;
    if (persisted && persisted.rails && Date.now() - (persisted.ts || 0) < HUB_ROTATE_MS) {
      _hubCache.set(cacheKey, persisted.rails);
      return persisted.rails;
    }
  } catch (e) {}
  const hub = STREAM_HUBS.find(x => x.id === hubId) || STREAM_HUBS[0];
  const year = new Date().getFullYear() - 2;
  const specs = hub.id === 'all'
    ? [
        { id: 'hub-trending', title: 'У тренді цього тижня', subtitle: 'Зараз дивляться', path: '/trending/tv/week?language=uk-UA' },
        { id: 'hub-mini', title: 'Міні-серіали на вихідні', subtitle: 'Завершені історії', path: _hubDiscover(hub, { with_type: '2', sort_by: 'vote_average.desc', 'vote_count.gte': '300' }) },
        { id: 'hub-cult', title: 'Завершені культові серіали', subtitle: 'Без кліфхенгерів', path: _hubDiscover(hub, { with_status: '3', sort_by: 'vote_average.desc', 'vote_count.gte': '60', 'vote_average.gte': '6.0' }) }
      ]
    : [
        { id: 'hub-' + hub.id + '-best', title: `Найкраще для вас на ${hub.label}`, subtitle: 'За вашим смаком', path: _hubDiscover(hub, { sort_by: 'vote_average.desc' }) },
        { id: 'hub-' + hub.id + '-new', title: `Нове й популярне на ${hub.label}`, subtitle: 'Останні роки', path: _hubDiscover(hub, { sort_by: 'popularity.desc', 'first_air_date.gte': year + '-01-01', 'vote_count.gte': '30', 'vote_average.gte': '6.0' }) },
        { id: 'hub-' + hub.id + '-mini', title: `Міні-серіали ${hub.label}`, subtitle: '6–8 серій', path: _hubDiscover(hub, { with_type: '2', sort_by: 'vote_average.desc', 'vote_count.gte': '300' }) },
        { id: 'hub-' + hub.id + '-done', title: `Завершені серіали ${hub.label}`, subtitle: 'Дивитись повністю', path: _hubDiscover(hub, { with_status: '3', sort_by: 'vote_average.desc', 'vote_count.gte': '60', 'vote_average.gte': '6.0' }) }
      ];
  const pagePath = (path, page) => path + (path.indexOf('?') === -1 ? '?' : '&') + 'page=' + page;
  const out = await Promise.all(specs.map(async spec => {
    try {
      const pages = await Promise.all([1, 2, 3, 4, 5].map(p => tmdbFetch(pagePath(spec.path, p)).catch(() => ({ results: [] }))));
      const pool = pages.flatMap(d => d.results || [])
        .filter(x => x && x.poster_path && !(typeof isExcludedShow === 'function' && isExcludedShow(x, 'tv')))
        .map(x => normalizeItem({ ...x, media_type: 'tv' }));
      const seen = new Set();
      const unique = pool.filter(x => x.id && !seen.has(x.id) && seen.add(x.id));
      const source = unique.length ? unique : pool;
      // Кожні 2 дні вікно зсувається на 15 тайтлів: 15 приходить, 15 іде.
      // Для малого пулу зменшуємо вікно, бо інакше завжди повертався б той самий набір.
      if (source.length <= HUB_WINDOW) return { id: spec.id, title: spec.title, subtitle: spec.subtitle, items: source };
      const maxStart = source.length - HUB_WINDOW;
      const start = (epoch * (HUB_WINDOW / 2)) % (maxStart + 1);
      const items = Array.from({ length: HUB_WINDOW }, (_, i) => source[start + i]);
      return { id: spec.id, title: spec.title, subtitle: spec.subtitle, items };
    } catch (e) {
      return { id: spec.id, title: spec.title, subtitle: spec.subtitle, items: [] };
    }
  }));
  _hubCache.set(cacheKey, out);
  try { if (typeof mcCacheSet === 'function') mcCacheSet('mycinema.hub.' + cacheKey, { ts: Date.now(), rails: out }); } catch (e) {}
  // тримаємо лише останні 3 доби кешу
  [..._hubCache.keys()].forEach(k => {
    const e = Number(String(k).split('|')[1]);
    if (isFinite(e) && epoch - e > 3) _hubCache.delete(k);
  });
  return out;
}

function renderHubPills(scope) {
  const active = state.home.hub || 'all';
  const wrap = el('div', 'hub-pills');
  STREAM_HUBS.forEach(h => {
    const b = el('button', 'hub-pill' + (h.id === active ? ' active' : ''), h.label);
    b.type = 'button';
    b.onclick = () => {
      state.home.hub = h.id;
      try { localStorage.setItem('mycinema.home.hub', h.id); } catch (e) {}
      _clearHeroTimer();
      if (scope === 'streamings') renderStreamings(); else refresh();
    };
    wrap.append(b);
  });
  return wrap;
}

let _settingsMoved = [];

function restoreSettingsPageBoxes() {
  _settingsMoved.forEach(item => {
    if (item.box && item.parent && item.box.parentElement !== item.parent) item.parent.appendChild(item.box);
  });
  _settingsMoved = [];
}

function renderSettingsPage() {
  if (state.tab !== 'settings') return;
  restoreSettingsPageBoxes();
  box.replaceChildren();
  box.style.padding = '0 12px';
  box.append(el('h2', 'section-title', 'Налаштування'));

  const grid = el('div', 'settings-page-grid');
  const groups = (typeof SETTINGS_GROUPS !== 'undefined') ? SETTINGS_GROUPS : {};
  const ico = (path) => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  const titles = {
    view: [ico('<circle cx="12" cy="12" r="9"/><circle cx="7.5" cy="10" r="1.2"/><circle cx="12" cy="6.8" r="1.2"/><circle cx="16.5" cy="9" r="1.2"/><path d="M12 21c3.3 0 5-2 5-4.3 0-2-1.7-3.2-3.6-3.2-1.5 0-2.4.9-2.4 2.1 0 1.1.8 1.8.8 2.6 0 .9-.7 1.5-1.7 1.5-1.6 0-2.9-1.6-2.9-4.2 0-3.6 2.9-6.5 6.5-6.5"/>'), 'Вигляд', 'Кольори, постери, логотипи'],
    online: [ico('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.4 3.8 5.5 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.5-3.8-9S9.5 5.4 12 3Z"/>'), 'Онлайн', 'Джерела перегляду й фільтри релізів'],
    extra: [ico('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'), 'Додаткові функції', 'Клавіатура, ефекти, інструменти'],
    data: [ico('<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'), 'Дані', 'Бібліотека, експорт, синхронізація']
  };

  if (typeof renderSettingsSwatches === 'function') renderSettingsSwatches();
  if (typeof injectSnowToggle === 'function') injectSnowToggle();
  if (typeof injectExtraSettings === 'function') injectExtraSettings();
  if (typeof injectDismissedReset === 'function') injectDismissedReset();
  if (typeof refreshSettingsControls === 'function') refreshSettingsControls();

  Object.keys(groups).forEach(key => {
    if (key === 'data') return;
    const modal = document.getElementById(groups[key]);
    const inner = modal && modal.querySelector('.settings-box');
    const card = el('section', 'settings-page-card');
    const meta = titles[key] || ['⚙️', key, ''];
    const icon = el('div', 'settings-page-icon');
    icon.innerHTML = meta[0];
    card.append(icon);
    card.append(el('h3', 'settings-page-title', meta[1]));
    card.append(el('div', 'settings-page-desc', meta[2]));
    if (inner) {
      inner.parentElement.removeChild(inner);
      inner.classList.add('settings-page-inner');
      card.append(inner);
      _settingsMoved.push({ box: inner, parent: modal });
    }
    grid.append(card);
  });

  // Акаунт + оновлення рекомендацій
  const accCard = el('section', 'settings-page-card');
  const accIcon = el('div', 'settings-page-icon');
  accIcon.innerHTML = ico('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1.5A4.5 4.5 0 0 1 8.5 15h7a4.5 4.5 0 0 1 4.5 4.5V21"/>');
  accCard.append(accIcon);
  accCard.append(el('h3', 'settings-page-title', 'Акаунт'));
  accCard.append(el('div', 'settings-page-desc', (window.currentUser && window.currentUser.email) || 'Гість'));
  const refreshSlot = document.getElementById('refresh-slot');
  const refreshBtn = refreshSlot && refreshSlot.querySelector('button');
  if (refreshBtn) {
    refreshBtn.classList.add('settings-page-action');
    refreshSlot.removeChild(refreshBtn);
    accCard.append(refreshBtn);
    _settingsMoved.push({ box: refreshBtn, parent: refreshSlot });
  }
  const logout = el('button', 'settings-page-action', 'Вийти з акаунту');
  logout.type = 'button';
  logout.onclick = () => { if (typeof logoutUser === 'function') logoutUser(); };
  accCard.append(logout);

  // Елементи розділу «Дані» — нижче за акаунт
  const dataModal = document.getElementById(groups.data);
  const dataInner = dataModal && dataModal.querySelector('.settings-box');
  if (dataInner) {
    dataInner.parentElement.removeChild(dataInner);
    dataInner.classList.add('settings-page-inner');
    accCard.append(dataInner);
    _settingsMoved.push({ box: dataInner, parent: dataModal });
  }
  grid.append(accCard);

  box.append(grid);
}

window.__renderSettingsPage = renderSettingsPage;
window.renderSettingsPage = renderSettingsPage;

function renderStreamings() {
  if (state.tab !== 'streamings') return;
  box.replaceChildren();
  box.style.padding = '0 12px';
  box.append(el('h2', 'section-title', 'Стріммінги'));
  box.append(el('p', 'streamings-lead', 'Профілі платформ. Обери бренд — і ми покажемо його добірки серед серіалів.'));

  const grid = el('div', 'streaming-profiles');
  STREAM_HUBS.filter(h => h.id !== 'all').forEach(h => {
    const card = el('button', 'streaming-profile');
    card.type = 'button';
    card.style.setProperty('--hub-accent', h.color || '#ffb86c');

    const glow = el('div', 'streaming-profile-glow');
    const logo = el('img', 'streaming-profile-logo');
    logo.src = TMDB_IMG + 'w300' + h.logo;
    logo.alt = h.label;
    logo.loading = 'lazy';
    const name = el('div', 'streaming-profile-name', h.label);
    const desc = el('div', 'streaming-profile-desc', h.tagline || '');
    const meta = el('div', 'streaming-profile-meta',
      h.network ? ('Originals · network ' + h.network) : ('Provider ' + h.provider + ' · ' + (h.region || 'US')));
    const open = el('div', 'streaming-profile-open', 'Відкрити добірки →');

    card.append(glow, logo, name, desc, meta, open);
    card.onclick = () => {
      state.home.hub = h.id;
      try { localStorage.setItem('mycinema.home.hub', h.id); } catch (e) {}
      if (typeof openStreamingProfile === 'function') openStreamingProfile(h.id);
      else {
        state.home.tab = 'tv';
        setTab('home');
      }
    };
    grid.append(card);
  });
  box.append(grid);
}

function renderHomeRails(recs, wrap) {
  const type = state.home.tab;
  const items = (recs.items || []).filter(x =>
    x.type === type &&
    !(typeof isTrackedInLib === 'function' ? isTrackedInLib(x.key) : !!lib[x.key]) &&
    !(typeof isDismissed === 'function' && isDismissed(x.key)));
  const g = state.home.general || {};
  const genreNames = {};
  (typeof GENRES !== 'undefined' ? GENRES : []).forEach(x => { genreNames[x.id] = x.name; });
  const criteria = (typeof RATING_CRITERIA !== 'undefined' ? RATING_CRITERIA : [])
    .map(x => ({ key: x.key, label: x.label }));
  const seedYears = (recs.seedList || [])
    .map(x => parseInt(x.year, 10))
    .filter(y => y > 1985);
  const tvStreams = (g.tvStreams || []).map(st => ({
    id: st.id, title: st.title, logo: st.logo, items: getTvStreamItems(st)
  }));
  const opts = {
    items,
    general: g,
    tvStreams,
    seeds: recs.seedList || [],
    topGenres: recs.topGenres || [],
    topCast: recs.topCast || [],
    topDirectors: recs.topDirectors || [],
    topKeywords: recs.topKeywords || [],
    names: recs.names || {},
    genreNames,
    collections: recs.collections || [],
    seedRecs: (recs.seedRecs || []).map(sr => ({
      key: sr.key,
      items: (sr.items || []).filter(x =>
        x.type === type &&
        !(typeof isTrackedInLib === 'function' ? isTrackedInLib(x.key) : !!lib[x.key]) &&
        !(typeof isDismissed === 'function' && isDismissed(x.key)))
    })),
    criteria,
    moods: (typeof MOODS !== 'undefined' ? MOODS : {}),
    seedYears,
    decades: [1980, 1990, 2000, 2010, 2020],
    type,
    mode: recs.mode || state.home.mode || 'balance',
    userId: (window.currentUser && window.currentUser.uid) || 'guest',
    dateKey: new Date().toISOString().slice(0, 10),
    nonce: state.home.refreshNonce || 0,
    nowYear: new Date().getFullYear(),
    limit: 18,
    ratingOf: (x) => (typeof imdbRef === 'function' ? imdbRef(x) : null)
  };
  const result = (typeof buildRails === 'function') ? buildRails(opts) : { hero: null, rails: [] };
  state.home.rails = result;
  if (result.hero) wrap.append(renderHomeHero(result.hero));

  if (type === 'tv') {
    try { state.home.hub = localStorage.getItem('mycinema.home.hub') || state.home.hub || 'all'; } catch (e) {}
    wrap.append(renderHubPills());
  }

  const host = el('div', 'rails-host');
  wrap.append(host);
  const paint = (res) => {
    host.querySelectorAll('.rail-section').forEach(sec => { if (sec._railIO) sec._railIO.disconnect(); });
    host.replaceChildren();
    res.rails.forEach(r => host.append(renderRailSection(r)));
  };
  paint(result);

  if (type === 'tv' && typeof fetchHubRails === 'function') {
    const hubId = state.home.hub || 'all';
    fetchHubRails(hubId).then(extra => {
      if (!host.isConnected) return;
      const hubOpts = hubId === 'all'
        ? Object.assign({}, opts, { extraRails: extra, limit: 20 })
        : {
            items: [], general: {}, generalPool: [], tvStreams: [],
            seeds: [], seedRecs: [], topGenres: [], topCast: [], topDirectors: [],
            topKeywords: [], names: {}, genreNames: {}, collections: [], criteria: [],
            moods: {}, seedYears: [], decades: [],
            type: 'tv', mode: 'none', nowYear: opts.nowYear, userId: opts.userId,
            dateKey: opts.dateKey, nonce: 0, limit: 12, ratingOf: opts.ratingOf,
            extraRails: extra
          };
      const merged = buildRails(hubOpts);
      state.home.rails = merged;
      paint(merged);
    });
  }
}


/* ================= HOVER PREVIEW (1.5s) ================= */
(function initHoverPreview() {
  // Лише справжній десктопний pointer: touch/coarse never triggers preview
  if (typeof matchMedia === 'function' &&
      (!matchMedia('(hover: hover)').matches || !matchMedia('(pointer: fine)').matches)) return;
  let timer = null, hideTimer = null, activeCard = null, preview = null;

  const hide = () => {
    clearTimeout(timer); clearTimeout(hideTimer);
    activeCard = null;
    if (preview) {
      const iframe = preview.querySelector('iframe');
      if (iframe) iframe.src = 'about:blank';
      preview.classList.remove('visible');
    }
  };

  const getPreview = () => {
    if (preview && preview.isConnected) return preview;
    preview = el('div', 'hover-preview');
    preview.id = 'hover-preview';
    (document.getElementById('results') || document.body).append(preview);
    preview.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    preview.addEventListener('mouseleave', hide);
    return preview;
  };

  const show = (card) => {
    const item = card && card._mcItem;
    if (!item || !card.isConnected) return;
    const p = getPreview();
    p.replaceChildren();

    const media = el('div', 'hp-media');
    const img = el('img', 'hp-img');
    const path = item.backdrop || item.poster;
    if (path) img.src = TMDB_IMG + 'w780' + path;
    img.alt = '';
    media.append(img);

    const body = el('div', 'hp-body');
    body.append(el('div', 'hp-title', item.title || ''));
    let meta = item.year || '';
    const rr = (typeof imdbRef === 'function') ? imdbRef(item) : null;
    if (rr && rr.rating > 0) meta += (meta ? ' · ' : '') + 'IMDb ' + rr.rating.toFixed(1);
    if (item.tmdbRating) meta += (meta ? ' · ' : '') + 'TMDB ' + item.tmdbRating.toFixed(1);
    if (typeof item._sortScore === 'number') meta += (meta ? ' · ' : '') + Math.round(item._sortScore * 100) + '% збіг';
    body.append(el('div', 'hp-meta', meta));

    const own = lib[item.key];
    if (own) {
      const r = computeItemRating(own);
      if (r.avg > 0) body.append(el('div', 'hp-own', 'Ваша оцінка: ' + fmtNum(r.avg)));
    }
    if (item._reasons && item._reasons.length) body.append(el('div', 'hp-why', item._reasons.join(' · ')));

    let desc = item.overview || '';
    if (desc.length > 210) desc = desc.slice(0, 207).trimEnd() + '…';
    body.append(el('p', 'hp-desc', desc || 'Опис поки відсутній.'));

    const actions = el('div', 'hp-actions');
    const trailer = el('button', 'hp-btn primary', '▶ Дивитись трейлер');
    trailer.type = 'button';
    trailer.onclick = async () => {
      if (trailer.disabled) return;
      trailer.disabled = true;
      trailer.textContent = '⏳ Завантаження…';
      let data = null;
      try {
        data = await tmdbFetch('/' + encodeURIComponent(item.type) + '/' + item.id + '?language=uk-UA&append_to_response=videos');
      } catch (e) {}
      if (!preview || !preview.isConnected) return;
      const list = findAllTrailers(data && data.videos, data && data.original_language);
      if (!list.length) {
        showSyncToast('Трейлер не знайдено');
        trailer.disabled = false;
        trailer.textContent = '▶ Дивитись трейлер';
        return;
      }
      const iframe = document.createElement('iframe');
      iframe.title = 'Трейлер: ' + (item.title || '');
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.src = 'https://www.youtube.com/embed/' + list[0].key + '?autoplay=1&rel=0';
      media.replaceChildren(iframe);
      const stop = el('button', 'hp-stop', '✕ Закрити трейлер');
      stop.type = 'button';
      stop.onclick = () => { iframe.src = 'about:blank'; media.replaceChildren(img); stop.remove(); trailer.disabled = false; trailer.textContent = '▶ Дивитись трейлер'; };
      media.append(stop);
      trailer.textContent = '▶ Трейлер грає';
    };

    const isPlanned = !!(lib[item.key] && lib[item.key].status === 'planned');
    const plan = el('button', 'hp-btn' + (isPlanned ? ' active' : ''), isPlanned ? '✓ У плану' : '📅 Планую');
    plan.type = 'button';
    plan.onclick = () => {
      updateCore(item, { status: isPlanned ? null : 'planned' });
      showSyncToast(isPlanned ? 'Знято з «Планую»' : '📅 Додано у «Планую»');
      plan.classList.toggle('active', !isPlanned);
      plan.textContent = isPlanned ? '📅 Планую' : '✓ У плану';
    };

    const more = el('button', 'hp-btn', 'Детальніше');
    more.type = 'button';
    more.onclick = () => { hide(); openCard(item); };
    actions.append(trailer, plan, more);
    body.append(actions);

    p.append(media, body);
    p.style.visibility = 'hidden';
    p.classList.add('visible');
    const rect = card.getBoundingClientRect();
    const w = p.offsetWidth || 360;
    const h = p.offsetHeight || 420;
    let left = rect.left;
    if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
    left = Math.max(12, left);
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 12) top = rect.top - h - 10;
    top = Math.max(12, top);
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    p.style.visibility = '';
  };

  document.addEventListener('mouseover', (e) => {
    // Синтетичні mouse-події після тапу на тач-пристрої не мають відкривати прев'ю
    if (e.sourceCapabilities && e.sourceCapabilities.firesTouchDevices) return;
    if (e.pointerType === 'touch') return;
    const el0 = e.target instanceof Element ? e.target : null;
    const card = el0 && el0.closest('.rail-strip .rec-card');
    if (!card || card === activeCard) return;
    clearTimeout(timer); clearTimeout(hideTimer);
    activeCard = card;
    timer = setTimeout(() => show(card), 1500);
  });
  document.addEventListener('mouseout', (e) => {
    const el0 = e.target instanceof Element ? e.target : null;
    const card = el0 && el0.closest('.rail-strip .rec-card');
    if (!card || card !== activeCard || card.contains(e.relatedTarget)) return;
    clearTimeout(timer);
    hideTimer = setTimeout(() => {
      if (!preview || !preview.matches(':hover')) hide();
    }, 180);
  });
  document.addEventListener('keydown', hide);
  window.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') hide();
  }, { passive: true });
})();

function renderHomeContent(taste) {
  if (state.tab !== 'home') return;
  if (!state.home.view) {
    try { state.home.view = localStorage.getItem('mycinema.home.view') || 'my'; } catch { state.home.view = 'my'; }
  }
  box.replaceChildren(); box.style.padding = 'var(--mc-home-pad, 0)';

  if (state.home.view === 'my') {
    updateTopTasteButton(taste);
  }

  const wrap = el('div', 'home-wrap');

  if (state.home.view === 'my') {
    const recs = state.home.recs;

    if (recs && recs.seeds > 0) {
      renderHomeRails(recs, wrap);
    } else {
      wrap.append(el('div', 'home-note', 'Постав оцінку 7+ або ❤️ улюбленому фільму чи серіалу — і тут з\'являться персональні рекомендації.'));
    }

    const plannedSec = buildPlannedByMoodSection();
    if (plannedSec) wrap.append(plannedSec);
  }

  box.append(wrap);
}

const _nextEpSeasonCache = new Map();

function computeNextEpisode(item) {
  const eps = item.watchedEpisodes || [];
  if (!eps.length) return null;
  const parsed = eps.map(k => {
    const parts = String(k).split('-').map(Number);
    return (parts[0] > 0 && parts[1] > 0) ? { s: parts[0], e: parts[1] } : null;
  }).filter(Boolean).sort((a, b) => a.s - b.s || a.e - b.e);
  if (!parsed.length) return null;

  const last = parsed[parsed.length - 1];
  const sc = item.seasonCounts || {};
  const curMax = sc[last.s] || 0;
  let nextS = last.s;
  let nextE = last.e + 1;

  if (curMax > 0 && nextE > curMax) {
    const nextSeasonNum = last.s + 1;
    if (item.totalSeasons && nextSeasonNum > item.totalSeasons) {
      return { finished: true, s: last.s, e: last.e };
    }
    nextS = nextSeasonNum;
    nextE = 1;
  }
  return { finished: false, s: nextS, e: nextE, code: `S${nextS}E${String(nextE).padStart(2, '0')}` };
}

function buildContinueWatchingSection() {
  const watching = Object.values(lib).filter(x => x.type === 'tv' && x.status === 'watching' && x.watchedEpisodes && x.watchedEpisodes.length > 0).sort((a, b) => b.updated - a.updated).slice(0, 6);
  if (!watching.length) return null;
  const sec = el('section', 'home-section continue-watching-sec');
  const head = el('div', 'section-head');
  head.append(el('h2', 'section-title', '⏯️ Продовжити'));
  sec.append(head);
  const grid = el('div', 'home-grid');
  const todayIso = new Date().toISOString().slice(0, 10);

  watching.forEach(item => {
    const c = el('div', 'rec-card');
    const pWrap = el('div', 'rec-poster-wrap');
    const p = el('img', 'rec-poster');
    if (item.poster) p.src = TMDB_IMG + 'w342' + item.poster;
    pWrap.append(p);
    c.append(pWrap, el('div', 'row-title', item.title));

    const eps = item.watchedEpisodes || [];
    const tot = item.episode_count || 0;
    const pct = tot > 0 ? Math.min(100, Math.round((eps.length / tot) * 100)) : 0;
    const next = computeNextEpisode(item);

    if (next) {
      let targetS = next.s, targetE = next.e, targetCode = next.code;
      let qBtn = null;
      if (!next.finished) {
        qBtn = el('button', 'cw-next-btn', '+ ' + targetCode);
        qBtn.type = 'button';
        qBtn.title = `Позначити ${targetCode} переглянутою`;
        qBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const latest = lib[item.key] || item;
          const curEps = [...(latest.watchedEpisodes || [])];
          const epKey = `${targetS}-${targetE}`;
          if (!curEps.includes(epKey)) curEps.push(epKey);
          if (typeof updateCore === 'function') {
            updateCore(latest, { watchedEpisodes: curEps, status: latest.status === 'watched' ? 'watched' : 'watching' });
          }
          if (typeof showSyncToast === 'function') showSyncToast(`✅ ${targetCode}`);
          const freshCw = buildContinueWatchingSection();
          if (freshCw) sec.replaceWith(freshCw);
        });
        pWrap.append(qBtn);
      }

      const baseText = next.finished
        ? 'Усі серії переглянуто'
        : `Далі: ${next.code}` + (tot > 0 ? ` · ${pct}%` : '');
      const labelEl = el('div', 'rec-why', baseText);
      c.append(labelEl);

      if (!next.finished && item.id) {
        const cacheKey = `${item.id}:${next.s}`;
        const applySeasonData = (episodes) => {
          if (!episodes || !labelEl.isConnected) return;
          if (!item.seasonCounts?.[next.s] && episodes.length && lib[item.key]) {
            lib[item.key].seasonCounts = { ...(lib[item.key].seasonCounts || {}), [next.s]: episodes.length };
            // Без цього кількість серій живе лише в пам'яті до випадкового save().
            if (typeof _dirtyItems !== 'undefined') _dirtyItems.add(item.key);
            if (typeof save === 'function') save();
          }
          const epObj = episodes.find(ep => ep.episode_number === next.e);
          if (epObj) {
            if (epObj.air_date && epObj.air_date > todayIso) {
              const dt = new Date(epObj.air_date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
              labelEl.textContent = `Чекаємо ${next.code} · ${dt}`;
              if (qBtn) qBtn.remove();
            } else if (epObj.name) {
              labelEl.textContent = `Далі: ${next.code} · ${epObj.name}`;
            }
          } else if (episodes.length > 0 && next.e > episodes.length) {
            const nextS = next.s + 1;
            const hasMoreSeasons = !item.totalSeasons || nextS <= item.totalSeasons;
            if (hasMoreSeasons) {
              targetS = nextS; targetE = 1; targetCode = `S${nextS}E01`;
              if (qBtn) { qBtn.textContent = '+ ' + targetCode; qBtn.title = `Позначити ${targetCode} переглянутою`; }
              labelEl.textContent = `Далі: ${targetCode}` + (tot > 0 ? ` · ${pct}%` : '');
            } else {
              labelEl.textContent = 'Сезон завершено';
              if (qBtn) qBtn.remove();
            }
          }
        };

        if (_nextEpSeasonCache.has(cacheKey)) {
          applySeasonData(_nextEpSeasonCache.get(cacheKey));
        } else {
          tmdbFetch(`/tv/${item.id}/season/${next.s}?language=uk-UA`)
            .then(d => {
              const epsArr = d.episodes || [];
              _nextEpSeasonCache.set(cacheKey, epsArr);
              applySeasonData(epsArr);
            })
            .catch(() => {});
        }
      }

      if (tot > 0) {
        const prog = el('div', 'item-progress');
        const fill = el('div', 'item-progress-fill');
        fill.style.width = pct + '%';
        prog.append(fill);
        c.append(prog);
      }
    }
    c.addEventListener('click', () => openCard(item));
    grid.append(c);
  });
  sec.append(grid);
  return sec;
}
