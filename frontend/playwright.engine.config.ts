import { defineConfig } from '@playwright/test';

// 独立浏览器上下文 + 空页面，只加载被测模块，不连接 AWU Backend/用户 Session。
export default defineConfig({
  testDir: './tests/engine', workers: 1, retries: 0, timeout: 30_000,
  outputDir: '../.qa/engine-browser/results', reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:55191', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 55191 --strictPort',
    url: 'http://127.0.0.1:55191', reuseExistingServer: false },
});
