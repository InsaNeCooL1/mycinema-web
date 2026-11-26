import { describe, it, expect, beforeEach } from 'vitest';

window.loadScript('src/player-controls.js');

describe('MCPlayerControls', () => {
  let host, video;

  beforeEach(() => {
    document.querySelectorAll('.mc-pc').forEach(el => el.remove());
    document.querySelectorAll('#mc-player-controls-style').forEach(el => el.remove());
    host = document.createElement('div');
    video = document.createElement('video');
    host.appendChild(video);
    document.body.appendChild(host);
  });

  it('замінює нативні контроли власними', () => {
    video.controls = true;
    const opened = [];
    const c = window.MCPlayerControls.mount({
      host, video, title: 'Тест',
      onMenu: () => opened.push('menu'),
      onFullscreen: () => opened.push('full')
    });
    expect(video.controls).toBe(false);
    expect(host.querySelector('.mc-pc-title').textContent).toBe('Тест');
    expect(host.querySelector('.mc-pc-seek input')).toBeTruthy();

    host.querySelector('[data-a="menu"]').click();
    host.querySelector('[data-a="full"]').click();
    expect(opened).toEqual(['menu', 'full']);

    c.destroy();
    expect(host.querySelector('.mc-pc')).toBeNull();
  });

  it('не скидає зсув ?start= після того, як currentTime його переріс', () => {
    const c = window.MCPlayerControls.mount({
      host, video, title: 'Тест', totalDuration: 90, timeOffset: 28,
      onSeek: () => {}
    });
    const time = host.querySelector('.mc-pc-time');
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 30 });
    video.dispatchEvent(new Event('timeupdate'));
    expect(time.textContent).toBe('0:58 / 1:30');

    c.setTimeOffset(28, true);
    expect(time.textContent).toBe('0:30 / 1:30');
    c.destroy();
  });
});
