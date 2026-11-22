import { describe, it, expect, beforeAll, afterEach } from 'vitest';

beforeAll(() => {
  window.loadScript('src/card/ui-kit.js');
});

function ratingsRow(omdb, type = 'movie') {
  const wrap = window.MC.createTitle({
    details: { title: 'Test', vote_average: 7.5, genres: [] },
    item: { key: 'movie-1', type },
    omdb,
  });
  return wrap.querySelector('.meta-ratings-wrap');
}

describe('Metacritic badge на картці фільму', () => {
  it('рендериться одразу після Rotten Tomatoes', () => {
    const row = ratingsRow({
      imdbRating: '8.1',
      Ratings: [
        { Source: 'Rotten Tomatoes', Value: '92%' },
        { Source: 'Metacritic', Value: '81/100' },
      ],
    });
    expect([...row.children].map(x => x.className)).toEqual([
      'rating-tmdb', 'rating-imdb', 'rating-rt', 'rating-mc',
    ]);
    const mc = row.querySelector('.rating-mc');
    expect(mc.querySelectorAll('span')[1].textContent).toBe('81');
    expect(mc.querySelector('.rate-chip')).toBeTruthy();
    expect(mc.querySelectorAll('span')[1].className).toBe('temp-green');
  });

  it('падає назад на Metascore і пропускає N/A', () => {
    const row = ratingsRow({ Metascore: '58' });
    const mc = row.querySelector('.rating-mc');
    expect(mc).not.toBeNull();
    expect(mc.querySelectorAll('span')[1].textContent).toBe('58');
    expect(mc.querySelector('.rate-chip')).toBeTruthy();
    expect(mc.querySelectorAll('span')[1].className).toBe('temp-orange');

    const na = ratingsRow({ Ratings: [{ Source: 'Metacritic', Value: 'N/A' }] });
    expect(na.querySelector('.rating-mc')).toBeNull();
  });

  it('не рендериться для серіалів', () => {
    const row = ratingsRow({ Ratings: [{ Source: 'Metacritic', Value: '81/100' }] }, 'tv');
    expect(row.querySelector('.rating-mc')).toBeNull();
    expect(row.querySelector('.rating-rt')).toBeNull();
  });
});

describe('Кнопки перегляду на картці', () => {
  const room = window.mcRoom || {};
  const origEnabled = room.enabled;
  const origOpen = room.open;

  afterEach(() => {
    if (origEnabled) room.enabled = origEnabled; else delete room.enabled;
    if (origOpen) room.open = origOpen; else delete room.open;
    delete window.mcChat;
  });

  function actions(item = { key: 'movie-1', type: 'movie' }) {
    return window.MC.createActions({ item, details: { title: 'Test' } });
  }

  it('не дублює AI-кнопку і лишає лише одну головну дію «Дивитись»', () => {
    window.mcChat = { enabled: () => true, open: () => {} };
    window.mcRoom.enabled = () => true;
    window.mcRoom.open = () => {};

    const row = actions();
    expect(row.querySelector('.btn-ai')).toBeFalsy();
    expect(row.textContent).not.toContain('AI');
    expect([...row.querySelectorAll('.btn-uakino')].map(b => b.textContent.trim()))
      .toEqual(['▶ Дивитись']);
  });

  it('кнопка «Дивитись» відкриває вибір джерела', () => {
    let opened = null;
    window.openStreamPicker = (title, year, type, imdb, orig, ctx) => { opened = ctx; };

    const row = actions();
    const watch = row.querySelector('.btn-watch-primary');
    expect(watch).toBeTruthy();
    watch.click();
    expect(opened).toMatchObject({ key: 'movie-1' });
  });
});
