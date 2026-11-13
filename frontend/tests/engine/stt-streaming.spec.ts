import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
      :root{--theme-text:#273244;--theme-text-muted:#687487;--theme-bg:#fff;--theme-border:#dce1e8;--theme-accent:#4b82f0;--theme-bg-secondary:#f7f9fc}
      *{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#f7f9fc}main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;padding:12px;height:100vh}
      .fixture-pane{flex-direction:column;min-width:0;min-height:0;position:relative;border:1px solid #dce1e8;border-radius:12px;background:#fff;overflow:hidden}
      @media(max-width:650px){main{display:block;padding:0}.fixture-pane{height:100%}.fixture-pane[aria-label=idle]{display:none!important}}
      </style></head><body><div id="root"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>` });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => { const path = '/tests/engine/stt-harness.tsx'; (await import(/* @vite-ignore */ path)).mountSttFixture(); });
}
const pane = (page: Page) => page.getByRole('region', { name: 'speaking', exact: true });
const transcript = (page: Page) => pane(page).getByRole('region', { name: '转写全文', exact: true });
async function start(page: Page) {
  await pane(page).getByRole('button', { name: '开始实时语音输入' }).click();
  await expect(pane(page).getByText('正在聆听', { exact: true })).toBeVisible();
}
async function emit(page: Page, text: string) { await page.evaluate(text => (window as any).sttFixture.text(text), text); }
const apply = (page: Page) => pane(page).getByRole('button', { name: '应用到输入框' });
const stop = (page: Page) => pane(page).getByRole('button', { name: '停止录音', exact: true }).click();

test('native capture reports silence separately from missing recognition and allows choosing the actual microphone', async ({ page }) => {
  await mount(page); await start(page);
  expect(await page.evaluate(() => (window as any).sttFixture.contextOptions)).toEqual([{ latencyHint: 'interactive' }]);
  await expect(pane(page).getByText('麦克风 · 测试麦克风')).toBeVisible();
  await page.evaluate(() => (window as any).sttFixture.pcm(0, 40));
  await expect(pane(page).getByText('麦克风声音过低，请检查所选设备或输入音量。')).toBeVisible();
  await page.evaluate(() => (window as any).sttFixture.pcm(4000, 50));
  await expect(pane(page).getByText('已采到音频，实时识别尚未返回文字。')).toBeVisible();
  await expect(pane(page).getByRole('meter', { name: '麦克风输入音量' })).not.toHaveAttribute('aria-valuenow', '0');
  await emit(page, '开始出现实时文字');
  await expect(transcript(page)).toHaveText('开始出现实时文字');
  await stop(page);
  await pane(page).getByLabel('语音输入麦克风').selectOption('mic-2');
  await pane(page).getByRole('button', { name: '继续录音' }).click();
  await expect(pane(page).getByText('正在聆听', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).sttFixture.audioRequests[1].audio.deviceId)).toEqual({ exact: 'mic-2' });
});

test('partials stage independently; Apply appends once to the current draft without sending', async ({ page }) => {
  await mount(page);
  await pane(page).locator('textarea').fill('原来的草稿'); await start(page);
  await emit(page, '正在说'); await expect(transcript(page)).toHaveText('正在说');
  await emit(page, '正在说话，文字实时显示'); await expect(transcript(page)).toHaveText('正在说话，文字实时显示');
  await expect(pane(page).locator('textarea')).toHaveValue('原来的草稿');
  await expect(apply(page)).toBeDisabled();
  await pane(page).locator('textarea').fill('录音期间编辑了草稿'); await stop(page);
  await expect(transcript(page)).toHaveText('最终识别结果');
  await expect(pane(page).locator('textarea')).toHaveValue('录音期间编辑了草稿');
  await apply(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(pane(page).locator('textarea')).toHaveValue('录音期间编辑了草稿\n最终识别结果');
  await expect(transcript(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'idle', exact: true }).locator('textarea')).toHaveValue('');
  expect(await page.evaluate(() => (window as any).sttFixture.sends)).toEqual([]);
});

test('disconnect retries are bounded, accumulate text and never start idle composers', async ({ page }) => {
  await mount(page); await expect(pane(page).locator('textarea')).toBeVisible();
  await page.evaluate(() => (window as any).sttFixture.end());
  expect(await page.evaluate(() => (window as any).sttFixture.starts)).toEqual([]);
  await start(page); await emit(page, '第一段');
  await page.evaluate(() => (window as any).sttFixture.end());
  await expect.poll(() => page.evaluate(() => (window as any).sttFixture.starts.length)).toBe(2);
  await expect(pane(page).getByText('正在聆听', { exact: true })).toBeVisible();
  await emit(page, '第二段'); await expect(transcript(page)).toHaveText('第一段\n第二段');
  await page.evaluate(() => { (window as any).sttFixture.result = ''; (window as any).sttFixture.end(); });
  await expect.poll(() => page.evaluate(() => (window as any).sttFixture.starts.length)).toBe(3);
  await expect(pane(page).getByText('正在聆听', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).sttFixture.end());
  await expect(pane(page).getByText(/实时语音重连仍未恢复/)).toBeVisible();
  await expect(apply(page)).toBeEnabled(); await expect(transcript(page)).toHaveText('第一段\n第二段');
  await expect(pane(page).locator('textarea')).toHaveValue('');
  expect(await page.evaluate(() => (window as any).sttFixture.starts)).toEqual(['speaking', 'speaking', 'speaking']);
});

test('long speech scrolls independently and preserves reading position on corrections', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await mount(page); await start(page);
  const long = Array.from({ length: 65 }, (_, i) => `第 ${i + 1} 段：把想法完整地说出来，转写在独立面板内持续更新。`).join('\n\n');
  await emit(page, long);
  const scroll = transcript(page);
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  const initial = await scroll.evaluate(el => ({ height: el.clientHeight, total: el.scrollHeight, remaining: el.scrollHeight - el.scrollTop - el.clientHeight }));
  expect(initial.total).toBeGreaterThan(initial.height); expect(initial.height).toBeLessThan(460); expect(initial.remaining).toBeLessThan(3);
  await scroll.evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')); });
  await expect(pane(page).getByRole('button', { name: '↓ 回到最新' })).toBeVisible();
  await emit(page, long + '\n\n新补充的内容'); expect(await scroll.evaluate(el => el.scrollTop)).toBe(100);
  await page.screenshot({ path: '../.qa/stt/dictation-desktop.png' });
  await pane(page).getByRole('button', { name: '↓ 回到最新' }).click();
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3);
  await expect(pane(page).locator('textarea')).toHaveValue('');
});

test('finalization disables Apply; collapse, continue and discard retain the draft', async ({ page }) => {
  await mount(page); await start(page); await emit(page, '第一段');
  await page.evaluate(() => { const f = (window as any).sttFixture; f.holdStop = true; f.result = '第一段精校'; });
  await pane(page).getByRole('button', { name: '停止实时语音输入', exact: true }).click(); await expect(apply(page)).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).sttFixture.stops.length)).toBe(1);
  await page.evaluate(() => (window as any).sttFixture.finishStop()); await expect(transcript(page)).toHaveText('第一段精校');
  await pane(page).getByRole('button', { name: '收起语音面板' }).click(); await expect(transcript(page)).toHaveCount(0);
  await pane(page).getByRole('button', { name: '查看语音转写' }).click(); await expect(transcript(page)).toHaveText('第一段精校');
  await page.addStyleTag({ content: ':root{--theme-bg:#1a1d24;--theme-panel-solid:#212630;--theme-text:#edf1f7;--theme-text-muted:#a3aec0;--theme-border:#394251;--theme-bg-secondary:#282f3b;--theme-bg-tertiary:#303947}' });
  await page.screenshot({ path: '../.qa/stt/dictation-ready-dark.png' });
  await pane(page).getByRole('button', { name: '继续录音' }).click();
  await expect(pane(page).getByText('正在聆听', { exact: true })).toBeVisible();
  await emit(page, '第二段'); await expect(transcript(page)).toHaveText('第一段精校\n第二段');
  await page.evaluate(() => { const f = (window as any).sttFixture; f.holdStop = false; f.result = ''; f.stopError = '最终识别暂时不可用'; });
  await stop(page); await expect(pane(page).getByRole('button', { name: '放弃', exact: true })).toBeVisible();
  await expect(transcript(page)).toHaveText('第一段精校\n第二段');
  await pane(page).getByRole('button', { name: '放弃', exact: true }).click();
  await expect(transcript(page)).toHaveCount(0); await expect(pane(page).locator('textarea')).toHaveValue('');
});

test('Session switch retains staged text and ignores late results in the new Session', async ({ page }) => {
  await mount(page); await start(page); await emit(page, '属于原会话的文字');
  await page.evaluate(() => { const f = (window as any).sttFixture; f.holdStop = true; f.switchSession('another'); });
  await expect.poll(() => page.evaluate(() => (window as any).sttFixture.stops.length)).toBe(1);
  await expect(transcript(page)).toHaveCount(0); await emit(page, '迟到事件');
  await page.evaluate(() => (window as any).sttFixture.finishStop());
  await expect(pane(page).locator('textarea')).toHaveValue(''); await expect(transcript(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).sttFixture.switchSession('speaking'));
  await expect(transcript(page)).toHaveText('属于原会话的文字'); await expect(apply(page)).toBeEnabled();
});

test('stopping during connection closes a late start once and releases the microphone', async ({ page }) => {
  await mount(page); await page.evaluate(() => (window as any).sttFixture.holdStart = true);
  await pane(page).getByRole('button', { name: '开始实时语音输入' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).sttFixture.starts.length)).toBe(1);
  await stop(page); await page.evaluate(() => (window as any).sttFixture.finishStart());
  await expect(apply(page)).toBeEnabled();
  expect(await page.evaluate(() => (window as any).sttFixture.stops)).toEqual(['speaking']);
  expect(await page.evaluate(() => (window as any).sttFixture.tracksStopped)).toBe(1);
});

test('large applied speech becomes one attachment, retaining the current draft and existing blocks', async ({ page }) => {
  await mount(page); const textarea = pane(page).locator('textarea');
  await textarea.fill('已有附件内容'.repeat(1300)); await expect(pane(page).getByText(/\.txt$/).first()).toBeVisible();
  await textarea.fill('当前草稿'); await start(page);
  const long = '这是完整的长篇语音内容。'.repeat(650); await emit(page, long);
  await page.evaluate(text => (window as any).sttFixture.result = text, long); await stop(page);
  await expect(apply(page)).toBeEnabled(); await apply(page).click();
  await expect(pane(page).getByText(/voice-transcript-.*\.txt/)).toHaveCount(1); await expect(textarea).toHaveValue(/当前草稿/);
  const draft = await page.evaluate(async () => {
    const path = '/src/utils/composerDrafts.ts'; const { composerDrafts } = await import(/* @vite-ignore */ path);
    const apiPath = '/src/api.ts'; const { harnessImageScope } = await import(/* @vite-ignore */ apiPath);
    return composerDrafts.get(`stt-fixture:speaking:${harnessImageScope('speaking', 'local').key}`);
  });
  expect(draft.textAttachments).toHaveLength(2); expect(draft.textAttachments[1].content).toBe(long);
});

test('narrow viewport bounds panel and controls to its pane; hiding stops capture', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mount(page); await start(page);
  await emit(page, '把长段想法放在独立区域里。\n\n'.repeat(60));
  const box = await pane(page).getByRole('region', { name: '语音转写', exact: true }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThan((await pane(page).locator('.awu-composer').boundingBox())!.y);
  await expect(pane(page).getByRole('button', { name: '停止录音', exact: true })).toBeInViewport();
  await page.screenshot({ path: '../.qa/stt/dictation-narrow.png' });
  await page.evaluate(() => (window as any).sttFixture.visible(false));
  await expect(page.getByRole('region', { name: '语音转写', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).sttFixture.stops.length)).toBe(1);
  await page.evaluate(() => (window as any).sttFixture.visible(true)); await expect(transcript(page)).toHaveText('最终识别结果');
});
