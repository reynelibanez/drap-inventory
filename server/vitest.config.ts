import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    env: { DB_NAME: 'refurbiz_test', JWT_SECRET: 'test-secret-test-secret-test-secret', NODE_ENV: 'test' },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
