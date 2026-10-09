/** 容器无关的预览适配；二进制/专用格式永不产生安全保存基线。 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
export const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
export const HTML_EXTS = new Set(['html', 'htm']);
export const STRUCTURED_PREVIEW_EXTS = new Set(['doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt']);
export const PREVIEW_TEXT_CAP = 200_000;
export const PREVIEW_ARCHIVE_CAP = 32 * 1024 * 1024;
export const PREVIEW_PDF_CAP = 64 * 1024 * 1024;

export interface DocumentPreview<TStructured = unknown> {
  rel: string; name: string; source: 'remote' | 'local';
  loading: boolean; text?: string; dataUrl?: string; isImage?: boolean; isMarkdown?: boolean;
  isHtml?: boolean; htmlFragment?: string; truncated?: boolean;
  renderer?: 'pdf' | 'docx' | 'drawio'; bytes?: Uint8Array; drawioXml?: string;
  loadingText?: string; structured?: TStructured; error?: string;
}

export function extOf(name: string): string {
  const basename = name.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  if (basename === 'dockerfile' || basename === 'makefile') return basename;
  const index = basename.lastIndexOf('.');
  return index < 0 ? '' : basename.slice(index + 1);
}

export function imageMime(ext: string): string {
  return ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
}

export function defaultDocumentView(name: string): 'source' | 'preview' {
  const ext = extOf(name);
  return IMAGE_EXTS.has(ext) || MARKDOWN_EXTS.has(ext) || HTML_EXTS.has(ext)
    || STRUCTURED_PREVIEW_EXTS.has(ext) || ['pdf', 'docx', 'drawio', 'dio', 'prov'].includes(ext) ? 'preview' : 'source';
}

export async function loadDocumentPreview<T>(
  base: DocumentPreview<T>,
  io: { bytes: (max: number) => Promise<Uint8Array>; structured: (bytes?: Uint8Array) => Promise<T>;
    base64: () => Promise<string> },
): Promise<DocumentPreview<T>> {
  const done = { ...base, loading: false, loadingText: undefined };
  const ext = extOf(base.name);
  if (HTML_EXTS.has(ext)) {
    const bytes = await io.bytes(8 * 1024 * 1024);
    return { ...done, isHtml: true, text: new TextDecoder().decode(bytes) };
  }
  if (ext === 'pdf' || ext === 'docx') {
    return { ...done, renderer: ext, bytes: await io.bytes(ext === 'pdf' ? PREVIEW_PDF_CAP : PREVIEW_ARCHIVE_CAP) };
  }
  if (ext === 'drawio' || ext === 'dio') {
    const bytes = await io.bytes(PREVIEW_ARCHIVE_CAP);
    return { ...done, renderer: 'drawio', drawioXml: new TextDecoder().decode(bytes), structured: await io.structured(bytes) };
  }
  if (STRUCTURED_PREVIEW_EXTS.has(ext)) return { ...done, structured: await io.structured() };
  const encoded = await io.base64();
  if (IMAGE_EXTS.has(ext)) return { ...done, isImage: true, dataUrl: `data:${imageMime(ext)};base64,${encoded}` };
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  let text = new TextDecoder().decode(bytes);
  const truncated = text.length > PREVIEW_TEXT_CAP;
  if (truncated) text = text.slice(0, PREVIEW_TEXT_CAP) + '\n\n…（已截断,仅预览前 200KB）';
  return { ...done, isImage: false, isMarkdown: MARKDOWN_EXTS.has(ext), text, truncated };
}
