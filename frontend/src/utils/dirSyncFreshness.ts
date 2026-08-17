/**
 * 文件同步的新旧解释层。
 *
 * hash 是“内容是否相同”的唯一依据；mtime 只在没有三向同步基线时用于
 * 推断哪一端较新。这样不会因为复制文件改变时间戳而制造伪差异。
 */

export interface SyncComparableFile {
  hash: string;
  mtime?: number;
}

export type SyncFreshnessKind =
  | 'same'
  | 'local-only'
  | 'remote-only'
  | 'local-updated'
  | 'remote-updated'
  | 'both-updated'
  | 'different-unknown';

export type SyncFreshnessBasis = 'hash' | 'presence' | 'baseline' | 'mtime' | 'unknown';

export interface SyncFreshness {
  kind: SyncFreshnessKind;
  basis: SyncFreshnessBasis;
  localMtime?: number;
  remoteMtime?: number;
}

function validMtime(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * 解释同一路径在两端的状态。
 *
 * 有基线时，哪个 hash 偏离基线就是哪个端发生过更新；两端都偏离即冲突。
 * 无基线时只能按 mtime 推断，并保留 2 秒容差以兼容低精度文件系统时间戳。
 */
export function describeSyncFreshness(
  local: SyncComparableFile | undefined,
  remote: SyncComparableFile | undefined,
  baseline?: SyncComparableFile,
  mtimeToleranceMs = 2_000,
): SyncFreshness {
  const localMtime = validMtime(local?.mtime);
  const remoteMtime = validMtime(remote?.mtime);

  if (!local && !remote) {
    return { kind: 'same', basis: 'hash' };
  }
  if (local && !remote) {
    return { kind: 'local-only', basis: 'presence', localMtime };
  }
  if (!local && remote) {
    return { kind: 'remote-only', basis: 'presence', remoteMtime };
  }

  // 上面的分支已经覆盖缺端；这里显式别名让 TypeScript 正确收窄。
  const localFile = local!;
  const remoteFile = remote!;
  if (localFile.hash === remoteFile.hash) {
    return { kind: 'same', basis: 'hash', localMtime, remoteMtime };
  }

  if (baseline?.hash) {
    const localChanged = localFile.hash !== baseline.hash;
    const remoteChanged = remoteFile.hash !== baseline.hash;
    if (localChanged && remoteChanged) {
      return { kind: 'both-updated', basis: 'baseline', localMtime, remoteMtime };
    }
    if (localChanged) {
      return { kind: 'local-updated', basis: 'baseline', localMtime, remoteMtime };
    }
    if (remoteChanged) {
      return { kind: 'remote-updated', basis: 'baseline', localMtime, remoteMtime };
    }
  }

  if (localMtime !== undefined && remoteMtime !== undefined) {
    if (localMtime - remoteMtime > mtimeToleranceMs) {
      return { kind: 'local-updated', basis: 'mtime', localMtime, remoteMtime };
    }
    if (remoteMtime - localMtime > mtimeToleranceMs) {
      return { kind: 'remote-updated', basis: 'mtime', localMtime, remoteMtime };
    }
  }

  return {
    kind: 'different-unknown',
    basis: 'unknown',
    localMtime,
    remoteMtime,
  };
}
