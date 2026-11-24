'use strict';

/* ========================================================= */
/* MOBILE SHELL (<768px): топ-бар, нижній Tab Bar,          */
/* складні Bottom Sheet (Списки, Статуси, Меню/Ще,         */
/* Фільтри, UA KINO), мобільний пошук, карт-флоти.         */
/* ========================================================= */

(function () {
  'use strict';

  function isMobShell() {
    if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) return true;
    return false;
  }

  const $ = document.getElementById.bind(document);
  const TOP_LOGO = $('mob-top-logo');
  const TOP_SEARCH = $('mob-top-search');
  const TOP_RIGHT = $('mob-topbar-right');
  const BOTTOM = $('mob-bottom');
  const SHEET_BD = $('mob-sheet-backdrop');
  const SHEET_PANEL = $('mob-sheet-panel');
  const SEARCH_PAGE = $('mob-search-page');

  // ---- Мобільні SVG-іконки (без емодзі — фарбовані, як більшість іконок додатку) ----
  const MV = {
    search: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>',
    play: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"/></svg>',
    check: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    calendar: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M3 10h18"/><path d="M8 14h4"/><path d="M12 14h4"/></svg>',
    crown: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9 8 3 8.5 12 14l5-5.5L21 8 12 2z"/></svg>',
    eye: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    sync: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4v6h-6"/><path d="M3 18v-6h6"/><path d="M3 9a7 7 0 0 1 14-3l-3.5 3.5"/><path d="M21 15a7 7 0 0 1-14 3l3.5-3.5"/></svg>',
    gear: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.8l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.83-.33 1.65 1.65 0 0 0-1.17 1.52V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-.82-.33 1.65 1.65 0 0 0-1.51 1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    dropped: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    notes: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M8 10h6M8 14h4"/></svg>',
    film: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="1.5"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M2 9h20"/><path d="M2 15h20"/></svg>',
    tv: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M12 16v3"/></svg>',
    heart: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
  };

  /* ---------- Top bar ---------- */
  function openMobSearch() {
    if (!SEARCH_PAGE) return;
    SEARCH_PAGE.classList.add('open');
    // Синхронізація: системний «Назад» має закрити пошук
    try { history.pushState({ mcSearch: 1 }, '', location.href); } catch (e) {}
  }
  function closeMobSearch() {
    if (!SEARCH_PAGE || !SEARCH_PAGE.classList.contains('open')) return;
    SEARCH_PAGE.classList.remove('open');
    if (history.state && history.state.mcSearch) {
      try { history.replaceState({ mc: cardStack.length }, '', location.href); } catch (e) {}
    }
  }
  if (TOP_SEARCH) TOP_SEARCH.addEventListener('click', openMobSearch);

  function syncMobTop() {
    if (!TOP_LOGO) return;
    const hasCard = cardStack.length > 0;
    TOP_LOGO.textContent = hasCard ? '← Назад' : 'MyCinema';
    TOP_LOGO.classList.toggle('mob-top-back', hasCard);
  }
  if (TOP_LOGO) {
    TOP_LOGO.addEventListener('click', () => {
      if (cardStack.length) {
        // Fallback для прямого посилання / порожньої історії → головна
        const canGoBack = window.history.length > 1 && !window._mcDirectEntry;
        if (!canGoBack) {
          window._mcDirectEntry = false;
          try { history.replaceState({ mc: 0 }, '', location.pathname + location.search); } catch (e) {}
          closeCard();
          setTab('home');
        } else closeCard();
      } else setTab('home');
      syncMobTop();
    });
  }

  /* ---------- Bottom nav ---------- */
  const NAV_SPECS = [
    { id: 'mob-nav-movies', fn: () => { setTab('home'); setHomeType('movie'); } },
    { id: 'mob-nav-tv', fn: () => setHomeType('tv') },
    { id: 'mob-nav-streamings', fn: () => setTab('streamings') },
    { id: 'mob-nav-lists', fn: () => openMobListsSheet() },
    { id: 'mob-nav-more', fn: () => openMobMoreSheet() }
  ];
  function syncMobNavActive() {
    if (!BOTTOM) return;
    let cur = 'mob-nav-more';
    if (state.tab === 'home') {
      cur = (state.home && state.home.tab === 'tv') ? 'mob-nav-tv' : 'mob-nav-movies';
    } else if (state.tab === 'streamings') {
      cur = 'mob-nav-streamings';
    } else if (['watching', 'watched', 'planned', 'dropped', 'favorites'].includes(state.tab)) {
      cur = 'mob-nav-lists';
    }
    NAV_SPECS.forEach(b => {
      const btn = BOTTOM.querySelector('#' + b.id);
      if (btn) btn.classList.toggle('active', b.id === cur);
    });
    syncMobTop();
  }
  // (Кліки на кнопки налаштовуються в секції Init — window. NAV_SPECS.)

  /* ---------- Sheet engine ---------- */
  function lockPageScroll(on) {
    document.body.classList.toggle('mc-sheet-locked', !!on);
    document.documentElement.classList.toggle('mc-sheet-locked', !!on);
  }
  function mobSheet(headTitle, bodyBuilder) {
    if (!SHEET_BD || !SHEET_PANEL) return null;
    SHEET_PANEL.replaceChildren();
    SHEET_PANEL.style.transform = '';
    SHEET_PANEL._y0 = 0;
    SHEET_PANEL._dy = 0;
    SHEET_PANEL._swiping = false;
    SHEET_PANEL.scrollTop = 0;
    const head = el('div', 'mob-sheet-head');
    head.append(el('div', 'mob-sheet-title', headTitle));
    const c = el('button', 'mob-sheet-close', '✕');
    c.onclick = () => mobSheetClose();
    head.append(c);
    SHEET_PANEL.append(head, el('div', 'mob-sheet-handle'));
    const body = el('div', 'mob-sheet-body');
    SHEET_PANEL.append(body);
    if (typeof bodyBuilder === 'function') bodyBuilder(body);
    SHEET_BD.classList.add('open');
    lockPageScroll(true);
    // Історія: системний «Назад» закриває шит
    try { history.pushState({ mcSheet: 1 }, '', location.href); } catch (e) {}

    // Клік по бекдропу обробляється одним постійним слухачем (див. init),
    // тут лише скид стану свайпу

    SHEET_PANEL._y0 = 0;
    SHEET_PANEL._dy = 0;
    SHEET_PANEL._swiping = false;
    return body;
  }
  function mobSheetClose() {
    if (!SHEET_BD) return;
    const wasOpen = SHEET_BD.classList.contains('open');
    SHEET_BD.classList.remove('open');
    if (SHEET_PANEL) { SHEET_PANEL.style.transform = ''; SHEET_PANEL._swiping = false; SHEET_PANEL.replaceChildren(); }
    lockPageScroll(false);
    if (wasOpen && history.state && history.state.mcSheet) {
      // Знімаємо прапорець шита з поточного запису, щоб системний «Назад» не «зависав»
      try { history.replaceState({ mc: cardStack.length }, '', location.href); } catch (e) {}
    }
  }
  function initSheetSwipe() {
    if (!SHEET_PANEL || SHEET_PANEL._swipeInit) return;
    SHEET_PANEL._swipeInit = true;
    /* Один постійний слухач бекдропу: закриває лише клік саме по фону */
    if (SHEET_BD) {
      SHEET_BD.addEventListener('click', (e) => {
        if (e.target !== SHEET_BD) return;
        if (!SHEET_BD.classList.contains('open')) return;
        mobSheetClose();
      });
    }
    SHEET_PANEL.addEventListener('pointerdown', (e) => {
      if (!SHEET_BD.classList.contains('open')) return;
      if (e.target.closest('button, a, input, select, textarea')) return;
      SHEET_PANEL._y0 = e.clientY;
      // Якщо контент ще не доскролено догори — жестом скролимо контент, не закриваємо
      SHEET_PANEL._swiping = SHEET_PANEL.scrollTop <= 0;
    });
    SHEET_PANEL.addEventListener('pointermove', (e) => {
      if (!SHEET_PANEL._swiping) return;
      SHEET_PANEL._dy = e.clientY - SHEET_PANEL._y0;
      if (SHEET_PANEL._dy > 0) SHEET_PANEL.style.transform = `translateY(${SHEET_PANEL._dy}px)`;
    });
    const finish = () => {
      if (!SHEET_PANEL._swiping) return;
      SHEET_PANEL._swiping = false;
      const dy = SHEET_PANEL._dy || 0;
      SHEET_PANEL.style.transform = '';
      if (dy > 120) mobSheetClose();
    };
    SHEET_PANEL.addEventListener('pointerup', finish);
    SHEET_PANEL.addEventListener('pointercancel', finish);
  }
  function mobSheetItem(text, icon, fn, extra) {
    const b = el('button', 'mob-sheet-item' + (extra || ''));
    if (icon) { const iconSpan = el('span', 'mob-sheet-icon'); iconSpan.innerHTML = icon; b.append(iconSpan); }
    b.append(el('span', 'mob-sheet-label', text));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (fn) fn(e); });
    return b;
  }

  function openMobListsSheet() {
    mobSheet('Списки', (body) => {
      const list = [
        ['Дивлюсь', MV.play, 'watching'],
        ['Переглянуто', MV.check, 'watched'],
        ['Планую', MV.calendar, 'planned'],
        ['Закинуто', MV.dropped, 'dropped'],
        ['Улюблене', MV.heart, 'favorites']
      ];
      list.forEach(([label, icon, tab]) => {
        const count = Object.values(lib || {}).filter(x =>
          tab === 'favorites' ? x.favorite : x.status === tab).length;
        body.append(mobSheetItem(`${label} · ${count}`, icon, () => { mobSheetClose(); setTab(tab); }, ' mob-sheet-list-item'));
      });
    });
  }

  function openMobMoreSheet() {
    mobSheet('Меню/Ще', (body) => {
      body.append(mobSheetItem('Календар', MV.calendar, () => { mobSheetClose(); setTab('calendar'); }));
      body.append(mobSheetItem('Цар гори', MV.crown, () => { mobSheetClose(); setTab('top'); }));
      body.append(mobSheetItem('Обсерваторія', MV.eye, () => { mobSheetClose(); setTab('statistics'); }));
      body.append(mobSheetItem('Синхронізація', MV.sync, () => { mobSheetClose(); syncFromSettings(); }));
      body.append(mobSheetItem('Налаштування', MV.gear, () => { mobSheetClose(); setTab('settings'); }));
    });
  }

  function openMobFiltersSheet() {
    mobSheet('Фільтри', (body) => {
      const opts = [{ id: 'all', label: 'Всі' }, { id: 'movie', label: 'Фільми', icon: MV.film }, { id: 'tv', label: 'Серіали', icon: MV.tv }];
      const cur = state.typeFilter === 'movie' ? 'movie' : (state.typeFilter === 'tv' ? 'tv' : 'all');
      opts.forEach(o => {
        body.append(mobSheetItem(o.label, o.icon || '', () => { mobSheetClose(); setTypeFilter(o.id); }, o.id === cur ? ' mob-sheet-item-active' : ''));
      });
    });
  }

  function openMobStatusSheet(ctx) {
    const r = ctx.item;
    const s = lib[r.key] || {};
    const isW = s.status === 'watched';
    mobSheet('Статуси', (body) => {
      const tv = r.type === 'tv';
      const watchBtn = mobSheetItem(isW ? 'Переглянуто' : 'Дивлюсь', isW ? MV.check : MV.play, () => {
        const newStatus = isW ? null : 'watched';
        let newEps = s.watchedEpisodes || [];
        if (tv && newStatus === 'watched') {
          newEps = [];
          ctx.details?.seasons?.forEach(season => {
            if (season.season_number !== 0) {
              const cnt = (season.episodes && season.episodes.length) ? season.episodes.length : (season.episode_count || 0);
              for (let i = 1; i <= cnt; i++) newEps.push(season.season_number + '-' + i);
            }
          });
        }
        update(r, { status: newStatus, watchedEpisodes: newEps });
        mobSheetClose();
      }, ' mob-sheet-watch');
      if (isW) watchBtn.classList.add('active');
      body.append(watchBtn);
      body.append(mobSheetItem('Планую', MV.calendar, () => { update(r, { status: s.status === 'planned' ? null : 'planned', watchedEpisodes: s.watchedEpisodes || [] }); mobSheetClose(); }));
      body.append(mobSheetItem('Закинуто', MV.dropped, () => { update(r, { status: s.status === 'dropped' ? null : 'dropped', watchedEpisodes: s.watchedEpisodes || [] }); mobSheetClose(); }));
      body.append(mobSheetItem('Нотатки', MV.notes, () => { mobSheetClose(); window.openQuickNoteModal(ctx); }));
      if (isW) {
        const rwCnt = s.rewatches || 0;
        body.append(mobSheetItem(`Перегляд ×${rwCnt + 1}${rwCnt > 0 ? ' — зафіксувати' : ''}`, MV.sync, () => {
          const latest = lib[r.key] || s;
          const nextRw = (latest.rewatches || 0) + 1;
          update(r, { rewatches: nextRw, rewatchDates: [...(latest.rewatchDates || []), Date.now()], statusDate: Date.now() });
          mobSheetClose();
        }));
        if (r.type === 'tv') {
          const done = (s.watchedEpisodes || []).length;
          const total = ctx.details?.number_of_episodes || 0;
          const meta = done > 0 ? `${done}/${total || '?'} серій · ${Math.round((done / Math.max(1, total)) * 100)}%` : '';
          if (meta) body.append(el('div', 'mob-sheet-meta', meta));
        }
      }
      if (lib[r.key]) {
        body.append(mobSheetItem('Видалити', MV.trash, () => {
          mobSheetClose();
          if (confirm('Видалити тайтл?')) {
            const snap = lib[r.key] || r;
            removeLibItem(r.key);
            logActivity && logActivity({ cat: 'remove', sub: 'delete', icon: '🗑️', text: 'Видалено з бібліотеки', item: snap });
            saveNow(); closeCard();
          }
        }, ' mob-sheet-item-danger'));
      }
    });
  }

  function initMobSearch() {
    if (!SEARCH_PAGE || !$('mob-search-input')) return;
    const input = $('mob-search-input');
    const results = $('mob-search-results');
    const history = $('mob-search-history');
    const back = $('mob-search-back');
    let acTimer = 0;
    const runSearch = (q) => {
      results.replaceChildren();
      history.replaceChildren();
      if (!q) {
        const hist = (typeof readSearchHistory === 'function' ? readSearchHistory() : []) || [];
        if (hist.length) {
          history.append(el('div', 'mob-search-history-head', 'Останні запити'));
          hist.slice(0, 8).forEach(t => {
            const b = el('button', 'mob-search-item', t);
            b.onclick = () => { input.value = t; runSearch(t); };
            history.append(b);
          });
        }
        return;
      }
      clearTimeout(acTimer);
      acTimer = setTimeout(async () => {
        if (!SEARCH_PAGE.classList.contains('open') || input.value.trim() !== q) return;
        history.replaceChildren();
        try {
          const data = await tmdbFetch(`/search/multi?language=uk-UA&query=${encodeURIComponent(q)}&include_adult=false`);
          const resultsList = (data && data.results) || [];
          if (!SEARCH_PAGE.classList.contains('open') || input.value.trim() !== q) return;
          results.replaceChildren();
          const media = resultsList.filter(r => r.media_type === 'movie' || r.media_type === 'tv').map(normalizeItem).slice(0, 12);
          const people = resultsList.filter(r => r.media_type === 'person').slice(0, 4);
          [
            ...media.map(item => ({ label: item.title, poster: item.poster, meta: (item.type === 'tv' ? 'Серіал' : 'Фільм') + (item.year ? ' · ' + item.year : ''), onClick: () => openCard(item) })),
            ...people.map(p => ({ label: p.name, poster: null, meta: 'Актор', onClick: () => openPerson(p.id) }))
          ].forEach(row => {
            const b = el('button', 'mob-search-item mob-search-card');
            const poster = el('div', 'mob-search-card-poster');
            if (row.poster) { const img = el('img'); img.src = TMDB_IMG + 'w185' + row.poster; poster.append(img); }
            b.append(poster, el('div', 'mob-search-card-info', `${row.label}\n${row.meta}`));
            b.onclick = () => { if (typeof addToHistory === 'function') addToHistory(input.value); row.onClick(); };
            results.append(b);
          });
          if (!results.children.length) results.append(el('div', 'mob-search-item mob-search-empty', 'Нічого не знайдено'));
        } catch (e) { results.innerHTML = ''; }
      }, 300);
    };
    input.addEventListener('input', () => runSearch(input.value.trim()));
    input.addEventListener('focus', () => runSearch(input.value.trim()));
    back.addEventListener('click', closeMobSearch);
    $('mob-search-close').addEventListener('click', closeMobSearch);
  }

  /* ---------- Card floats (<768) ---------- */
  function initMobCardFloats() {
    const card = document.getElementById('card');
    if (!card) return;
    const attach = () => {
      const hero = card.querySelector('.mobile-hero');
      if (!hero) return;
      hero.querySelectorAll('.mob-hero-floats').forEach(n => n.remove());
      const floats = el('div', 'mob-hero-floats');
      /* Трейлер — внизу зліва поверх градієнта */
      const tbtn = hero.querySelector('.btn-play, .btn-stop');
      if (tbtn) {
        const t = el('button', 'mob-glass-btn mob-trailer'); t.innerHTML = MV.play + ' Трейлер';
        t.type = 'button';
        t.onclick = tbtn.onClick || tbtn.onclick;
        floats.append(t);
        /* Оригінальну кнопку ховаємо — інакше на постері два трейлери */
        tbtn.classList.add('mob-trailer-hidden');
      }
      /* Сердечко — вгорі праворуч, нижче топ-бару */
      const fav = card.querySelector('.hero-fav-btn');
      if (fav) floats.append(fav);
      hero.append(floats);

      /* Статус-шит відкривається через делегований обробник (див. нижче).
         Тут нічого не додаємо — зайвий рядок кнопок не потрібен. */
      /* Згорнута «Моя оцінка» — клікабельна вся панель */
      const score = card.querySelector('.mobile-score');
      if (score && !score.dataset.mobToggle) {
        score.dataset.mobToggle = '1';
        const toggle = () => {
          const t = score.querySelector('.score-toggle');
          if (t) t.click();
        };
        const hit = (e) => {
          if (!score.classList.contains('collapsed')) return;
          if (e.target.closest('.btn-clear-ratings, .score-toggle')) return;
          toggle();
        };
        score.querySelector('.score-total')?.addEventListener('click', hit);
        score.querySelector('.score-header')?.addEventListener('click', hit);
      }
      /* Статуси тепер відкриваються через селектор статусу (Bottom Sheet).
         Інлайн-рядок статусів на мобільному ховаємо, щоб не дублювати. */
      const st = card.querySelector('.mobile-statuses');
      if (st) st.remove();
    };
    const after = (r) => { attach(); syncMobTop(); return r; };
    const _rc = window.renderCard;
    window.renderCard = function (restore) {
      const r = _rc(restore);
      return (r && typeof r.then === 'function') ? r.then(after) : after(r);
    };
    const _oc = window.openCard;
    window.openCard = function (item) {
      const r = _oc(item);
      return (r && typeof r.then === 'function') ? r.then(after) : after(r);
    };
    const _cc = window.closeCard;
    window.closeCard = function () {
      const r = _cc();
      syncMobTop();
      setTimeout(syncMobTop, 0); /* history.go асинхронний */
      return r;
    };
    attach();
    syncMobTop();
  }

  /* ---------- Статус-селектор картки → Bottom Sheet (делегований) ---------- */
  document.addEventListener('click', (e) => {
    if (!isMobShell()) return;
    const btn = e.target instanceof Element ? e.target.closest('.status-select-btn') : null;
    if (!btn || !document.getElementById('card').contains(btn)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const ctx = cardStack[cardStack.length - 1];
    if (ctx) openMobStatusSheet(ctx);
  }, true);

  /* ---------- Library filters → filters sheet (mobile) ---------- */
  document.addEventListener('click', (e) => {
    if (!isMobShell()) return;
    const btn = e.target.closest('.filter-btn');
    if (btn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openMobFiltersSheet();
    }
  }, true);

  /* ---------- UA KINO streams picker → sheet on mobile ---------- */
  if (typeof window.openStreamPicker === 'function') {
    const _osp = window.openStreamPicker;
    window.openStreamPicker = function () {
      const r = _osp.apply(this, arguments);
      /* openStreamPicker нічого не повертає — беремо реальний оверлей з DOM */
      if (isMobShell()) {
        const ov = document.getElementById('streams-overlay');
        if (ov) ov.classList.add('mob-streams-sheet');
      }
      return r;
    };
  }

  /* ---------- Escape closes sheets/search ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (SEARCH_PAGE && SEARCH_PAGE.classList.contains('open')) { closeMobSearch(); return; }
    if (SHEET_BD && SHEET_BD.classList.contains('open')) mobSheetClose();
  });

  /* ---------- Системний «Назад»: завжди знімаємо оверлеї/скрол-лок ---------- */
  function closeAllOverlays() {
    // НЕ закриваємо картку — вона є частиною роутингу через hash,
    // інакше deep-link/переходи закривають щойно відкритий тайтл
    if (SEARCH_PAGE && SEARCH_PAGE.classList.contains('open')) closeMobSearch();
    if (SHEET_BD && SHEET_BD.classList.contains('open')) mobSheetClose();
    lockPageScroll(false);
  }
  window.addEventListener('popstate', () => { closeAllOverlays(); setTimeout(() => { syncMobTop(); lockPageScroll(false); }, 0); });
  window.addEventListener('hashchange', () => { closeAllOverlays(); setTimeout(() => { syncMobTop(); lockPageScroll(false); }, 0); });

  /* ---------- Init ---------- */
  if (isMobShell()) {
    // Пряме посилання на картку: «Назад» має вести на головну, а не в нікуди
    if (/^#\/(movie|tv|person|company|streaming)\//.test(location.hash) &&
        history.state && history.state.mc === 0) {
      window._mcDirectEntry = true;
    }
    if (TOP_RIGHT) {
      const tasteBtn = document.getElementById('taste-top-btn');
      if (tasteBtn) TOP_RIGHT.append(tasteBtn);
    }
    NAV_SPECS.forEach(b => { if (BOTTOM) BOTTOM.querySelector('#' + b.id).addEventListener('click', b.fn); });
    initMobSearch();
    initMobCardFloats();
    initSheetSwipe();
    syncMobNavActive();
    syncMobTop();
    window.syncMobNavActive = syncMobNavActive;
    window.openMobStatusSheet = openMobStatusSheet;
    window.openMobFiltersSheet = openMobFiltersSheet;
    window.openMobListsSheet = openMobListsSheet;
    window.openMobMoreSheet = openMobMoreSheet;
    window.mobSheet = mobSheet;
    window.isMobShell = isMobShell;
    window.SEARCH_PAGE = SEARCH_PAGE;
  }
})();
