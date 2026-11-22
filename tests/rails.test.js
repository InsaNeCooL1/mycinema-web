import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  window.loadScript('src/rails.js');
});

function item(i, extra = {}) {
  return {
    key: 'movie-' + i, id: i, type: 'movie', title: 'Фільм ' + i,
    poster: '/p' + i + '.jpg', year: String(2024 - (i % 20)),
    genres: [i % 2 ? 18 : 878], tmdbRating: 6 + (i % 4), popularity: i % 50,
    _sortScore: 0.9 - i * 0.001,
    _reasonTags: ['seed-movie-1', 'cast-1', 'dir-1', 'genre-' + (i % 2 ? 18 : 878)],
    ...extra
  };
}

function baseOpts(overrides = {}) {
  return {
    items: Array.from({ length: 100 }, (_, i) => item(i + 1)),
    seeds: [{ key: 'movie-1', id: 1, type: 'movie', title: 'Сід', avg: 8.1 }],
    topCast: [1], topDirectors: [1], topGenres: [18, 878],
    names: { cast: { 1: 'Актор' }, directors: { 1: 'Режисер' }, keywords: {} },
    genreNames: { 18: 'Драма', 878: 'Фантастика' },
    moods: {
      chill: { label: 'Спокій', emoji: '😌', genres: [10749] },
      intense: { label: 'Напруга', emoji: '⚡', genres: [53] },
      thoughtful: { label: 'Роздуми', emoji: '🕯️', genres: [99] },
      fun: { label: 'Розвага', emoji: '🎈', genres: [35] },
      dark: { label: 'Похмуре', emoji: '🌑', genres: [27] },
      epic: { label: 'Епічне', emoji: '🌋', genres: [12] }
    },
    general: {
      trMovies: Array.from({ length: 30 }, (_, i) => item(200 + i)),
      newMovies: [], topMovies: []
    },
    type: 'movie', mode: 'balance', userId: 'u1', dateKey: '2026-01-01', nonce: 0,
    nowYear: 2026, limit: 18,
    ratingOf: (x) => ({ rating: x.tmdbRating, votes: 1000 }),
    ...overrides
  };
}

describe('buildRails', () => {
  it('повертає hero й обмежену кількість гілок', () => {
    const out = window.buildRails(baseOpts());
    expect(out.hero.item).toBeTruthy();
    expect(out.hero.slides.length).toBeGreaterThan(0);
    expect(out.rails.length).toBeGreaterThanOrEqual(10);
    expect(out.rails.length).toBeLessThanOrEqual(18);
  });

  it('не містить настроєвих гілок, але містить гілку режиму', () => {
    const out = window.buildRails(baseOpts());
    const kinds = out.rails.map(r => r.kind);
    expect(kinds.filter(k => k === 'mood').length).toBe(0);
    expect(kinds).toContain('mode');
  });

  it('режим none не додає гілку режиму, хаб-гілки працюють окремо', () => {
    const out = window.buildRails(baseOpts({
      mode: 'none', items: [], seeds: [], moods: {}, general: {}, generalPool: [],
      extraRails: [{ id: 'hub-x', title: 'Хаб', subtitle: '', items: baseOpts().items.slice(0, 12) }]
    }));
    expect(out.rails.some(r => r.id === 'mode-balance')).toBe(false);
    expect(out.rails.some(r => r.id === 'hub-x')).toBe(true);
  });

  it('детермінований для тих самих даних', () => {
    const a = window.buildRails(baseOpts());
    const b = window.buildRails(baseOpts());
    expect(a.rails.map(r => r.id)).toEqual(b.rails.map(r => r.id));
    expect(a.hero.item.key).toBe(b.hero.item.key);
  });

  it('інший день або nonce дає інший набір/героя', () => {
    const a = window.buildRails(baseOpts());
    const b = window.buildRails(baseOpts({ dateKey: '2026-01-02' }));
    const c = window.buildRails(baseOpts({ nonce: 3 }));
    const sig = o => o.rails.map(r => r.id).join('|') + '#' + o.hero.item.key;
    expect(sig(b)).not.toBe(sig(a));
    expect(sig(c)).not.toBe(sig(a));
  });

  it('жоден тайтл не потрапляє більше ніж у 2 гілки', () => {
    const out = window.buildRails(baseOpts());
    const counts = new Map();
    out.rails.forEach(r => r.items.forEach(x => counts.set(x.key, (counts.get(x.key) || 0) + 1)));
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });

  it('герой не дублюється в гілках', () => {
    const out = window.buildRails(baseOpts());
    const heroKey = out.hero.item.key;
    out.rails.forEach(r => {
      if (r.kind !== 'mood') expect(r.items.some(x => x.key === heroKey)).toBe(false);
    });
  });

  it('не ламається на порожніх даних', () => {
    const out = window.buildRails(baseOpts({ items: [], seeds: [], general: {}, moods: {} }));
    expect(out.hero).toBeNull();
    expect(Array.isArray(out.rails)).toBe(true);
  });
});
