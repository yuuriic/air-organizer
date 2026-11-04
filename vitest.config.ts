import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/build-desktop.global.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
