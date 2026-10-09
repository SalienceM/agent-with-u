import { expect, type Locator, type Page } from '@playwright/test';

export async function openSessionMenu(page: Page, pane: Locator, keyboard = false) {
  const menu = page.getByRole('dialog', { name: '当前会话菜单', exact: true });
  if (await menu.isVisible()) return menu;
  if (await pane.locator('.awu-session-workbench').getAttribute('data-view-mode') === 'engine') {
    await pane.getByRole('button', { name: '当前会话菜单', exact: true }).click();
  } else {
    const sid = await pane.getAttribute('data-session-tab-panel');
    const tab = page.locator(`[id="workbench-tab-session:${sid}"]`);
    if (keyboard) { await tab.focus(); await tab.press('Shift+F10'); }
    else await tab.click({ button: 'right' });
  }
  await expect(menu).toBeVisible();
  return menu;
}

export async function selectMode(page: Page, pane: Locator, mode: 'Chat' | 'Engine') {
  const menu = await openSessionMenu(page, pane);
  await menu.getByRole('menuitemradio', { name: new RegExp(`^${mode} ·`) }).click();
}

// 预置已下载夹具，不接触 OS 用户目录；真实下载操作另有端到端用例。
export async function seedLocalCopy(page: Page, session: string, files: Record<string, string>) {
  await page.evaluate(async ({ session, files }) => {
    const { useManagedLocalDir } = await import('/src/utils/dirSync.ts');
    const fs = await useManagedLocalDir(session);
    for (const [name, text] of Object.entries(files)) await fs.writeBlob!(name, new Blob([text]));
  }, { session, files });
}

export async function expectTreeFillsColumn(pane: Locator) {
  const tree = pane.getByRole('complementary', { name: 'Engine 文件目录' });
  await expect.poll(async () => {
    const outer = (await tree.boundingBox())!, inner = (await tree.locator('.ftp-panel').boundingBox())!;
    return Math.abs(outer.width - inner.width);
  }).toBeLessThanOrEqual(2);
}
