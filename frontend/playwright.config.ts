import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.AUCTION_E2E_URL || 'http://127.0.0.1:5174',
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    launchOptions: {
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    },
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.AUCTION_E2E_URL ? undefined : {
    command: 'npm run dev -- --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
  },
})
