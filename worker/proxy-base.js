/* Cloudflare Worker — MyCinema Proxy
 *
 * Покращення:
 *   1. Стрімінг res.body замість arrayBuffer() — 0 навантаження на RAM і миттєвий старт відео.
 *   2. Проброс X-Requested-With та Origin для AJAX-запитів.
 *   3. Універсальний wildcard *.ashdi.vip, а також uafilm.me / embf.net / uacdn.online.
 *   4. Детект Cloudflare Challenge на 403/503 тільки для текстових/HTML відповідей.
 *   5. EmbF: AJAX-пошук іде POST-ом на uakinogo.is → додані uakinogo.is / kinogo.is.
 */

const ALLOWED_DOMAIN_SUFFIXES = [
  // Українські балансери та сайти
  'ashdi.vip',
  'tortuga.wtf',
  'tortuga.tw',
  'uafilm.me',
  'uacdn.online',
  'embf.net',
  'eneyida.tv',
  'hdvbua.pro',
  'ufdub.com',
  'uafix.net',
  'uaserials.my',
  'uaserials.pro',
  'kinoukr.tv',
  'csst.online',
  'monstro.online',
  'monstro.site',
  'qeruya.cyou',

  // EmbF — AJAX-пошук (POST /engine/ajax/controller.php?mod=search)
  'uakinogo.is',
  'kinogo.is',

  // Filmix mobile API v2 + відео-CDN
  'filmixapp.cyou',
  'coldcdn.xyz',
  'sundb.nl',
  'filmix.fm',
  'filmix.my',
  'filmix.ws',
  'filmix.pics',
  'filmix.vip',
  'filmix.one',
  // реальні CDN-хости з player_links (перевірено на живому /api/v2/post/)
  'cdnsqu.com',
  'werkecdn.me',
];

const FILMIX_CDN_SUFFIXES = [
  'coldcdn.xyz', 'sundb.nl', 'filmix.fm', 'filmix.my', 'filmix.ws',
  'filmix.pics', 'filmix.vip', 'filmix.one', 'cdnsqu.com', 'werkecdn.me',
];
function isFilmixApi(host) { return String(host).toLowerCase().endsWith('filmixapp.cyou'); }
function isFilmixCdn(host) {
  const h = String(host).toLowerCase();
  return FILMIX_CDN_SUFFIXES.some((d) => h === d || h.endsWith('.' + d));
}

/* Відносні URI в m3u8 інакше резолвляться проти origin'у воркера */
function rewriteM3U8(text, baseUrl, referer, workerOrigin) {
  function proxied(u) {
    const p = new URL(workerOrigin);
    p.search = '';
    p.searchParams.set('url', u);
    if (referer) p.searchParams.set('referer', referer);
    return p.toString();
  }
  return String(text || '').split(/\r?\n/).map(function (line) {
    const s = line.trim();
    if (!s || s.charAt(0) === '#') return line;
    let abs;
    try {
      abs = /^https?:\/\//i.test(s) ? s : new URL('./' + s.replace(/^\.\//, ''), baseUrl).toString();
    } catch (e) { return line; }
    return proxied(abs);
  }).join('\n');
}

function isAllowedHost(host) {
  const h = host.toLowerCase();
  return ALLOWED_DOMAIN_SUFFIXES.some(
    (domain) => h === domain || h.endsWith('.' + domain)
  );
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Authorization, Range, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

function isChallenge(res) {
  if (res.status !== 403 && res.status !== 503) return false;
  const ct = res.headers.get('Content-Type') || '';
  return /text|html|json/i.test(ct);
}
function challengeText(text) {
  return /Just a moment|cf-browser-verification|Attention Required! \| Cloudflare|Проверяем, что вы не бот|within\.website\/x\/xess/i.test(text || '');
}
function wrapResponse(res, ctype) {
  const type = ctype || res.headers.get('Content-Type') || '';
  const outHeaders = {
    ...CORS_HEADERS,
    'Content-Type': type || 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  for (const h of ['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag', 'Last-Modified']) {
    const v = res.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
      });
    }

    const u = new URL(request.url);
    const target = u.searchParams.get('url');
    const referer = u.searchParams.get('referer') || '';
    const customOrigin = u.searchParams.get('origin') || '';

    if (!target) return json({ error: 'Missing ?url=' }, 400);

    let t;
    try { t = new URL(target); } catch { return json({ error: 'Invalid url' }, 400); }

    if (t.protocol !== 'https:' && t.protocol !== 'http:') {
      return json({ error: 'Bad protocol' }, 400);
    }
    if (!isAllowedHost(t.hostname)) {
      return json({ error: 'Host not allowed: ' + t.hostname }, 403);
    }

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    if (isFilmixApi(t.hostname)) {
      // Мобільний API Filmix приймає тільки okhttp UA і забороняє браузерні
      // Origin/Referer — інакше 400 або бан.
      headers['User-Agent'] = 'okhttp/3.10.0';
      delete headers['Origin'];
      delete headers['Referer'];
    } else {
      if (referer) headers['Referer'] = referer;
      if (customOrigin) {
        headers['Origin'] = customOrigin;
      } else if (request.method === 'POST' && referer) {
        try { headers['Origin'] = new URL(referer).origin; } catch {}
      }
    }
    const xrw = request.headers.get('X-Requested-With');
    if (xrw) headers['X-Requested-With'] = xrw;
    else if (request.method === 'POST') headers['X-Requested-With'] = 'XMLHttpRequest';

    const range = request.headers.get('Range');
    if (range) headers['Range'] = range;
    const ifModified = request.headers.get('If-Modified-Since');
    if (ifModified) headers['If-Modified-Since'] = ifModified;

    const init = { method: request.method, headers, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
      headers['Content-Type'] =
        request.headers.get('Content-Type') || 'application/x-www-form-urlencoded; charset=UTF-8';
    }

    try {
      const res = await fetch(t.toString(), init);
      if (isFilmixCdn(t.hostname) &&
          (/\.m3u8(\?|$)/i.test(t.pathname + t.search) || /mpegurl/i.test(res.headers.get('Content-Type') || ''))) {
        const body = rewriteM3U8(
          await res.text(), t.toString(), referer || '', new URL(request.url).origin
        );
        return new Response(body, {
          status: res.status,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
        });
      }
      if (isChallenge(res)) {
        let txt = '';
        try { txt = await res.text(); } catch {}
        if (challengeText(txt)) {
          return json({ error: 'Cloudflare Challenge', host: t.hostname }, res.status);
        }
        return new Response(txt, {
          status: res.status,
          headers: { ...CORS_HEADERS, 'Content-Type': res.headers.get('Content-Type') || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      return wrapResponse(res);
    } catch (e) {
      return json({ error: 'Fetch failed: ' + e.message }, 502);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
