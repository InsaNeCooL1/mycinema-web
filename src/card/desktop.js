/* Desktop UI картки */
(function () {
  'use strict';

  function renderDesktopCard(ctx, scroll) {
    if (!window.MC) {
      scroll.innerHTML = '<div style="text-align:center; padding:40px; color:var(--danger);">Помилка: функції UI картки не завантажені.</div>';
      return;
    }

    scroll.innerHTML = '';
    const root = el('div', 'card-desktop-root');

    // ─── ЛІВА КОЛОНКА ───
    const colLeft = el('div', 'card-desktop-left');
    
    // 1. Артворк і трейлер
    colLeft.append(MC.createHero(ctx));

    // 2. Моя оцінка під постером: фільми — загальна, серіали — посезонна
    if (ctx.item) colLeft.append(ctx.item.type === 'tv' ? MC.createTvScoreBlock(ctx) : MC.createScoreBlock(ctx));

    // ─── ПРАВА КОЛОНКА ───
    const colRight = el('div', 'card-desktop-right');

    colRight.append(MC.createTitle(ctx));
    colRight.append(MC.createActions(ctx));
    colRight.append(MC.createOverview(ctx));
    colRight.append(MC.createTabs(ctx));

    // Інформація — легко, внизу, без рамки
    if (typeof renderDetailsTab === 'function') {
      const info = el('div', 'card-info-block');
      info.append(el('div', 'card-info-title', 'Інформація'));
      renderDetailsTab(ctx).forEach(node => info.append(node));
      colRight.append(info);
    }

    root.append(colLeft, colRight);
    scroll.append(root);
  }

  window.renderDesktopCard = renderDesktopCard;
})();
