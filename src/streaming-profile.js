/* Повноцінний профіль стрімінгу: логотип, статистика, фільми/серіали, сортування. */
'use strict';

const STREAM_PROVIDERS = {
  netflix: 8, apple: 350, hbo: 1899, prime: 9,
  disney: 337, hulu: 15, peacock: 386, sky: 29
};

/* Ручний довідник: company_id -> slug стрімінгу (не шукаємо через /search/company). */
const STREAM_COMPANY_MAP = { 3268: 'hbo', 320325: 'prime' };
if (typeof window !== 'undefined') window.STREAM_COMPANY_MAP = STREAM_COMPANY_MAP;

function resolveStreamingHub(ref) {
  const str = String(ref);
  if (STREAM_COMPANY_MAP[str]) return STREAM_COMPANY_MAP[str];
  return str;
}

function streamRgb(hubId) {
  const map = {
    netflix: '229,9,20', apple: '245,245,247', hbo: '88,34,180', prime: '0,168,225',
    disney: '59,130,246', hulu: '28,231,131', peacock: '245,179,0', sky: '230,176,255'
  };
  return map[hubId] || '255,184,108';
}

function userTasteGenres() {
  const counts = {};
  Object.values(lib).forEach(x => {
    const avg = computeItemRating(x).avg;
    if (!(avg > 0) && !x.favorite) return;
    const w = (avg || 8) / 10;
    (x.genres || []).forEach(g => { counts[g] = (counts[g] || 0) + w; });
  });
  return new Set(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => Number(x[0])));
}

function personalRank(items, taste) {
  return items.slice().sort((a, b) => {
    const sa = (a.genres || []).filter(g => taste.has(Number(g))).length;
    const sb = (b.genres || []).filter(g => taste.has(Number(g))).length;
    return sb - sa || (b.tmdbRating || 0) - (a.tmdbRating || 0);
  });
}

function makeStreamingCtx(hubId) {
  return {
    type: 'streaming',
    id: hubId,
    tab: 'overview',
    sort: 'popularity.desc',
    pages: { movie: null, tv: null },
    overview: [],
    loadingMore: false,
    _seq: 0
  };
}

function streamPath(hub, type, sort, page, overrides) {
  const p = new URLSearchParams({
    language: 'uk-UA',
    sort_by: sort,
    page: String(page)
  });
  if (type === 'tv') {
    p.set('with_type', '2|4');
    p.set('vote_count.gte', '120');
    if (hub.network) p.set('with_networks', String(hub.network));
    else {
      p.set('with_watch_providers', String(hub.provider || STREAM_PROVIDERS[hub.id] || 8));
      p.set('watch_region', hub.region || 'US');
      p.set('with_watch_monetization_types', 'flatrate');
    }
  } else {
    p.set('vote_count.gte', '50');
    p.set('with_watch_providers', String(hub.provider || STREAM_PROVIDERS[hub.id] || 8));
    p.set('watch_region', hub.region || 'US');
    p.set('with_watch_monetization_types', 'flatrate');
  }
  Object.keys(overrides || {}).forEach(k => p.set(k, overrides[k]));
  return '/discover/' + type + '?' + p.toString();
}

async function fetchStreamPage(hub, type, sort, page, overrides) {
  const data = await tmdbFetch(streamPath(hub, type, sort, page, overrides));
  const items = (data.results || [])
    .filter(x => x && x.poster_path && !(typeof isExcludedShow === 'function' && isExcludedShow(x, type)))
    .map(x => normalizeItem({ ...x, media_type: type }));
  return { items, page: data.page || page, totalPages: data.total_pages || 1, totalResults: data.total_results || 0 };
}

async function openStreamingProfile(ref) {
  if (!ref) return;
  const hubId = resolveStreamingHub(ref);
  const hub = (typeof STREAM_HUBS !== 'undefined' ? STREAM_HUBS : []).find(x => x.id === hubId);
  if (!hub || hub.id === 'all') return;
  const top = cardStack[cardStack.length - 1];
  if (top && top.type === 'streaming' && top.id === hubId) return;
  if (typeof _mcSavePageScroll === 'function' && !cardStack.length) _mcSavePageScroll();
  overlay.classList.add('open');
  saveCardScroll();
  const ctx = makeStreamingCtx(hubId);
  ctx.hub = hub;
  cardStack.push(ctx);
  pushCardState();
  renderLoading();
  await loadStreamingData(ctx);
  if (cardStack[cardStack.length - 1] !== ctx) return;
  renderCard();
}

async function loadStreamingData(ctx) {
  try {
    const [movies, shows] = await Promise.all([
      fetchStreamPage(ctx.hub, 'movie', ctx.sort, 1, { 'vote_count.gte': '50' }),
      fetchStreamPage(ctx.hub, 'tv', ctx.sort, 1, { 'vote_count.gte': '50', with_type: '2|4' })
    ]);
    ctx.pages.movie = movies;
    ctx.pages.tv = shows;

    const year = new Date().getFullYear() - 2;
    const specs = [
      { id: 'ov-best', title: `Найточніший збіг для вас на ${ctx.hub.label}`, subtitle: 'За вашим смаком', overrides: { sort_by: 'popularity.desc' }, personal: true },
      { id: 'ov-cult', title: 'Культові хіти платформи', subtitle: 'IMDb/голоси', overrides: { sort_by: 'vote_average.desc', 'vote_count.gte': '400' } },
      { id: 'ov-fresh', title: 'Свіжі прем’єри та нові сезони', subtitle: 'Останні 2 роки', overrides: { sort_by: 'popularity.desc', 'first_air_date.gte': year + '-01-01' } },
      { id: 'ov-mini', title: 'Міні-серіали', subtitle: 'Завершені історії', overrides: { with_type: '2', sort_by: 'vote_average.desc', 'vote_count.gte': '300' } }
    ];
    const loaded = await Promise.all(specs.map(async sp => {
      try {
        const data = await fetchStreamPage(ctx.hub, 'tv', 'popularity.desc', 1, sp.overrides);
        const items = sp.personal ? personalRank(data.items, userTasteGenres()) : data.items;
        return { id: sp.id, title: sp.title, subtitle: sp.subtitle, items: items.slice(0, 20) };
      } catch (e) { return { id: sp.id, title: sp.title, subtitle: sp.subtitle, items: [] }; }
    }));
    ctx.overview = loaded;
  } catch (e) {
    ctx.error = e.message;
  }
}

async function reloadStreamingTab(ctx, type, append) {
  if (ctx.loadingMore) return;
  const seq = ++ctx._seq;
  ctx.loadingMore = true;
  const cur = ctx.pages[type];
  const nextPage = append && cur && cur.sort === ctx.sort ? (cur.page + 1) : 1;
  try {
    const data = await fetchStreamPage(ctx.hub, type, ctx.sort, nextPage);
    if (seq !== ctx._seq || cardStack[cardStack.length - 1] !== ctx) return;
    ctx.pages[type] = {
      items: append && cur ? cur.items.concat(data.items) : data.items,
      page: data.page, totalPages: data.totalPages, totalResults: data.totalResults, sort: ctx.sort
    };
    saveCardScroll();
    renderCard(true);
  } catch (e) {
    ctx.error = e.message;
    renderCard(true);
  } finally {
    ctx.loadingMore = false;
  }
}

function renderStreamingCard(ctx, scroll) {
  const hub = ctx.hub || {};
  const rgb = streamRgb(ctx.id);
  const backdrop = (ctx.overview || []).flatMap(r => r.items || []).find(x => x.backdrop);
  const movieBackdrop = (ctx.pages.movie?.items || []).find(x => x.backdrop);
  const art = backdrop || movieBackdrop;

  const header = el('div', 'person-header company-header stream-profile-header');
  header.style.setProperty('--hub-accent', hub.color || '#ffb86c');
  header.style.setProperty('--hub-rgb', rgb);
  if (art) {
    const artLayer = el('div', 'stream-profile-art');
    artLayer.style.backgroundImage = `url("${TMDB_IMG}w1280${art.backdrop}")`;
    header.append(artLayer);
  }

  const logoWrap = el('div', 'company-logo-box');
  if (hub.logo) {
    const img = el('img', 'company-logo-img');
    if (['hbo', 'apple', 'netflix', 'disney', 'peacock'].indexOf(ctx.id) !== -1) img.classList.add('logo-screen');
    else if (['prime', 'sky'].indexOf(ctx.id) !== -1) img.classList.add('logo-multiply');
    img.src = TMDB_IMG + 'w300' + hub.logo;
    img.alt = hub.label || '';
    logoWrap.append(img);
  } else {
    logoWrap.classList.add('empty');
    logoWrap.textContent = String(hub.label || '?').charAt(0).toUpperCase();
  }
  header.append(logoWrap);

  const info = el('div', 'stream-profile-info');
  info.append(el('div', 'person-name', hub.label || ctx.id));
  info.append(el('div', 'person-meta',
    (hub.network ? 'Originals · network ' + hub.network : 'Provider ' + (hub.provider || STREAM_PROVIDERS[ctx.id] || '—')) +
    ' · ' + (hub.region || 'US') + ' · ' + (hub.tagline || '')));

  const all = [...(ctx.pages.movie?.items || []), ...(ctx.pages.tv?.items || [])];
  const seen = new Set();
  const inLib = [];
  all.forEach(it => {
    if (seen.has(it.key)) return;
    seen.add(it.key);
    if (lib[it.key] && typeof hasWatched === 'function' && hasWatched(lib[it.key])) inLib.push(lib[it.key]);
  });
  const rated = inLib.map(x => computeItemRating(x).avg).filter(v => v > 0);
  const avg = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : 0;
  const taste = userTasteGenres();
  const matches = all.filter(x => (x.genres || []).some(g => taste.has(Number(g)))).length;
  const compatibility = all.length ? Math.min(99, Math.round(45 + (matches / all.length) * 110)) : 0;

  const chips = el('div', 'stream-profile-chips');
  chips.append(el('span', 'stream-chip', `📚 У бібліотеці: ${inLib.length}`));
  if (avg > 0) chips.append(el('span', 'stream-chip', `⭐ Середня: ${fmtNum(avg)}`));
  if (compatibility > 0) chips.append(el('span', 'stream-chip', `🎯 Сумісність: ${compatibility}%`));
  info.append(chips);

  const site = el('a', 'person-wiki-link', '🌐 Офіційний сайт ↗');
  const domains = {
    netflix: 'https://www.netflix.com', apple: 'https://tv.apple.com', hbo: 'https://www.max.com',
    prime: 'https://www.primevideo.com', disney: 'https://www.disneyplus.com', hulu: 'https://www.hulu.com',
    peacock: 'https://www.peacocktv.com', sky: 'https://www.sky.com'
  };
  site.href = domains[ctx.id] || 'https://www.themoviedb.org';
  site.target = '_blank';
  site.rel = 'noopener noreferrer';
  info.append(site);

  header.append(info);
  scroll.append(header);

  // вкладки
  const mTotal = ctx.pages.movie?.totalResults || 0;
  const tTotal = ctx.pages.tv?.totalResults || 0;
  const tabs = el('div', 'card-tabs');
  const defs = [
    ['overview', '✨ Огляд'],
    ['tv', `📺 Серіали (${tTotal})`],
    ['movie', `🎬 Фільми (${mTotal})`]
  ];
  defs.forEach(([val, label]) => {
    const b = el('button', 'card-tab' + (ctx.tab === val ? ' active' : ''), label);
    b.onclick = () => {
      if (ctx.tab === val) return;
      ctx.tab = val;
      if (val !== 'overview' && (!ctx.pages[val] || ctx.pages[val].sort !== ctx.sort)) {
        reloadStreamingTab(ctx, val, false);
      } else {
        saveCardScroll();
        renderCard(true);
      }
    };
    tabs.append(b);
  });
  scroll.append(tabs);

  if (ctx.tab === 'overview') {
    (ctx.overview || []).forEach(r => {
      if (!r.items || !r.items.length) return;
      if (typeof renderRailSection === 'function') scroll.append(renderRailSection(r));
    });
    return;
  }

  const sortBar = el('div', 'company-sort-bar');
  [
    { id: 'popularity.desc', label: '🔥 Популярні' },
    { id: 'vote_average.desc', label: '⭐ За рейтингом' },
    { id: 'primary_release_date.desc', label: '🆕 Новіші' }
  ].forEach(sd => {
    const b = el('button', 'recs-mode-pill' + (ctx.sort === sd.id ? ' active' : ''), sd.label);
    b.type = 'button';
    b.onclick = () => {
      if (ctx.sort === sd.id || ctx.loadingMore) return;
      ctx.sort = sd.id;
      reloadStreamingTab(ctx, ctx.tab, false);
    };
    sortBar.append(b);
  });
  scroll.append(sortBar);

  const data = ctx.pages[ctx.tab];
  if (!data || !data.items || !data.items.length) {
    scroll.append(el('div', 'avail-empty', 'Немає даних'));
    return;
  }

  const grid = el('div', 'filmography-grid');
  grid.style.marginTop = '14px';
  data.items.forEach(item => {
    const c = el('div', 'filmography-card');
    const poster = el('img', 'filmography-poster');
    poster.src = TMDB_IMG + 'w342' + item.poster;
    poster.loading = 'lazy';
    poster.decoding = 'async';
    c.append(poster, el('div', 'filmography-title', item.title || ''));
    const saved = lib[item.key];
    const avgSaved = saved ? computeItemRating(saved).avg : 0;
    const parts = [];
    if (item.year) parts.push(item.year);
    if (item.tmdbRating > 0) parts.push(item.tmdbRating.toFixed(1));
    if (avgSaved > 0) parts.push('⭐ ' + fmtNum(avgSaved));
    else if (saved?.status === 'watched') parts.push('✅');
    else if (saved?.status === 'watching') parts.push('▶️');
    else if (saved?.status === 'planned') parts.push('📅');
    if (parts.length) c.append(el('div', 'filmography-year', parts.join(' · ')));
    c.onclick = () => openMediaFromStack(item);
    grid.append(c);
  });
  scroll.append(grid);

  if (data.page < data.totalPages) {
    const more = el('button', 'home-more', ctx.loadingMore ? 'Завантаження...' : 'Показати ще');
    more.type = 'button';
    more.disabled = ctx.loadingMore;
    more.onclick = () => reloadStreamingTab(ctx, ctx.tab, true);
    scroll.append(more);
  }
}

window.openStreamingProfile = openStreamingProfile;
