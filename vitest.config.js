import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    // worker/index.js з секретами не лежить у репо — тест воркера не для web-клієнта
    exclude: ['tests/worker-imdb.test.js', 'node_modules/**'],
    restoreMocks: true,
  },
});
