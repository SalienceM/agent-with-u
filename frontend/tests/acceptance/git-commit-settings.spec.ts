import { test, expect, type Page } from '@playwright/test';

const builtin = { mode: 'builtin', prompt: '', promptName: '', signature: true };
const defaultPrompt = '根据实际变更生成中文提交说明。\n- 标题概括行为变化。\n- 不编造测试结果。\n- 不逐个罗列文件名。';
const libraryPrompt = '按用户可见行为分组，说明兼容性影响。';

async function fixture(page: Page) {
  let revision = 0;
  const settings: Record<string, any> = {};
  const calls: { method: string; params: any[] }[] = [];
  let failSave = false;
  const resolve = (rule: any) => rule.mode === 'library' ? libraryPrompt : rule.mode === 'custom' ? rule.prompt : defaultPrompt;
  const state = (root: string) => {
    const inherited = root ? settings[''] || builtin : builtin;
    const effective = settings[root] || inherited;
    return { status: 'ok', root, revision: String(revision), setting: settings[root] || null, effective,
      inherited, inheritedPrompt: resolve(inherited), source: root && settings[root] ? 'project' : settings[''] ? 'default' : 'builtin',
      prompt: resolve(effective), resolutionError: '', defaultPrompt };
  };
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      calls.push(frame);
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (/^(gitStage|gitCommit|gitPush|gitGenerateCommitMessage|sendMessage)$/.test(frame.method)) throw new Error(`Settings must not execute ${frame.method}`);
      if (frame.method === 'listPrompts') return reply([{ name: '团队提交规范', content: libraryPrompt }]);
      if (frame.method === 'gitCommitSettingsGet') return reply(state(frame.params[0]));
      if (frame.method === 'gitCommitSettingsSave') {
        if (failSave) return reply({ status: 'error', message: '配置已被其他窗口修改，请重新加载后再保存' });
        expect(frame.params[2]).toBe(String(revision));
        settings[frame.params[0]] = JSON.parse(frame.params[1]);
        revision++;
        return reply(state(frame.params[0]));
      }
      if (frame.method === 'gitCommitPromptPreview') return reply({ status: 'ok', constraints: state(frame.params[0]).prompt,
        content: 'file.txt: staged change + working change', source: state(frame.params[0]).source,
        warnings: ['large.txt 的 diff 已截断，未展示部分未经核验'], fileCount: 2, scope: frame.params[1] ? 'staged' : 'working-tree-vs-HEAD' });
      server.send(raw);
    });
  });
  await page.goto('/');
  return { calls, settings, setFailSave: (value: boolean) => { failSave = value; } };
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /^用户与设置：/ }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /Git 提交/ }).click();
  const panel = page.getByRole('region', { name: 'Git 提交生成规则' });
  await expect(panel.getByLabel('生成规则来源', { exact: true })).toBeVisible();
  return panel;
}

test('settings bind library/default/project rules and preview without model, staging or commit', async ({ page }, info) => {
  const { calls, settings } = await fixture(page);
  const panel = await openSettings(page);
  const source = panel.getByLabel('生成规则来源', { exact: true });
  const editor = panel.getByLabel('提交规则正文', { exact: true });
  const save = panel.getByRole('button', { name: '保存生成规则', exact: true });
  await expect(save).toBeDisabled();
  await source.selectOption('library');
  await panel.getByLabel('提交 Prompt 模板', { exact: true }).selectOption('团队提交规范');
  await expect(editor).toHaveValue(libraryPrompt);
  await expect(editor).toHaveAttribute('readonly', '');
  await save.click();
  await expect(panel).toContainText('已保存到所选执行端');
  expect(settings[''].promptName).toBe('团队提交规范');
  const projects = panel.getByLabel('提交规则项目', { exact: true });
  const project = await projects.locator('option').nth(1).getAttribute('value');
  await projects.selectOption(project!);
  await panel.getByLabel('提交规则范围', { exact: true }).selectOption('project');
  await expect(source).toHaveValue('inherit');
  await expect(editor).toHaveValue(libraryPrompt);
  await source.selectOption('custom');
  await editor.fill('项目只描述行为变化，不写未执行的测试。');
  await panel.getByRole('checkbox', { name: /末尾添加 By AgentWithU/ }).uncheck();
  await save.click();
  await expect(panel).toContainText('已保存到所选执行端');
  expect(settings[project!].signature).toBe(false);
  await panel.getByRole('button', { name: '预览实际输入（不调用 AI）', exact: true }).click();
  await expect(panel.getByLabel('提交提示词预览', { exact: true })).toContainText('项目只描述行为变化');
  await expect(panel).toContainText('staged change + working change');
  await expect(panel).toContainText('已截断');
  await source.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('git-commit-settings.png') });
  await panel.getByRole('button', { name: '恢复继承默认', exact: true }).click();
  await expect(editor).toHaveValue(libraryPrompt);
  await save.click();
  await expect(save).toBeDisabled();
  expect(settings[project!]).toBeNull();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: /^用户与设置：/ }).click();
  await expect(page.getByLabel('生成规则来源', { exact: true })).toHaveValue('library');
  expect(calls.filter(item => item.method === 'gitCommitPromptPreview')).toHaveLength(1);
});

test('dirty rules survive cancelled navigation and failed save; reload requires confirmation', async ({ page }) => {
  const fixtureState = await fixture(page);
  const panel = await openSettings(page);
  await panel.getByLabel('生成规则来源', { exact: true }).selectOption('custom');
  const editor = panel.getByLabel('提交规则正文', { exact: true });
  await editor.fill('不能丢失的规则草稿');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(editor).toHaveValue('不能丢失的规则草稿');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /常规/ }).click();
  await expect(editor).toHaveValue('不能丢失的规则草稿');
  fixtureState.setFailSave(true);
  await panel.getByRole('button', { name: '保存生成规则', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('其他窗口修改');
  await expect(editor).toHaveValue('不能丢失的规则草稿');
  await expect(panel.getByRole('button', { name: '预览实际输入（不调用 AI）', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(editor).toHaveValue(defaultPrompt);
  await expect(panel.getByRole('button', { name: '保存生成规则', exact: true })).toBeDisabled();
});
