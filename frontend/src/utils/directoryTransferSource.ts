import type { LocalFs, Manifest } from './dirSync';
import { isIgnored } from './dirSyncPolicy';
import { IncrementalSha256 } from './sha256';
import { yieldToUi } from './cooperativeWork';

export function inTransferScope(path: string, scope: string, directory: boolean): boolean {
  return directory ? !scope || path.startsWith(scope + '/') : path === scope;
}
export function sameTransferManifest(a: Manifest, b: Manifest): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(p => a[p].hash === b[p]?.hash && a[p].size === b[p]?.size);
}
export async function scanTransferSource(fs: LocalFs, scope: string, directory: boolean, ignore: string[], includeGit: boolean): Promise<Manifest> {
  if (scope && isIgnored(scope, ignore, includeGit)) throw new Error('所选范围被同步规则排除');
  if (fs.transferScan) return clean(await fs.transferScan(scope, directory, ignore, includeGit));
  if (fs.kind === 'tauri') throw new Error('请更新桌面端以支持完整传输检查');
  const files: Manifest = Object.create(null);
  let total = 0, count = 0;
  const read = async (path: string) => {
    const size = await fs.fileSize(path), hash = new IncrementalSha256();
    total += size;
    if (!Number.isSafeInteger(size) || size < 0 || total > 8 * 1024 ** 3 || ++count > 20000) throw new Error('超出扫描预算（20000 文件 / 8 GiB）');
    for (let offset = 0; offset < size;) {
      const data = Uint8Array.from(atob(await fs.readChunk(path, offset, Math.min(1024 ** 2, size - offset))), c => c.charCodeAt(0));
      if (!data.length || offset + data.length > size) throw new Error('扫描期间源文件变化');
      hash.update(data); offset += data.length; await yieldToUi();
    }
    if (await fs.fileSize(path) !== size) throw new Error('扫描期间源文件变化');
    files[path] = { hash: hash.digestHex(), size };
  };
  const walk = async (path: string): Promise<void> => {
    const entries = await fs.listDir(path); // 失败不可当作空目录。
    if (fs.kind === 'managed' && path && !entries.length) throw new Error('托管副本中的源目录已不存在，请重新选择范围');
    for (const entry of entries) {
      const rel = path ? `${path}/${entry.name}` : entry.name;
      if (isIgnored(rel, ignore, includeGit)) continue;
      if (entry.isDir) await walk(rel); else await read(rel);
    }
  };
  if (directory) await walk(scope); else await read(scope);
  return clean(files);
}
function clean(files: Manifest): Manifest {
  return Object.fromEntries(Object.entries(files).map(([path, value]) => {
    if (!/^[a-f0-9]{64}$/.test(value.hash) || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('扫描未返回完整文件哈希');
    return [path, { hash: value.hash, size: value.size }];
  }));
}
