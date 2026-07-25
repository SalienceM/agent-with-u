import { expect, test } from '@playwright/test';

const CONTROL_URL = 'http://127.0.0.1:45423';

async function openCleanHome(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('agent-with-u:pane-sessions');
    localStorage.removeItem('awu.connectionTarget');
    localStorage.removeItem('awu.execRoster');
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '工作总览' })).toBeVisible();
}

test.describe.serial('desktop and regular-web dashboard acceptance', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !['desktop-chromium', 'web-chromium'].includes(testInfo.project.name),
      'Small-screen acceptance belongs to step 7.',
    );
  });

  test('critical state is recognizable within three seconds', async ({ page }, testInfo) => {
    await openCleanHome(page);
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('24');
    const readyMs = await page.evaluate(() => Math.round(performance.now()));
    expect(readyMs, `critical dashboard state became ready in ${readyMs}ms`).toBeLessThan(3000);

    await testInfo.attach('first-screen-timing.json', {
      body: JSON.stringify({
        project: testInfo.project.name,
        viewport: page.viewportSize(),
        criticalStateReadyMs: readyMs,
        thresholdMs: 3000,
        passed: readyMs < 3000,
      }, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({
      path: testInfo.outputPath('first-screen.png'),
      fullPage: false,
    });
  });

  test('every core action reaches its destination with one click', async ({ browser }, testInfo) => {
    const checks: Array<{
      index: number;
      id: string;
      verify: (page: import('@playwright/test').Page) => Promise<void>;
    }> = [
      {
        index: 0,
        id: 'new-chat',
        verify: async (page) => {
          await expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible();
          await expect(page.getByText('Working Directory:', { exact: true })).toBeVisible();
        },
      },
      {
        index: 1,
        id: 'new-loop',
        verify: async (page) => {
          await expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible();
          await expect(page.getByText(/Loop 策略与心智/)).toBeVisible();
        },
      },
      {
        index: 2,
        id: 'resume-work',
        verify: async (page) => {
          await expect(page.locator('.home-dashboard')).toBeHidden();
          await expect(page.getByText('loopexecute', { exact: true }).first()).toBeVisible();
        },
      },
      {
        index: 3,
        id: 'open-tasks',
        verify: async (page) => {
          await expect(page.locator('.home-dashboard')).toBeHidden();
          await expect(page.locator('[title="收起"]')).toBeVisible();
        },
      },
      {
        index: 4,
        id: 'manage-models',
        verify: async (page) => {
          await expect(page.getByRole('heading', { name: 'Backend Manager' })).toBeVisible();
        },
      },
    ];

    const results: Array<{ id: string; clicks: number; passed: boolean }> = [];
    for (const check of checks) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await openCleanHome(page);
      await page.locator('.home-action-grid button').nth(check.index).click();
      await check.verify(page);
      results.push({ id: check.id, clicks: 1, passed: true });
      await page.screenshot({
        path: testInfo.outputPath(`one-click-${check.id}.png`),
        fullPage: false,
      });
      await context.close();
    }
    await testInfo.attach('one-click-results.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
  });

  test('module customization survives a real reload', async ({ page }, testInfo) => {
    await openCleanHome(page);
    await page.locator('.home-sync button').nth(1).click();
    await expect(page.locator('.home-customizer')).toBeVisible();

    await page.locator('.home-density button').nth(1).click();
    await page.locator('.home-customizer-row').last().locator('input[type="checkbox"]').uncheck();
    await expect(page.locator('.home-dashboard')).toHaveClass(/density-compact/);
    await expect(page.locator('.home-module-activity')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('main', { name: '工作总览' })).toBeVisible();
    await expect(page.locator('.home-dashboard')).toHaveClass(/density-compact/);
    await expect(page.locator('.home-module-activity')).toHaveCount(0);
    const saved = await page.evaluate(() => localStorage.getItem('awu.home.preferences.v1'));
    expect(saved).toContain('"density":"compact"');
    expect(saved).toContain('"activity":false');

    await testInfo.attach('persisted-preferences.json', {
      body: saved || '',
      contentType: 'application/json',
    });
    await page.screenshot({
      path: testInfo.outputPath('customization-after-reload.png'),
      fullPage: false,
    });
  });

  test('an empty split layout mounts one global dashboard only', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('agent-with-u:layout', '2x2');
      localStorage.setItem('agent-with-u:pane-sessions', JSON.stringify([null, null, null, null]));
      localStorage.removeItem('awu.connectionTarget');
      localStorage.removeItem('awu.execRoster');
    });
    await page.goto('/');

    await expect(page.getByRole('main', { name: '工作总览' })).toHaveCount(1);
    await expect(page.locator('.home-dashboard')).toHaveCount(1);
    await expect(page.locator('.home-empty-pane')).toHaveCount(3);
  });

  test('real event, disconnect and reconnect update the dashboard', async ({ page, request }, testInfo) => {
    await openCleanHome(page);
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('24');

    const eventResponse = await request.get(`${CONTROL_URL}/event/task`);
    expect(eventResponse.ok()).toBeTruthy();
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('25');
    await expect(page.locator('.home-activity li')).not.toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('realtime-event.png'),
      fullPage: false,
    });

    const stopResponse = await request.get(`${CONTROL_URL}/backend/stop`);
    expect(stopResponse.ok()).toBeTruthy();
    await expect(page.locator('.home-banner')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: testInfo.outputPath('backend-disconnected.png'),
      fullPage: false,
    });

    const reconnectStartedAt = Date.now();
    const startResponse = await request.get(`${CONTROL_URL}/backend/start`);
    expect(startResponse.ok()).toBeTruthy();
    await expect(page.locator('.home-banner')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.home-status-item').first().locator('strong')).toContainText('已连接');
    const reconnectMs = Date.now() - reconnectStartedAt;
    await testInfo.attach('reconnect-timing.json', {
      body: JSON.stringify({ reconnectMs, recovered: true }, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({
      path: testInfo.outputPath('backend-reconnected.png'),
      fullPage: false,
    });

    const cleanupResponse = await request.get(`${CONTROL_URL}/event/task/remove`);
    expect(cleanupResponse.ok()).toBeTruthy();
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('24');
  });
});
