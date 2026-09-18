import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const skill = { id: 'manual-demo', name: 'manual-demo', content: '# Agent instructions', description: 'fixture' };
const original = '# 原始说明\n\n原始步骤不会被维护操作覆盖。\n\n<script>window.top.__unsafeManual=true</script>';
async function mockManuals(context: BrowserContext) {
  const requests: string[] = [];
  const asks: unknown[][] = [];
  let data = { status: 'ok', name: skill.name, hasManual: false, content: original, originalContent: original,
    originalPath: 'README.md', documents: ['README.md', 'SKILL.md'], revision: '', sourceHash: 'source', outdated: false, source: { repository: 'fixture/repo' } };
  await context.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      requests.push(frame.method);
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (/^(activateSkill|skillRuntimePrepare|skillMarketInstall|sendMessage)$/.test(frame.method)) throw new Error(`Unexpected execution: ${frame.method}`);
      if (frame.method === 'listSkills') return reply([skill]);
      if (frame.method === 'listPrompts') return reply([]);
      if (frame.method === 'listSkillManuals') return reply({ status: 'ok', manuals: [{ name: skill.name, hasManual: data.hasManual }] });
      if (frame.method === 'getSkillManual') return reply(data);
      if (frame.method === 'saveSkillManual') {
        if (frame.params[2] !== data.revision) return reply({ status: 'error', message: 'SKILL_MANUAL_CHANGED' });
        data = { ...data, content: frame.params[1], hasManual: true, revision: `r${data.revision}` };
        return reply(data);
      }
      if (frame.method === 'chatAsk') { asks.push(frame.params); return reply({ status: 'ok', turnId: 'manual-question' }); }
      server.send(message);
    });
  });
  return { requests, asks };
}
async function sidebar(page: Page) {
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
}
async function repo(page: Page) {
  await sidebar(page);
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /Skills 与 Prompts/ }).click();
  return page.locator('#workbench-panel-library');
}

test('Repo manuals are lazy, editable, isolated from source, and open as real independent windows', async ({ page, context }, info) => {
  const { requests } = await mockManuals(context);
  await page.goto('/');
  const library = await repo(page);
  await expect(library.getByText(skill.name, { exact: true })).toBeVisible();
  expect(requests.filter(name => name === 'getSkillManual')).toHaveLength(0);
  await library.getByRole('button', { name: '维护手册', exact: true }).click();
  const manual = page.getByRole('dialog', { name: 'Skill 使用手册' });
  await expect(manual).toContainText('尚未维护');
  await expect(manual.frameLocator('iframe').getByText('原始步骤不会被维护操作覆盖。')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__unsafeManual)).toBeUndefined();
  await manual.getByRole('button', { name: '维护手册', exact: true }).click();
  await manual.getByRole('textbox', { name: '使用手册 Markdown' }).fill('# 使用流程\n\n1. 安装 CLI\n2. 初始化项目\n3. 调用 apply\n\n## 常见报错\n缺少 CLI 时请自行安装。');
  await manual.getByRole('button', { name: '保存手册', exact: true }).click();
  await expect(manual).toContainText('手册已保存');
  await manual.getByRole('button', { name: '原始文档', exact: true }).click();
  await expect(manual.frameLocator('iframe').getByText('原始步骤不会被维护操作覆盖。')).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await manual.getByRole('button', { name: '独立窗口', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('dialog', { name: 'Skill 使用手册' })).toBeVisible();
  await expect(popup.frameLocator('iframe').getByRole('heading', { name: '使用流程' })).toBeVisible();
  expect(new URL(popup.url()).searchParams.get('skillExecKey')).toBe('local');
  await popup.screenshot({ path: info.outputPath('manual-independent.png') });
  // 两个窗口从同一版本开始；第二个保存后，第一个不能悄悄覆盖。
  const independent = popup.getByRole('dialog', { name: 'Skill 使用手册' });
  await independent.getByRole('button', { name: '维护手册', exact: true }).click();
  await independent.getByRole('textbox', { name: '使用手册 Markdown' }).fill('# 来自另一个窗口');
  await independent.getByRole('button', { name: '保存手册', exact: true }).click();
  await expect(independent).toContainText('手册已保存');
  await manual.getByRole('button', { name: '维护手册', exact: true }).click();
  await manual.getByRole('textbox', { name: '使用手册 Markdown' }).fill('冲突草稿不能丢');
  await manual.getByRole('button', { name: '保存手册', exact: true }).click();
  await expect(manual.getByRole('alert')).toContainText('SKILL_MANUAL_CHANGED');
  await expect(manual.getByRole('textbox', { name: '使用手册 Markdown' })).toHaveValue('冲突草稿不能丢');
  await popup.close();
});

test('Thoughts @SKILL selects knowledge, preserves focus for followups, and previews without executing', async ({ page, context }, info) => {
  const { requests, asks } = await mockManuals(context);
  await page.goto('/');
  await sidebar(page);
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  const thoughts = page.getByRole('complementary', { name: '俺寻思注意力助手' });
  const input = thoughts.locator('textarea').first();
  await input.fill('@SKILL');
  const picker = page.getByRole('listbox', { name: '引用 Skill 手册' });
  await expect(picker.getByRole('option').filter({ hasText: skill.name })).toBeVisible();
  const before = requests.filter(name => name === 'listSkillManuals').length;
  await input.fill('@SKILL:manual');
  await expect(picker).toBeVisible();
  expect(requests.filter(name => name === 'listSkillManuals')).toHaveLength(before);
  await picker.getByRole('option').filter({ hasText: skill.name }).click();
  await expect(input).toHaveValue(`@SKILL:${skill.name} `);
  expect(asks).toHaveLength(0);
  await input.fill(`@SKILL:${skill.name} 怎么开始？`);
  await input.press('Enter');
  await expect.poll(() => asks.length).toBe(1);
  expect(asks[0][1]).toContain(`@SKILL:${skill.name}`);
  expect(JSON.parse(String(asks[0][3])).kind).toBe('skills');
  await input.fill('下一步呢？');
  await input.press('Enter');
  await expect.poll(() => asks.length).toBe(2);
  expect(asks[1][1]).toContain(`@SKILL:${skill.name}`);
  const popupPromise = page.waitForEvent('popup');
  await thoughts.getByRole('button', { name: `📖 ${skill.name} ↗` }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('dialog', { name: 'Skill 使用手册' })).toBeVisible();
  await popup.close();
  await thoughts.getByRole('button', { name: '退出 Skill 关注' }).click();
  await expect(thoughts.getByRole('button', { name: `📖 ${skill.name} ↗` })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('manual-attention.png') });
});

test('scratchpad and thoughts browser detach open the correct page; blocked popup keeps original panel', async ({ page, context }) => {
  await mockManuals(context);
  await page.goto('/');
  await page.getByRole('button', { name: '打开便签本', exact: true }).click();
  let promise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '弹出独立窗口', exact: true }).click();
  let popup = await promise;
  await expect(popup.getByRole('button', { name: '新建便签', exact: true })).toBeVisible();
  expect(new URL(popup.url()).searchParams.has('scratchpad')).toBe(true);
  await popup.close();
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  const thoughts = page.getByRole('complementary', { name: '俺寻思注意力助手' });
  promise = page.waitForEvent('popup');
  await thoughts.getByRole('button', { name: /分离/ }).click();
  popup = await promise;
  await expect(popup.getByRole('complementary', { name: '俺寻思注意力助手' })).toBeVisible();
  expect(new URL(popup.url()).searchParams.has('thoughts')).toBe(true);
  await popup.close();
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  await expect(thoughts).toBeVisible();
  await page.evaluate(() => { window.open = () => null; });
  await thoughts.getByRole('button', { name: /分离/ }).click();
  await expect(thoughts).toBeVisible();
  await expect(page.getByText(/浏览器阻止了独立窗口/)).toBeVisible();
});
