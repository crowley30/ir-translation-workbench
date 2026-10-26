import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 35000,
  expect: { timeout: 8000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command:
      'npx --no-install concurrently -k "npm start" "npx --no-install vite --host 127.0.0.1"',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      TRANSLATION_MODE: 'mock',
      DATABASE_PATH: 'test-results/e2e.sqlite',
    },
  },
});
