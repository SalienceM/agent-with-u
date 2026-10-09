import type { LocalByteDocument, LocalDocumentAdapter } from './localDocuments';
import { withLocalDocumentLock } from './localDocumentStorage';
import { DocumentProtocolError, documentRelativePath } from './workspaceDocuments';
import type { DiskVersion } from './sessionWorkbench';

type NativeCall = <T>(method: string, parameters: Record<string, unknown>) => Promise<T>;
interface NativeBytes { data: string; size: number; complete: boolean; readonly: boolean; canonicalPath: string; version: DiskVersion | null; }

export class TauriDocumentAdapter implements LocalDocumentAdapter {
  private constructor(readonly bindingId: string, readonly canonicalRoot: string, private call: NativeCall, private caseSensitive: boolean) {}
  static async connect(dir: string, call: NativeCall): Promise<TauriDocumentAdapter> {
    const root = await call<{ bindingId: string; canonicalRoot: string; caseSensitive?: boolean }>('local_document_bind', { dir });
    if (!root.bindingId?.startsWith('tauri:') || !root.canonicalRoot) throw new DocumentProtocolError('invalid_document_response');
    // 老端仅实现 Windows；新端必须显式声明 Linux 大小写语义。
    return new TauriDocumentAdapter(root.bindingId, root.canonicalRoot, call, root.caseSensitive === true);
  }
  lock<T>(_relative: string, operation: () => Promise<T>): Promise<T> { return withLocalDocumentLock(operation); }
  async resourceKey(relative: string): Promise<string> {
    const read = await this.read(relative);
    return `tauri-path:${this.caseSensitive ? read.canonicalPath! : read.canonicalPath!.toUpperCase()}`;
  }
  private decode(raw: NativeBytes): LocalByteDocument {
    if (typeof raw.data !== 'string' || raw.data.length > (8 * 1024 * 1024 + 2) / 3 * 4
      || !Number.isSafeInteger(raw.size) || raw.size < 0 || !raw.canonicalPath || typeof raw.complete !== 'boolean') {
      throw new DocumentProtocolError('invalid_document_response');
    }
    return { ...raw, bytes: Uint8Array.from(atob(raw.data), char => char.charCodeAt(0)) };
  }
  async read(relative: string): Promise<LocalByteDocument> {
    return this.decode(await this.call<NativeBytes>('local_document_read', {
      dir: this.canonicalRoot, bindingId: this.bindingId, rel: documentRelativePath(relative),
    }));
  }
  async replace(relative: string, baseline: DiskVersion, bytes: Uint8Array, assertCurrent: () => void): Promise<LocalByteDocument> {
    const rel = documentRelativePath(relative);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    assertCurrent();
    try {
      return this.decode(await this.call<NativeBytes>('local_document_replace', {
        dir: this.canonicalRoot, bindingId: this.bindingId, rel, baseline, data: btoa(binary),
      }));
    } catch (error) {
      // IPC 丢失/worker 异常不能推断提交失败，后续 read 会等待原生所属 I/O 锁。
      const reason = typeof error === 'string' ? error : '';
      throw new DocumentProtocolError(['disk_conflict', 'document_readonly', 'write_not_started', 'stale_workspace'].includes(reason)
        ? reason : 'save_result_unverified');
    }
  }
}
