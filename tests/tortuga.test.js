import { beforeAll, describe, expect, it, vi } from 'vitest';

function pack(str) {
  const seed = 71;
  const src = Array.from(new TextEncoder().encode(str));
  const bytes = [seed];
  src.forEach((c, i) => bytes.push(c ^ ((seed + 7 * i + 13) & 255)));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function proxiedUrl(u) {
  try { return decodeURIComponent(new URL(String(u)).searchParams.get('url') || ''); }
  catch (e) { return ''; }
}

const SEARCH_HTML = `
  <div class="short clearfix">
    <a class="short-title" href="https://kinoukr.tv/9911-test.html">Тестовий фільм 9911</a>
    <span class="m-film"></span>
  </div>`;
const PAGE_HTML = `
  <h1 itemprop="name">Тестовий фільм 9911</h1>
  <div class="foriginal">Test Movie 9911</div>
  <span>Рік:</span> <a href="/xfsearch/year/2013/">2013</a>
  <div class="tabs-b video-box"><iframe src="https://tortuga.tw/vod/9911" frameborder="0"></iframe></div>
  <div class="tabs-b video-box"><iframe src="https://ashdi.vip/vod/6500"></iframe></div>`;

const TREE = [
  { title: ' Голос &amp; Дубляж', folder: [
    { title: ' Сезон 1', folder: [{ title: 'Серія 1', file: 'https://calypso.tortuga.tw/x/index.m3u8' }] }
  ] }
];

beforeAll(() => {
  window.loadScript('src/streams.js');
});

describe('Tortuga provider (адаптація kinoukr_snack)', () => {
  it('приймає тільки плеєри tortuga', () => {
    const { isTortugaPlayer } = window._streamsUtil;
    expect(isTortugaPlayer('https://tortuga.tw/vod/6946')).toBe(true);
    expect(isTortugaPlayer('https://tortuga.wtf/embed/12?x=1')).toBe(true);
    expect(isTortugaPlayer('https://ashdi.vip/vod/6500')).toBe(false);
    expect(isTortugaPlayer('http://tortuga.tw/vod/6946')).toBe(false);
  });

  it('розпаковує base64 + XOR з seed', () => {
    const src = 'https://calypso.tortuga.tw/t/sig/index.m3u8';
    expect(window._streamsUtil.tortugaUnpack(pack(src))).toBe(src);
  });

  it('парсить одиночний file й субтитри з TortugaCore', () => {
    const url = 'https://calypso.tortuga.tw/t/single/index.m3u8';
    const html = `new TortugaCore({file:"${pack(url)}",subtitle:"${pack('[Укр]https://s/sub.vtt')}"})`;
    const tree = window._streamsUtil.parseTortugaHtml(html);
    expect(tree).toHaveLength(1);
    expect(tree[0].file).toBe(url);
    expect(tree[0].subtitle).toBe('https://s/sub.vtt');
  });

  it('парсить дерево озвучка → сезон → серія', () => {
    const html = `new TortugaCore({file:"${pack(JSON.stringify(TREE))}"})`;
    const tree = window._streamsUtil.parseTortugaHtml(html);
    expect(tree[0].title).toBe('Голос & Дубляж');
    expect(tree[0].folder[0].folder[0].file).toBe('https://calypso.tortuga.tw/x/index.m3u8');
  });

  it('не повертає трейлер з /hls/trailers/', () => {
    const html = `new TortugaCore({file:"${pack('/hls/trailers/1/index.m3u8')}"})`;
    expect(window._streamsUtil.parseTortugaHtml(html)).toBeNull();
  });

  it('парсить картки xfsearch й iframe сторінки тайтла', () => {
    const { parseKinoukrSearch, parseKinoukrPage } = window._streamsUtil;
    const cards = parseKinoukrSearch(SEARCH_HTML);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('movie');
    expect(cards[0].href).toBe('https://kinoukr.tv/9911-test.html');

    const info = parseKinoukrPage(PAGE_HTML);
    expect(info.title).toBe('Тестовий фільм 9911');
    expect(info.orig).toBe('Test Movie 9911');
    expect(info.year).toBe(2013);
    expect(info.players).toEqual(['https://tortuga.tw/vod/9911']);
  });

  it('шукає тільки точний тайтл і прикріплює плеєри Tortuga', async () => {
    global.fetch = vi.fn((u) => {
      const url = proxiedUrl(u);
      const body = url.indexOf('/xfsearch/') >= 0 ? SEARCH_HTML : PAGE_HTML;
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    });
    const res = await window._streamsUtil.searchKinoukrSmart(
      'Тестовий фільм 9911', 'Test Movie 9911', 'Тестовий фільм 9911', 2013, 'movie'
    );
    expect(res).toHaveLength(1);
    expect(res[0].provider).toBe('tortuga');
    expect(res[0].players).toEqual(['https://tortuga.tw/vod/9911']);
    expect(res[0].year).toBe(2013);

    const wrong = await window._streamsUtil.searchKinoukrSmart(
      'Зовсім інший фільм 9912', 'Other Movie 9912', '', 2013, 'movie'
    );
    expect(wrong).toEqual([]);
  });

  it('переживає 404 xfsearch і шукає за коротким тегом', async () => {
    const cards = `<div class="short clearfix"><a class="short-title" href="https://kinoukr.tv/8950-avatar-vogon-i-popil.html">Аватар: Вогонь і Попіл</a><span class="m-film"></span></div>`;
    const detail = `<h1>Аватар: Вогонь і Попіл</h1><div class="foriginal">Avatar: Fire and Ash</div><span>Рік:</span> <a href="/xfsearch/year/2025/">2025</a><iframe src="https://tortuga.tw/vod/8910"></iframe>`;
    global.fetch = vi.fn((u) => {
      const url = proxiedUrl(u);
      if (url.indexOf('/xfsearch/Avatar%3A%20Fire%20and%20Ash/') >= 0) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      }
      if (url.indexOf('/xfsearch/Avatar/') >= 0) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(cards) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(detail) });
    });
    const res = await window._streamsUtil.searchKinoukrSmart(
      'Аватар: Пламя и Пепел', 'Avatar: Fire and Ash', 'Аватар: Пламя и Пепел', 2025, 'movie'
    );
    expect(res).toHaveLength(1);
    expect(res[0].players).toEqual(['https://tortuga.tw/vod/8910']);
  });

  it('резолвить прямий HLS без mcProxy', async () => {
    const url = 'https://calypso.tortuga.tw/t/9912/index.m3u8';
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, text: () => Promise.resolve(`new TortugaCore({file:"${pack(url)}"})`)
    }));
    const flat = await window._streamsUtil.resolveTortuga({
      href: 'https://kinoukr.tv/9912-direct.html',
      players: ['https://tortuga.tw/vod/9912']
    });
    expect(flat).toHaveLength(1);
    expect(flat[0].url).toBe(url);
    expect(flat[0].translation).toBe('Tortuga');
    expect(flat[0].mcProxy).toBeUndefined();
    expect(flat[0].fallbackIframeUrl).toBe('https://tortuga.tw/vod/9912');
  });

  it('на fatal 403 прямого HLS відкриває iframe того ж Tortuga', async () => {
    const handlers = {};
    function FakeHls() { this.media = null; this.on = (e, cb) => { handlers[e] = cb; }; this.loadSource = () => {}; this.attachMedia = () => {}; }
    FakeHls.isSupported = () => true;
    FakeHls.Events = { ERROR: 'error', AUDIO_TRACKS_UPDATED: 'audio' };
    FakeHls.DefaultConfig = { loader: function () {} };
    window.Hls = FakeHls;
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve());

    window._streamsUtil.openVideo('https://calypso.tortuga.tw/x/index.m3u8', '', {
      title: 'Tortuga test',
      forceHls: true,
      iframeFallback: 'https://tortuga.tw/vod/9912'
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof handlers.error).toBe('function');
    handlers.error({}, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    const ov = document.getElementById('streams-video');
    const iframe = ov && ov.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('src')).toBe('https://tortuga.tw/vod/9912');
    playSpy.mockRestore();
    delete window.Hls;
  });

  it('не перескакує на іншого провайдера, коли плеєр недоступний', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const flat = await window._streamsUtil.resolveTortuga({
      href: 'https://kinoukr.tv/9913-down.html',
      players: ['https://tortuga.tw/vod/9913']
    });
    expect(flat).toHaveLength(1);
    expect(flat[0].iframeUrl).toBe('https://tortuga.tw/vod/9913');
    expect(flat[0].url).toBeUndefined();
  });
});
