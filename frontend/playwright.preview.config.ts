import { defineConfig } from '@playwright/test';
import engine from './playwright.engine.config';

// Optional, explicitly owned Vite server for environments where child startup stalls.
export default defineConfig({ ...engine,
  testMatch: /preview-interaction\.spec\.ts/,
  webServer: process.env.AWU_PREVIEW_TEST_SERVER === 'owned' ? undefined : engine.webServer,
});
