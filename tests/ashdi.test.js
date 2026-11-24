import { beforeAll, describe, expect, it, vi } from 'vitest';

const VOD_HTML = `
  makePlayer({
    file:'[{"title":" не визначено","file":"https://ashdi.vip/a/2160p/index.m3u8","subtitle":"[Укр]https://ashdi.vip/sub/1.vtt"},
           {"title":" Голос &amp; Дубляж","file":"https://jk19ocmje0yql3tj.ashdi.vip/x/index.m3u8"}]',
    poster:'https://ashdi.vip/p.jpg'
  });`;

const SERIAL_HTML = `
  makePlayer({
    file:'[{"title":" АМС","folder":[{"title":" Сезон 1","folder":[{"title":"Серія 1","file":"https://ashdi.vip/s01e01/index.m3u8"}]}]}]'
  });`;

function proxiedUrl(u) {
  try { return decodeURIComponent(new URL(String(u)).searchParams.get('url') || ''); }
  catch (e) { return ''; }
}

beforeAll(() => {
  window.loadScript('src/streams.js');
});

describe('Ashdi provider (адаптація makhno_snack)', () => {
  it('приймає тільки плеєри ashdi', () => {
    const { isAshdiPlayer } = window._streamsUtil;
    expect(isAshdiPlayer('https://ashdi.vip/vod/1054')).toBe(true);
    expect(isAshdiPlayer('https://ashdi.vip/serial/44?x=1')).toBe(true);
    expect(isAshdiPlayer('https://evil.example/vod/1')).toBe(false);
  });

  it('парсить PlayerJS-дерево, чистить назви й ставить [4K]', () => {
    const { parseAshdiHtml, tagAshdiTree } = window._streamsUtil;
    const tree = tagAshdiTree(parseAshdiHtml(VOD_HTML));
    expect(tree).toHaveLength(2);
    expect(tree[0].title).toBe('[4K]');
    expect(tree[1].title).toBe('Голос & Дубляж');
    expect(tree[1].file).toContain('jk19ocmjeoyql3tj');
  });

  it('парсить одиночне file без дерева', () => {
    const tree = window._streamsUtil.parseAshdiHtml("file:'https://ashdi.vip/a/one.m3u8',");
    expect(tree[0].file).toBe('https://ashdi.vip/a/one.m3u8');
  });

  it('шукає за IMDb/TMDB id через Jina й кешує відповідь', async () => {
    const urls = [];
    global.fetch = vi.fn((u) => {
      urls.push(String(u));
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html><body><pre>{"play":"https://ashdi.vip/vod/1054"}</pre></body></html>')
      });
    });
    const play = await window._streamsUtil.lookupAshdi('tt0137523', '550', 'movie');
    expect(play).toBe('https://ashdi.vip/vod/1054');
    expect(urls[0]).toContain('imdb_id=tt0137523');
    expect(urls[0]).toContain('tmdb_id=550');
    expect(urls[0]).toContain('serial=0');
    expect(await window._streamsUtil.lookupAshdi('tt0137523', '550', 'movie')).toBe(play);
    expect(urls).toHaveLength(1);
  });

  it('не повертає чужий хост з WH', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, text: () => Promise.resolve('{"play":"https://evil.example/vod/1"}')
    }));
    expect(await window._streamsUtil.lookupAshdi('tt9999999', '999', 'movie')).toBe('');
  });

  it('резолвить /vod/ у плоский список з multivoice і виправляє субтитри', async () => {
    global.fetch = vi.fn((u) => {
      const url = proxiedUrl(u);
      expect(url).toContain('multivoice');
      return Promise.resolve({ ok: true, text: () => Promise.resolve(VOD_HTML) });
    });
    const flat = await window._streamsUtil.resolveAshdi({ href: 'https://ashdi.vip/vod/777' });
    expect(flat.length).toBe(2);
    expect(flat[0].translation).toContain('[4K]');
    expect(flat[0].subtitle).toBe('https://ashdi.vip/sub/1.vtt');
  });

  it('резолвить /serial/ у сезони й серії', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, text: () => Promise.resolve(SERIAL_HTML)
    }));
    const flat = await window._streamsUtil.resolveAshdi({ href: 'https://ashdi.vip/serial/778' });
    expect(flat).toHaveLength(1);
    expect(flat[0].translation).toBe('АМС');
    expect(flat[0].season).toContain('Сезон 1');
    expect(flat[0].episode).toBe('Серія 1');
  });

  it('позначає джерела ashdi як такі, що йдуть через проксі', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, text: () => Promise.resolve(VOD_HTML)
    }));
    const flat = await window._streamsUtil.resolveAshdi({ href: 'https://ashdi.vip/vod/779' });
    expect(flat.every((x) => x.mcProxy === true)).toBe(true);
  });

  it('proxyMediaUrl загортає цільовий URL у CF-проксі', () => {
    const u = window._streamsUtil.proxyMediaUrl('https://jk29ocmjeoyql3tj.ashdi.vip/a/segment1.ts');
    expect(decodeURIComponent(u)).toContain('https://jk29ocmjeoyql3tj.ashdi.vip/a/segment1.ts');
    expect(u).toContain('workers.dev?url=');
  });

  it('обгортка лоадера переписує тільки сегменти/ключі на ashdi CDN', () => {
    const seen = [];
    function Base(config) { this.stats = {}; this.config = config; }
    Base.prototype.load = function (ctx) { seen.push(ctx); };
    Base.prototype.destroy = function () {};
    Base.prototype.abort = function () {};
    const Loader = window._streamsUtil.createProxyLoader(Base);
    const inst = new Loader({});
    expect(inst.stats).toBeDefined();

    const frag = { frag: {}, url: 'https://jk29ocmjeoyql3tj.ashdi.vip/a/segment1.ts' };
    inst.load(frag, {}, {});
    expect(frag.url).toContain('workers.dev?url=');

    const key = { keyInfo: {}, url: 'https://jk29ocmjeoyql3tj.ashdi.vip/a/key.bin' };
    inst.load(key, {}, {});
    expect(key.url).toContain('workers.dev?url=');

    const manifest = { type: 'manifest', url: 'https://ashdi.vip/a/index.m3u8' };
    inst.load(manifest, {}, {});
    expect(manifest.url).toBe('https://ashdi.vip/a/index.m3u8');
    expect(seen).toHaveLength(3);
  });
});
