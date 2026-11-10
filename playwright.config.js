import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test', testMatch: '*.spec.js', workers: 1,
  timeout: 180000, expect: { timeout: 15000 },
  use: { baseURL: process.env.TEST_URL || 'http://127.0.0.1:3211', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
});
