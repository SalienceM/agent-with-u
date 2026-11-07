import { PreviewRegistry, type PreviewIdentity, type PreviewRegistration } from './previewLifecycle';

async function locked<T>(operation: (registry: PreviewRegistry) => T): Promise<T> {
  if (!navigator.locks) throw new Error('当前浏览器不支持安全的独立预览登记');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try { return await navigator.locks.request('awu-file-preview-registry-v2', { signal: controller.signal }, () => operation(new PreviewRegistry(localStorage))); }
  finally { clearTimeout(timer); }
}
export const registerPreview = (row: Omit<PreviewRegistration, 'expires'>) => locked(registry => registry.put(row));
export const removePreviewRegistration = (id: string, identity: PreviewIdentity) => locked(registry => registry.remove(id, identity));
