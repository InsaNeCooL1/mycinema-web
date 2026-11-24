import { beforeAll, describe, expect, it, vi } from 'vitest';

const HOME_HTML = `var dle_login_hash = 'abc123def456';`;
const SEARCH_HTML = `
<a href="https://uakinogo.is/4850-chelovek-pauk-novyj-den.html"><span class="searchheading">Человек-паук: Новый день (2026)</span><span>Опис</span></a>
<a href="https://kinogo.is/174-posledniaia-duel.html"><span class="searchheading">Последняя дуэль (2021)</span><span>Опис</span></a>
<span class="notfound">Похожих статей на сайте не найдено.</span>`;
const GARBAGE_HTML = `
<a href="https://uakinogo.is/6394-serdce-zverya.html"><span class="searchheading">Сердце зверя (2026)</span><span>Опис</span></a>
<a href="https://uakinogo.is/2614-odisseja.html"><span class="searchheading">Одиссея (2026)</span><span>Опис</span></a>`;
const PAGE_HTML = `<div><iframe src="https://api.embf.net/embed/movie/90039"></iframe></div>`;

function mockFetch(html) {
  const calls = [];
  global.fetch = vi.fn((u, init) => {
    const url = String(u);
    calls.push({ url, init });
    let body = '';
    // URL у проксі закодований: controller.php%3Fmod%3Dsearch
    if (url.includes('controller.php')) body = html;
    else if (url.includes('workers.dev') && url.includes('uakinogo.is%2F')) body = HOME_HTML;
    else if (/r\.jina\.ai\/https:\/\/uakinogo\.is\/\d+-/.test(url)) body = PAGE_HTML;
    else if (url.includes('r.jina.ai')) body = HOME_HTML;
    return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
  });
  return calls;
}

beforeAll(() => {
  window.loadScript('src/streams.js');
});

describe('EmbF provider', () => {
  it('шукає через AJAX POST, а не GET-каталог, і бере рік із назви', async () => {
    const calls = mockFetch(SEARCH_HTML);
    const res = await window._streamsUtil.searchEmbf('Человек-паук');
    expect(res).toHaveLength(2);
    expect(res[0].href).toContain('4850-chelovek-pauk-novyj-den.html');
    expect(res[0].year).toBe('2026');
    expect(res[1].href).toContain('uakinogo.is'); // kinogo.is нормалізовано
    const post = calls.find((c) => c.url.includes('controller.php'));
    expect(post.init.method).toBe('POST');
    expect(post.init.body).toContain('query=');
    expect(post.init.body).toContain('user_hash=abc123def456');
  });

  it('жорстко відсіює випадковий топ-10 каталогу', async () => {
    mockFetch(GARBAGE_HTML);
    const res = await window._streamsUtil.searchEmbfSmart('Нація Z', 'Z Nation', 'Нация Z', 2014);
    expect(res).toEqual([]);
  });

  it('приймає збіг за російською назвою TMDB', async () => {
    mockFetch(SEARCH_HTML);
    const res = await window._streamsUtil.searchEmbfSmart('Человек-паук', 'Spider-Man', 'Человек-паук', 2026);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].title).toContain('Человек-паук');
  });

  it('оновлює hash, якщо сесія сайту застаріла', async () => {
    let n = 0;
    global.fetch = vi.fn((u) => {
      const url = String(u);
      let body = '';
      if (url.includes('controller.php')) body = (n++ === 0)
        ? 'Ваша пользовательская сессия истекла, перезагрузите страницу'
        : SEARCH_HTML;
      else if (url.includes('workers.dev') && url.includes('uakinogo.is%2F')) body = HOME_HTML;
      else if (url.includes('r.jina.ai')) body = PAGE_HTML;
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    });
    const res = await window._streamsUtil.searchEmbf('Человек-паук');
    expect(res).toHaveLength(2);
  });

  it('резолвить картку в рідний EmbF iframe', async () => {
    mockFetch(SEARCH_HTML);
    const out = await window._streamsUtil.resolveEmbf({
      href: 'https://uakinogo.is/4850-chelovek-pauk-novyj-den.html'
    });
    expect(out).toHaveLength(1);
    expect(out[0].iframeUrl).toContain('api.embf.net/embed/movie/90039');
    expect(out[0].url).toBeUndefined();
  });
});
