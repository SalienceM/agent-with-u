import { test, expect, type Locator, type Page } from '@playwright/test';

async function setup(page: Page, smallImageUrl?: string) {
  // 本地画布测试图，角落和边框帮助检查长图/横图是否完整，无外部图片请求。
  const images = await page.evaluate(() => {
    const make = (width: number, height: number) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#dae7f3'; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#08385c'; ctx.lineWidth = 12; ctx.strokeRect(6, 6, width - 12, height - 12);
      ctx.fillStyle = '#ff6347'; ctx.fillRect(12, 12, 70, 70);
      ctx.fillStyle = '#168b55'; ctx.fillRect(width - 82, height - 82, 70, 70);
      for (let y = 150; y < height - 100; y += 200) { ctx.fillStyle = '#9bb8d0'; ctx.fillRect(30, y, width - 60, 50); }
      return canvas.toDataURL('image/png');
    };
    return { tall: make(800, 4000), wide: make(4000, 800), small: make(120, 100) };
  });
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    const loads = new Set<unknown>();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'loadSession') loads.add(frame.id);
      server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (loads.delete(frame.id)) {
        const session = JSON.parse(frame.result);
        session.messages = [
          { id: 'preview-tall', role: 'user', content: '预览长图', images: [images.tall], timestamp: 1785000000 },
          { id: 'preview-small', role: 'user', content: '预览小图', images: [smallImageUrl || images.small], timestamp: 1785000001 },
          { id: 'preview-wide', role: 'assistant', content: `![测试横图](${images.wide})`, timestamp: 1785000002 },
        ];
        session.messagesTotal = session.messages.length;
        frame.result = JSON.stringify(session); socket.send(JSON.stringify(frame));
      } else socket.send(message);
    });
  });
  await page.goto('/');
  const sidebar = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  await expect(pane.getByAltText('attachment').first()).toBeVisible();
  return { pane, images, dialog: page.getByRole('dialog', { name: '图片预览', exact: true }) };
}

async function expectFit(dialog: Locator, page: Page) {
  const img = dialog.getByAltText('预览原图');
  await expect(img).toBeVisible();
  await expect.poll(async () => {
    const box = (await img.boundingBox())!;
    const stage = (await dialog.getByTestId('image-preview-stage').boundingBox())!;
    const viewport = page.viewportSize()!;
    return Math.max(Math.abs(box.x + box.width / 2 - viewport.width / 2),
      Math.abs(box.y + box.height / 2 - viewport.height / 2),
      stage.x - box.x, stage.y - box.y,
      box.x + box.width - stage.x - stage.width, box.y + box.height - stage.y - stage.height);
  }).toBeLessThan(2);
}

test('message and markdown images are viewport-centered and fully fitted despite transformed/clipped ancestors', async ({ page }, info) => {
  const { pane, dialog } = await setup(page);
  await pane.evaluate(node => { const el = node as HTMLElement; el.style.transform = 'translateY(22px)'; el.style.contain = 'paint'; el.style.overflow = 'hidden'; });
  await pane.getByAltText('attachment').first().click();
  await expectFit(dialog, page);
  expect(await dialog.evaluate(node => node.closest('[data-session-tab-panel]'))).toBeNull();
  await page.screenshot({ path: info.outputPath('image-tall-fit.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭图片预览' }).click();
  await pane.getByAltText('测试横图').click();
  await expectFit(dialog, page);
  await page.screenshot({ path: info.outputPath('image-wide-fit.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await pane.getByAltText('attachment').nth(1).click();
  await expectFit(dialog, page);
  await expect(dialog.getByLabel('图片缩放比例')).toHaveText('100%');
});

test('wheel zoom is continuous, dragging exposes cropped content, fit resets and Escape restores focus', async ({ page }) => {
  const { pane, dialog } = await setup(page);
  await pane.locator('.chat-textarea').focus();
  await pane.getByAltText('attachment').first().click();
  await expectFit(dialog, page);
  const image = dialog.getByAltText('预览原图');
  const stage = dialog.getByTestId('image-preview-stage');
  await dialog.getByRole('button', { name: '原始尺寸' }).click();
  await expect(dialog.getByLabel('图片缩放比例')).toHaveText('100%');
  const bounds = (await stage.boundingBox())!;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const before = (await image.boundingBox())!;
  await page.mouse.move(center.x, center.y); await page.mouse.wheel(0, -1);
  await expect.poll(async () => (await image.boundingBox())!.height).toBeGreaterThan(before.height);
  const zoomed = (await image.boundingBox())!;
  expect(zoomed.height).toBeLessThan(before.height * 1.01); // 小滚轮增量，不是固定几档。
  await page.mouse.down(); await page.mouse.move(center.x, center.y - 90, { steps: 5 }); await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect((await image.boundingBox())!.y).toBeLessThan(zoomed.y - 80);
  await dialog.getByRole('button', { name: '适应窗口' }).click();
  await expectFit(dialog, page);
  await image.dblclick();
  await expect(dialog.getByLabel('图片缩放比例')).toHaveText('100%');
  await image.dblclick();
  await expectFit(dialog, page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(pane.getByRole('button', { name: '预览附件图片 1' }).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expectFit(dialog, page);
});

test('composer preview shares fitting, remains complete after resize and disappears with its Session', async ({ page }) => {
  const { pane, images, dialog } = await setup(page);
  await pane.locator('input[type="file"]').setInputFiles({ name: 'long.png', mimeType: 'image/png', buffer: Buffer.from(images.tall.split(',')[1], 'base64') });
  await pane.locator('.awu-composer').evaluate(node => { const el = node as HTMLElement; el.style.transform = 'translateY(-4px)'; el.style.overflow = 'hidden'; });
  await pane.getByAltText('Pasted').click();
  await expectFit(dialog, page);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  await expectFit(dialog, page);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '缩小图片' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '关闭图片预览' })).toBeFocused();
  // 保活 Tab 由外部导航切走时，Portal 和文档级监听也必须离开。
  await page.getByRole('button', { name: '返回工作总览', exact: true }).evaluate(node => (node as HTMLElement).click());
  await expect(dialog).toHaveCount(0);
});

test('a failed original shows retry and can recover to a complete fitted image', async ({ page }) => {
  let recoveredImage = '';
  await page.route('**/preview-retry.png', route => recoveredImage
    ? route.fulfill({ contentType: 'image/png', body: Buffer.from(recoveredImage.split(',')[1], 'base64') })
    : route.abort());
  const { pane, images, dialog } = await setup(page, '/preview-retry.png');
  await pane.getByRole('button', { name: '预览附件图片 1' }).nth(1).click();
  await expect(dialog.getByRole('alert')).toContainText('图片加载失败');
  await expect(dialog.getByRole('button', { name: '放大图片' })).toBeDisabled();
  recoveredImage = images.wide;
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expectFit(dialog, page);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('touch pinch zooms smoothly and lifting two fingers does not dismiss the viewer', async ({ page, context }, info) => {
  test.skip(!info.project.use.hasTouch, '触屏项目验证原生双指 Pointer Events');
  const { pane, dialog } = await setup(page);
  await pane.getByAltText('attachment').first().click();
  await expectFit(dialog, page);
  const image = dialog.getByAltText('预览原图');
  const before = (await image.boundingBox())!;
  const box = (await dialog.getByTestId('image-preview-stage').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  const touches = (distance: number) => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(30) });
  for (const distance of [40, 50, 65, 80]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(distance) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(dialog).toBeVisible();
  expect((await image.boundingBox())!.height).toBeGreaterThan(before.height * 2);
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await dialog.getByRole('button', { name: '适应窗口' }).click();
  await expectFit(dialog, page);
});
