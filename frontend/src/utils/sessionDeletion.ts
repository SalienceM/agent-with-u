export interface SessionDeletionResult {
  status: 'succeeded' | 'failed' | 'not_submitted' | 'unknown';
  message: string; directory?: string; directoryDeleted?: boolean;
}
interface DeletionIO {
  online(): boolean;
  current(): boolean;
  request(method: string, params: unknown[], timeout: number): Promise<unknown>;
}

/** 不接收后备节点，不保存命令。未知结果只能由调用者只读核对。 */
export async function deleteSessionOnTarget(io: DeletionIO, session: string, destroy = false): Promise<SessionDeletionResult> {
  if (!session || !io.current() || !io.online()) return { status: 'not_submitted', message: '所属节点离线或身份已变化，未提交操作' };
  try {
    const raw = await io.request(destroy ? 'destroySession' : 'deleteSession', destroy ? [session, 'DESTROY'] : [session], 10000);
    if (!io.current()) return { status: 'unknown', message: '身份已变化，请回到原身份核对结果' };
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!destroy && result === true || destroy && result?.status === 'ok')
      return { status: 'succeeded', message: destroy ? '已销毁' : '已删除会话，工作目录保留',
        ...(destroy ? { directory: result.directory, directoryDeleted: result.directoryDeleted } : {}) };
    if (result === false || result?.status === 'error') return { status: 'failed', message: result?.message || '执行端未能删除会话' };
    return { status: 'unknown', message: '未收到有效删除确认，结果未知；请只读核对，不要重复提交' };
  } catch (error) {
    const failure = error as { notSubmitted?: boolean; serverRejected?: boolean; message?: string };
    if (failure.notSubmitted) return { status: 'not_submitted', message: failure.message || '未提交操作' };
    if (failure.serverRejected) return { status: 'failed', message: failure.message || '执行端拒绝操作' };
    return { status: 'unknown', message: '连接中断或超时，删除结果未知；请只读核对，不会自动重试' };
  }
}
