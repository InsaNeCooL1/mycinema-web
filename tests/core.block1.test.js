import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

describe('Block 1 fixes & invariants', () => {
  beforeAll(() => {
    window.loadScript('src/streams.js');
    window.loadScript('src/calendar.js');
  });

  beforeEach(() => {
    localStorage.clear();
    window.lib = {};
    window.save = vi.fn();
  });

  it('extractProvidersUA бере тільки UA і не підміняє на US + не падає на Amazon Channel', () => {
    const onlyUs = {
      'watch/providers': {
        results: {
          US: { flatrate: [{ provider_name: 'HBO Max Amazon Channel', logo_path: '/hbo.png' }] }
        }
      }
    };
    expect(window.extractProvidersUA(onlyUs)).toEqual([]);

    const withUa = {
      'watch/providers': {
        results: {
          UA: {
            flatrate: [
              { provider_name: 'HBO Max Amazon Channel', logo_path: '/bad.png' },
              { provider_name: 'Netflix', logo_path: '/nf.png' }
            ]
          }
        }
      }
    };
    const res = window.extractProvidersUA(withUa);
    expect(res).toHaveLength(1);
    expect(res[0].key).toBe('netflix');
  });

  it('isTrackedInLib не вважає запис без статусу/оцінки за переглянутий', () => {
    window.lib = {
      'movie-1': { key: 'movie-1', type: 'movie', title: 'Empty', status: null, ratings: null },
      'movie-2': { key: 'movie-2', type: 'movie', title: 'Planned', status: 'planned', ratings: null },
      'movie-3': { key: 'movie-3', type: 'movie', title: 'Fav', status: null, favorite: true }
    };
    expect(window.isTrackedInLib('movie-1')).toBe(false);
    expect(window.isTrackedInLib('movie-2')).toBe(true);
    expect(window.isTrackedInLib('movie-3')).toBe(true);
  });

  it('TorrServer має адресу за замовчуванням', () => {
    expect(window.getOnlineConfig().serverUrl).toBe('http://localhost:8092');
  });

  it('scoreCandidate у streams.js надає пріоритет точному збігу назви, року й типу', () => {
    const { scoreCandidate } = window._streamsUtil;
    const oldRemake = { title: 'Дюна', year: '1984', isTvHint: false, provider: 'ashdi' };
    const rightMovie = { title: 'Dune', year: '2021', isTvHint: false, provider: 'ashdi' };
    const wrongType = { title: 'Дюна', year: '2021', isTvHint: true, provider: 'embf' };

    const sOld = scoreCandidate(oldRemake, 'Дюна', 'Dune', '2021', 'movie');
    const sRight = scoreCandidate(rightMovie, 'Дюна', 'Dune', '2021', 'movie');
    const sWrongT = scoreCandidate(wrongType, 'Дюна', 'Dune', '2021', 'movie');

    expect(sRight).toBeGreaterThan(sOld);
    expect(sRight).toBeGreaterThan(sWrongT);
  });
});

describe('Block 2 IndexedDB cache fallback', () => {
  it('mcCacheSet / mcCacheGet / mcCacheDel коректно зберігають і видаляють дані', () => {
    window.mcCacheSet('mycinema.metaCache.v2', { 'movie-1': { ts: 123 } });
    expect(window.mcCacheGet('mycinema.metaCache.v2', {})).toEqual({ 'movie-1': { ts: 123 } });
    window.mcCacheDel('mycinema.metaCache.v2');
    expect(window.mcCacheGet('mycinema.metaCache.v2', {})).toEqual({});
  });
});
