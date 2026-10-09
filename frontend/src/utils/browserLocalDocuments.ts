import { byteHash, MAX_EDIT_BYTES, PREVIEW_BYTES } from './documentCodec';
import type { LocalByteDocument, LocalDocumentAdapter } from './localDocuments';
import { browserHandleBinding, withLocalDocumentLock } from './localDocumentStorage';
import { DocumentProtocolError, documentRelativePath, sameDiskVersion } from './workspaceDocuments';
import type { DiskVersion } from './sessionWorkbench';

interface GrantedHandle extends FileSystemFileHandle {
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export class BrowserDocumentAdapter implements LocalDocumentAdapter {
  private constructor(readonly bindingId: string, private root: FileSystemDirectoryHandle) {}
  static async connect(root: FileSystemDirectoryHandle): Promise<BrowserDocumentAdapter> {
    return new BrowserDocumentAdapter(await browserHandleBinding(root), root);
  }
  lock<T>(_relative: string, operation: () => Promise<T>): Promise<T> { return withLocalDocumentLock(operation); }
  private async handle(relative: string): Promise<GrantedHandle> {
    const parts = documentRelativePath(relative).split('/');
    let dir = this.root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return await dir.getFileHandle(parts[parts.length - 1]) as GrantedHandle;
  }
  async resourceKey(relative: string): Promise<string> { return browserHandleBinding(await this.handle(relative)); }
  private async snapshot(handle: GrantedHandle): Promise<LocalByteDocument> {
    const file = await handle.getFile();
    const complete = file.size <= MAX_EDIT_BYTES;
    const bytes = new Uint8Array(await file.slice(0, complete ? file.size : PREVIEW_BYTES).arrayBuffer());
    const id = await browserHandleBinding(handle);
    return { bytes, complete, size: file.size,
      readonly: await handle.queryPermission({ mode: 'readwrite' }) !== 'granted',
      version: complete ? { exists: true, sha256: byteHash(bytes), byteLength: file.size,
        fileId: id, modifiedNs: `${file.lastModified}`, changedNs: `${file.lastModified}` } : null };
  }
  async read(relative: string): Promise<LocalByteDocument> { return this.snapshot(await this.handle(relative)); }
  async replace(relative: string, baseline: DiskVersion, bytes: Uint8Array, assertCurrent: () => void): Promise<LocalByteDocument> {
    let writer: FileSystemWritableFileStream | undefined, handle: GrantedHandle;
    try {
      handle = await this.handle(relative);
      if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new DocumentProtocolError('document_readonly');
      if (!sameDiskVersion((await this.snapshot(handle)).version, baseline)) throw new DocumentProtocolError('disk_conflict');
      assertCurrent();
      writer = await handle.createWritable();
      await writer.write(bytes.slice().buffer);
      const current = await this.handle(relative);
      if (!await handle.isSameEntry(current) || !sameDiskVersion((await this.snapshot(current)).version, baseline)) {
        throw new DocumentProtocolError('disk_conflict');
      }
      if (await current.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new DocumentProtocolError('document_readonly');
      assertCurrent();
    } catch (error) {
      if (writer) {
        try { await writer.abort(); }
        catch { throw new DocumentProtocolError('save_result_unverified'); }
      }
      throw error instanceof DocumentProtocolError ? error : new DocumentProtocolError('write_not_started');
    }
    // close 是提交边界：异常后不能假设没写入，更不能再次 close 或覆盖重试。
    try { await writer.close(); }
    catch { throw new DocumentProtocolError('save_result_unverified'); }
    const current = await this.handle(relative);
    if (!await handle.isSameEntry(current)) throw new DocumentProtocolError('save_result_unverified');
    return this.snapshot(current);
  }
}
