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

];

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
    if (referer) headers['Referer'] = referer;
    if (customOrigin) {
      headers['Origin'] = customOrigin;
    } else if (request.method === 'POST' && referer) {
      try { headers['Origin'] = new URL(referer).origin; } catch {}
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
      /* DLE-каталог KinoUKR відповідає 404 з повноцінною HTML-сторінкою,
         коли тег xfsearch не знайдено. Для клієнта це порожній результат,
         а не помилка проксі — повертаємо тіло зі статусом 200. */
      if (res.status === 404 && t.hostname.endsWith('kinoukr.tv') && /\/xfsearch\//.test(t.pathname)) {
        return new Response(await res.text(), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
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
