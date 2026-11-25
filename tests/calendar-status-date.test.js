import { describe, it, expect, beforeAll } from 'vitest';

describe('Календар — дата статусу', () => {
  beforeAll(() => {
    window.loadScript('src/calendar.js');
    window.loadScript('src/library.js');
  });

  it('бере statusDate навіть якщо createdAt/updated новіші', () => {
    const ts = window.calendarStatusTs({ statusDate: 1000, createdAt: 2000, updated: 3000 });
    expect(ts).toBe(1000);
  });

  it('не бере updated, коли є createdAt', () => {
    const ts = window.calendarStatusTs({ statusDate: null, createdAt: 2000, updated: 3000 });
    expect(ts).toBe(2000);
  });

  it('підтримує легасі _fieldTs.status і рядкові таймстемпи', () => {
    expect(window.calendarStatusTs({ _fieldTs: { status: '1500' }, createdAt: 2000 })).toBe(1500);
    expect(window.calendarStatusTs({ statusDate: '1700', createdAt: 2000 })).toBe(1700);
  });

  it('порожній запис дає 0 — тайтл не потрапить у календар', () => {
    expect(window.calendarStatusTs(null)).toBe(0);
    expect(window.calendarStatusTs({})).toBe(0);
  });

  it('renderCalendar групує за statusDate, навіть якщо updated новіший', () => {
    const sep = new Date(2026, 8, 5).getTime();
    const oct = new Date(2026, 9, 10).getTime();
    window.lib = {
      'movie-a': { key: 'movie-a', type: 'movie', title: 'A', status: 'watched', statusDate: sep, updated: oct },
      'movie-b': { key: 'movie-b', type: 'movie', title: 'B', status: 'watched', statusDate: oct, updated: oct }
    };
    window.state.calendarStatus = 'all';
    window.state.calendarMonth = '2026-9';

    window.renderCalendar();

    const titles = [...document.querySelectorAll('#results .item .title')].map(e => e.textContent);
    expect(titles).toEqual(['B']);
    const monthSel = document.querySelectorAll('#results select.calendar-select')[1];
    expect([...monthSel.options].map(o => o.value)).toEqual(['2026-9', '2026-8']);
  });
});
