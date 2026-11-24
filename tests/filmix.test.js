import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const POSTS = [
  { id: 111, title: 'Ходячие мертвецы', original_title: 'The Walking Dead', year: 2010, section: 7 },
  { id: 222, title: 'Случайный фильм', original_title: 'Random Movie', year: 2026, section: 0 }
];

const MOVIE_POST = {
  id: 111,
  title: 'Ходячие мертвецы',
  original_title: 'The Walking Dead',
  year: 2010,
  section: 0,
  player_links: {
    movie: [
      { translation: 'Оригинал (EN)', link: 'https://cdn.example/f/orig_[1080,720,480].mp4' },
      { translation: 'Украинский дубляж', link: 'https://sundb.coldcdn.xyz/f/ua_[1080,720,480].mp4' }
    ],
    playlist: []
  }
};

const SERIES_POST = {
  id: 222,
  title: 'Тестовый сериал',
  original_title: 'Test Series',
  year: 2020,
  section: 7,
  player_links: {
    playlist: {
      '1': {
        'Оригинал (EN)': { '1': { link: 'https://cdn.example/s/en_[1080,720].mp4' } },
        'Украинский дубляж': { '1': { link: 'https://cdn.example/s/ua_[1080,720].mp4' } }
      }
    }
  }
};

function targetOf(u) {
  try { return decodeURIComponent(new URL(String(u)).searchParams.get('url') || ''); }
  catch (e) { return ''; }
}
function mockBody(body) {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(body) }));
}

beforeAll(() => {
  window.loadScript('src/streams.js');
});
beforeEach(() => {
  window.filmixTokenApi.set('tok_test_1234567890');
});

describe('Filmix mobile API v2', () => {
  it('кожен запит містить параметри пристрою', async () => {
    mockBody('{"posts":[]}');
    await window._streamsUtil.filmixApi('suggestions?search_word=test');
    const url = targetOf(global.fetch.mock.calls[0][0]);
    expect(url).toContain('/api/v2/suggestions?search_word=test');
    expect(url).toContain('user_dev_id=');
    expect(url).toContain('user_dev_name=Xiaomi');
    expect(url).toContain('user_dev_vendor=Xiaomi');
    expect(url).toContain('user_dev_os=14');
    expect(url).toContain('user_dev_apk=2.2.0');
    expect(url).toContain('app_lang=ru-rRU');
    expect(url).toContain('user_dev_token=tok_test_1234567890');
  });

  it('device-flow: код → активація через user_profile → збереження токена', async () => {
    mockBody('{"status":"ok","code":"temp123","user_code":"ABCD","expire":1795496231}');
    const started = await window._streamsUtil.filmixDeviceStart();
    expect(started.user_code).toBe('ABCD');
    expect(window.localStorage.getItem('mycinema.filmix.pending')).toBe('temp123');
    mockBody('{"user_data":{"login":"tester"}}');
    const activated = await window._streamsUtil.filmixDeviceCheck();
    expect(activated.activated).toBe(true);
    expect(activated.token).toBe('temp123');
    expect(window.filmixTokenApi.get()).toBe('temp123');
    window.filmixTokenApi.set('tok_test_1234567890');
  });

  it('якість: парсинг, підміна та заміна CDN-хоста', () => {
    const u = window._streamsUtil;
    expect(u.filmixQualities('https://x/a_[1080,720,480].mp4')).toEqual([1080, 720, 480]);
    expect(u.filmixApplyQuality('https://x/a_[1080,720,480].mp4', 720)).toBe('https://x/a_720.mp4');
    expect(u.filmixApplyQuality('https://x/a_%s.mp4', 480)).toBe('https://x/a_480.mp4');
    expect(u.filmixApplyQuality('https://sundb.coldcdn.xyz/a_[720].mp4', 720))
      .toBe('https://sundb.nl/a_720.mp4');
  });

  it('пошук жорстко фільтрує чужий реліз і повертає matches[]', async () => {
    mockBody(JSON.stringify(POSTS));
    const res = await window._streamsUtil.searchFilmixSmart(
      'Ходячі мерці', 'The Walking Dead', 'Ходячие мертвецы', '2010', 'tv', '');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('111');
    expect(res[0].matches).toEqual([]);
  });

  it('порожні suggestions → fallback на /search?story=', async () => {
    global.fetch = vi.fn((u) => {
      const t = targetOf(u);
      const body = t.includes('suggestions') ? '{"posts":[]}'
        : (t.includes('/search?story=') ? JSON.stringify([POSTS[0]]) : '[]');
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    });
    const res = await window._streamsUtil.searchFilmixSmart(
      'Ходячі мерці', 'The Walking Dead', '', '2010', 'tv', '');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('111');
  });

  it('фільм: беремо найкращу якість ≤ ліміту, українку — першою', async () => {
    global.fetch = vi.fn((u) => {
      const t = targetOf(u);
      const body = t.includes('user_profile')
        ? '{"user_data":{}}' /* без Pro → 720 */
        : (t.includes('/post/') ? JSON.stringify(MOVIE_POST) : '{"posts":[]}');
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    });
    const out = await window._streamsUtil.resolveFilmix({ id: '111' }, 'movie', '');
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].translation).toContain('Украин');
    expect(out[0].url).toContain('_720.mp4');
    expect(out[0].audioLang).toBe('uk');
  });

  it('серіал: сезони/серії та українська озвучка першою', async () => {
    global.fetch = vi.fn((u) => {
      const t = targetOf(u);
      const body = t.includes('user_profile')
        ? '{"user_data":{}}'
        : (t.includes('/post/') ? JSON.stringify(SERIES_POST) : '{"posts":[]}');
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    });
    const out = await window._streamsUtil.resolveFilmix({ id: '222' }, 'tv', '');
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].season).toBe('Сезон 1');
    expect(out[0].episode).toBe('Серія 1');
    expect(out[0].translation).toContain('Украин');
  });

  it('UI токена з\'являється в блоці «Онлайн» (модалка або сторінка)', () => {
    if (!document.getElementById('settings-online-box')) {
      const box = document.createElement('div');
      box.id = 'settings-online-box';
      box.className = 'settings-box';
      document.body.appendChild(box);
    }
    window.injectFilmixSettings();
    expect(document.getElementById('filmix-token')).toBeTruthy();
    expect(document.getElementById('filmix-code')).toBeTruthy();
    expect(document.getElementById('filmix-activate')).toBeTruthy();
  });

  it('маппінг tmdb → filmixId зберігається', () => {
    window._streamsUtil.fmMapSet('tv', '1402', '111', 'Ходячие мертвецы', '2010');
    const e = window._streamsUtil.fmMapGet('tv', '1402');
    expect(e.filmixId).toBe('111');
  });
});
