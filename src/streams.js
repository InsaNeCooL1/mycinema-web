/* Ashdi + EmbF providers — Integrated Diary Player */
(function () {
  'use strict';

  var PROXY_DEFAULT = 'https://mycinema-proxy-base.insaneteresh123.workers.dev';
  var EMBF_SITE = 'https://uakinogo.is';
  var PREFS_KEY = 'mycinema.streamPrefs.v1';
  var RESUME_KEY = 'mycinema.streamResume.v1';

  function getProxy() {
    try { return localStorage.getItem('mycinema.proxy') || PROXY_DEFAULT; }
    catch (e) { return PROXY_DEFAULT; }
  }
  function px(url, opts) {
    opts = opts || {};
    var parts = ['url=' + encodeURIComponent(url)];
    if (opts.referer) parts.push('referer=' + encodeURIComponent(opts.referer));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tmr = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 8000) : null;
    var init = { method: opts.method || 'GET', headers: opts.headers || {} };
    if (opts.body) init.body = opts.body;
    if (ctrl) init.signal = ctrl.signal;
    return fetch(getProxy() + '?' + parts.join('&'), init).then(function (r) {
      if (!r.ok && !(opts.allow404 && r.status === 404)) throw new Error('Проксі HTTP ' + r.status);
      return r.text();
    }).finally(function () { if (tmr) clearTimeout(tmr); });
  }

  /* Лише для пошуку на сайті-джерелі: Jina віддає HTML ізReflection CORS.
     Sam embed і медіа тягнуться напряму з браузера — без проксі. */
  function jinaPx(url) {
    return fetch('https://r.jina.ai/' + url, { headers: { 'X-Return-Format': 'html' } })
      .then(function (r) { if (!r.ok) throw new Error('Jina HTTP ' + r.status); return r.text(); });
  }

  function readJsonStore(k) {
    try {
      var raw = JSON.parse(localStorage.getItem(k) || '{}');
      return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch (e) { return {}; }
  }
  function writeJsonStore(k, obj, limit) {
    try {
      var entries = Object.entries(obj);
      if (entries.length > limit) {
        entries.sort(function (a, b) { return ((b[1] && b[1].ts) || 0) - ((a[1] && a[1].ts) || 0); });
        obj = Object.fromEntries(entries.slice(0, limit));
      }
      localStorage.setItem(k, JSON.stringify(obj));
    } catch (e) {}
  }

  function getStreamPref(mediaKey) {
    if (!mediaKey) return null;
    return readJsonStore(PREFS_KEY)[mediaKey] || null;
  }
  function saveStreamPref(mediaKey, patch) {
    if (!mediaKey) return;
    var all = readJsonStore(PREFS_KEY);
    all[mediaKey] = Object.assign({}, all[mediaKey] || {}, patch, { ts: Date.now() });
    writeJsonStore(PREFS_KEY, all, 200);
  }

  function getResumePos(resumeKey) {
    if (!resumeKey) return 0;
    var r = readJsonStore(RESUME_KEY)[resumeKey];
    return r && r.t > 15 ? r.t : 0;
  }
  function saveResumePos(resumeKey, t, duration) {
    if (!resumeKey) return;
    var all = readJsonStore(RESUME_KEY);
    if (duration > 60 && (duration - t) < 25) {
      delete all[resumeKey];
    } else if (t > 15) {
      all[resumeKey] = { t: Math.floor(t), ts: Date.now() };
    }
    writeJsonStore(RESUME_KEY, all, 100);
  }

  function fmtTimeSec(sec) {
    var s = Math.max(0, Math.floor(sec));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
    return m + ':' + String(r).padStart(2, '0');
  }

  function extractNum(str, fallback) {
    var m = String(str || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : (fallback || 0);
  }

  function isEpWatchedInLib(mediaKey, sNum, epNum) {
    if (!mediaKey || typeof lib === 'undefined' || !lib[mediaKey]) return false;
    var item = lib[mediaKey];
    if (item.status === 'watched') return true;
    var w = item.watchedEpisodes || [];
    return w.indexOf(sNum + '-' + epNum) >= 0;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normStr(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[’ʼ'`"«»“”]/g, '')
      .replace(/[:;,.!?()[\]{}—–\-/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractSnippetMeta(snippet) {
    var clean = String(snippet || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    var ym = clean.match(/\b(19\d{2}|20[0-3]\d)\b/);
    var isTvHint = null;
    if (/(сезон|серіал|мультсеріал|серія|\bseries\b|\/serial)/i.test(clean)) isTvHint = true;
    else if (/(фільм|повнометраж)/i.test(clean)) isTvHint = false;
    return { year: ym ? ym[1] : '', isTvHint: isTvHint };
  }

  function scoreCandidate(cand, title, origTitle, year, type) {
    var ct = normStr(cand.title);
    var nt = normStr(title);
    var no = normStr(origTitle);
    var score = 0;

    function titleMatchScore(target) {
      if (!target || !ct) return 0;
      if (ct === target) return 60;
      if (ct.indexOf(target) === 0 || target.indexOf(ct) === 0) return 46;
      if (ct.indexOf(target) !== -1 || target.indexOf(ct) !== -1) return 34;
      var tw = target.split(' ').filter(function (w) { return w.length >= 2; });
      var cw = ct.split(' ').filter(function (w) { return w.length >= 2; });
      if (!tw.length || !cw.length) return 0;
      var hits = 0;
      tw.forEach(function (w) { if (cw.indexOf(w) !== -1) hits++; });
      return Math.round((hits / Math.max(tw.length, cw.length)) * 32);
    }

    score += Math.max(titleMatchScore(nt), titleMatchScore(no));

    var yTarget = parseInt(year, 10) || 0;
    var yCand = parseInt(cand.year, 10) || 0;
    if (yTarget && yCand) {
      var diff = Math.abs(yTarget - yCand);
      if (diff === 0) score += 30;
      else if (diff === 1) score += 12;
      else score -= 25;
    }

    if (cand.isTvHint !== null && type) {
      var wantTv = (type === 'tv');
      if (cand.isTvHint === wantTv) score += 10;
      else score -= 18;
    }

    return score;
  }

  // ─── Quality cache & detail cache ───
  var qualCache = {};
  var detailCache = {};

  function parseMaster(text, baseUrl) {
    var lines = text.split(/\r?\n/);
    var variants = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
      var res = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      var next = (lines[i + 1] || '').trim();
      if (!res || !next || next.indexOf('#') === 0) continue;
      var w = parseInt(res[1], 10), h = parseInt(res[2], 10);
      var label = w >= 3000 ? '4K' : (w >= 1900 ? '1080p' : (h >= 700 ? '720p' : h + 'p'));
      var vurl = next.indexOf('http') === 0 ? next : baseUrl + next.replace(/^\.?\//, '');
      variants.push({ width: w, height: h, label: label, url: vurl });
    }
    variants.sort(function (a, b) { return b.width - a.width; });
    return variants;
  }

  function fetchQualities(m3u8Url) {
    // iframe-плеєри (наприклад EmbF) не мають прямого url — просто немає що парсити
    if (!m3u8Url || typeof m3u8Url !== 'string') return Promise.resolve([]);
    if (qualCache[m3u8Url]) return Promise.resolve(qualCache[m3u8Url]);
    var base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    /* calypso.tortuga.tw віддає ACAO:* — воркер його не бере (403), тому
       одразу йдемо напряму, без зайвої помилки в консолі. */
    var directFetch = fetch(m3u8Url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
    var loadPlaylist = /^https?:\/\/(?:[^/?#]*\.)?tortuga\.tw\//i.test(m3u8Url)
      ? directFetch
      : (typeof px === 'function' ? px(m3u8Url).catch(function () { return directFetch; }) : directFetch);
    return loadPlaylist.then(function (text) {
      var v = parseMaster(text, base);
      qualCache[m3u8Url] = v;
      return v;
    }).catch(function () {
      qualCache[m3u8Url] = [];
      return [];
    });
  }

  /* Універсальний контракт для плеєра: будь-яке джерело (Ashdi, EmbF,
     нове — потім) просто віддає flat-список, а оверлей сам будує селектори. */
  function buildVariants(rawItems) {
    return Promise.all((rawItems || []).map(function (x) {
      if (x.mcSkipQuality) return Promise.resolve([]);
      return fetchQualities(x.url).catch(function () { return []; });
    })).then(function (allQ) {
      var out = [];
      (rawItems || []).forEach(function (x, i) {
        var qs = allQ[i] && allQ[i].length ? allQ[i] : [{ label: x.quality || '', url: x.url }];
        qs.forEach(function (q) {
          out.push({
            season: x.season || '',
            episode: x.episode || '',
            translation: x.translation || 'За замовчуванням',
            quality: q.label || 'Найкраща',
            url: q.url || x.url,
            subtitle: x.subtitle || '',
            audioLang: x.audioLang || '',
            proxy: !!(x.mcProxy || x.proxy),
            iframeFallback: x.fallbackIframeUrl || ''
          });
        });
      });
      return out;
    });
  }

  /* ─── Ashdi ──────────────────────────────────────────────────────────────
     Адаптовано з модуля makhno_snack: тайтл шукається за IMDb/TMDB id на
     WH-сервісі, потім парситься сторінка плеєра ashdi (file:'[...]').
     Запити йдуть через Jina (WH) і проксі сайту (плеєр) — без CORS у браузері.
     ─────────────────────────────────────────────────────────────────────── */
  var WH_HOST = 'https://wh.lme.isroot.in/';
  var ASHDI_RE = /^https:\/\/(?:ashdi\.vip|sniplyo\.online|creavio\.online)\/(vod|serial)\/\d+(?:[?#]|$)/i;
  var Q4K_RE = /(^|[^0-9])2160p?([^0-9]|$)|(^|[^a-z0-9])(4k|uhd)([^a-z0-9]|$)/i;
  var whCache = {};

  function isAshdiPlayer(u) { return ASHDI_RE.test(String(u || '')); }
  function ashdiOrigin(u) {
    var m = /^https?:\/\/[^\/?#]+/i.exec(String(u || ''));
    return m ? m[0] : 'https://ashdi.vip';
  }
  function ashdiFix(u) { return String(u || '').trim().replace(/0yql3tj/g, 'oyql3tj'); }
  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#0*39;/g, "'").replace(/&#x27;/gi, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  function ashdiVoice(t) {
    t = String(t || '').trim();
    return /^(не\s*визначено|невідомо|unknown)$/i.test(t) ? '' : t;
  }
  // ashdi пише субтитри як "[Українські]https://...vtt" — плеєру потрібен чистий URL
  function ashdiSub(s) {
    var text = decodeEntities(String(s || ''));
    var m = /\[[^\]]*\]\s*(https?:\/\/[^\s,]+|\/[^\s,]+)/.exec(text)
      || /(https?:\/\/[^\s,]+|\/[^\s,]+)/.exec(text);
    return m ? m[1] : '';
  }
  function collectAshdiFiles(n, out) {
    if (!n || typeof n !== 'object') return;
    if (n.file) out.push(String(n.file));
    (n.folder || []).forEach(function (x) { collectAshdiFiles(x, out); });
  }
  function tag4k(name, files) {
    if (/^\[4K\]/i.test(name) || !files.some(function (f) { return Q4K_RE.test(f); })) return name;
    return '[4K]' + (name ? ' ' + name : '');
  }
  function slimAshdi(n) {
    if (!n || typeof n !== 'object') return null;
    var o = { title: ashdiVoice(decodeEntities(String(n.title || '')).replace(/\s+/g, ' ').trim()) };
    if (n.file) o.file = ashdiFix(n.file);
    if (n.subtitle) o.subtitle = ashdiSub(n.subtitle);
    if (Array.isArray(n.folder)) {
      o.folder = n.folder.map(slimAshdi).filter(function (x) { return x; });
      if (!o.folder.length) delete o.folder;
    }
    return o;
  }
  function parseAshdiHtml(html) {
    var a = /file\s*:\s*'(\[[\s\S]+?\])'\s*[,}]/.exec(html)
      || /file\s*:\s*"(\[[\s\S]+?\])"\s*[,}]/.exec(html);
    var tree = null;
    if (a) {
      try { tree = JSON.parse(a[1].replace(/\\'/g, "'")); } catch (e) {}
    }
    if (!tree) {
      var m = /file\s*:\s*["'](https?:\/\/[^"'\s]+)["']/.exec(html);
      if (!m) return null;
      var sm = /subtitle\s*:\s*["']([^"']*)["']/.exec(html);
      tree = [{ title: '', file: m[1], subtitle: sm ? sm[1] : '' }];
    }
    if (!Array.isArray(tree)) tree = [tree];
    var out = tree.map(slimAshdi).filter(function (x) { return x; });
    return out.length ? out : null;
  }
  function tagAshdiTree(tree) {
    var hasVoices = tree[0] && tree[0].folder && tree[0].folder[0] && tree[0].folder[0].folder;
    tree.forEach(function (v) {
      var files = [];
      if (hasVoices) collectAshdiFiles(v, files);
      else if (v.file) files.push(v.file);
      if (files.length) v.title = tag4k(v.title, files);
    });
    return tree;
  }
  function lookupAshdi(imdbId, tmdbId, type, title) {
    var imdb = /^tt\d{5,10}$/.test(String(imdbId || '').trim()) ? String(imdbId).trim() : '';
    var tmdb = /^\d+$/.test(String(tmdbId || '').trim()) ? String(tmdbId).trim() : '';
    if (!imdb && !tmdb) return Promise.resolve('');
    var serial = type === 'tv' ? '1' : (type === 'movie' ? '0' : '');
    var ck = 'wh:' + imdb + ':' + tmdb + ':' + serial;
    var hit = whCache[ck];
    if (hit && Date.now() < hit.until) return Promise.resolve(hit.play || '');
    var p = [];
    if (imdb) p.push('imdb_id=' + encodeURIComponent(imdb));
    if (tmdb) p.push('tmdb_id=' + encodeURIComponent(tmdb));
    if (serial) p.push('serial=' + serial);
    p.push('silent=true');
    // WH-сервіс не віддає CORS і не в списку дозволених хостів нашого проксі,
    // тому йдемо через Jina (як EmbF) і дістаємо JSON з <pre>.
    return jinaPx(WH_HOST + '?' + p.join('&')).then(function (text) {
      var raw = String(text || '').trim();
      var pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(raw);
      if (pre) raw = pre[1].replace(/&quot;/g, '"').replace(/&#0*39;|&#x27;/gi, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      var j = null;
      try { j = JSON.parse(raw.trim()); } catch (e) {}
      var play = j && typeof j.play === 'string' ? j.play.trim() : '';
      if (!isAshdiPlayer(play)) play = '';
      if (play) return play;
      /* WH не знає цей ID — шукаємо за назвою на сайті Ashdi через Jina. */
      var q = String(title || '').trim();
      if (!q) return '';
      var searchUrl = 'https://ashdi.vip/?do=search&subaction=search&story=' + encodeURIComponent(q);
      return jinaPx(searchUrl).then(function (html) {
        var m = /(?:https?:\/\/)?(?:www\.)?(?:ashdi\.vip|sniplyo\.online|creavio\.online)?\/(vod|serial)\/(\d+)/i.exec(String(html || ''));
        if (!m) return '';
        var found = 'https://ashdi.vip/' + m[1] + '/' + m[2];
        return isAshdiPlayer(found) ? found : '';
      }).catch(function () { return ''; });
    }).then(function (play) {
      whCache[ck] = { play: play || '', until: Date.now() + (play ? 86400000 : 3600000) };
      return play || '';
    }).catch(function () { return ''; });
  }
  function resolveAshdi(cand) {
    if (detailCache[cand.href]) return Promise.resolve(detailCache[cand.href]);
    var href = cand.href;
    var ask = (/\/vod\//i.test(href) && !/multivoice/i.test(href))
      ? href + (href.indexOf('?') >= 0 ? '&' : '?') + 'multivoice' : href;
    /* Ashdi геоблокує IP воркера й віддає «Змініть країну перегляду» замість
       плеєра. Jina читає ту саму сторінку зі свого діапазону — конфіг лишається
       повний, а медіа нижче йдуть через воркер (там геоблоку немає). */
    return jinaPx(ask).then(function (html) {
      var tree = parseAshdiHtml(html);
      if (!tree) throw new Error('Ashdi: плеєр не віддав джерела');
      tagAshdiTree(tree);
      var flat = flatten(tree);
      if (!flat.length) throw new Error('Немає доступних джерел');
      var origin = ashdiOrigin(href);
      flat.forEach(function (x) {
        if (x.subtitle && /^\//.test(x.subtitle)) x.subtitle = origin + x.subtitle;
        // сегменти лежать на jk*ocmjeoyql3tj.ashdi.vip з ACAO: https://ashdi.vip —
        // їх треба тягнути через наш CF-прокси, інакше браузер блокує CORS
        x.mcProxy = true;
      });
      detailCache[href] = flat;
      return flat;
    });
  }

  // ─── Search providers ───

  /* EmbF — GET-пошук (?story=) НЕ фільтрує каталог і завжди віддає останні
     10 релізів. Реальний пошук — AJAX POST з query + user_hash. */
  var embfHash = { value: '', ts: 0 };
  function embfUserHash() {
    if (embfHash.value && Date.now() - embfHash.ts < 600000) return Promise.resolve(embfHash.value);
    /* Важливо: hash треба брати тим самим проксі, що й AJAX-запит.
       Jina віддає hash від іншої сесії → DLE каже «сессия истекла». */
    return px(EMBF_SITE + '/').then(function (html) {
      var m = /dle_login_hash\s*=\s*['"]([a-f0-9]+)['"]/i.exec(html);
      embfHash.value = m ? m[1] : '';
      embfHash.ts = Date.now();
      return embfHash.value;
    }).catch(function () { return ''; });
  }
  function parseEmbfAjax(html) {
    var results = [], seen = {};
    var re = /<a[^>]+href="(https?:\/\/(?:uakinogo|kinogo)\.is\/\d+-[^"]+\.html)"[^>]*>\s*<span class="searchheading">([\s\S]{1,200}?)<\/span>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var href = m[1].replace(/^https?:\/\/kinogo\.is/i, EMBF_SITE);
      var title = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      var ym = /\((\d{4})\)/.exec(title); /* рік — з назви, не з дати оновлення */
      var clean = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      if (!clean || seen[href]) continue;
      seen[href] = 1;
      results.push({ href: href, title: clean, year: ym ? ym[1] : '',
        isTvHint: null, provider: 'embf' });
    }
    return results;
  }
  function embfAjaxSearch(query) {
    var q = String(query || '').replace(/[«»"“”]/g, '').trim();
    if (!q) return Promise.resolve([]);
    function post(hash) {
      return px(EMBF_SITE + '/engine/ajax/controller.php?mod=search', {
        method: 'POST',
        referer: EMBF_SITE + '/',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'query=' + encodeURIComponent(q) + '&user_hash=' + encodeURIComponent(hash)
      });
    }
    return embfUserHash().then(function (hash) {
      if (!hash) return [];
      return post(hash).then(function (html) {
        if (/сессия истекла|перезагрузите страницу/i.test(html)) {
          /* Сесія на сайті оновилась — беремо свіжий hash і повторюємо запит */
          embfHash.value = '';
          return embfUserHash().then(function (h2) {
            return h2 ? post(h2).then(parseEmbfAjax) : [];
          });
        }
        return parseEmbfAjax(html);
      }).catch(function () { return []; });
    });
  }
  function searchEmbf(query) { return embfAjaxSearch(query); }

  /* Жорсткий фільтр: кандидат має збігатися з однією з відомих назв.
     Інакше повертаємо 0, а не випадковий топ-10 каталогу. */
  function embfMatchScore(cand, names, year) {
    var c = normStr(String(cand.title || '').replace(/\s*\(\d{4}\)\s*$/, ''));
    if (!c) return 0;
    var best = 0;
    (names || []).forEach(function (n) {
      var t = normStr(n);
      if (!t) return;
      var v = 0;
      if (c === t) v = 100;
      else if (c.indexOf(t) === 0 || t.indexOf(c) === 0) v = 80;
      else if (c.indexOf(t) >= 0 || t.indexOf(c) >= 0) v = 60;
      else {
        var cw = c.split(' ').filter(function (w) { return w.length > 2; });
        var tw = t.split(' ').filter(function (w) { return w.length > 2; });
        if (!cw.length || !tw.length) return;
        var hits = cw.filter(function (w) { return tw.indexOf(w) >= 0; }).length;
        /* Повний збіг слів (напр. "Аватар 3: Вогонь і попіл" проти
           "Аватар: Вогонь і Попіл") має проходити поріг 60. */
        v = Math.round((hits / Math.max(cw.length, tw.length)) * 80);
      }
      if (v > best) best = v;
    });
    if (best && cand.year && year && String(cand.year) !== String(year).slice(0, 4)) {
      best = Math.max(0, best - 40);
    }
    return best;
  }
  function searchEmbfSmart(title, origTitle, ruTitle, year) {
    var names = [], seenName = {};
    [origTitle, ruTitle, title].forEach(function (n) {
      var s = String(n || '').replace(/[«»"“”]/g, '').trim();
      if (s && !seenName[normStr(s)]) { seenName[normStr(s)] = 1; names.push(s); }
    });
    if (!names.length) return Promise.resolve([]);
    return Promise.all(names.map(function (q) {
      return embfAjaxSearch(q).catch(function () { return []; });
    })).then(function (groups) {
      var seen = {}, out = [];
      groups.forEach(function (g) {
        g.forEach(function (c) {
          if (seen[c.href]) return;
          var score = embfMatchScore(c, names, year);
          if (score < 60) return; /* відсікаємо чужий топ-10 */
          seen[c.href] = 1;
          c.score = score;
          out.push(c);
        });
      });
      return out.sort(function (a, b) { return b.score - a.score; });
    });
  }
  function getEmbfRuTitle(tmdbId, type) {
    if (!tmdbId || typeof tmdbFetch !== 'function') return Promise.resolve('');
    return Promise.resolve(tmdbFetch('/' + (type === 'tv' ? 'tv' : 'movie') + '/' + tmdbId + '?language=ru-RU'))
      .then(function (d) { return (d && (d.title || d.name)) || ''; })
      .catch(function () { return ''; });
  }

  /* ─── Tortuga через KinoUKR ───────────────────────────────────────────────
     Адаптовано з kinoukr_snack: картки шукаються на kinoukr.tv/xfsearch,
     сторінка тайтла дає iframe Tortuga, а конфіг плеєра лежить у TortugaCore:
     base64, перший байт — seed, далі b[i] ^ ((seed + 7*(i-1) + 13) & 255).
     ─────────────────────────────────────────────────────────────────────── */
  var KINOUKR_SITE = 'https://kinoukr.tv';
  var TORTUGA_RE = /^https:\/\/(?:tortuga\.tw|tortuga\.wtf)\/(?:vod|embed)\/\d+(?:[?#]|$)/i;
  var B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var kinoukrCache = {};

  function isTortugaPlayer(u) { return TORTUGA_RE.test(String(u || '')); }
  function tortugaFix(u) { return decodeEntities(String(u || '')).trim().replace(/0yql3tj/g, 'oyql3tj'); }

  function b64bytes(s) {
    var src = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < src.length; i++) {
      buf = (buf << 6) | B64_ALPHA.indexOf(src.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); buf &= (1 << bits) - 1; }
    }
    return out;
  }
  function bytesToUtf8(a) {
    var s = '', i = 0;
    while (i < a.length) {
      var c = a[i++];
      if (c < 128) s += String.fromCharCode(c);
      else if (c >= 192 && c < 224) s += String.fromCharCode(((c & 31) << 6) | (a[i++] & 63));
      else if (c >= 224 && c < 240) {
        s += String.fromCharCode(((c & 15) << 12) | ((a[i] & 63) << 6) | (a[i + 1] & 63));
        i += 2;
      } else {
        var cp = ((c & 7) << 18) | ((a[i] & 63) << 12) | ((a[i + 1] & 63) << 6) | (a[i + 2] & 63);
        i += 3;
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
      }
    }
    return s;
  }
  function tortugaUnpack(v) {
    var b = b64bytes(v);
    if (b.length < 2) return '';
    var seed = b[0], out = [];
    for (var i = 1; i < b.length; i++) out.push(b[i] ^ ((seed + 7 * (i - 1) + 13) & 255));
    return bytesToUtf8(out);
  }
  function tortugaSubs(s) {
    var out = [], re = /\[([^\]]*)\]([^,\[]+)/g, m;
    while ((m = re.exec(String(s || ''))) !== null) {
      var u = tortugaFix(m[2]);
      if (/^https?:\/\//i.test(u)) out.push(u);
    }
    return out;
  }
  function slimTortuga(n) {
    if (!n || typeof n !== 'object') return null;
    var o = { title: decodeEntities(String(n.title || '')).replace(/\s+/g, ' ').trim() };
    if (n.file) o.file = tortugaFix(n.file);
    if (n.subtitle) o.subtitle = tortugaSubs(n.subtitle)[0] || '';
    if (Array.isArray(n.folder)) {
      o.folder = n.folder.map(slimTortuga).filter(function (x) { return x; });
      if (!o.folder.length) delete o.folder;
    }
    return o;
  }
  function cleanTortugaTree(nodes) {
    var out = [];
    (nodes || []).forEach(function (n) {
      if (!n || typeof n !== 'object') return;
      if (n.file && /\/hls\/trailers\//i.test(n.file)) return;
      var o = { title: n.title || '' };
      if (n.file) o.file = n.file;
      if (n.subtitle) o.subtitle = n.subtitle;
      if (Array.isArray(n.folder)) {
        o.folder = cleanTortugaTree(n.folder);
        if (!o.folder.length) delete o.folder;
      }
      if (o.file || o.folder) out.push(o);
    });
    return out;
  }
  function parseTortugaHtml(html) {
    var src = String(html || '');
    var i = src.indexOf('TortugaCore(');
    if (i < 0) return null;
    var blk = src.slice(i, i + 200000);
    var fm = /\bfile\s*:\s*"([^"]+)"/.exec(blk);
    if (!fm) return null;
    var file = tortugaUnpack(fm[1]);
    var tree = null;
    if (/^\s*\[/.test(file)) {
      try { tree = JSON.parse(file); } catch (e) { return null; }
    } else if (/^https?:\/\//i.test(file.trim())) {
      if (/\/hls\/trailers\//i.test(file)) return null;
      var sm = /\bsubtitle\s*:\s*"([^"]*)"/.exec(blk);
      tree = [{ title: 'Tortuga', file: file.trim(), subtitle: sm ? tortugaUnpack(sm[1]) : '' }];
    } else return null;
    if (!Array.isArray(tree)) tree = [tree];
    var out = cleanTortugaTree(tree.map(slimTortuga).filter(function (x) { return x; }));
    return out.length ? out : null;
  }

  function parseKinoukrSearch(html) {
    var out = [], seen = {};
    var parts = String(html || '').split('<div class="short clearfix');
    for (var i = 1; i < parts.length && out.length < 20; i++) {
      var b = parts[i];
      var m = /class="short-title"\s+href="([^"]+)">([^<]+)<\/a>/.exec(b);
      if (!m) continue;
      var href = decodeEntities(m[1]).trim();
      if (!/^https?:\/\/(?:www\.)?kinoukr\.tv\//i.test(href) || seen[href]) continue;
      seen[href] = 1;
      var kind = /m-series|m-sezon/.test(b) ? 'tv' : (/m-film/.test(b) ? 'movie' : '');
      out.push({
        href: href, title: decodeEntities(m[2]).replace(/\s+/g, ' ').trim(), kind: kind,
        isTvHint: kind === 'tv' ? true : (kind === 'movie' ? false : null), provider: 'tortuga'
      });
    }
    return out;
  }
  function parseKinoukrPage(html) {
    var info = { title: '', orig: '', year: 0, players: [] };
    var h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ''));
    if (h1) info.title = decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    var om = /class="foriginal">([^<]*)</.exec(String(html || ''));
    if (om) info.orig = decodeEntities(om[1]).trim();
    var ym = /<span>Рік:<\/span>\s*<a[^>]*\/xfsearch\/year\/(\d{4})\//.exec(String(html || ''))
      || /\/xfsearch\/year\/(\d{4})\//.exec(String(html || ''));
    if (ym) info.year = parseInt(ym[1], 10);
    var re = /<iframe[^>]+src="(https?:\/\/[^"]+)"/ig, m;
    while ((m = re.exec(String(html || ''))) !== null) {
      var u = decodeEntities(m[1]).trim();
      if (isTortugaPlayer(u) && info.players.indexOf(u) < 0) info.players.push(u);
    }
    return info;
  }
  function searchKinoukr(query) {
    var q = String(query || '').replace(/[«»"“”]/g, '').trim();
    if (!q) return Promise.resolve([]);
    var ck = 'ku:' + q.toLowerCase();
    var hit = kinoukrCache[ck];
    if (hit && Date.now() < hit.until) return Promise.resolve(hit.items);
    var url = KINOUKR_SITE + '/xfsearch/' + encodeURIComponent(q) + '/';
    return px(url, { referer: KINOUKR_SITE + '/', allow404: true }).then(function (html) {
      var items = parseKinoukrSearch(html);
      kinoukrCache[ck] = { items: items, until: Date.now() + (items.length ? 3600000 : 600000) };
      return items;
    }).catch(function () {
      kinoukrCache[ck] = { items: [], until: Date.now() + 600000 };
      return [];
    });
  }
  function searchKinoukrSmart(title, origTitle, ruTitle, year, type) {
    var names = [], seenName = {};
    [origTitle, ruTitle, title].forEach(function (n) {
      var s = String(n || '').replace(/[«»"“”]/g, '').trim();
      if (s && !seenName[normStr(s)]) { seenName[normStr(s)] = 1; names.push(s); }
    });
    if (!names.length) return Promise.resolve([]);
    /* XFsearch працює за тегами: «Avatar: Fire and Ash» треба шукати ще й
       як «Avatar», інакше DLE віддає порожній 404. Для збігу лишаємо повну назву. */
    var queries = [], seenQuery = {};
    names.forEach(function (n) {
      var k = normStr(n);
      if (!seenQuery[k]) { seenQuery[k] = 1; queries.push(n); }
      var base = String(n).split(/[:—–]/)[0].trim();
      var variants = [base];
      var words = base.split(/\s+/).filter(function (w) { return w; });
      if (words.length > 2) variants.push(words.slice(0, 2).join(' '));
      var hyphen = /[^\s:—–]+(?:-[^\s:—–]+)+/.exec(base);
      if (hyphen) variants.push(hyphen[0]);
      variants.forEach(function (v) {
        v = String(v || '').trim();
        var vk = normStr(v);
        if (v && v !== n && !seenQuery[vk]) { seenQuery[vk] = 1; queries.push(v); }
      });
    });
    var wantType = type === 'tv' ? 'tv' : (type === 'movie' ? 'movie' : '');
    var wantYear = parseInt(year, 10) || 0;
    return Promise.all(queries.slice(0, 8).map(function (q) {
      return searchKinoukr(q).catch(function () { return []; });
    })).then(function (groups) {
      var byHref = {}, order = [];
      groups.forEach(function (g) {
        g.forEach(function (c) { if (!byHref[c.href]) { byHref[c.href] = c; order.push(c); } });
      });
      order.sort(function (a, b) {
        function rank(c) {
          var n = normStr(c.title), v = 0;
          names.forEach(function (x) { if (normStr(x) === n) v += 100; });
          if (wantType && c.kind && c.kind !== wantType) v -= 30;
          return v;
        }
        return rank(b) - rank(a);
      });
      var checked = 0;
      return order.slice(0, 8).reduce(function (chain, c) {
        return chain.then(function (acc) {
          if (acc.length >= 3 || checked >= 6) return acc;
          checked++;
          return px(c.href, { referer: KINOUKR_SITE + '/', allow404: true }).then(function (html) {
            var info = parseKinoukrPage(html);
            if (!info.players.length) return acc;
            var titles = [info.title, info.orig, c.title].map(normStr).filter(function (x) { return x; });
            var ok = false;
            names.forEach(function (n) { if (titles.indexOf(normStr(n)) >= 0) ok = true; });
            if (!ok) return acc;
            if (wantYear && info.year && Math.abs(info.year - wantYear) > 1) return acc;
            acc.push({
              href: c.href, title: info.title || c.title, orig: info.orig,
              year: info.year || '', isTvHint: wantType ? wantType === 'tv' : !!c.isTvHint,
              provider: 'tortuga', players: info.players,
              score: (wantYear && info.year === wantYear ? 100 : 80)
            });
            return acc;
          }).catch(function () { return acc; });
        });
      }, Promise.resolve([])).then(function (res) {
        return res.sort(function (a, b) { return b.score - a.score; });
      });
    });
  }
  function resolveTortuga(cand) {
    if (detailCache[cand.href]) return Promise.resolve(detailCache[cand.href]);
    var players = (cand.players || []).slice(0, 4);
    if (!players.length) return Promise.reject(new Error('Tortuga: немає плеєра'));
    return players.reduce(function (chain, href) {
      return chain.then(function (flat) {
        if (flat.length) return flat;
        return px(href, { referer: KINOUKR_SITE + '/' }).then(function (html) {
          var tree = parseTortugaHtml(html);
          if (!tree || !tree.length) return [];
          return flatten(tree).filter(function (x) {
            return x.url && !/\/hls\/trailers\//i.test(x.url);
          }).map(function (x) {
            if (!x.translation) x.translation = 'Tortuga';
            /* Підписаний HLS може протермінуватись — тримаємо iframe того ж
               Tortuga як запасний шлях (без переходу на іншого провайдера). */
            if (!x.fallbackIframeUrl) x.fallbackIframeUrl = players[0];
            return x;
          });
        }).catch(function () { return []; });
      });
    }, Promise.resolve([])).then(function (flat) {
      /* Плеєр Tortuga блокує серверні запити з CF-IP — лишаємо його власний
         iframe як робочий шлях, без переходу на іншого провайдера. */
      if (!flat.length) {
        flat = [{ title: 'Tortuga', translation: 'Tortuga', iframeUrl: players[0], season: '', episode: '' }];
      }
      detailCache[cand.href] = flat;
      return flat;
    });
  }

  function resolveEmbf(cand) {
    // Відкриваємо рідний плеєр EmbF у iframe — там його власні селектори
    // якості й озвучки виглядають саме так, як на сайті-джерелі.
    return jinaPx(cand.href).then(function (html) {
      var m = html.match(/(?:https?:)?\/\/api\.embf\.net\/embed\/(?:movie|serial)\/\d+/i);
      if (!m) throw new Error('EmbF: embed не знайдено');
      var embedUrl = m[0].replace(/^\/\//, 'https://');
      return [{
        title: 'EmbF',
        translation: 'EmbF',
        iframeUrl: embedUrl,
        season: '', episode: ''
      }];
    });
  }
  function searchProviderSmart(searchFn, title, origTitle, year, type) {
    var q1 = String(title || '').replace(/[«»"“”]/g, '').trim();
    var q2 = String(origTitle || '').replace(/[«»"“”]/g, '').trim();
    return searchFn(q1).catch(function () { return []; }).then(function (res1) {
      var scored1 = res1.map(function (c) {
        c.score = scoreCandidate(c, title, origTitle, year, type);
        return c;
      }).sort(function (a, b) { return b.score - a.score; });

      var bestScore = scored1.length ? scored1[0].score : -1;
      var needOrig = q2 && normStr(q2) !== normStr(q1) && (!scored1.length || bestScore < 65);
      if (!needOrig) return scored1;

      return searchFn(q2).catch(function () { return []; }).then(function (res2) {
        var byHref = {};
        scored1.forEach(function (c) { byHref[c.href] = c; });
        res2.forEach(function (c) {
          if (!byHref[c.href]) {
            c.score = scoreCandidate(c, title, origTitle, year, type);
            byHref[c.href] = c;
          }
        });
        return Object.keys(byHref).map(function (k) { return byHref[k]; })
          .sort(function (a, b) { return b.score - a.score; });
      });
    });
  }

  // ─── Resolvers ───
  function flatten(tree, path) {
    path = path || {};
    var out = [];
    if (!Array.isArray(tree)) tree = [tree];
    tree.forEach(function (n) {
      var t = n.title || '';
      var np = {
        season: /сезон/i.test(t) ? t : path.season,
        translation: t && !/сезон|серія|серия/i.test(t) ? t : path.translation,
        episode: /серія|серия/i.test(t) ? t : path.episode
      };
      if (n.file) out.push({
        season: np.season || '', translation: np.translation || '', episode: np.episode || '',
        url: n.file, subtitle: n.subtitle || ''
      });
      if (n.folder) out = out.concat(flatten(n.folder, np));
    });
    return out;
  }

  function resolveGenericDetailAndEmbed(cand) {
    var ref = cand.href.replace(/^(https?:\/\/[^/]+).*$/, '$1/');
    return px(cand.href).then(function (html) {
      var m = html.match(/class="[^"]*tabs_b[^"]*visible[^"]*"[^>]*>[\s\S]{0,3000}?<iframe[^>]+(?:data-)?src="([^"]+)"/)
        || html.match(/<iframe[^>]+(?:data-)?src="(https?:\/\/[^"]*(?:ashdi|tortuga|hdvbua|csst|monstro|qeruya|ufdub)[^"]+)"/i)
        || html.match(/<iframe[^>]+(?:data-)?src="([^"]+)"/i);
      if (!m) throw new Error('Player iframe не знайдено');
      var embedUrl = m[1];
      if (embedUrl.indexOf('//') === 0) embedUrl = 'https:' + embedUrl;
      return px(embedUrl, { referer: ref }).then(function (eHtml) {
        var fm = eHtml.match(/file\s*:\s*'([^']+)'/) || eHtml.match(/file\s*:\s*"([^"]+)"/);
        if (fm) {
          var raw = fm[1];
          if (raw.indexOf('http') === 0) return [{ title: 'HD', file: raw }];
          try { return JSON.parse(raw); } catch (e) {}
        }
        return [{ title: 'Плеєр (Iframe)', iframeUrl: embedUrl }];
      }).catch(function () {
        return [{ title: 'Плеєр (Iframe)', iframeUrl: embedUrl }];
      });
    });
  }

  function loadFlatForResult(cand) {
    if (detailCache[cand.href]) return Promise.resolve(detailCache[cand.href]);
    if (cand.provider === 'ashdi') return resolveAshdi(cand);
    if (cand.provider === 'tortuga') return resolveTortuga(cand);
    if (cand.provider === 'embf') {
      return resolveEmbf(cand).then(function (res) {
        if (res && res.length) detailCache[cand.href] = res;
        return res;
      });
    }
    return Promise.reject(new Error('Невідомий провайдер джерел'));
  }

  // ─── Fullscreen & Back helpers ───
  function setNativeFullscreen(enabled) {
    document.body.classList.toggle('mc-fs', !!enabled);
  }

  function toggleElementFullscreen(targetEl) {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      setNativeFullscreen(false);
    } else if (targetEl) {
      var req = targetEl.requestFullscreen || targetEl.webkitRequestFullscreen;
      if (req) {
        Promise.resolve(req.call(targetEl)).then(function () { setNativeFullscreen(true); }).catch(function () { setNativeFullscreen(true); });
      } else {
        setNativeFullscreen(true);
      }
    }
  }

  function syncFsBar() {
    var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    var vidOv = document.getElementById('streams-video');
    if (vidOv) {
      var bar = vidOv.querySelector('[data-role="video-bar"]');
      if (bar) bar.style.display = isFs ? 'none' : 'flex';
    }
    setNativeFullscreen(isFs);
  }
  document.addEventListener('fullscreenchange', syncFsBar);
  document.addEventListener('webkitfullscreenchange', syncFsBar);

  function closeVideoOverlay() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      try { if (document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) {}
    }
    setNativeFullscreen(false);
    var v = document.getElementById('streams-video');
    if (v) {
      var vid = v.querySelector('video');
      var watchedTime = 0;
      if (vid) {
        watchedTime = vid.currentTime || 0;
        if (v._resumeKey) saveResumePos(v._resumeKey, vid.currentTime || 0, vid.duration || 0);
        vid.pause();
      }
      if (v._hls) { try { v._hls.destroy(); } catch (e) {} }
      if (v._overlay) { try { v._overlay.destroy(); } catch (e) {} }
      if (v._controls) { try { v._controls.destroy(); } catch (e) {} }
      var onClosed = v._onClosed;
      v.remove();
      if (typeof onClosed === 'function') onClosed(watchedTime);
    }
  }

  var _streamsHistoryActive = false;
  function ensureStreamsHistoryGuard() {
    if (_streamsHistoryActive) return;
    _streamsHistoryActive = true;
    var curMc = (history.state && history.state.mc) || 0;
    history.pushState({ mc: curMc, mcStreams: 1 }, '', location.href);
  }

  function closeModal(fromPopstate) {
    closeVideoOverlay();
    var el = document.getElementById('streams-overlay');
    if (el) el.remove();
    document.documentElement.classList.remove('streams-lock');
    document.body.classList.remove('streams-lock');
    if (!fromPopstate && _streamsHistoryActive) {
      _streamsHistoryActive = false;
      try { history.back(); } catch (e) {}
    } else if (fromPopstate) {
      _streamsHistoryActive = false;
    }
  }

  function handleStreamsBack() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    var v = document.getElementById('streams-video');
    if (fsEl) {
      try { if (document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) {}
      setNativeFullscreen(false);
      return true;
    }
    if (v) {
      closeVideoOverlay();
      return true;
    }
    var ov = document.getElementById('streams-overlay');
    if (ov) {
      var matchesOpen = ov.querySelector('.streams-matches-list');
      if (matchesOpen && matchesOpen.style.display !== 'none') {
        matchesOpen.style.display = 'none';
        return true;
      }
      closeModal(false);
      return true;
    }
    return false;
  }
  window.handleStreamsBack = handleStreamsBack;

  window.addEventListener('popstate', function () {
    var v = document.getElementById('streams-video');
    var ov = document.getElementById('streams-overlay');
    if (!v && !ov) { _streamsHistoryActive = false; return; }
    if (v) {
      closeVideoOverlay();
      var curMc = (history.state && history.state.mc) || 0;
      history.pushState({ mc: curMc, mcStreams: 1 }, '', location.href);
      return;
    }
    closeModal(true);
  });

  // ─── hls.js loader ───
  var hlsLoading = null;
  function ensureHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLoading) return hlsLoading;
    hlsLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
      s.onload = function () { resolve(window.Hls); };
      s.onerror = function () { hlsLoading = null; reject(new Error('Не вдалось завантажити hls.js')); };
      document.head.appendChild(s);
    });
    return hlsLoading;
  }

  function proxyMediaUrl(u) {
    return getProxy() + '?url=' + encodeURIComponent(String(u || ''));
  }

  /* hls.js: плейлисти ashdi.vip мають ACAO:*, а сегменти лежать на
     jk*ocmjeoyql3tj.ashdi.vip з ACAO: https://ashdi.vip. Переписуємо URL
     фрагментів/ключів на CF-прокси.
     Важливо: hls.js створює лоадер як new Loader(config), а фрагменти завантажує
     окремим config.fLoader — тому обгортка має коректний сигнітур і ставитись
     і в loader, і в fLoader. */
  function createProxyLoader(Base) {
    function ProxyLoader(config) {
      this._base = new Base(config);
      this.stats = this._base.stats;
    }
    ProxyLoader.prototype.load = function (context, loaderConfig, callbacks) {
      if (context && (context.frag || context.keyInfo)) {
        var u = String(context.url || '');
        /* Фрагменти Ashdi без ACAO йдуть через той самий CF-проксі, що й mp4.
           Якорі кінця не дають подвійно проксувати вже проксований URL воркера. */
        if (/^https?:\/\/(?:[^/?#]*\.)?(?:ashdi\.vip|sniplyo\.online|creavio\.online)(?:\/|[?#]|$)/i.test(u)) context.url = proxyMediaUrl(u);
      }
      return this._base.load(context, loaderConfig, callbacks);
    };
    ['abort', 'destroy', 'getCacheAge', 'getResponseHeader'].forEach(function (m) {
      ProxyLoader.prototype[m] = function () {
        if (typeof this._base[m] !== 'function') return null;
        return this._base[m].apply(this._base, arguments);
      };
    });
    Object.defineProperty(ProxyLoader.prototype, 'context', {
      configurable: true,
      get: function () { return this._base.context; },
      set: function (v) { this._base.context = v; }
    });
    return ProxyLoader;
  }

  function openVideo(url, subtitle, meta) {
    meta = meta || {};
    closeVideoOverlay();
    var ov = document.createElement('div');
    ov.id = 'streams-video';
    ov._resumeKey = meta.resumeKey || '';
    ov._onClosed = meta.onClosed || null;
    ov.style.cssText = 'position:fixed;inset:0;height:100dvh;width:100vw;background:#000;z-index:10000;display:flex;flex-direction:column;overflow:hidden;';

    var videoWrap = document.createElement('div');
    videoWrap.style.cssText = 'flex:1;position:relative;min-height:0;min-width:0;background:#000;overflow:hidden;';

    var video = document.createElement('video');
    video.controls = false; video.autoplay = true; video.playsInline = true;
    video.setAttribute('playsinline', ''); video.setAttribute('crossorigin', 'anonymous');
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;';

    if (subtitle) {
      var sm = subtitle.match(/https?:\/\/\S+\.(vtt|srt)/);
      if (sm) {
        var tr = document.createElement('track');
        tr.kind = 'subtitles'; tr.label = 'Українські'; tr.srclang = 'uk'; tr.src = sm[0]; tr.default = true;
        video.appendChild(tr);
      }
    }

    video.addEventListener('error', fallbackToIframe);
    videoWrap.appendChild(video);
    ov.appendChild(videoWrap);
    document.body.appendChild(ov);

    var resumeAt = getResumePos(meta.resumeKey);
    var resumed = false;
    var lastSaveT = 0;
    var activeResumeKey = meta.resumeKey || '';
    var switchingSource = false;
    video.addEventListener('loadedmetadata', function () {
      switchingSource = false;
      if (!resumed && resumeAt > 15 && (!video.duration || (video.duration - resumeAt) > 20)) {
        resumed = true;
        try { video.currentTime = resumeAt; } catch (e) {}
        if (typeof showSyncToast === 'function') showSyncToast('▶ Продовжено з ' + fmtTimeSec(resumeAt));
      }
    });
    video.addEventListener('timeupdate', function () {
      if (switchingSource) return;
      var now = Date.now();
      if (now - lastSaveT > 5000 && activeResumeKey) {
        lastSaveT = now;
        saveResumePos(activeResumeKey, video.currentTime || 0, video.duration || 0);
      }
    });
    video.addEventListener('pause', function () {
      if (switchingSource) return;
      if (activeResumeKey) saveResumePos(activeResumeKey, video.currentTime || 0, video.duration || 0);
    });
    video.addEventListener('webkitbeginfullscreen', function () { setNativeFullscreen(true); });
    video.addEventListener('webkitendfullscreen', function () { setNativeFullscreen(false); });

    var desiredAudioLang = meta.audioLang || '';
    var overlay = null;
    var currentVariant = meta.initial || (meta.variants && meta.variants[0]) || null;
    /* Збережена озвучка має перемагати варіант за замовчуванням */
    if (meta.initialTranslation && meta.variants && meta.variants.length) {
      var tr = String(meta.initialTranslation).toLowerCase();
      var savedVariant = meta.variants.find(function (v) {
        return String(v.translation || '').toLowerCase() === tr;
      });
      if (savedVariant) currentVariant = savedVariant;
    }
    var baseTitle = String(meta.title || 'MyCinema').replace(/ · S\d+E\d+$/, '');
    var iframeFallbackUrl = String(meta.iframeFallback || '');
    var fellBackToIframe = false;
    function fallbackToIframe() {
      if (fellBackToIframe || !iframeFallbackUrl) return;
      fellBackToIframe = true;
      openIframeOverlay(iframeFallbackUrl, baseTitle);
    }

    function variantCode(v) {
      var s = extractNum(v && v.season, 0), e = extractNum(v && v.episode, 0);
      return (s || e) ? 'S' + (s || 1) + 'E' + String(e || 1).padStart(2, '0') : '';
    }
    function variantResumeKey(v) {
      var base = String(meta.resumeKey || (baseTitle + '|s0|e0')).replace(/\|s\d+\|e\d+$/, '');
      return base + '|s' + extractNum(v && v.season, 0) + '|e' + extractNum(v && v.episode, 0);
    }
    function updateTitle(v) {
      var code = variantCode(v);
      var text = baseTitle + (code ? ' · ' + code : '');
      if (ov._controls) ov._controls.setTitle(text);
      else ov.querySelector('[data-role="video-title"]')?.setAttribute('data-title', text);
    }

    function applyNativeAudio() {
      var tracks = video.audioTracks;
      if (!tracks || !desiredAudioLang) return;
      for (var i = 0; i < tracks.length; i++) {
        var lang = String(tracks[i].language || '').toLowerCase();
        if (lang.indexOf(desiredAudioLang.toLowerCase()) === 0 || /укр|ukr/i.test(tracks[i].label || '')) {
          tracks[i].enabled = true; break;
        }
      }
    }
    function bindHlsAudio(Hls, hls) {
      if (!Hls || !hls || hls._mcAudioBound) return;
      hls._mcAudioBound = true;
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function (_e, data) {
        if (!desiredAudioLang) return;
        var list = (data && data.audioTracks) || [];
        for (var i = 0; i < list.length; i++) {
          var t = list[i] || {};
          var lang = String(t.lang || '').toLowerCase();
          if (lang.indexOf(desiredAudioLang.toLowerCase()) === 0 || /укр|ukr/i.test(t.name || '')) {
            try { hls.audioTrack = i; } catch (e) {}
            break;
          }
        }
      });
    }

    /* Вибір джерела — для старту й для оверлею один і той самий шлях. */
    function loadSource(nextUrl, audioLang, keepTime, resumeAt) {
      desiredAudioLang = audioLang || '';
      var pos = 0;
      /* Нова серія починається з її власної позиції (або з 0), а не з поточного часу. */
      if (resumeAt && resumeAt > 0) pos = resumeAt;
      else if (keepTime) { try { pos = video.currentTime || 0; } catch (e) {} }
      var isHls = /\.m3u8(\?|$)/i.test(nextUrl);
      /* CDN Ashdi без ACAO — гонимо через воркер, він пробрасує Range
         і ставить Access-Control-Allow-Origin. */
      var mediaSrc = nextUrl;
      if (/^https?:\/\//i.test(mediaSrc) && /ashdi\.vip|sniplyo\.online|creavio\.online/i.test(mediaSrc)) {
        mediaSrc = proxyMediaUrl(mediaSrc);
      }
      function afterSeek() {
        var seek = function () {
          try { video.currentTime = pos; } catch (e) {}
          video.removeEventListener('loadedmetadata', seek);
        };
        if (pos > 0) video.addEventListener('loadedmetadata', seek);
        video.play().catch(function () {});
      }
      if (isHls && !meta.forceHls && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = mediaSrc;
        video.addEventListener('loadedmetadata', applyNativeAudio);
        afterSeek();
      } else if (isHls) {
        ensureHls().then(function (Hls) {
          if (Hls && Hls.isSupported()) {
            var hlsOpts = { enableWorker: true, lowLatencyMode: false };
            /* mcProxy:true або вже проксований HLS — ставимо свій лоадер. */
            if (meta.forceHls || mediaSrc !== nextUrl) {
              hlsOpts.loader = createProxyLoader(Hls.DefaultConfig.loader);
              hlsOpts.fLoader = createProxyLoader(Hls.DefaultConfig.fLoader || Hls.DefaultConfig.loader);
            }
            var hls = ov._hls || new Hls(hlsOpts);
            ov._hls = hls;
            hls.loadSource(mediaSrc);
            if (!hls.media) hls.attachMedia(video);
            bindHlsAudio(Hls, hls);
            hls.on(Hls.Events.ERROR, function (_e, data) {
              if (data && data.fatal) fallbackToIframe();
            });
          } else {
            video.src = mediaSrc;
          }
          afterSeek();
        }).catch(function () { video.src = mediaSrc; afterSeek(); });
      } else {
        if (ov._hls) { try { ov._hls.destroy(); } catch (e) {} ov._hls = null; }
        video.src = mediaSrc;
        video.addEventListener('loadedmetadata', applyNativeAudio);
        afterSeek();
      }
    }

    loadSource((currentVariant && currentVariant.url) || url,
      (currentVariant && currentVariant.audioLang) || meta.audioLang, false);

    if (window.MCPlayerOverlay && meta.variants && meta.variants.length) {
      overlay = window.MCPlayerOverlay.mount({
        host: videoWrap,
        variants: meta.variants,
        initial: currentVariant || meta.variants[0],
        onSwitch: function (v) {
          var sameEpisode = currentVariant &&
            String(currentVariant.season || '') === String(v.season || '') &&
            String(currentVariant.episode || '') === String(v.episode || '');
          /* Зберігаємо позицію поточної серії, перш ніж перемкнутись. */
          switchingSource = true;
          if (activeResumeKey) saveResumePos(activeResumeKey, video.currentTime || 0, video.duration || 0);
          currentVariant = v;
          var newKey = variantResumeKey(v);
          activeResumeKey = newKey;
          meta.resumeKey = newKey;
          ov._resumeKey = newKey;
          updateTitle(v);
          if (sameEpisode) {
            loadSource(v.url, v.audioLang, true);
          } else {
            var at = getResumePos(newKey);
            loadSource(v.url, v.audioLang, false, at > 15 ? at : 0);
          }
          setTimeout(function () { switchingSource = false; }, 1500);
          if (typeof meta.onVariantSwitch === 'function') meta.onVariantSwitch(v);
        }
      });
      ov._overlay = overlay;
    }

    if (window.MCPlayerControls) {
      ov._controls = window.MCPlayerControls.mount({
        host: videoWrap,
        video: video,
        title: meta.title || 'MyCinema',
        onBack: closeVideoOverlay,
        onMenu: overlay && overlay.hasOptions() ? function () { overlay.toggle(); } : null,
        onFullscreen: function () { toggleElementFullscreen(ov); }
      });
      updateTitle(currentVariant);
    }
  }

  function openIframeOverlay(url, title) {
    closeVideoOverlay();
    ensureStreamsHistoryGuard();
    var ov = document.createElement('div');
    ov.id = 'streams-video';
    ov.style.cssText = 'position:fixed;inset:0;height:100dvh;width:100vw;background:#000;z-index:10000;display:flex;flex-direction:column;overflow:hidden;';

    var bar = document.createElement('div');
    bar.setAttribute('data-role', 'video-bar');
    bar.style.cssText = 'padding:8px 14px;background:var(--bg-1);display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;';

    var backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.title = 'До списку';
    backBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
    backBtn.style.cssText = 'background:var(--bg-2);border:1px solid rgba(255,255,255,0.08);color:var(--text);width:36px;height:36px;border-radius:8px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;';
    backBtn.addEventListener('click', closeVideoOverlay);
    bar.appendChild(backBtn);

    var titleSpan = document.createElement('span');
    titleSpan.style.cssText = 'color:var(--text-secondary);font-size:13px;font-family:var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;text-align:center;';
    titleSpan.textContent = title || 'Плеєр';
    bar.appendChild(titleSpan);

    var fsBtn = document.createElement('button');
    fsBtn.type = 'button'; fsBtn.title = 'На весь екран';
    fsBtn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
    fsBtn.style.cssText = 'background:var(--bg-2);border:1px solid rgba(255,255,255,0.08);color:var(--text);width:36px;height:36px;border-radius:8px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;';
    fsBtn.addEventListener('click', function () { toggleElementFullscreen(ov); });
    bar.appendChild(fsBtn);

    var cb = document.createElement('button');
    cb.type = 'button'; cb.textContent = '✕';
    cb.style.cssText = 'background:var(--bg-2);border:1px solid rgba(255,255,255,0.08);color:var(--text);width:36px;height:36px;border-radius:8px;font-size:16px;cursor:pointer;flex-shrink:0;';
    cb.addEventListener('click', function () { closeModal(false); });
    bar.appendChild(cb);

    var iframeWrap = document.createElement('div');
    iframeWrap.style.cssText = 'flex:1;position:relative;min-height:0;min-width:0;background:#000;overflow:hidden;';

    var iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;';
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');

    iframeWrap.appendChild(iframe);
    ov.appendChild(bar);
    ov.appendChild(iframeWrap);
    document.body.appendChild(ov);
  }

  // ─── Unified Themed Modal ───
  function createShell(headerText) {
    closeModal(false);
    ensureStreamsHistoryGuard();
    document.documentElement.classList.add('streams-lock');
    document.body.classList.add('streams-lock');

    var ov = document.createElement('div');
    ov.id = 'streams-overlay';
    ov.innerHTML =
      '<div class="streams-modal">' +
        '<div class="streams-head">' +
          '<div class="streams-head-title">' + esc(headerText) + '</div>' +
          '<button type="button" class="streams-close-btn" data-act="close" aria-label="Закрити">✕</button>' +
        '</div>' +
        '<div class="streams-providers" id="streams-providers" style="display:none;"></div>' +
        '<div id="streams-body"><div class="streams-status">Пошук…</div></div>' +
      '</div>';

    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(false); });
    ov.querySelector('[data-act="close"]').addEventListener('click', function () { closeModal(false); });
    return ov;
  }

  function renderUnifiedPicker(providers, mediaTitle, mediaKey) {
    var ov = document.getElementById('streams-overlay');
    if (!ov) return;
    var provBar = ov.querySelector('#streams-providers');
    var body = ov.querySelector('#streams-body');
    var reqSeq = 0;

    var savedPref = getStreamPref(mediaKey);
    var startProvIdx = 0;
    if (savedPref && savedPref.provId) {
      var foundIdx = providers.findIndex(function (p) { return p.id === savedPref.provId; });
      if (foundIdx >= 0) startProvIdx = foundIdx;
    }

    var ui = {
      provIdx: startProvIdx,
      matchIdxByProv: {},
      matchesOpen: false,
      translation: (savedPref && savedPref.translation) || '',
      season: '',
      quality: '',
      pendingMark: null
    };

    function renderProvidersBar() {
      provBar.style.display = 'flex';
      provBar.innerHTML = '';
      providers.forEach(function (p, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'streams-prov-btn' + (i === ui.provIdx ? ' active' : '');
        var cnt = String(p.results.length);
        btn.innerHTML = '<span>' + esc(p.label) + '</span><span class="streams-prov-cnt">' + esc(cnt) + '</span>';
        btn.addEventListener('click', function () {
          if (ui.provIdx === i) return;
          ui.provIdx = i;
          ui.matchesOpen = false;
          saveStreamPref(mediaKey, { provId: p.id });
          renderProvidersBar();
          loadCurrentProvider();
        });
        provBar.appendChild(btn);
      });
    }

    /* Усі перемикання (сезон/серія/якість/озвучка) тепер у плеєрі. */
    function playVariants(rawItems, epMeta) {
      buildVariants(rawItems).then(function (variants) {
        if (!variants.length) return;
        var prov = providers[ui.provIdx];
        saveStreamPref(mediaKey, { provId: prov ? prov.id : '', translation: ui.translation });
        var sNum = epMeta ? epMeta.sNum : 0;
        var epNum = epMeta ? epMeta.epNum : 0;
        var markMeta = epMeta;
        var rKey = (mediaKey || mediaTitle) + '|s' + sNum + '|e' + epNum;
        var labelTitle = mediaTitle + (epMeta && epMeta.code ? ' · ' + epMeta.code : '');
        openVideo(variants[0].url, variants[0].subtitle, {
          resumeKey: rKey,
          title: labelTitle,
          variants: variants,
          initial: variants[0],
          audioLang: variants[0].audioLang,
          forceHls: variants.some(function (v) { return v.proxy; }),
          /* Якщо прямий HLS протермінувався (403) — лишаємо iframe того самого
             провайдера, без автоматичного переходу на іншого. */
          iframeFallback: variants[0].iframeFallback || '',
          /* Озвучка, вибрана раніше, має застосовуватись і в оверлеї */
          initialTranslation: ui.translation,
          onVariantSwitch: function (v) {
            if (!v) return;
            if (v.translation) {
              ui.translation = v.translation;
              saveStreamPref(mediaKey, { translation: ui.translation });
            }
            var ns = parseInt(v.season, 10) || 0;
            var ne = parseInt(v.episode, 10) || 0;
            markMeta = {
              sNum: ns, epNum: ne,
              code: (ns || ne)
                ? 'S' + (ns < 10 ? '0' + ns : ns) + 'E' + (ne < 10 ? '0' + ne : ne)
                : (epMeta && epMeta.code)
            };
          },
          onClosed: function (watchedSec) {
            if (markMeta && Number.isFinite(markMeta.sNum) && Number.isFinite(markMeta.epNum) &&
                mediaKey && watchedSec >= 25 && !isEpWatchedInLib(mediaKey, markMeta.sNum, markMeta.epNum)) {
              ui.pendingMark = markMeta;
              loadCurrentProvider();
            }
          }
        });
      });
    }

    function renderMatchSelector(prov, activeIdx) {
      var cur = prov.results[activeIdx];
      var wrap = document.createElement('div');
      var bar = document.createElement('div');
      bar.className = 'streams-match-bar';

      var curSpan = document.createElement('div');
      curSpan.className = 'streams-match-cur';
      curSpan.innerHTML = '✓ ' + esc(cur.title) + (cur.year ? '<span class="streams-match-yr">(' + esc(cur.year) + ')</span>' : '');
      bar.appendChild(curSpan);

      if (prov.results.length > 1) {
        var altBtn = document.createElement('button');
        altBtn.type = 'button';
        altBtn.className = 'streams-alt-toggle';
        altBtn.textContent = ui.matchesOpen ? 'Згорнути ▴' : 'Інші збіги (' + (prov.results.length - 1) + ') ▾';
        altBtn.addEventListener('click', function () {
          ui.matchesOpen = !ui.matchesOpen;
          altBtn.textContent = ui.matchesOpen ? 'Згорнути ▴' : 'Інші збіги (' + (prov.results.length - 1) + ') ▾';
          listEl.style.display = ui.matchesOpen ? 'flex' : 'none';
        });
        bar.appendChild(altBtn);
      }
      wrap.appendChild(bar);

      var listEl = document.createElement('div');
      listEl.className = 'streams-matches-list';
      listEl.style.display = ui.matchesOpen ? 'flex' : 'none';
      if (prov.results.length > 1) {
        prov.results.forEach(function (res, idx) {
          var itemBtn = document.createElement('button');
          itemBtn.type = 'button';
          itemBtn.className = 'streams-alt-item' + (idx === activeIdx ? ' active' : '');
          itemBtn.innerHTML = '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(res.title) + '</span>' +
            (res.year ? '<span class="streams-prov-cnt">' + esc(res.year) + '</span>' : '');
          itemBtn.addEventListener('click', function () {
            ui.matchIdxByProv[prov.id] = idx;
            ui.matchesOpen = false;
              loadCurrentProvider();
          });
          listEl.appendChild(itemBtn);
        });
        wrap.appendChild(listEl);
      }
      return wrap;
    }

    function renderPlayerControls(rawItems, prov, activeIdx) {
      body.innerHTML = '';

      if (ui.pendingMark && mediaKey) {
        var pm = ui.pendingMark;
        var markBar = document.createElement('div');
        markBar.className = 'streams-mark-bar';
        markBar.innerHTML = '<span class="streams-mark-txt">Позначити ' + esc(pm.code) + ' переглянутою?</span>' +
          '<div class="streams-mark-acts">' +
            '<button type="button" class="streams-mark-yes">✓ Так</button>' +
            '<button type="button" class="streams-mark-no">✕</button>' +
          '</div>';
        markBar.querySelector('.streams-mark-yes').addEventListener('click', function () {
          var itemObj = (typeof lib !== 'undefined' && lib[mediaKey]) || (typeof cardStack !== 'undefined' && cardStack[cardStack.length - 1]?.item);
          if (itemObj && typeof update === 'function') {
            var curEps = [].concat(itemObj.watchedEpisodes || []);
            var ek = pm.sNum + '-' + pm.epNum;
            if (curEps.indexOf(ek) < 0) curEps.push(ek);
            update(itemObj, { watchedEpisodes: curEps, status: itemObj.status === 'watched' ? 'watched' : 'watching' });
            if (typeof showSyncToast === 'function') showSyncToast('✅ ' + pm.code);
          }
          ui.pendingMark = null;
          renderPlayerControls(rawItems, prov, activeIdx);
        });
        markBar.querySelector('.streams-mark-no').addEventListener('click', function () {
          ui.pendingMark = null;
          markBar.remove();
        });
        body.appendChild(markBar);
      }

      body.appendChild(renderMatchSelector(prov, activeIdx));

      var iframeItem = rawItems.find(function (x) { return x.iframeUrl; });
      var playable = rawItems.filter(function (x) { return x.url && !x.iframeUrl; });

      if (iframeItem && !playable.length) {
        var ifBtn = document.createElement('button');
        ifBtn.type = 'button';
        ifBtn.className = 'streams-play-btn';
        ifBtn.textContent = '▶ Відкрити плеєр балансера';
        ifBtn.addEventListener('click', function () { openIframeOverlay(iframeItem.iframeUrl, mediaTitle); });
        body.appendChild(ifBtn);
      } else if (!playable.length) {
        var errEl = document.createElement('div');
        errEl.className = 'streams-error';
        errEl.textContent = 'Немає прямих джерел для відтворення';
        body.appendChild(errEl);
      } else {
        var first = playable[0];
        var sNum = extractNum(first.season, 1);
        var epNum = extractNum(first.episode, 1);
        var epMeta = first.season
          ? { sNum: sNum, epNum: epNum, code: 'S' + sNum + 'E' + String(epNum).padStart(2, '0'), audioLang: first.audioLang }
          : { audioLang: first.audioLang };
        var playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'streams-play-btn';
        playBtn.textContent = '▶ Дивитись' + (playable.length > 1 ? ' (' + playable.length + ')' : '');
        playBtn.addEventListener('click', function () { playVariants(playable, epMeta); });
        body.appendChild(playBtn);
      }
    }

    function loadCurrentProvider() {
      var seq = ++reqSeq;
      var prov = providers[ui.provIdx];
      if (!prov) return;

      var idx = ui.matchIdxByProv[prov.id] || 0;
      if (idx >= prov.results.length) idx = 0;
      ui.matchIdxByProv[prov.id] = idx;

      body.innerHTML = '';
      body.appendChild(renderMatchSelector(prov, idx));
      var stEl = document.createElement('div');
      stEl.className = 'streams-status';
      stEl.textContent = 'Завантаження плеєра «' + prov.results[idx].title + '»…';
      body.appendChild(stEl);

      loadFlatForResult(prov.results[idx]).then(function (flat) {
        if (seq !== reqSeq || !body.isConnected) return;
        renderPlayerControls(flat, prov, idx);
      }).catch(function (err) {
        if (seq !== reqSeq || !body.isConnected) return;
        if (idx === 0 && prov.results.length > 1) {
          ui.matchIdxByProv[prov.id] = 1;
          loadFlatForResult(prov.results[1]).then(function (flat2) {
            if (seq !== reqSeq || !body.isConnected) return;
            renderPlayerControls(flat2, prov, 1);
          }).catch(function (err2) {
            if (seq !== reqSeq || !body.isConnected) return;
            body.innerHTML = '';
            body.appendChild(renderMatchSelector(prov, idx));
            var er = document.createElement('div');
            er.className = 'streams-error';
            er.textContent = 'Помилка: ' + err2.message;
            body.appendChild(er);
          });
          return;
        }
        body.innerHTML = '';
        body.appendChild(renderMatchSelector(prov, idx));
        var er = document.createElement('div');
        er.className = 'streams-error';
        er.textContent = 'Помилка: ' + err.message;
        body.appendChild(er);
      });
    }

    renderProvidersBar();
    loadCurrentProvider();
  }

  function openStreamPicker(title, year, type, imdbId, origTitle, opts) {
    var mediaKey = (opts && opts.key) || '';
    var tmdbId = (opts && opts.tmdbId) || '';
    var q = String(title || '').trim();
    var headerTitle = q + (year ? ' (' + year + ')' : '');
    var ov = createShell(headerTitle || 'Джерело UA');

    // Тримаємо body саме цього оверлею: якщо користувач закриє його й
    // відкриє інший тайтл, пізня відповідь не має малюватися в новому.
    var body = ov.querySelector('#streams-body');
    if (!q && !origTitle) {
      body.innerHTML = '<div class="streams-error">Порожня назва</div>';
      return;
    }
    body.innerHTML = '<div class="streams-status">Пошук «' + esc(q || origTitle) + '»…</div>';

    var ashdiP = lookupAshdi(imdbId, tmdbId, type, q).then(function (href) {
      if (!href) return [];
      return [{
        href: href,
        title: q || origTitle || '',
        year: year || '',
        isTvHint: type === 'tv',
        provider: 'ashdi'
      }];
    });

    var localizedP = getEmbfRuTitle(tmdbId, type);
    var embfP = localizedP.then(function (ruTitle) {
      return searchEmbfSmart(q, origTitle, ruTitle, year);
    });
    var tortugaP = localizedP.then(function (ruTitle) {
      return searchKinoukrSmart(q, origTitle, ruTitle, year, type);
    });
    Promise.allSettled([ashdiP, embfP, tortugaP]).then(function (results) {
      if (!body || !body.isConnected) return;
      var ashdi = results[0].status === 'fulfilled' ? results[0].value : [];
      var embf = results[1].status === 'fulfilled' ? results[1].value : [];
      var tortuga = results[2].status === 'fulfilled' ? results[2].value : [];

      var providers = [];
      if (ashdi.length) providers.push({ id: 'ashdi', label: 'Ashdi', results: ashdi });
      if (embf.length) providers.push({ id: 'embf', label: 'EmbF', results: embf });
      if (tortuga.length) providers.push({ id: 'tortuga', label: 'Tortuga', results: tortuga });

      if (!providers.length) {
        body.innerHTML = '<div class="streams-error">Нічого не знайдено</div>';
        return;
      }

      renderUnifiedPicker(providers, q || origTitle, mediaKey);
    }).catch(function (e) {
      if (!body || !body.isConnected) return;
      body.innerHTML = '<div class="streams-error">Помилка: ' + esc(e.message) + '</div>';
    });
  }

  window.openStreamPicker = openStreamPicker;
  window.closeStreamPicker = function () { closeModal(false); };
  // Використовується кімнатою у браузері: відкрити
  // потік убудованим плеєром замість спроби запустити VLC.
  window.mcStreamsOpen = function (url, title) {
    if (!url) return;
    ensureStreamsHistoryGuard(); /* Back закриває плеєр, а не картку під ним */
    openVideo(url, '', { title: title || 'MyCinema' });
  };
  window._streamsUtil = {
    scoreCandidate: scoreCandidate, extractSnippetMeta: extractSnippetMeta, normStr: normStr,
    searchEmbf: searchEmbf, searchEmbfSmart: searchEmbfSmart,
    embfMatchScore: embfMatchScore, resolveEmbf: resolveEmbf,
    isAshdiPlayer: isAshdiPlayer, parseAshdiHtml: parseAshdiHtml, tagAshdiTree: tagAshdiTree,
    lookupAshdi: lookupAshdi, resolveAshdi: resolveAshdi,
    isTortugaPlayer: isTortugaPlayer, tortugaUnpack: tortugaUnpack,
    parseTortugaHtml: parseTortugaHtml, parseKinoukrSearch: parseKinoukrSearch,
    parseKinoukrPage: parseKinoukrPage, searchKinoukr: searchKinoukr,
    searchKinoukrSmart: searchKinoukrSmart, resolveTortuga: resolveTortuga,
    openVideo: openVideo,
    proxyMediaUrl: proxyMediaUrl, createProxyLoader: createProxyLoader
  };

})();
