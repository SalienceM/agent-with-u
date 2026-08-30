export interface BackendManagedSession {
  execKey?: string;
  [key: string]: unknown;
}

/**
 * Backend 配置是执行节点级资源。删除配置时只能检查、迁移同一节点上的
 * Session；没有 execKey 的旧缓存记录按当时的 home 节点处理。
 */
export function sessionsForBackendExecutor<T extends BackendManagedSession>(
  sessions: T[],
  targetExecKey: string,
  homeExecKey: string,
): T[] {
  return sessions.filter((session) => (
    String(session.execKey || homeExecKey) === targetExecKey
  ));
}
