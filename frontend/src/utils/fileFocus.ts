export interface ResolvedFileLink {
  /** 工作目录内统一使用正斜杠的相对路径。 */
  relativePath: string;
  /** 去掉行列号后的原始文件路径，供右键菜单展示/复制。 */
  filePath: string;
  line?: number;
  column?: number;
}

export interface FileFocusRequest {
  requestId: number;
  sessionId: string;
  workingDir: string;
  relativePath: string;
}

interface ParsedFileHref {
  filePath: string;
  line?: number;
  column?: number;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value);
}

function isUncAbsolute(value: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

function isAbsolute(value: string): boolean {
  return isWindowsAbsolute(value) || isUncAbsolute(value) || value.startsWith('/');
}

/**
 * 规范化本地/执行端路径。不能使用浏览器所在系统的 path 模块，因为远端
 * Session 可能是 Linux，而当前客户端可能是 Windows（反之亦然）。
 */
export function normalizeFilePath(value: string): string {
  let path = safeDecode(String(value || '').trim()).replace(/\\/g, '/');
  const unc = path.startsWith('//');
  const drive = path.match(/^([a-z]:)(?:\/|$)/i)?.[1] || '';
  const rooted = !drive && !unc && path.startsWith('/');

  if (drive) path = path.slice(drive.length).replace(/^\/+/, '');
  else if (unc) path = path.replace(/^\/+/, '');
  else if (rooted) path = path.replace(/^\/+/, '');

  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!drive && !unc && !rooted) parts.push(part);
      continue;
    }
    parts.push(part);
  }

  const body = parts.join('/');
  if (drive) return body ? `${drive}/${body}` : `${drive}/`;
  if (unc) return `//${body}`;
  if (rooted) return `/${body}`;
  return body;
}

export function normalizeRelativeFilePath(value: string): string | null {
  const normalized = normalizeFilePath(value);
  if (!normalized || isAbsolute(normalized)) return null;
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function parseFileHref(rawHref: string): ParsedFileHref | null {
  let value = String(rawHref || '').trim();
  if (!value || value.startsWith('#')) return null;

  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:') return null;
      value = `${safeDecode(url.pathname)}${url.hash || ''}`;
      // file:///C:/path 在 URL.pathname 中会多一个前导斜杠。
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    } catch {
      return null;
    }
  } else if (!isWindowsAbsolute(value) && !isUncAbsolute(value)
    && /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // http(s)、mailto、data、blob 等都继续走普通链接逻辑。
    return null;
  }

  let line: number | undefined;
  let column: number | undefined;

  const hashMatch = value.match(/#L(\d+)(?:C(\d+))?$/i);
  if (hashMatch) {
    line = Number(hashMatch[1]);
    column = hashMatch[2] ? Number(hashMatch[2]) : undefined;
    value = value.slice(0, hashMatch.index);
  } else {
    const suffixMatch = value.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (suffixMatch) {
      value = suffixMatch[1];
      line = Number(suffixMatch[2]);
      column = suffixMatch[3] ? Number(suffixMatch[3]) : undefined;
    }
  }

  value = normalizeFilePath(value);
  return value ? { filePath: value, line, column } : null;
}

function comparablePath(value: string): string {
  const normalized = normalizeFilePath(value).replace(/\/$/, '');
  return (isWindowsAbsolute(normalized) || normalized.startsWith('//'))
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

export function sameWorkspacePath(left: string, right: string): boolean {
  if (!left || !right) return false;
  return comparablePath(left) === comparablePath(right);
}

/**
 * 把 Markdown 链接解析为当前 Session 工作目录内的文件。工作目录之外的
 * 绝对路径以及网页链接返回 null，避免把它们错误地交给文件面板。
 */
export function resolveFileLink(rawHref: string, workingDir: string): ResolvedFileLink | null {
  const parsed = parseFileHref(rawHref);
  const root = normalizeFilePath(workingDir).replace(/\/$/, '');
  if (!parsed || !root) return null;

  let relativePath = '';
  if (isAbsolute(parsed.filePath)) {
    const rootKey = comparablePath(root);
    const pathKey = comparablePath(parsed.filePath);
    if (!pathKey.startsWith(`${rootKey}/`)) return null;
    relativePath = parsed.filePath.slice(root.length + 1);
  } else {
    relativePath = parsed.filePath;
  }

  const normalizedRelative = normalizeRelativeFilePath(relativePath);
  if (!normalizedRelative) return null;
  return {
    relativePath: normalizedRelative,
    filePath: parsed.filePath,
    line: parsed.line,
    column: parsed.column,
  };
}
