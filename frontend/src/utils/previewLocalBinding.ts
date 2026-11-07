import { BrowserLocalFs, ManagedBrowserLocalFs, TauriLocalFs, type LocalFs } from './dirSync';
import { browserHandleByBinding } from './localDocumentStorage';
import type { PreviewLocalBinding } from './previewLifecycle';
import { DocumentProtocolError } from './workspaceDocuments';

export async function capturePreviewBinding(fs: LocalFs): Promise<PreviewLocalBinding> {
  if (!fs.documentAdapter) throw new DocumentProtocolError('safe_local_documents_unsupported');
  const adapter = await fs.documentAdapter();
  return { kind: fs.kind, id: adapter.bindingId, root: fs.kind === 'tauri' ? fs.label() : fs.kind === 'managed' ? fs.id().slice('managed:'.length) : adapter.bindingId };
}
export async function restorePreviewBinding(binding: PreviewLocalBinding, requestPermission = false): Promise<LocalFs> {
  let fs: LocalFs;
  if (binding.kind === 'browser') {
    const handle = await browserHandleByBinding(binding.id) as FileSystemDirectoryHandle & {
      queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
      requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    };
    let permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && requestPermission) permission = await handle.requestPermission({ mode: 'read' });
    if (permission !== 'granted') throw new DocumentProtocolError('local_permission_required');
    fs = new BrowserLocalFs(handle);
  } else if (binding.kind === 'tauri') fs = new TauriLocalFs(binding.root);
  else fs = new ManagedBrowserLocalFs(binding.root);
  const adapter = await fs.documentAdapter!();
  if (adapter.bindingId !== binding.id) throw new DocumentProtocolError('local_binding_changed');
  return fs;
}
