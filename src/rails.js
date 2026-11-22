/* Rails — декларативні рекомендаційні полиці.
   Чиста логіка: не рахує скор, не ходить у мережу. Лише групує,
   фільтрує, обертає й розкладає вже готові тайтли по гілках. */

'use strict';

const RAIL_DEFAULT_LIMIT = 14;
const RAIL_MIN_ITEMS = 4;

function railHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function railRng(key) {
  let a = railHash(key) || 1;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function railShuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

function railWeightedPick(list, rng) {
  if (!list.length) return null;
  const weights = list.map((_, i) => 1 / (1 + i * 0.6));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

function railTags(item) {
  const tags = item && item._reasonTags;
  return Array.isArray(tags) ? tags : (item && Array.isArray(item._reasons) ? item._reasons : []);
}

function railHasTag(item, tag) {
  return railTags(item).indexOf(tag) !== -1;
}

function railRating(item, ctx) {
  if (typeof ctx.ratingOf === 'function') {
    const r = ctx.ratingOf(item);
    if (r && r.rating > 0) return r.rating;
  }
  return item.tmdbRating || 0;
}

function railVotes(item, ctx) {
  if (typeof ctx.ratingOf === 'function') {
    const r = ctx.ratingOf(item);
    if (r && r.votes > 0) return r.votes;
  }
  return item.votes || 0;
}

function railYear(item) {
  const y = parseInt(item.year || (item.releaseDate || '').slice(0, 4), 10);
  return isFinite(y) ? y : 0;
}

/* ---------- hero ---------- */

function buildHero(ctx, rng) {
  const pool = ctx.items.slice().sort((a, b) => (b._sortScore || 0) - (a._sortScore || 0)).slice(0, 8);
  if (!pool.length) return null;
  const main = railWeightedPick(pool.slice(0, 6), rng) || pool[0];
  const slides = pool.filter(x => x.key !== main.key).slice(0, 5);
  return { item: main, slides };
}

/* ---------- каталог кандидатів ---------- */

function collectCandidates(ctx) {
  const out = [];
  const add = (cfg) => out.push(cfg);
  const type = ctx.type;

  // Perсональні: сіди
  (ctx.seeds || []).forEach((s) => {
    if (type && s.type && s.type !== type) return;
    add({
      id: 'seed-' + s.key, kind: 'seed', group: 'personal',
      title: `Бо ви дивились «${s.title}»`,
      subtitle: s.avg > 0 ? `Ваша оцінка ${fmtRailNum(s.avg)}` : (s.isFav ? 'З улюбленого' : 'На основі вашого смаку'),
      pick: (items, c) => {
        const direct = items.filter(x => railHasTag(x, 'seed-' + s.key) || railHasTag(x, 'seed-' + (s.type ? s.type + '-' : '') + s.id));
        const extra = ((c.seedRecs || []).find(sr => sr.key === s.key) || {}).items || [];
        const seen = new Set(direct.map(x => x.key));
        return direct.concat(extra.filter(x => !seen.has(x.key)));
      }
    });
  });

  // Актори
  (ctx.topCast || []).forEach((id) => {
    const name = ctx.names && ctx.names.cast && ctx.names.cast[id];
    if (!name) return;
    add({
      id: 'cast-' + id, kind: 'cast', group: 'personal',
      title: `З ${name}`, subtitle: 'Актор, які ви любите',
      pick: (items) => items.filter(x => railHasTag(x, 'cast-' + id))
    });
  });

  // Режисери
  (ctx.topDirectors || []).forEach((id) => {
    const name = ctx.names && ctx.names.directors && ctx.names.directors[id];
    if (!name) return;
    add({
      id: 'dir-' + id, kind: 'director', group: 'personal',
      title: `Режисер: ${name}`, subtitle: 'За вашими оцінками',
      pick: (items) => items.filter(x => railHasTag(x, 'dir-' + id))
    });
  });

  // Жанри
  (ctx.topGenres || []).forEach((id) => {
    const name = ctx.genreNames && ctx.genreNames[id];
    if (!name) return;
    add({
      id: 'genre-' + id, kind: 'genre', group: 'personal',
      title: `Твій жанр · ${name}`, subtitle: 'Підібрано за вашою бібліотекою',
      pick: (items) => items.filter(x => (x.genres || []).indexOf(Number(id)) !== -1)
    });
  });

  // Ключові слова / теми
  (ctx.topKeywords || []).forEach((id) => {
    const name = ctx.names && ctx.names.keywords && ctx.names.keywords[id];
    if (!name) return;
    add({
      id: 'kw-' + id, kind: 'keyword', group: 'personal',
      title: `Тема: ${name}`, subtitle: 'Знайдено у ваших улюблених',
      pick: (items) => items.filter(x => railHasTag(x, 'kw-' + id))
    });
  });

  // Критерії смаку
  (ctx.criteria || []).forEach((c) => {
    add({
      id: 'crit-' + c.key, kind: 'criterion', group: 'personal',
      title: `Під «${c.label}»`, subtitle: 'Ваш найсильніший критерій',
      pick: (items) => items.filter(x => railHasTag(x, 'crit-' + c.key))
    });
  });

  // Якість / час
  add({
    id: 'q-topmatch', kind: 'top', group: 'core', pinned: true,
    title: 'Найточніший збіг', subtitle: 'За вашою моделлю смаку',
    pick: (items) => items.slice().sort((a, b) => (b._sortScore || 0) - (a._sortScore || 0))
  });
  add({
    id: 'q-gems', kind: 'gems', group: 'quality',
    title: 'Перлини, які ви пропустили', subtitle: 'Висока оцінка · низька популярність',
    pick: (items) => items.filter(x => railRating(x, ctx) >= 7.5 && (x.popularity || 0) < 300)
      .sort((a, b) => railRating(b, ctx) - railRating(a, ctx))
  });
  add({
    id: 'q-fresh', kind: 'fresh', group: 'quality',
    title: 'Новинки останніх 2 років', subtitle: 'Свіжі релізи',
    pick: (items) => items.filter(x => railYear(x) >= ctx.nowYear - 2)
      .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
  });
  add({
    id: 'q-classic', kind: 'classic', group: 'quality',
    title: 'Класика з високим рейтингом', subtitle: 'Перевірено часом',
    pick: (items) => items.filter(x => railYear(x) > 0 && railYear(x) <= ctx.nowYear - 10 && railVotes(x, ctx) >= 1000)
      .sort((a, b) => railRating(b, ctx) - railRating(a, ctx))
  });
  add({
    id: 'q-imdb8', kind: 'imdb', group: 'quality',
    title: 'IMDb 8+', subtitle: 'Найкраще оцінені',
    pick: (items) => items.filter(x => railRating(x, ctx) >= 8)
      .sort((a, b) => railRating(b, ctx) - railRating(a, ctx))
  });
  (ctx.seedYears || []).forEach((y) => {
    add({
      id: 'q-year-' + y, kind: 'year', group: 'quality',
      title: `Найкращі ${y}-х`, subtitle: 'Рік вашого смаку',
      pick: (items) => items.filter(x => railYear(x) >= y && railYear(x) <= y + 2)
        .sort((a, b) => railRating(b, ctx) - railRating(a, ctx))
    });
  });

  // Стрімінг-хаби (підключені зовні)
  ctx.extraRails.forEach(d => {
    if (!d || !d.items || d.items.length < RAIL_MIN_ITEMS) return;
    add({
      id: d.id, kind: 'hub', group: 'hub', pinned: true, unique: true, limit: 30,
      title: d.title, subtitle: d.subtitle || '',
      pick: () => d.items.slice()
    });
  });

  // Каталог
  const g = ctx.general || {};
  const catalogDefs = type === 'tv'
    ? (ctx.tvStreams || []).map((s) => ({ id: 'stream-' + s.id, title: s.title, subtitle: s.logo ? 'Платформа' : 'Каталог', items: s.items || [] }))
    : [
      { id: 'cat-popular', title: 'Популярне зараз', subtitle: 'Сьогодні', items: g.trMovies || [] },
      { id: 'cat-new', title: 'Нові фільми', subtitle: 'Свіже', items: g.newMovies || [] },
      { id: 'cat-top', title: 'Найрейтинговіші', subtitle: 'Класика', items: g.topMovies || [] }
    ];
  catalogDefs.forEach((d) => {
    if (!d.items || d.items.length < RAIL_MIN_ITEMS) return;
    add({
      id: d.id, kind: 'catalog', group: 'catalog',
      title: d.title, subtitle: d.subtitle,
      pick: () => d.items.slice()
    });
  });

  // Доступність
  add({
    id: 'avail-ua', kind: 'availability', group: 'catalog',
    title: 'Доступне в UA', subtitle: 'Дивитися зараз',
    pick: (items) => items.filter(x => (x.streamingUA || []).length > 0)
  });
  add({
    id: 'avail-digital', kind: 'availability', group: 'catalog',
    title: 'Вийшло в цифрі', subtitle: 'Вже можна дивитися',
    pick: (items) => items.filter(x => !!x.digitalReleaseDate)
  });

  // Франшизи
  (ctx.collections || []).forEach((c) => {
    add({
      id: 'col-' + c.id, kind: 'collection', group: 'catalog',
      title: `Франшиза «${c.title}»`, subtitle: 'Усі частини',
      pick: (items) => items.filter(x => x.colId === c.id || railHasTag(x, 'col-' + c.id))
    });
  });

  // Десятиліття
  (ctx.decades || []).forEach((d) => {
    add({
      id: 'decade-' + d, kind: 'decade', group: 'catalog',
      title: `Кіно ${d}-х`, subtitle: 'За десятиліттям',
      pick: (items) => items.filter(x => railYear(x) >= d && railYear(x) < d + 10)
        .sort((a, b) => railRating(b, ctx) - railRating(a, ctx))
    });
  });

  // Режим — окрема гілка ('none' — указати, що гілка не потрібна)
  if (ctx.mode === 'none') {
    // немає гілки режиму
  } else if (ctx.mode === 'gems') {
    add({
      id: 'mode-gems', kind: 'mode', group: 'mode', pinned: true,
      title: '💎 Перлини', subtitle: 'Режим «Перлини»',
      pick: (items) => items.filter(x => railRating(x, ctx) >= 7.2)
        .sort((a, b) => railRating(b, ctx) - railRating(a, ctx))
    });
  } else if (ctx.mode === 'fresh') {
    add({
      id: 'mode-fresh', kind: 'mode', group: 'mode', pinned: true,
      title: '🆕 Свіже', subtitle: 'Режим «Новинки»',
      pick: (items) => items.slice().sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    });
  } else {
    add({
      id: 'mode-balance', kind: 'mode', group: 'mode', pinned: true,
      title: '⚖️ Баланс', subtitle: 'Режим «Баланс»',
      pick: (items) => items.slice().sort((a, b) => (b._sortScore || 0) - (a._sortScore || 0))
    });
  }

  return out;
}

function fmtRailNum(v) {
  const n = Number(v) || 0;
  return (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
}

/* ---------- відбір гілок ---------- */

function selectDescriptors(ctx, candidates, rng) {
  const pinned = candidates.filter(c => c.pinned);
  const rest = candidates.filter(c => !c.pinned);
  const quotas = { personal: 5, quality: 2, catalog: 2 };
  const picked = pinned.slice();
  const usedKinds = {};
  const bump = (c) => { usedKinds[c.kind] = (usedKinds[c.kind] || 0) + 1; };
  pinned.forEach(bump);

  Object.keys(quotas).forEach((group) => {
    let pool = railShuffle(rest.filter(c => c.group === group && !picked.includes(c)), rng);
    if (group === 'personal') {
      const seedRails = pool.filter(c => c.kind === 'seed').slice(0, 3);
      const otherRails = pool.filter(c => c.kind !== 'seed');
      pool = seedRails.concat(otherRails);
    }
    let taken = 0;
    for (const c of pool) {
      if (taken >= quotas[group] || picked.length >= ctx.limit) break;
      if ((usedKinds[c.kind] || 0) >= 2) continue;
      picked.push(c); bump(c); taken++;
    }
  });

  // Добираємо, якщо якихось груп не вистачило
  const extras = railShuffle(rest.filter(c => !picked.includes(c)), rng);
  for (const c of extras) {
    if (picked.length >= ctx.limit) break;
    if ((usedKinds[c.kind] || 0) >= 2) continue;
    picked.push(c); bump(c);
  }

  // Фіксований порядок груп, перемішування — всередині групи
  const renderOrder = { core: 0, personal: 1, hub: 2, mode: 3, mood: 4, quality: 5, catalog: 6 };
  return picked.sort((a, b) => {
    const ga = renderOrder[a.group] === undefined ? 9 : renderOrder[a.group];
    const gb = renderOrder[b.group] === undefined ? 9 : renderOrder[b.group];
    return ga - gb;
  });
}

function materializeRails(descs, ctx, used = new Map()) {
  const out = [];
  // Пріоритет claim-у: ядро → режим → настрої (вони обов'язкові) → решта
  const claimOrder = { core: 0, mode: 1, mood: 2, personal: 3, hub: 4, quality: 5, catalog: 6 };
  const ordered = descs.slice().sort((a, b) =>
    (claimOrder[a.group] === undefined ? 9 : claimOrder[a.group]) -
    (claimOrder[b.group] === undefined ? 9 : claimOrder[b.group]));
  const carouselKeys = new Set((ctx.hero && ctx.hero.slides || []).map(x => x.key));
  if (ctx.hero && ctx.hero.item) carouselKeys.add(ctx.hero.item.key);

  const claim = (item) => {
    const k = item.key;
    const n = used.get(k) || 0;
    if (n >= 2) return false;
    used.set(k, n + 1);
    return true;
  };

  for (const d of ordered) {
    let picked = [];
    const source = d.scope === 'all' ? ctx.allItems : ctx.items;
    try { picked = (d.pick(source, ctx) || []).slice(); } catch (e) { picked = []; }
    const final = [];
    for (const item of picked) {
      if (!item || !item.poster) continue;
      if (item.key && carouselKeys.has(item.key) && d.group !== 'mood') continue;
      if (item.key && d.unique && used.has(item.key)) continue;
      if (item.key && !claim(item)) continue;
      final.push(item);
      if (final.length >= (d.limit || ctx.limit || RAIL_DEFAULT_LIMIT)) break;
    }
    if (final.length < RAIL_MIN_ITEMS && d.group === 'mood') {
      const have = new Set(final.map(x => x.key));
      const filler = (ctx.generalPool || []).concat(ctx.items)
        .filter(x => x && x.poster && !have.has(x.key));
      for (const x of filler) {
        if (final.length >= RAIL_MIN_ITEMS) break;
        if (!claim(x)) continue;
        final.push(x); have.add(x.key);
      }
    }
    if (final.length < RAIL_MIN_ITEMS) continue;
    out.push({ id: d.id, kind: d.kind, group: d.group, title: d.title, subtitle: d.subtitle, items: final });
  }
  const renderOrder = { core: 0, personal: 1, hub: 2, mode: 3, mood: 4, quality: 5, catalog: 6 };
  out.sort((a, b) =>
    (renderOrder[a.group] === undefined ? 9 : renderOrder[a.group]) -
    (renderOrder[b.group] === undefined ? 9 : renderOrder[b.group]));
  return out;
}

/* ---------- публічний API ---------- */

function buildRails(opts) {
  const o = opts || {};
  const ctx = {
    items: Array.isArray(o.items) ? o.items : [],
    general: o.general || {},
    generalPool: Array.isArray(o.generalPool) ? o.generalPool : [],
    tvStreams: Array.isArray(o.tvStreams) ? o.tvStreams : [],
    seeds: Array.isArray(o.seeds) ? o.seeds : [],
    topGenres: o.topGenres || [],
    topCast: o.topCast || [],
    topDirectors: o.topDirectors || [],
    topKeywords: o.topKeywords || [],
    names: o.names || {},
    genreNames: o.genreNames || {},
    collections: Array.isArray(o.collections) ? o.collections : [],
    criteria: Array.isArray(o.criteria) ? o.criteria : [],
    moods: o.moods || {},
    seedRecs: Array.isArray(o.seedRecs) ? o.seedRecs : [],
    extraRails: Array.isArray(o.extraRails) ? o.extraRails : [],
    seedYears: Array.isArray(o.seedYears) ? o.seedYears : [],
    decades: Array.isArray(o.decades) ? o.decades : [],
    type: o.type || 'movie',
    mode: o.mode || 'balance',
    nowYear: o.nowYear || new Date().getFullYear(),
    limit: o.limit || RAIL_DEFAULT_LIMIT,
    ratingOf: o.ratingOf,
    hero: null
  };
  const rng = railRng(`${o.userId || 'guest'}|${o.dateKey || ''}|${o.nonce || 0}|rails`);
  if (!ctx.generalPool.length) {
    const seen = new Set();
    ctx.generalPool = (ctx.general.trMovies || [])
      .concat(ctx.general.newMovies || [], ctx.general.topMovies || [])
      .concat(...ctx.tvStreams.map(s => (s.items || []).slice(0, 20)))
      .filter(x => x && x.key && !seen.has(x.key) && seen.add(x.key));
  }
  ctx.hero = buildHero(ctx, railRng(`${o.userId || 'guest'}|${o.dateKey || ''}|${o.nonce || 0}|hero`));
  ctx.allItems = ctx.items.concat(ctx.generalPool).filter((x, i, arr) =>
    x && x.key && arr.findIndex(y => y && y.key === x.key) === i);
  const candidates = collectCandidates(ctx);
  candidates.forEach(c => {
    if (['quality', 'catalog', 'availability', 'collection', 'decade', 'mode', 'hub'].indexOf(c.group) !== -1) c.scope = 'all';
  });
  const descs = selectDescriptors(ctx, candidates, rng);
  const used = new Map();
  let rails = materializeRails(descs, ctx, used);
  if (rails.length < ctx.limit) {
    const extras = railShuffle(candidates.filter(c => descs.indexOf(c) === -1), rng);
    for (const c of extras) {
      if (rails.length >= ctx.limit) break;
      const extra = materializeRails([c], ctx, used);
      if (extra.length) rails.push(extra[0]);
    }
  }
  const renderOrder = { core: 0, personal: 1, hub: 2, mode: 3, mood: 4, quality: 5, catalog: 6 };
  rails.sort((a, b) =>
    (renderOrder[a.group] === undefined ? 9 : renderOrder[a.group]) -
    (renderOrder[b.group] === undefined ? 9 : renderOrder[b.group]));
  rails = rails.map(({ group, ...rail }) => rail);
  return { hero: ctx.hero, rails };
}

if (typeof window !== 'undefined') window.buildRails = buildRails;
