import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*e2e*.spec.js',
  fullyParallel: false, // Run tests serially for this pipeline test
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1, // Single worker for e2e test
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report' }]
  ],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: false, // Show browser for visual debugging
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream', // Auto-grant mic permissions
            '--use-fake-device-for-media-stream', // Use fake audio device
            '--autoplay-policy=no-user-gesture-required', // Allow autoplay
          ]
        }
      },
    },
  ],
  // Don't start webserver (expect server to be running)
  webServer: undefined,
});
