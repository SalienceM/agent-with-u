import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const parentId = 'repo.0123456789abcdef';
const members = ['apply-change', 'verify-change', 'archive-change', 'explore-change'];
const session = { id: 'group-binding-qa', title: '父级绑定回归', messageCount: 0, updatedAt: 1, workingDir: 'C:/isolated-session',
  backendId: 'qa-backend', sessionType: 'normal', abilities: { skills: ['apply-change', 'unrelated'], prompts: [] } };
const otherSession = { ...session, id: 'another-project', title: '另一个项目', workingDir: 'C:/other-project' };

async function fixtures(context: BrowserContext, layout = false) {
  let parent = { id: parentId, name: 'OpenSpec', repository: 'example/OpenSpec', revision: 'r1' };
  let bound = { ...session, abilities: { ...session.abilities } };
  let defaults = false;
  let failSave = false;
  const requests: string[] = [];
  const asks: any[][] = [];
  const bindingSaves: any[][] = [];
  const renames: any[][] = [];
  const histories: Record<string, any[]> = {
    [session.id]: [
      { id: 'old-project', question: '当前项目需要兼容旧接口', answer: '保留既有接口', status: 'done', contextKey: 'session', contextKind: 'session' },
      { id: 'old-manual', question: `@SKILL:${parentId} 之前的手册问题`, answer: '旧手册答疑内容', status: 'done', contextKey: `skills:${parentId}`, contextKind: 'skills', contextLabel: 'Skill 手册 · OpenSpec' },
    ], [otherSession.id]: [],
  };
  await context.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      requests.push(frame.method);
      const reply = (value: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (['activateSkill', 'skillMarketInstall', 'skillRuntimePrepare', 'sendMessage'].includes(frame.method)) throw new Error(`Unexpected execution: ${frame.method}`);
      if (frame.method === 'listSessions') return reply([bound, otherSession]);
      if (frame.method === 'loadSessionMeta') return reply(frame.params[0] === otherSession.id ? otherSession : bound);
      if (frame.method === 'loadSession') return reply({ ...(frame.params[0] === otherSession.id ? otherSession : bound), messages: [] });
      if (frame.method === 'chatAsideList') return reply({ status: 'ok', asides: histories[frame.params[0]] || [], asideBackendId: '' });
      if (frame.method === 'readClipboardImage') return reply(null);
      if (frame.method === 'assetPush') return reply({ ok: true });
      if (frame.method === 'listSkills') return reply([...members.map(name => ({ name, content: `# ${name}`, parent, isDefault: defaults })),
        ...(layout ? [
          { name: 'football-search', description: '搜索足球录像、集锦与直播资源', hasCallPy: true, isDefault: true, hasSecretsSchema: true },
          { name: 'generate-image', description: '根据文字描述生成图片', isDefault: true },
          { name: 'ppt-master', parent: { id: 'repo.1123456789abcdef', name: 'ppt-master', repository: 'example/ppt-master', revision: 'p1' } },
          { name: 'web-fetch', description: '获取网页的正文内容', isDefault: true },
          { name: 'web-search', description: '搜索网页与最新资料', isDefault: true },
          { name: 'a-very-long-skill-name-that-must-never-push-the-library-outside-the-window', description: 'Long unbroken descriptions must also stay within the available row width.' },
        ] : [{ name: 'unrelated', content: '# Unrelated' }])]);
      if (frame.method === 'listPrompts') return reply(layout ? [{ name: '代码审阅', content: 'Review changes', icon: '📝', isDefault: true }] : []);
      if (frame.method === 'updateSessionAbilities') {
        bindingSaves.push(frame.params);
        if (failSave) return reply({ status: 'error', message: '模拟绑定失败' });
        bound = { ...bound, abilities: JSON.parse(frame.params[1]) };
        return reply({ status: 'ok' });
      }
      if (frame.method === 'renameSkillGroup') {
        renames.push(frame.params);
        parent = { ...parent, name: frame.params[1], revision: 'r2' };
        return reply({ status: 'ok', group: parent });
      }
      if (frame.method === 'setSkillGroupDefault') { expect(frame.params[0]).toBe(parentId); defaults = frame.params[1]; return reply({ status: 'ok' }); }
      if (frame.method === 'listSkillManuals') return reply({ status: 'ok', manuals: [{ name: parentId, displayName: parent.name, kind: 'parent', hasManual: false,
        repository: parent.repository, children: members.map(name => ({ name, hasManual: false })) }] });
      if (frame.method === 'getSkillManual') return reply({ status: 'ok', name: parentId, displayName: parent.name, kind: 'parent', children: members,
        hasManual: false, content: members.map(name => `## ${name}\nGuide for ${name}`).join('\n'), originalContent: members.map(name => `## ${name}\nOriginal ${name}`).join('\n'),
        originalPath: '子 Skill 资料汇总', documents: ['子 Skill 资料汇总'], revision: '', sourceHash: 'hash', outdated: false, source: { repository: parent.repository } });
      if (frame.method === 'chatAsk') {
        asks.push(frame.params);
        const attention = JSON.parse(frame.params[3]);
        const turn = { id: `parent-question-${asks.length}`, question: frame.params[1], answer: '结合当前项目给出的建议', status: 'done',
          contextKey: attention.key, contextKind: attention.kind, contextLabel: attention.label };
        histories[frame.params[0]].push(turn);
        reply({ status: 'ok', turnId: turn.id });
        socket.send(JSON.stringify({ event: 'chatAsideUpdated', data: JSON.stringify({ sessionId: frame.params[0], asides: histories[frame.params[0]] }) }));
        return;
      }
      server.send(message);
    });
  });
  return { requests, asks, bindingSaves, renames, bound: () => bound, fail: (value: boolean) => { failSave = value; } };
}

async function sidebar(page: Page) {
  await expect(page.getByRole('button', { name: '返回工作总览', exact: true })).toBeVisible();
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
}

test('binding defaults to parent, preserves partial legacy state and supports child-only atomically', async ({ page, context }, info) => {
  const fixture = await fixtures(context);
  await page.goto('/');
  await sidebar(page);
  await page.locator('.awu-sidebar').getByText(session.title, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /绑定能力/ }).click();
  const dialog = page.getByRole('dialog', { name: '绑定能力', exact: true });
  const group = dialog.getByRole('region', { name: '仓库 OpenSpec', exact: true });
  await expect(group).toContainText('1/4 已启用');
  await expect(group.getByRole('checkbox', { name: 'OpenSpec', exact: true })).toHaveAttribute('aria-checked', 'mixed');
  await expect(group.getByRole('checkbox', { name: members[1], exact: true })).not.toBeVisible();
  fixture.fail(true);
  await group.getByRole('checkbox', { name: 'OpenSpec', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('模拟绑定失败');
  await expect(group).toContainText('1/4 已启用');
  fixture.fail(false);
  await group.getByRole('checkbox', { name: 'OpenSpec', exact: true }).click();
  await expect(group).toContainText('4/4 已启用');
  expect(new Set(fixture.bound().abilities.skills)).toEqual(new Set([...members, 'unrelated']));
  await group.getByText('子 Skill · example/OpenSpec', { exact: true }).click();
  // 绑定只在执行端确认保存后更新，不能用要求点击后立即变值的 uncheck()。
  await group.getByRole('checkbox', { name: 'verify-change', exact: true }).click();
  await expect(group).toContainText('3/4 已启用');
  await expect(group.getByRole('checkbox', { name: 'verify-change', exact: true })).not.toBeChecked();
  await group.getByRole('button', { name: '仅此项', exact: true }).nth(1).click();
  await expect(group).toContainText('1/4 已启用');
  expect(fixture.bound().abilities.skills).toEqual(['unrelated', 'verify-change']);
  expect(fixture.bindingSaves).toHaveLength(4);
  expect(fixture.requests).not.toContain('getSkillManual');
  await page.screenshot({ path: info.outputPath('parent-binding.png'), fullPage: true });
});

test('library operates on repository parents, renames without child changes and previews all child guides', async ({ page, context }, info) => {
  const fixture = await fixtures(context);
  await page.goto('/'); await sidebar(page);
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /Skills 与 Prompts/ }).click();
  const library = page.locator('#workbench-panel-library');
  let group = library.getByRole('region', { name: 'Skill 仓库 OpenSpec', exact: true });
  await expect(group).toContainText('4 子 Skill');
  await expect(group.getByText('apply-change', { exact: true })).toHaveCount(0);
  await group.getByRole('button', { name: '管理 OpenSpec', exact: true }).click();
  await group.getByRole('button', { name: '改名', exact: true }).click();
  await group.getByRole('textbox', { name: '父级名称' }).fill('我的规范流程');
  await group.getByRole('button', { name: '保存名称', exact: true }).click();
  group = library.getByRole('region', { name: 'Skill 仓库 我的规范流程', exact: true });
  await expect(group).toContainText('example/OpenSpec');
  expect(fixture.renames).toEqual([[parentId, '我的规范流程', 'r1']]);
  await group.getByRole('button', { name: '整组设为默认', exact: true }).click();
  await expect(group).toContainText('默认档 4/4');
  await group.getByRole('button', { name: '维护手册', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'Skill 使用手册' });
  await expect(guide).toContainText('我的规范流程');
  await expect(guide.frameLocator('iframe').getByText('Guide for explore-change', { exact: true })).toBeVisible();
  await guide.getByRole('button', { name: '关闭', exact: true }).click();
  await group.getByRole('button', { name: '展开子 Skill', exact: true }).click();
  for (const name of members) await expect(group.getByText(name, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('parent-library.png'), fullPage: true });
});

test('Thoughts stays in Session with auxiliary parent references, screenshots and shared history', async ({ page, context }, info) => {
  const fixture = await fixtures(context);
  await page.goto('/'); await sidebar(page);
  await page.locator('.awu-sidebar').getByText(session.title, { exact: true }).click();
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  const thoughts = page.getByRole('complementary', { name: '俺寻思注意力助手' });
  const input = thoughts.locator('textarea').first();
  await input.fill('@SKILL');
  const picker = page.getByRole('listbox', { name: '引用 Skill 手册' });
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('option')).toContainText('OpenSpec');
  await expect(picker.getByRole('option')).toContainText('全部 4 个子 Skill');
  await picker.getByRole('button', { name: '展开子 Skill（单独引用）', exact: true }).click();
  await expect(picker.getByRole('option')).toHaveCount(5);
  await picker.getByRole('button', { name: '仅显示父级', exact: true }).click();
  await picker.getByRole('option').click();
  await expect(input).toHaveValue(`@SKILL:${parentId} [OpenSpec] `);
  await expect(thoughts.getByRole('combobox', { name: '切换俺寻思的注意力线程' })).toHaveValue('session');
  await expect(thoughts.locator('strong').filter({ hasText: session.title })).toBeVisible();
  await expect(thoughts.getByRole('group', { name: '附加 Skill 参考资料' })).toContainText('OpenSpec');
  await expect(thoughts.getByText('旧手册答疑内容', { exact: true })).toBeVisible();
  await expect(thoughts.getByText('当前项目需要兼容旧接口', { exact: true })).toBeVisible();
  const pasteImage = async () => {
    await expect(input).toBeEnabled();
    await input.focus();
    await input.evaluate(element => {
      const clipboard = new DataTransfer();
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#f0f4ff'; ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = '#1e3a5f'; ctx.font = '14px sans-serif'; ctx.fillText('Screenshot', 12, 28);
      ctx.fillStyle = '#d8e4fa'; ctx.fillRect(12, 42, 136, 32);
      const uri = canvas.toDataURL('image/png');
      clipboard.setData('text/html', `<img src="${uri}">`);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    });
    await expect(thoughts.locator('img')).toHaveCount(1);
  };
  await pasteImage();
  await page.screenshot({ path: info.outputPath('parent-screenshot-question.png'), fullPage: false });
  expect(fixture.requests).not.toContain('getSkillManual');
  await input.press('Enter');
  await expect.poll(() => fixture.asks.length).toBe(1);
  expect(fixture.asks[0][1]).toContain(`@SKILL:${parentId}`);
  expect(JSON.parse(fixture.asks[0][3])).toMatchObject({ key: 'session', kind: 'session', label: session.title });
  expect(JSON.parse(fixture.asks[0][3]).content).toContain('Session 主工作区');
  expect(JSON.parse(fixture.asks[0][2])).toHaveLength(1);
  await expect(input).toHaveValue('');
  await expect(thoughts.getByRole('group', { name: '附加 Skill 参考资料' })).toHaveCount(0);
  await input.fill('下一步怎么做？'); await input.press('Enter');
  await expect.poll(() => fixture.asks.length).toBe(2);
  expect(fixture.asks[1][1]).toBe('下一步怎么做？');
  await expect(input).toHaveValue('');
  await expect(input).toBeEnabled();
  await expect(thoughts.getByText('下一步怎么做？', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('plain-followup-no-reference.png'), fullPage: false });
  await input.press('Enter');
  await expect(input).toBeEnabled();
  expect(fixture.asks).toHaveLength(2); // 保留关注不应让空消息变成一次提问。
  await pasteImage();
  await thoughts.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => fixture.asks.length).toBe(3);
  expect(fixture.asks[2][1]).not.toContain('@SKILL'); // 仅图追问也不能继承上一条的引用。
  expect(JSON.parse(fixture.asks[2][2])).toHaveLength(1);
  await expect(input).toBeEnabled();
  await input.fill(`@SKILL:${parentId} [OpenSpec] 这个项目下一步呢`);
  await thoughts.getByRole('button', { name: '清除 Skill 参考' }).click();
  await expect(input).toHaveValue('这个项目下一步呢');
  await input.press('Enter');
  await expect.poll(() => fixture.asks.length).toBe(4);
  expect(fixture.asks[3][1]).not.toContain('@SKILL');
  expect(JSON.parse(fixture.asks[3][3]).key).toBe('session');
  await expect(thoughts.getByText('旧手册答疑内容', { exact: true })).toBeVisible();
  await expect(thoughts.getByText('结合当前项目给出的建议', { exact: true })).toHaveCount(4);
  expect(fixture.requests).not.toContain('skillRuntimePrepare');
});

test('Skill references do not leak across Sessions; pinned attention retains the original project', async ({ page, context }) => {
  const fixture = await fixtures(context);
  await page.goto('/'); await sidebar(page);
  await page.locator('.awu-sidebar').getByText(session.title, { exact: true }).click();
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  const thoughts = page.getByRole('complementary', { name: '俺寻思注意力助手' });
  const input = thoughts.locator('textarea').first();
  await input.fill(`@SKILL:${parentId} 这个项目怎么用`);
  await thoughts.getByRole('button', { name: '📌 固定注意力', exact: true }).click();
  // 小屏浮层会遮住侧栏：收起后切换，再打开同一个组件。
  await thoughts.getByRole('button', { name: '✕', exact: true }).click();
  await sidebar(page);
  await page.locator('.awu-sidebar').getByText(otherSession.title, { exact: true }).click();
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  await expect(thoughts.locator('strong').filter({ hasText: session.title })).toBeVisible();
  await expect(thoughts.getByRole('group', { name: '附加 Skill 参考资料' })).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => fixture.asks.length).toBe(1);
  expect(fixture.asks[0][0]).toBe(session.id);
  await expect(input).toBeEnabled();
  await thoughts.getByRole('button', { name: '◎ 解除固定', exact: true }).click();
  await expect(thoughts.locator('strong').filter({ hasText: otherSession.title })).toBeVisible();
  await expect(thoughts.getByRole('group', { name: '附加 Skill 参考资料' })).toHaveCount(0);
  await expect(thoughts.getByText('旧手册答疑内容', { exact: true })).toHaveCount(0);
  await input.fill('现在是哪个项目？'); await input.press('Enter');
  await expect.poll(() => fixture.asks.length).toBe(2);
  expect(fixture.asks[1][0]).toBe(otherSession.id);
  expect(fixture.asks[1][1]).not.toContain('@SKILL');
});

for (const theme of ['dark', 'light']) {
  test(`library compact rows use full width with progressive actions, search and tabs (${theme})`, async ({ page, context }, info) => {
    const fixture = await fixtures(context, true);
    await page.addInitScript(value => localStorage.setItem('agent-with-u:appearance:v1:local:local', JSON.stringify({
      version: 1, theme: value, bgOpacity: .3, uiOpacity: 1, background: 'none',
    })), theme);
    await page.goto('/'); await sidebar(page);
    await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
    await page.locator('.awu-sidebar').getByRole('button', { name: /Skills 与 Prompts/ }).click();
    const library = page.locator('#workbench-panel-library');
    const rows = library.locator('#ability-panel-skills .ability-library-row');
    await expect(rows).toHaveCount(7);
    await expect(library.getByRole('button', { name: '维护手册', exact: true })).toHaveCount(0);
    const bounds = await rows.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { x: rect.x, width: rect.width, height: rect.height };
    }));
    for (const row of bounds) {
      expect(row.height).toBeLessThanOrEqual(70);
      expect(row.width).toBeCloseTo(bounds[0].width, 0);
      expect(row.x + row.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    expect(await library.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`library-compact-${theme}.png`), fullPage: false });
    const search = library.getByRole('textbox', { name: '搜索能力库' });
    await search.fill('verify-change');
    await expect(rows).toHaveCount(1);
    const group = library.getByRole('region', { name: 'Skill 仓库 OpenSpec', exact: true });
    await expect(group).toContainText('4 子 Skill'); // 搜索不能缩小整组操作范围。
    await group.getByRole('button', { name: '展开子 Skill', exact: true }).click();
    for (const name of members) await expect(group.getByText(name, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`library-children-${theme}.png`), fullPage: false });
    await search.fill('missing-no-match');
    await expect(library.getByText('没有匹配的仓库或 Skill')).toBeVisible();
    await search.fill('football');
    const skill = library.getByRole('region', { name: 'Skill football-search', exact: true });
    const manage = skill.getByRole('button', { name: '管理 football-search', exact: true });
    await manage.focus(); await manage.press('Enter');
    await expect(skill.getByRole('button', { name: '配置凭据', exact: true })).toBeVisible();
    await expect(skill.getByRole('button', { name: '取消默认档', exact: true })).toBeVisible();
    await expect(skill.getByRole('button', { name: '删除', exact: true })).toBeVisible();
    expect(await library.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await library.getByRole('tab', { name: /^Prompts ·/ }).click();
    await expect(search).toHaveValue('');
    await expect(library.getByText('代码审阅', { exact: true })).toBeVisible();
    await expect(manage).not.toBeVisible();
    await library.getByRole('button', { name: '新建 Prompt', exact: true }).click();
    await expect(library.getByPlaceholder('Prompt 名称', { exact: true })).toBeVisible();
    expect(fixture.requests).not.toContain('getSkillManual');
  });
}
