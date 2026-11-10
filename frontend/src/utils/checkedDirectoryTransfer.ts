import { api, getCurrentUserProfile } from '../api';
import type { LocalFs, Manifest } from './dirSync';
import type { WorkspaceIdentity } from './sessionWorkbench';
import { sameWorkspace } from './workspaceDocuments';
import { documentStore } from './documentStore';
import { fileTransfers } from './fileTransfers';
import { inTransferScope, sameTransferManifest, scanTransferSource } from './directoryTransferSource';

export interface TransferEntry { path: string; action: 'add' | 'update' | 'skip' | 'delete'; hash: string; size: number }
export interface DirectoryTransferPlan {
  version: number; id: string; state: 'preview' | 'committing' | 'succeeded' | 'failed' | 'cancelled';
  workspace: WorkspaceIdentity; scope: string; mirror: boolean; entries: TransferEntry[]; uploaded: string[]; deleted: string[]; message: string;
}
export interface DirectoryTransferInput {
  executor: string; session: string; workingDir: string; fs: LocalFs; scope: string; directory: boolean;
  mirror: boolean; includeGit: boolean; transferKey: string; label: string;
  current: () => boolean;
}
export interface PreparedDirectoryTransfer {
  input: DirectoryTransferInput; plan: DirectoryTransferPlan; source: Manifest; ignore: string[]; identity: string;
}
function assertCurrent(input: DirectoryTransferInput, identity: string): void {
  if (!input.current() || api.projectTransferIdentity() !== identity) throw new Error('用户、节点或副本已变化，请重新预览');
}
function checkDrafts(prepared: PreparedDirectoryTransfer): void {
  const { input, plan } = prepared;
  if (documentStore.all().some(doc => doc.identity.workspace.ownerId === plan.workspace.ownerId
    && (doc.identity.workspace.sessionId === input.session || sameWorkspace(doc.identity.workspace, plan.workspace))
    && inTransferScope(doc.identity.relativePath, input.scope, input.directory)
    && (doc.dirty || !!doc.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || '')))) {
    throw new Error('范围内存在未保存或待核对的文件，请先处理');
  }
}
function validatePlan(plan: DirectoryTransferPlan, workspace: WorkspaceIdentity, input: DirectoryTransferInput): void {
  if (plan?.version !== 1 || !plan.id || !sameWorkspace(plan.workspace, workspace) || plan.scope !== input.scope || plan.mirror !== input.mirror
    || !Array.isArray(plan.entries) || plan.entries.length > 40000 || !Array.isArray(plan.uploaded) || !Array.isArray(plan.deleted)) throw new Error('传输计划身份无效');
  const paths = new Set<string>();
  for (const entry of plan.entries) {
    if (paths.has(entry.path) || !inTransferScope(entry.path, input.scope, input.directory) || !['add', 'update', 'skip', 'delete'].includes(entry.action)
      || entry.action === 'delete' && !input.mirror || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('传输计划范围无效');
    paths.add(entry.path);
  }
}
export async function prepareDirectoryTransfer(input: DirectoryTransferInput): Promise<PreparedDirectoryTransfer> {
  const identity = api.projectTransferIdentity(); assertCurrent(input, identity);
  const config = await api.directoryTransferCall(input.executor, 'Config', [input.session, input.workingDir]);
  assertCurrent(input, identity);
  if (config.version !== 1 || config.workspace?.ownerId !== getCurrentUserProfile().userId || config.workspace?.sessionId !== input.session
    || !Array.isArray(config.ignore) || !config.ignore.every((p: unknown) => typeof p === 'string')) throw new Error('执行端不支持完整传输检查');
  const source = await scanTransferSource(input.fs, input.scope, input.directory, config.ignore, input.includeGit);
  assertCurrent(input, identity);
  const plan = await api.directoryTransferCall(input.executor, 'Plan', [input.session, JSON.stringify(config.workspace), JSON.stringify({
    scope: input.scope, directory: input.directory, mirror: input.mirror, includeGit: input.includeGit, source, ignore: config.ignore,
  })]);
  assertCurrent(input, identity); validatePlan(plan, config.workspace, input);
  const prepared = { input, identity, source, ignore: config.ignore, plan };
  checkDrafts(prepared);
  return prepared;
}
export async function cancelDirectoryTransfer(prepared: PreparedDirectoryTransfer): Promise<void> {
  const { input, plan, identity } = prepared;
  if (api.projectTransferIdentity() !== identity) return;
  await api.directoryTransferCall(input.executor, 'Cancel', [input.session, JSON.stringify(plan.workspace), plan.id]);
}
export async function submitDirectoryTransfer(prepared: PreparedDirectoryTransfer, changed: () => void): Promise<void> {
  const { input, plan, source, ignore, identity } = prepared;
  assertCurrent(input, identity); checkDrafts(prepared);
  const job = fileTransfers.start(input.transferKey, input.label, 'push', input.scope);
  if (!job) throw new Error('此目录已有传输尚未完成');
  job.ownerId = plan.workspace.ownerId;
  let submitted = false, pending: Promise<void> | undefined;
  const args = [input.session, JSON.stringify(plan.workspace), plan.id];
  const unknown = () => fileTransfers.reviewState(job, 'unresolved', '提交结果未知，请核对原请求；不会自动重复写入', reconcile);
  const settle = (row: DirectoryTransferPlan) => {
    validatePlan(row, plan.workspace, input);
    if (row.id !== plan.id) throw new Error('回执不属于原传输');
    if (row.state === 'succeeded') {
      const expected = plan.entries.filter(e => e.action === 'add' || e.action === 'update').map(e => e.path).sort();
      const deletions = plan.entries.filter(e => e.action === 'delete').map(e => e.path).sort();
      if (JSON.stringify([...row.uploaded].sort()) !== JSON.stringify(expected) || JSON.stringify([...row.deleted].sort()) !== JSON.stringify(deletions)) throw new Error('传输验收回执不完整');
      fileTransfers.reviewState(job, 'done', `已上传 ${expected.length} · 跳过 ${plan.entries.filter(e => e.action === 'skip').length} · 删除 ${deletions.length}`);
      changed();
    } else if (row.state === 'failed' || row.state === 'cancelled') {
      fileTransfers.reviewState(job, 'error', `${row.message || '传输未完成'}；已上传 ${row.uploaded.length}，已删除 ${row.deleted.length}`);
      changed();
    } else unknown();
  };
  const reconcile = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      if (api.projectTransferIdentity() !== identity) { unknown(); return; }
      try { settle(await api.directoryTransferCall(input.executor, 'Status', args)); }
      catch { unknown(); }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const recheckSource = async () => {
    assertCurrent(input, identity); checkDrafts(prepared);
    const actual = await scanTransferSource(input.fs, input.scope, input.directory, ignore, input.includeGit);
    assertCurrent(input, identity);
    if (!sameTransferManifest(actual, source)) throw new Error('源目录已变化，请重新预览；未提交目标修改');
  };
  try {
    await recheckSource();
    const entries = plan.entries.filter(e => e.action === 'add' || e.action === 'update');
    const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    let doneBytes = 0;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]; let offset = 0;
      do {
        assertCurrent(input, identity);
        if (job.abort.current) throw new Error('传输已取消，目标未修改');
        const size = Math.min(1024 ** 2, entry.size - offset);
        const data = size ? await input.fs.readChunk(entry.path, offset, size) : '';
        if (atob(data).length !== size) throw new Error('源文件读取长度变化');
        const result = await api.directoryTransferCall(input.executor, 'Chunk', [...args, entry.path, offset, data]);
        if (result.written !== size) throw new Error('上传分块未确认');
        offset += size; doneBytes += size;
        fileTransfers.progress(job, { ...job.progress, fileIndex: index + 1, fileCount: entries.length, rel: entry.path,
          fileBytes: offset, fileSize: entry.size, totalBytes, doneBytes, activeCount: 1 });
      } while (offset < entry.size);
    }
    await recheckSource();
    if (job.abort.current) throw new Error('传输已取消，目标未修改');
    fileTransfers.reviewState(job, 'running', '正在核对目标并提交…');
    submitted = true;
    const row = await api.directoryTransferCall(input.executor, 'Commit', [input.session, JSON.stringify(plan.workspace), input.workingDir, plan.id]);
    settle(row);
  } catch (error) {
    if (submitted && !(error as { transferRejected?: boolean })?.transferRejected) await reconcile();
    else {
      await cancelDirectoryTransfer(prepared).catch(() => {});
      fileTransfers.finish(job, String(error instanceof Error ? error.message : error), true);
    }
  }
}
