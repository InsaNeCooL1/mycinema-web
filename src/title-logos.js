/* FIX-TITLE-LOGOS — українські логотипи назв замість тексту (опційно). */
'use strict';

const TITLE_LOGO_CACHE = 'mycinema.titleLogos.v2';
const TITLE_LOGO_TTL = 30 * 24 * 60 * 60 * 1000;
const TITLE_LOGO_MAX = 800;
const _titleLogoMem = new Map();
const _titleLogoPending = new Map();

/* Обмежуємо одночасні запити, щоб стрічки не влаштовували burst із десятків fetch. */
const LOGO_CONCURRENCY = 4;
const _logoQueue = [];
let _logoActive = 0;
function _pumpLogoQueue() {
  while (_logoActive < LOGO_CONCURRENCY && _logoQueue.length) {
    const job = _logoQueue.shift();
    _logoActive++;
    job.run().then(job.resolve, job.reject).finally(() => { _logoActive--; _pumpLogoQueue(); });
  }
}
function _queueLogoFetch(run) {
  return new Promise((resolve, reject) => {
    _logoQueue.push({ run, resolve, reject });
    _pumpLogoQueue();
  });
}

function readTitleLogoCache() {
  const c = typeof mcCacheGet === 'function' ? mcCacheGet(TITLE_LOGO_CACHE, {}) : {};
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

function writeTitleLogoCache(cache) {
  try {
    const entries = Object.entries(cache);
    if (entries.length > TITLE_LOGO_MAX) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      cache = Object.fromEntries(entries.slice(0, TITLE_LOGO_MAX));
    }
    if (typeof mcCacheSet === 'function') mcCacheSet(TITLE_LOGO_CACHE, cache);
  } catch (e) {}
}

/* Спочатку uk, потім en. Відсіюємо криві співвідношення, бо вони
   роблять логотипи «різної висоти» на одній лінійці. */
function pickUkrainianLogo(logos) {
  if (!Array.isArray(logos)) return null;
  const good = l => l && l.file_path && (!l.aspect_ratio || (l.aspect_ratio >= 1.3 && l.aspect_ratio <= 4.5));
  const uk = logos.filter(l => good(l) && l.iso_639_1 === 'uk');
  if (uk.length) return uk[0].file_path;
  const en = logos.filter(l => good(l) && l.iso_639_1 === 'en');
  if (en.length) return en[0].file_path;
  const any = logos.filter(good);
  return any.length ? any[0].file_path : null;
}

function fetchTitleLogo(item) {
  if (!item || !item.id || !item.type) return Promise.resolve(null);
  const key = item.type + '-' + item.id;
  const cache = readTitleLogoCache();
  const hit = cache[key];
  if (hit && Date.now() - (hit.ts || 0) < TITLE_LOGO_TTL) return Promise.resolve(hit.path || null);
  if (_titleLogoMem.has(key)) return Promise.resolve(_titleLogoMem.get(key));
  if (_titleLogoPending.has(key)) return _titleLogoPending.get(key);

  const promise = _queueLogoFetch(() => (typeof tmdbFetch === 'function'
    ? tmdbFetch('/' + encodeURIComponent(item.type) + '/' + item.id + '/images?include_image_language=uk,en')
    : Promise.resolve(null)))
    .then(data => pickUkrainianLogo(data && data.logos))
    .catch(() => null)
    .then(path => {
      _titleLogoMem.set(key, path);
      const c = readTitleLogoCache();
      c[key] = { ts: Date.now(), path: path };
      writeTitleLogoCache(c);
      return path;
    })
    .finally(() => { _titleLogoPending.delete(key); });

  _titleLogoPending.set(key, promise);
  return promise;
}

function applyTitleLogo(item, titleEl, className, force) {
  if (!titleEl || !item) return;
  if (!force && (typeof settings === 'undefined' || !settings.titleLogos)) return;
  fetchTitleLogo(item).then(path => {
    if (!path || !titleEl.isConnected) return;
    const url = TMDB_IMG + (/\.svg$/i.test(path) ? 'original' : 'w300') + path;
    const img = document.createElement('img');
    img.className = (className || 'rec-title-logo') + ' logo-normal';
    img.alt = String(titleEl.textContent || item.title || '');
    img.loading = 'lazy';
    img.src = url;
    titleEl.replaceChildren(img);

  });
}

window._titleLogos = { pickUkrainianLogo, fetchTitleLogo, applyTitleLogo };
