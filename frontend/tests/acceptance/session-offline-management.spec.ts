import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

const sid = 'qa-chat-004';
const title = '离线收藏验证';
const meta = { id: sid, title, workingDir: '', backendId: 'qa-primary', messageCount: 0, updatedAt: 1, sessionType: 'normal' };
async function apiCall(page: Page, method: string, ...args: any[]) {
  return page.evaluate(async ({ method, args }) => {
    const source = '/src/api.ts'; const { api } = await import(/* @vite-ignore */ source);
    return api[method](...args);
  }, { method, args });
}
async function history(page: Page, seed = false) {
  return page.evaluate(async ({ sid, seed }) => {
    const apiPath = '/src/api.ts', historyPath = '/src/utils/inputHistory.ts';
    const { getCurrentUserProfile } = await import(/* @vite-ignore */ apiPath);
    const { inputHistoryKey, inputHistoryStore } = await import(/* @vite-ignore */ historyPath);
    const key = inputHistoryKey(getCurrentUserProfile(), 'local', sid);
    if (seed) inputHistoryStore.append(key, 'QA retained input');
    return inputHistoryStore.read(key);
  }, { sid, seed });
}
async function showSidebar(page: Page) {
  if (await page.locator('.awu-sidebar').getByText(title, { exact: true }).isVisible()) return;
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await expect(page.locator('.awu-sidebar').getByText(title, { exact: true })).toBeVisible();
}
async function menu(page: Page) {
  await showSidebar(page);
  await page.locator('.awu-sidebar').getByText(title, { exact: true }).click({ button: 'right' });
  return page.getByRole('menu', { name: `${title} 的会话操作` });
}
async function setup(page: Page) {
  const state = { offline: false, pinned: false, revision: 0, deleted: false, deletion: 'false', holdMeta: false,
    calls: [] as string[], sockets: [] as WebSocketRoute[], pending: null as { socket: WebSocketRoute; id: string } | null };
  await page.routeWebSocket(/127\.0\.0\.1:45421/, socket => {
    state.sockets.push(socket);
    if (state.offline) { void socket.close({ code: 1012, reason: 'QA offline' }); return; }
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message)), method = frame.method;
      state.calls.push(method);
      const reply = (result: any) => socket.send(JSON.stringify({ id: frame.id, result: typeof result === 'boolean' || result === null ? result : JSON.stringify(result) }));
      if (method === 'listSessions') { reply(state.deleted ? [] : [{ ...meta, pinned: state.pinned, favoriteRevision: state.revision }]); return; }
      if (frame.params?.[0] === sid) {
        if (method === 'loadSessionMeta') {
          if (state.holdMeta) { state.pending = { socket, id: frame.id }; return; }
          reply(state.deleted ? null : { ...meta, pinned: state.pinned, favoriteRevision: state.revision }); return;
        }
        if (method === 'loadSession') { reply({ ...meta, messages: [], pinned: state.pinned, favoriteRevision: state.revision }); return; }
        if (method === 'sessionFavoriteGet') { reply(state.deleted ? { status: 'not_found' } : { status: 'ok', protocolVersion: 1, pinned: state.pinned, favoriteRevision: state.revision }); return; }
        if (method === 'sessionFavoriteSet') {
          const input = JSON.parse(frame.params[1]);
          if (input.expectedRevision !== state.revision) { reply({ status: 'conflict' }); return; }
          state.pinned = input.pinned; state.revision++;
          reply({ status: 'ok', protocolVersion: 1, pinned: state.pinned, favoriteRevision: state.revision, lastRequestId: input.requestId }); return;
        }
        if (method === 'deleteSession' || method === 'destroySession') {
          if (state.deletion === 'false') reply(false);
          else if (state.deletion === 'denied') socket.send(JSON.stringify({ id: frame.id, error: 'QA: 无权删除该会话' }));
          else if (state.deletion === 'disconnect') { state.offline = true; void socket.close({ code: 1012, reason: 'QA lost reply' }); }
          else if (state.deletion === 'unknown') reply(null);
          else if (state.deletion === 'timeout' || state.deletion === 'identity') state.pending = { socket, id: frame.id };
          else {
            state.deleted = true;
            socket.send(JSON.stringify({ event: 'sessionUpdated', data: JSON.stringify({ type: 'session_deleted', sessionId: sid }) }));
            reply(method === 'destroySession' ? { status: 'ok', directoryDeleted: true } : true);
          }
          return;
        }
      }
      if (['sendMessage', 'executeCommand', 'loopRunIteration', 'seqtaskTakeNext', 'seqtaskSetAuto', 'workspaceDocumentSave', 'syncReviewApply'].includes(method))
        throw new Error(`Unexpected mutation: ${method}`);
      server.send(message);
    });
  });
  await page.goto('/'); await showSidebar(page);
  return state;
}

test('online favorite, offline unpin, reopen and reconnect retain latest without rebound', async ({ page }, info) => {
  const state = await setup(page);
  await (await menu(page)).getByRole('menuitem', { name: /收藏并置顶/ }).click();
  await expect.poll(() => state.pinned).toBe(true);
  await expect(page.locator('[data-favorite-status]')).toHaveCount(0);
  state.offline = true; await state.sockets.at(-1)!.close({ code: 1012 });
  await (await menu(page)).getByRole('menuitem', { name: /取消置顶/ }).click();
  await expect(page.locator('[data-favorite-status="pending"]')).toBeVisible();
  await expect(page.locator('.awu-sidebar [title="已置顶"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('offline-pending.png') });
  await page.reload(); await showSidebar(page);
  await expect(page.locator('[data-favorite-status="pending"]')).toBeVisible();
  await expect(page.locator('.awu-sidebar [title="已置顶"]')).toHaveCount(0);
  state.offline = false;
  await expect.poll(() => state.pinned, { timeout: 16000 }).toBe(false);
  await expect(page.locator('[data-favorite-status]')).toHaveCount(0);
  state.sockets.at(-1)!.send(JSON.stringify({ event: 'sessionUpdated', data: JSON.stringify({ type: 'session_appearance', sessionId: sid, summary: { ...meta, pinned: true, favoriteRevision: 1 } }) }));
  await expect(page.locator('.awu-sidebar [title="已置顶"]')).toHaveCount(0);
  expect(state.calls.filter(m => m === 'sessionFavoriteSet')).toHaveLength(2);
  expect(state.calls.filter(m => m === 'deleteSession' || m === 'destroySession')).toHaveLength(0);
  await info.attach('rpc-counts', { body: JSON.stringify(state.calls.reduce((all, key) => ({ ...all, [key]: (all[key] || 0) + 1 }), {} as Record<string, number>)), contentType: 'application/json' });
});

test('conflict choices are explicit and remote deletion cleans pending only', async ({ page }, info) => {
  const state = await setup(page);
  for (const choice of ['采用远端收藏值', '保留本设备选择并同步']) {
    state.offline = true; await state.sockets.at(-1)!.close({ code: 1012 });
    await apiCall(page, 'setSessionFavorite', sid, true, 'local');
    state.revision += 2; state.pinned = false; state.offline = false;
    await expect(page.locator('[data-favorite-status="conflict"]')).toBeVisible({ timeout: 16000 });
    const actions = await menu(page);
    await expect(actions.getByRole('menuitem', { name: choice, exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`conflict-${choice}.png`), animations: 'disabled' });
    await actions.getByRole('menuitem', { name: choice, exact: true }).click();
    await expect(page.locator('[data-favorite-status]')).toHaveCount(0);
    expect(state.pinned).toBe(choice.startsWith('保留'));
  }
  state.offline = true; await state.sockets.at(-1)!.close({ code: 1012 });
  await apiCall(page, 'setSessionFavorite', sid, false, 'local');
  state.deleted = true; state.offline = false;
  await expect(page.locator('[data-favorite-status]')).toHaveCount(0, { timeout: 16000 });
  expect(state.calls.filter(m => m === 'deleteSession')).toHaveLength(0);
});

for (const failure of ['false', 'denied', 'unknown', 'disconnect', 'timeout'] as const) {
  test(`deletion ${failure} preserves tab and feedback; unknown never replays`, async ({ page }, info) => {
    test.setTimeout(45000);
    const state = await setup(page); state.deletion = failure;
    await history(page, true);
    await page.locator('.awu-sidebar').getByText(title, { exact: true }).click();
    await (await menu(page)).getByRole('menuitem', { name: /删除会话（保留目录）/ }).click();
    const dialog = page.getByRole('dialog', { name: '确认删除会话' });
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 14000 });
    await expect(page.getByRole('tab', { name: title, exact: true })).toBeVisible();
    if (['unknown', 'disconnect', 'timeout'].includes(failure)) {
      await expect(dialog.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: '只读核对', exact: true }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
    }
    expect(state.calls.filter(m => m === 'deleteSession')).toHaveLength(1);
    expect(await history(page)).toContain('QA retained input');
    await page.screenshot({ path: info.outputPath(`delete-${failure}.png`) });
  });
}

test('offline home and missing target never mock success; successful event and receipt clean once', async ({ page }, info) => {
  const state = await setup(page);
  expect((await apiCall(page, 'deleteSession', sid, 'not-a-node')).status).toBe('not_submitted');
  state.offline = true; await state.sockets.at(-1)!.close({ code: 1012 });
  expect((await apiCall(page, 'deleteSession', sid, 'local')).status).toBe('not_submitted');
  expect((await apiCall(page, 'destroySession', sid, 'DESTROY', 'local')).status).toBe('not_submitted');
  expect(state.calls.filter(m => m === 'deleteSession' || m === 'destroySession')).toHaveLength(0);
  await apiCall(page, 'setSessionFavorite', sid, true, 'local');
  state.offline = false;
  await expect.poll(() => state.pinned, { timeout: 16000 }).toBe(true);
  await page.evaluate(async () => { const path = '/src/api.ts'; const { api } = await import(/* @vite-ignore */ path);
    (window as any).deletedEvents = 0; api.onSessionUpdated((event: any) => { if (event.type === 'session_deleted') (window as any).deletedEvents++; }); });
  state.deletion = 'success';
  await history(page, true);
  await showSidebar(page);
  await page.locator('.awu-sidebar').getByText(title, { exact: true }).click();
  await expect(page.getByRole('tab', { name: title, exact: true })).toBeVisible();
  expect((await apiCall(page, 'deleteSession', sid, 'local')).status).toBe('succeeded');
  expect(await page.evaluate(() => (window as any).deletedEvents)).toBe(1);
  expect(await history(page)).toEqual([]);
  await expect(page.locator('.awu-sidebar').getByText(title, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: title, exact: true })).toHaveCount(0);
  // 已发出的旧列表/推送不能复活已确认删除的目标。
  state.deleted = false;
  expect((await apiCall(page, 'listSessions')).filter((row: any) => row.id === sid)).toHaveLength(0);
  state.sockets.at(-1)!.send(JSON.stringify({ event: 'sessionUpdated', data: JSON.stringify({ type: 'session_changed', sessionId: sid, summary: meta }) }));
  await expect(page.locator('.awu-sidebar').getByText(title, { exact: true })).toHaveCount(0);
  await info.attach('rpc-counts', { body: JSON.stringify(state.calls), contentType: 'application/json' });
});

test('account switch clears pending choices and ignores a late destructive receipt', async ({ page }) => {
  const state = await setup(page);
  state.offline = true; await state.sockets.at(-1)!.close({ code: 1012 });
  await apiCall(page, 'setSessionFavorite', sid, true, 'local');
  await page.routeWebSocket(/qa-identity\.invalid/, socket => { void socket.close({ code: 1012 }); });
  await page.evaluate(async () => {
    const path = '/src/api.ts'; const api = await import(/* @vite-ignore */ path);
    await api.setConnectionTarget({ mode: 'relay', url: 'wss://qa-identity.invalid', token: 'qa-placeholder', deviceId: 'same', user: { userId: 'bob', username: 'bob' } });
  });
  await expect.poll(() => page.evaluate(async () => { const path = '/src/utils/sessionFavorites.ts'; const { IndexedFavoriteRepository } = await import(/* @vite-ignore */ path); return (await new IndexedFavoriteRepository().all()).length; })).toBe(0);
  expect(state.calls.filter(m => m === 'sessionFavoriteSet')).toHaveLength(0);
  await page.evaluate(async () => { const path = '/src/api.ts'; const api = await import(/* @vite-ignore */ path); await api.setConnectionTarget({ mode: 'local' }); });
  state.offline = false;
  await expect.poll(async () => (await apiCall(page, 'listSessions')).length, { timeout: 16000 }).toBe(1);
  await showSidebar(page); state.deletion = 'identity';
  await (await menu(page)).getByRole('menuitem', { name: /删除会话（保留目录）/ }).click();
  await page.getByRole('dialog', { name: '确认删除会话' }).getByRole('button', { name: '删除', exact: true }).click();
  await expect.poll(() => !!state.pending).toBe(true);
  await page.evaluate(async () => { const path = '/src/api.ts'; const api = await import(/* @vite-ignore */ path);
    (window as any).deletedEvents = 0; api.api.onSessionUpdated((event: any) => { if (event.type === 'session_deleted') (window as any).deletedEvents++; });
    await api.setConnectionTarget({ mode: 'relay', url: 'wss://qa-identity.invalid', token: 'qa-placeholder', deviceId: 'same', user: { userId: 'carol', username: 'carol' } }); });
  // 已销毁的原连接不能把成功写进新身份；发送到关闭的 route 在测试层也可被拒绝。
  try { state.pending!.socket.send(JSON.stringify({ id: state.pending!.id, result: true })); } catch { /* closed */ }
  await expect(page.getByRole('dialog', { name: '确认删除会话' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).deletedEvents)).toBe(0);
  expect(state.calls.filter(m => m === 'deleteSession')).toHaveLength(1);
});

test('healthy exact remote deletion does not wait for offline default or fall back after node removal', async ({ page }) => {
  await setup(page);
  const calls: { node: string; method: string }[] = [];
  await page.routeWebSocket(/qa-routing\.invalid/, socket => {
    let node = '';
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.t === 'hello') {
        node = frame.deviceId;
        if (node === 'home-offline') { void socket.close({ code: 1012 }); return; }
        socket.send(JSON.stringify({ t: 'ready' })); return;
      }
      calls.push({ node, method: frame.method });
      const result = frame.method === 'deleteSession' ? true : JSON.stringify(frame.method === 'listSessions' ? [{ ...meta, favoriteRevision: 0 }] : frame.method === 'loadSessionMeta' ? meta : null);
      socket.send(JSON.stringify({ id: frame.id, result }));
    });
  });
  await page.evaluate(async () => { const path = '/src/api.ts'; const api = await import(/* @vite-ignore */ path);
    const base = { mode: 'relay', url: 'wss://qa-routing.invalid', token: 'qa-placeholder', user: { userId: 'alice', username: 'alice' } };
    await api.setConnectionTarget({ ...base, deviceId: 'home-offline' }); api.addExecRoster({ ...base, deviceId: 'healthy' }); });
  await expect.poll(() => page.evaluate(async () => { const path = '/src/api.ts'; const api = await import(/* @vite-ignore */ path);
    return api.getExecutors().some((node: any) => node.key === 'relay:alice:healthy' && node.connected); })).toBe(true);
  const started = Date.now();
  expect((await apiCall(page, 'deleteSession', sid, 'relay:alice:healthy')).status).toBe('succeeded');
  expect(Date.now() - started).toBeLessThan(4000);
  await page.evaluate(async () => { const path = '/src/api.ts'; const api = await import(/* @vite-ignore */ path); api.removeExecRoster('relay:alice:healthy'); });
  expect((await apiCall(page, 'deleteSession', sid, 'relay:alice:healthy')).status).toBe('not_submitted');
  expect(calls.filter(item => item.method === 'deleteSession')).toEqual([{ node: 'healthy', method: 'deleteSession' }]);
});

test('favorite admission timeout is bounded and late readiness cannot submit', async ({ page }) => {
  test.setTimeout(45000);
  const state = await setup(page);
  state.holdMeta = true;
  await apiCall(page, 'setSessionFavorite', sid, true, 'local');
  await expect.poll(() => !!state.pending).toBe(true);
  await expect.poll(async () => (await apiCall(page, 'listSessions'))[0]?.favoriteMessage, { timeout: 14000 }).toContain('超时');
  state.pending!.socket.send(JSON.stringify({ id: state.pending!.id, result: JSON.stringify(meta) }));
  await expect(page.locator('[data-favorite-status="pending"]')).toBeVisible();
  expect(state.calls.filter(m => m === 'sessionFavoriteSet')).toHaveLength(0);
});

test('real IndexedDB transactions survive windows, limits and storage failure', async ({ page, context }, info) => {
  const state = await setup(page);
  const second = await context.newPage(); await second.goto('/');
  const edit = (p: Page, pinned: boolean) => p.evaluate(async pinned => {
    const path = '/src/utils/sessionFavorites.ts'; const { IndexedFavoriteRepository, favoriteKey } = await import(/* @vite-ignore */ path);
    const repo = new IndexedFavoriteRepository(), target = { scope: 'qa', node: 'n', session: 's' }, key = favoriteKey(target);
    await repo.edit(key, (old: any) => ({ ...target, key, generation: (old?.generation || 0) + 1, requestId: `r-${(old?.generation || 0) + 1}`, pinned, baseRevision: 0, phase: 'pending' }));
  }, pinned);
  await Promise.all([edit(page, true), edit(second, false)]);
  const proof = await page.evaluate(async () => {
    const path = '/src/utils/sessionFavorites.ts'; const { IndexedFavoriteRepository, favoriteKey } = await import(/* @vite-ignore */ path);
    const repo = new IndexedFavoriteRepository();
    const generation = (await repo.all()).find((row: any) => row.scope === 'qa').generation;
    for (let i = 1; i < 2000; i++) { const target = { scope: 'qa', node: 'n', session: `s${i}` }, key = favoriteKey(target);
      await repo.edit(key, () => ({ ...target, key, generation: 1, requestId: `r${i}`, pinned: true, baseRevision: 0, phase: 'pending' })); }
    const target = { scope: 'qa', node: 'n', session: 'overflow' }, key = favoriteKey(target);
    let limit = '', bytes = '';
    try { await repo.edit(key, () => ({ ...target, key, generation: 1, requestId: 'limit', pinned: true, baseRevision: 0, phase: 'pending' })); } catch (error: any) { limit = error.message; }
    try { await repo.edit(key, () => ({ ...target, key, generation: 1, requestId: 'bytes', pinned: true, baseRevision: 0, phase: 'pending', message: '长'.repeat(800) })); } catch (error: any) { bytes = error.message; }
    return { generation, limit, bytes, count: (await repo.all()).length };
  });
  expect(proof).toMatchObject({ generation: 2, count: 2000 }); expect(proof.limit).toContain('2000'); expect(proof.bytes).toContain('2 KiB');
  expect(await page.evaluate(async () => {
    const path = '/src/utils/sessionFavorites.ts'; const { IndexedFavoriteRepository, favoriteKey } = await import(/* @vite-ignore */ path);
    const repo = new IndexedFavoriteRepository(), target = { scope: 'other-user', node: 'n', session: 's' }, key = favoriteKey(target);
    await repo.edit(key, () => ({ ...target, key, generation: 1, requestId: 'other', pinned: true, baseRevision: 0, phase: 'pending' }));
    await repo.clear(['qa']); const remaining = await repo.all(); return remaining.map((row: any) => row.scope);
  })).toEqual(['other-user']);
  await second.close();
  await page.evaluate(() => { const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: any[]) { if (this.name === 'awu-session-favorites-v1' && args[1] === 'readwrite') throw new DOMException('QA quota exhausted', 'QuotaExceededError'); return (original as any).apply(this, args); }; });
  await (await menu(page)).getByRole('menuitem', { name: /收藏并置顶/ }).click();
  await expect(page.getByRole('alertdialog', { name: '收藏保存失败' })).toContainText('quota');
  expect(state.calls.filter(m => m === 'sessionFavoriteSet')).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('storage-failure.png') });
});
