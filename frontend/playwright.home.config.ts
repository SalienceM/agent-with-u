import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const profile = process.env.HOME_QA_PROFILE === 'stress' ? 'stress' : 'typical';
const qaRoot = path.join(repoRoot, '.qa', 'home');
const resultRoot = path.join(qaRoot, 'results', profile);
const wsPort = 45421;
const webPort = 55173;
const controlPort = 45423;

export default defineConfig({
  testDir: './tests/acceptance',
  globalSetup: './tests/acceptance/global-setup.ts',
  outputDir: path.join(resultRoot, 'artifacts'),
  timeout: profile === 'stress' ? 45_000 : 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['line'],
    ['html', { outputFolder: path.join(resultRoot, 'html'), open: 'never' }],
    ['json', { outputFile: path.join(resultRoot, 'results.json') }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } },
    { name: 'web-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    {
      name: 'narrow-mobile-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 360, height: 640 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: [
    {
      command: 'node scripts/run-home-qa-backend.mjs',
      cwd: path.join(repoRoot, 'frontend'),
      env: {
        ...process.env,
        HOME_QA_PROFILE: profile,
        HOME_QA_WS_PORT: String(wsPort),
        HOME_QA_WEB_PORT: String(webPort),
        HOME_QA_CONTROL_PORT: String(controlPort),
      },
      port: webPort,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
