import { expect, test } from '@playwright/test';

test('isolated fixture reaches the real dashboard data chain', async ({ page }, testInfo) => {
  const stress = process.env.HOME_QA_PROFILE === 'stress';
  await page.addInitScript(() => {
    localStorage.removeItem('agent-with-u:pane-sessions');
    localStorage.removeItem('awu.connectionTarget');
    localStorage.removeItem('awu.execRoster');
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '工作总览' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '工作总览' })).toBeVisible();
  await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText(stress ? '2280' : '24');
  await expect(page.locator('.home-loops .home-list-row')).toHaveCount(stress ? 6 : 4);
  await expect(page.locator('.home-card')).not.toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath('fixture-dashboard.png'),
    fullPage: true,
  });
});
