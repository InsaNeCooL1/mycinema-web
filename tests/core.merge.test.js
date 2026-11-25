import { describe, it, expect } from 'vitest';

describe('mergeLibraries', () => {
  // ВАЖЛИВО: усі timestamp-и мають бути реалістичними (Date.now()-based).
  // Інакше tombstones із "старими" значеннями (наприклад, 100 = 1970 рік)
  // видаляються TTL-очищенням (> 90 днів) ДО того, як вони встигають
  // вплинути на фільтрацію. Це не баг коду — це контракт: tombstones
  // старші за TOMBSTONE_TTL (90 днів) вважаються "протухлими" і ігноруються.

  it('бере новішу версію (за updated) — cloud wins', () => {
    const now = Date.now();
    const local = { 'movie-1': { key: 'movie-1', title: 'A', updated: now - 1000 } };
    const cloud = { 'movie-1': { key: 'movie-1', title: 'B', updated: now } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['movie-1'].title).toBe('B');
  });

  it('local новіший за cloud → local wins', () => {
    const now = Date.now();
    const local = { 'movie-1': { key: 'movie-1', title: 'A', updated: now } };
    const cloud = { 'movie-1': { key: 'movie-1', title: 'B', updated: now - 1000 } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['movie-1'].title).toBe('A');
  });

  it('tombstone новіший за updated → видаляє', () => {
    const now = Date.now();
    const local = { 'movie-1': { key: 'movie-1', title: 'A', updated: now - 1000 } };
    const del = { 'movie-1': now };
    const res = window.mergeLibraries(local, del, {}, {});
    expect(res.items['movie-1']).toBeUndefined();
  });

  it('updated новіший за tombstone → зберігає', () => {
    const now = Date.now();
    const local = { 'movie-1': { key: 'movie-1', title: 'A', updated: now } };
    const del = { 'movie-1': now - 1000 };
    const res = window.mergeLibraries(local, del, {}, {});
    expect(res.items['movie-1'].title).toBe('A');
  });

  it('старі tombstones (> 90 днів) видаляються з мапи deleted', () => {
    const now = Date.now();
    const oldTs = now - 91 * 24 * 60 * 60 * 1000;
    const del = { 'movie-1': oldTs };
    const res = window.mergeLibraries({}, del, {}, {});
    expect(res.deleted['movie-1']).toBeUndefined();
  });

  it('свіжий tombstone + свіжий updated → item видаляється, tombstone лишається', () => {
    const now = Date.now();
    const local = { 'movie-1': { key: 'movie-1', title: 'A', updated: now - 1000 } };
    const del = { 'movie-1': now };
    const res = window.mergeLibraries(local, del, {}, {});
    expect(res.items['movie-1']).toBeUndefined();
    expect(res.deleted['movie-1']).toBe(now);
  });

  it('протухлий tombstone не видаляє старий item (TTL) — задокументована поведінка', () => {
    const now = Date.now();
    const ancient = now - 100 * 24 * 60 * 60 * 1000; // 100 днів тому
    const local = { 'movie-1': { key: 'movie-1', title: 'A', updated: ancient + 1000 } };
    const del = { 'movie-1': ancient + 2000 }; // теж стародавній tombstone
    const res = window.mergeLibraries(local, del, {}, {});
    // Обидва протухли; tombstone очищується, item виживає.
    expect(res.items['movie-1']).toBeDefined();
    expect(res.deleted['movie-1']).toBeUndefined();
  });
});

describe('SYNC-FIELD-MERGE — паралельні правки не затираються', () => {
  it('зберігає оцінку з одного пристрою і статус з іншого', () => {
    const now = Date.now();
    const local = { 'movie-9': { key: 'movie-9', updated: now - 5000, ratings: { overall: 9 }, ratingUpdated: now - 1000 } };
    const cloud = { 'movie-9': { key: 'movie-9', updated: now, status: 'watched', statusDate: now, ratings: null } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['movie-9'].ratings.overall).toBe(9);
    expect(res.items['movie-9'].status).toBe('watched');
    expect(res.items['movie-9'].updated).toBe(now);
  });

  it('зливає оцінки сезонів по ключах, а не цілим об\'єктом', () => {
    const now = Date.now();
    const local = { 'tv-9': { key: 'tv-9', updated: now - 1000, seasonRatings: { 1: { overall: 8 } }, seasonRatingTs: { 1: now - 1000 } } };
    const cloud = { 'tv-9': { key: 'tv-9', updated: now, seasonRatings: { 2: { overall: 9 } }, seasonRatingTs: { 2: now } } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['tv-9'].seasonRatings[1].overall).toBe(8);
    expect(res.items['tv-9'].seasonRatings[2].overall).toBe(9);
  });

  it('офлайн-правка зі старим updated, але свіжим _fieldTs перемагає', () => {
    const now = Date.now();
    const local = { 'movie-10': { key: 'movie-10', updated: now - 10000, notes: 'нова нотатка', _fieldTs: { notes: now } } };
    const cloud = { 'movie-10': { key: 'movie-10', updated: now - 5000, notes: 'стара нотатка' } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['movie-10'].notes).toBe('нова нотатка');
  });

  it('поле, яке є тільки в хмарі, не губиться при злитті', () => {
    const now = Date.now();
    const local = { 'movie-12': { key: 'movie-12', updated: now, ratings: { overall: 8 } } };
    const cloud = { 'movie-12': { key: 'movie-12', updated: now - 1000, notes: 'важлива нотатка' } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['movie-12'].notes).toBe('важлива нотатка');
    expect(res.items['movie-12'].ratings.overall).toBe(8);
  });

  it('повторне додання знімає tombstone, щоб запис не видалявся з хмари', () => {
    const now = Date.now();
    const local = { 'movie-11': { key: 'movie-11', updated: now } };
    const del = { 'movie-11': now - 1000 };
    const res = window.mergeLibraries(local, del, {}, {});
    expect(res.items['movie-11']).toBeDefined();
    expect(res.deleted['movie-11']).toBeUndefined();
  });
});

describe('CAL-STATUS-TS — дата статусу не губиться при злитті', () => {
  const day = 24 * 60 * 60 * 1000;

  it('оновлення метаданих (updated) не переписує дату статусу', () => {
    const now = Date.now();
    const statusTs = now - 5 * day;
    const local = { 'movie-20': { key: 'movie-20', status: 'watched', statusDate: statusTs, cast: ['A'], updated: now } };
    const cloud = { 'movie-20': { key: 'movie-20', status: 'watched', statusDate: statusTs, updated: statusTs } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['movie-20'].statusDate).toBe(statusTs);
  });

  it('новіший статус з хмари перемагає старіший локальний попри свіжий updated', () => {
    const now = Date.now();
    const local = { 'movie-21': { key: 'movie-21', status: 'watched', statusDate: now - 10 * day, updated: now } };
    const cloud = { 'movie-21': { key: 'movie-21', status: 'planned', statusDate: now - day, updated: now - 10 * day } };
    const res = window.mergeLibraries(local, {}, cloud, {});
    expect(res.items['movie-21'].status).toBe('planned');
    expect(res.items['movie-21'].statusDate).toBe(now - day);
  });

  it('легасі-запис без statusDate отримує фіксовану дату з createdAt', () => {
    const now = Date.now();
    const createdAt = now - 7 * day;
    const local = { 'movie-22': { key: 'movie-22', status: 'watched', createdAt, updated: now } };
    const res = window.mergeLibraries(local, {}, {}, {});
    expect(res.items['movie-22'].statusDate).toBe(createdAt);
  });

  it('load() backfill-ить statusDate для старих записів у localStorage', () => {
    const now = Date.now();
    const createdAt = now - 3 * day;
    localStorage.setItem(window.LS, JSON.stringify({
      'movie-23': { key: 'movie-23', status: 'watched', createdAt, updated: now }
    }));
    expect(window.load()['movie-23'].statusDate).toBe(createdAt);
  });
});
