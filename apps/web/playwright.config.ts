import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

if (!process.env.DATABASE_URL) {
  loadEnvFile(resolve(__dirname, '../../.env'));
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev --workspace @video-meetings/api',
      url: 'http://localhost:3001/meetings',
      env: { ...process.env, TRUSTED_PROXY_IPS: 'loopback' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run dev --workspace @video-meetings/web',
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'desktop-chromium',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      use: {
        browserName: 'chromium',
        hasTouch: true,
        isMobile: true,
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: 'mobile-landscape-chromium',
      use: {
        browserName: 'chromium',
        hasTouch: true,
        isMobile: true,
        viewport: { width: 844, height: 390 },
      },
    },
  ],
});
