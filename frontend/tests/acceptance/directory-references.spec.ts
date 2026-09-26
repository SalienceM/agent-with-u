import { test, expect, type Page } from '@playwright/test';

const tree: Record<string, { name: string; path: string; isDir: boolean }[]> = {
  '.': [
    { name: 'docs', path: 'docs', isDir: true },
    { name: 'src', path: 'src', isDir: true },
    { name: '需求 文档', path: '需求 文档', isDir: true },
    { name: 'README.md', path: 'README.md', isDir: false },
  ],
  src: [
    { name: 'components', path: 'src/components', isDir: true },
    { name: 'main.ts', path: 'src/main.ts', isDir: false },
  ],
  'src/components': [{ name: 'Button.tsx', path: 'src/components/Button.tsx', isDir: false }],
  docs: [], '需求 文档': [],
};

async function fixture(page: Page) {
  const sent: any[] = [];
  const requests: { method: string; params: any[] }[] = [];
  let hold = '';
  let release: (() => void) | undefined;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    server.onMessage(message => socket.send(message));
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      requests.push(frame);
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'listDirectory') {
        const dir = frame.params[0];
        const respond = () => reply(tree[dir] || { error: '目录不存在（测试）' });
        if (hold === dir) { hold = ''; release = respond; }
        else respond();
      } else if (frame.method === 'seqtaskGet') reply({ status: 'ok', seqTasks: [], seqAuto: false });
      else if (frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[0]);
        sent.push(payload);
        for (const type of ['text_delta', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
          sessionId: payload.sessionId, messageId: payload.messageId, type, text: type === 'text_delta' ? '已收到目录引用' : '',
        }) }));
      } else if (frame.method === 'chatAsk' || frame.method === 'loopAsk') reply({ status: 'error', message: '测试禁止调用模型' });
      else server.send(message);
    });
  });
  await page.goto('/');
  const sidebar = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  const input = pane.locator('.chat-textarea');
  await expect(input).toBeVisible();
  return { pane, input, sent, requests, hold: (dir: string) => { hold = dir; }, release: () => { release?.(); } };
}

test('name click and Enter select directories without browsing or sending, and send preserves the reference', async ({ page }) => {
  const f = await fixture(page);
  const picker = page.getByRole('dialog', { name: '引用文件或目录' });
  await f.input.fill('检查 @sr');
  await picker.getByRole('button', { name: '引用目录 src', exact: true }).click();
  await expect(f.input).toHaveValue('检查 @src/ ');
  await expect(f.input).toBeFocused();
  await expect(picker).toBeHidden();
  expect(f.sent).toHaveLength(0);
  expect(f.requests.filter(r => r.method === 'listDirectory').map(r => r.params[0])).toEqual(['.']);
  await f.input.fill('检查 @sr');
  await expect(picker.getByRole('button', { name: '引用目录 src', exact: true })).toBeVisible();
  await f.input.press('Enter');
  await expect(f.input).toHaveValue('检查 @src/ ');
  expect(f.sent).toHaveLength(0);
  await f.input.press('Enter');
  await expect.poll(() => f.sent.length).toBe(1);
  expect(f.sent[0].content).toBe('检查 @src/');
});

test('browsing keeps the selected level and supports nested, empty, root and space-containing directories', async ({ page }, info) => {
  const f = await fixture(page);
  const picker = page.getByRole('dialog', { name: '引用文件或目录' });
  await f.input.fill('@sr');
  await expect(picker.getByRole('button', { name: '进入目录 src', exact: true })).toBeVisible();
  await f.input.press('Tab');
  await expect(f.input).toHaveValue('@src/');
  await expect(picker.getByRole('button', { name: '引用目录 components', exact: true })).toBeVisible();
  await f.input.press('ArrowRight');
  await expect(f.input).toHaveValue('@src/components/');
  await expect(picker.getByRole('button', { name: '引用文件 Button.tsx', exact: true })).toBeVisible();
  await f.input.press('ArrowLeft');
  await expect(f.input).toHaveValue('@src/');
  await expect(picker.getByRole('button', { name: '引用当前目录', exact: true })).toBeEnabled();
  await f.input.press('Control+Enter');
  await expect(f.input).toHaveValue('@src/ ');
  await f.input.fill('@docs/');
  await expect(picker).toContainText('空目录');
  await f.input.press('Enter');
  await expect(f.input).toHaveValue('@docs/ ');
  await f.input.fill('@');
  await picker.getByRole('button', { name: '引用当前目录', exact: true }).click();
  await expect(f.input).toHaveValue('@./ ');
  await f.input.fill('@需求');
  await picker.getByRole('button', { name: '进入目录 需求 文档', exact: true }).click();
  await expect(f.input).toHaveValue('@需求\\ 文档/');
  await expect(picker).toContainText('空目录');
  await picker.getByRole('button', { name: '引用当前目录', exact: true }).click();
  await expect(f.input).toHaveValue('@需求\\ 文档/ ');
  await f.input.fill('@src/m');
  await picker.getByRole('button', { name: '引用文件 main.ts', exact: true }).click();
  await expect(f.input).toHaveValue('@src/main.ts ');
  await f.input.fill('@src/');
  await expect(picker.getByRole('button', { name: '进入目录 components', exact: true })).toBeVisible();
  const bounds = await picker.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath('directory-reference-picker.png'), fullPage: true });
  expect(f.sent).toHaveLength(0);
  expect(f.requests.filter(r => /syncReadFile|syncReadChunk|searchFiles/.test(r.method))).toHaveLength(0);
});

test('late listings cannot replace another directory or reopen after Escape; failures cannot be selected', async ({ page }) => {
  const f = await fixture(page);
  const picker = page.getByRole('dialog', { name: '引用文件或目录' });
  f.hold('src');
  await f.input.fill('@src/');
  await expect(picker).toContainText('正在读取目录');
  await f.input.fill('@docs/');
  await expect(picker).toContainText('空目录');
  f.release();
  await expect(picker.getByRole('button', { name: '引用目录 components', exact: true })).toHaveCount(0);
  f.hold('src');
  await f.input.fill('@src/');
  await expect(picker).toContainText('正在读取目录');
  await f.input.press('Escape');
  f.release();
  await expect(picker).toBeHidden();
  await expect(f.input).toHaveValue('@src/');
  await f.input.fill('@missing/');
  await expect(picker.getByRole('alert')).toContainText('目录不存在');
  await expect(picker.getByRole('button', { name: '引用当前目录', exact: true })).toBeDisabled();
  await f.input.press('Control+Enter');
  await expect(f.input).toHaveValue('@missing/');
  expect(f.sent).toHaveLength(0);
});

test('Thoughts uses the same directory selection, explicit browse and typed paths without invoking a model', async ({ page }, info) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  const thoughts = page.getByRole('complementary', { name: '俺寻思注意力助手' });
  const input = thoughts.locator('textarea').first();
  const picker = page.getByRole('listbox', { name: '引用工作区文件或目录' });
  await input.fill('@sr');
  await expect(picker.getByRole('option').filter({ hasText: 'src' })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('@src/ ');
  await input.fill('@sr');
  await picker.getByRole('button', { name: '进入目录 src', exact: true }).click();
  await expect(input).toHaveValue('@src/');
  await expect(picker.getByRole('button', { name: '进入目录 components', exact: true })).toBeVisible();
  await input.press('Control+Enter');
  await expect(input).toHaveValue('@src/ ');
  await input.fill('@docs/');
  await expect(picker).toContainText('空目录');
  await picker.getByRole('button', { name: '引用当前目录', exact: true }).click();
  await expect(input).toHaveValue('@docs/ ');
  await input.fill('@需求\\ 文档/');
  await expect(picker).toContainText('空目录');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('@需求\\ 文档/ ');
  await input.fill('@');
  await expect(picker.getByRole('button', { name: '引用当前目录', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('advanced-directory-reference-picker.png'), fullPage: true });
  expect(f.requests.filter(r => ['sendMessage', 'chatAsk', 'loopAsk'].includes(r.method))).toHaveLength(0);
});
