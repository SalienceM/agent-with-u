import { init, parse } from 'es-module-lexer';

// 虚拟地址只用于解析相对路径，绝不指向控制端 HTTP 服务。
export const HTML_PREVIEW_ORIGIN = 'https://awu-preview.invalid';
export const HTML_PREVIEW_FILE_LIMIT = 8 * 1024 * 1024;
const TOTAL_LIMIT = 32 * 1024 * 1024;
const FILE_LIMIT = 128;

export function previewFileUrl(rel: string): string {
  return `${HTML_PREVIEW_ORIGIN}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function previewRelativePath(href: string): string {
  const url = new URL(href);
  if (url.origin !== HTML_PREVIEW_ORIGIN) throw new Error('不是当前预览目录内的资源');
  const path = decodeURIComponent(url.pathname).replace(/^\//, '');
  // 页面脚本只获得静态预览读能力，不能读取隐藏配置、密钥或跨出工作区。
  if (!path || /[\\\x00-\x1f:]/.test(path)
    || path.split('/').some(part => part.startsWith('.') || !part)
    || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(path)) {
    throw new Error('预览不允许读取该路径');
  }
  return path;
}

export function resolvePreviewUrl(raw: string, base: string, root: string): string {
  let value = raw.trim();
  if (/^(?:file:|[a-z]:[\\/])/i.test(value)) {
    const filePath = /^file:/i.test(value) ? (() => {
      const file = new URL(value);
      if (file.hostname && file.hostname !== 'localhost') throw new Error('预览不访问网络共享');
      return decodeURIComponent(file.pathname).replace(/^\/(?=[a-z]:\/)/i, '');
    })() : value;
    const normalized = filePath.replace(/\\/g, '/');
    const prefix = root.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const windows = /^[a-z]:\//i.test(prefix);
    if (!(windows ? normalized.toLowerCase().startsWith(prefix.toLowerCase()) : normalized.startsWith(prefix))) {
      throw new Error('文件链接超出当前工作目录');
    }
    value = previewFileUrl(normalized.slice(prefix.length));
  }
  const resolved = new URL(value, base);
  if (resolved.origin === HTML_PREVIEW_ORIGIN) {
    // URL 会折叠 ..；额外检查原始层级，不能把越界链接悄悄改成根目录文件。
    let depth = value.startsWith('/') ? 0 : new URL(base).pathname.split('/').length - 2;
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
      for (const part of decodeURIComponent(value.split(/[?#]/)[0]).split('/')) {
        if (part === '..' && --depth < 0) throw new Error('链接超出当前工作目录');
        if (part && part !== '.' && part !== '..') depth++;
      }
    }
    previewRelativePath(resolved.pathname.endsWith('/') ? new URL('__index__.html', resolved).href : resolved.href);
  }
  return resolved.href;
}

export function previewMime(path: string): string {
  const ext = path.split(/[?#]/)[0].split('.').pop()?.toLowerCase() || '';
  return ({ html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
    json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif', woff: 'font/woff',
    woff2: 'font/woff2', ttf: 'font/ttf', mp3: 'audio/mpeg', mp4: 'video/mp4', txt: 'text/plain',
    csv: 'text/csv', wasm: 'application/wasm', pdf: 'application/pdf',
  } as Record<string, string>)[ext] || 'application/octet-stream';
}

export function previewDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
const textUrl = (text: string, mime: string) => previewDataUrl(new TextEncoder().encode(text), mime);
const jsonScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export interface HtmlPreviewBundle {
  srcDoc: string;
  warnings: string[];
  read: (href: string) => Promise<{ data: string; mime: string }>;
}

export async function buildHtmlPreview(options: {
  source: string; rel: string; root: string; channel: string; runtime: string;
  interactive: boolean; fragment?: string;
  readFile: (rel: string) => Promise<Uint8Array>; signal: AbortSignal;
}): Promise<HtmlPreviewBundle> {
  const { source, root, channel, runtime, readFile, signal } = options;
  let base = previewFileUrl(options.rel);
  const warnings: string[] = [];
  const warn = (message: string) => { if (warnings.length < 20 && !warnings.includes(message)) warnings.push(message); };
  const cache = new Map<string, Promise<Uint8Array>>();
  let total = 0;
  let embedded = source.length;
  const embed = (bytes: Uint8Array, mime: string) => {
    embedded += Math.ceil(bytes.byteLength / 3) * 4;
    if (embedded > 48 * 1024 * 1024) throw new Error('页面内嵌资源超过大小上限');
    return previewDataUrl(bytes, mime);
  };
  const read = (url: string): Promise<Uint8Array> => {
    signal.throwIfAborted();
    const rel = previewRelativePath(url);
    if (!cache.has(rel)) {
      if (cache.size >= FILE_LIMIT) throw new Error('页面资源超过 128 个，已停止加载');
      if (total >= TOTAL_LIMIT) throw new Error('页面资源超过预览大小上限');
      cache.set(rel, (async () => {
        const bytes = await readFile(rel);
        signal.throwIfAborted();
        total += bytes.byteLength;
        if (bytes.byteLength > HTML_PREVIEW_FILE_LIMIT || total > TOTAL_LIMIT) throw new Error('页面资源超过预览大小上限');
        return bytes;
      })());
    }
    return cache.get(rel)!;
  };
  const resolve = (value: string, from: string) => resolvePreviewUrl(value, from, root);
  const asset = async (value: string, from: string): Promise<string> => {
    if (!value.trim() || value.startsWith('#') || value.startsWith('data:')) return value;
    const url = resolve(value, from);
    if (new URL(url).origin !== HTML_PREVIEW_ORIGIN) throw new Error(`外部资源未加载：${value}`);
    return embed(await read(url), previewMime(url)) + new URL(url).hash;
  };
  const css = async (text: string, from: string, ancestors: string[] = []): Promise<string> => {
    if (ancestors.length > 12) throw new Error('CSS 引用层级过深');
    // 保留媒体条件；先展开 @import 的 URL，再处理普通 url()，避免重复编码 data URI。
    const tokens = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s;)]+))\s*\)?|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let result = ''; let cursor = 0;
    for (const match of text.matchAll(tokens)) {
      result += text.slice(cursor, match.index);
      cursor = match.index! + match[0].length;
      const isImport = /^@import/i.test(match[0]);
      const value = (isImport ? match[1] ?? match[2] ?? match[3] : match[4] ?? match[5] ?? match[6]).trim();
      try {
        let url: string;
        if (isImport && !value.startsWith('data:')) {
          const resolved = resolve(value, from);
          if (ancestors.includes(resolved)) throw new Error('CSS 循环引用');
          url = textUrl(await css(new TextDecoder().decode(await read(resolved)), resolved, [...ancestors, resolved]), 'text/css');
        } else url = await asset(value, from);
        result += `${isImport ? '@import ' : ''}url("${url.replace(/"/g, '%22')}")`;
      } catch (error) {
        warn(String(error)); result += isImport ? '@import url("data:text/css,")' : 'url("data:,")';
      }
    }
    return result + text.slice(cursor);
  };
  const doc = new DOMParser().parseFromString(source, 'text/html');
  if (!options.interactive) {
    doc.querySelectorAll('script').forEach(node => node.remove());
    doc.querySelectorAll('*').forEach(node => {
      for (const attr of Array.from(node.attributes)) {
        if (/^on/i.test(attr.name) || /^javascript:/i.test(attr.value.trim())) node.removeAttribute(attr.name);
      }
    });
  }
  const givenBase = doc.querySelector('base[href]')?.getAttribute('href');
  if (givenBase) {
    try {
      const candidate = resolve(givenBase, base);
      if (new URL(candidate).origin !== HTML_PREVIEW_ORIGIN) throw new Error('外部 base 地址不适用于执行端目录预览');
      base = candidate;
    } catch (error) { warn(String(error)); }
  }
  doc.querySelectorAll('base, meta[http-equiv], iframe, frame, object, embed').forEach(node => node.remove());
  const bases = doc.createElement('base'); bases.href = base;
  doc.head.prepend(bases);

  await init;
  const imports: Record<string, string> = {};
  const bareImports: Record<string, string> = {};
  for (const node of doc.querySelectorAll('script[type="importmap"]')) {
    try { Object.assign(bareImports, JSON.parse(node.textContent || '{}').imports || {}); }
    catch { warn('原页面 import map 无法解析'); }
    node.remove();
  }
  const modules = new Set<string>();
  const moduleText = (code: string, from: string): string => {
    let result = code;
    const edits: { start: number; end: number; text: string }[] = [];
    for (const item of parse(code)[0]) {
      if (item.d === -2) {
        // 保留资源相对于执行端模块的位置，不让 import.meta.url 指向 data URI。
        if (code.slice(item.e, item.e + 4) === '.url') edits.push({ start: item.s, end: item.e + 4, text: jsonScript(from) });
        continue;
      }
      if (!item.n) { warn('动态计算的模块路径需要实际开发服务器'); continue; }
      let name = item.n;
      if (!/^(?:\.?\.?\/|[a-z][a-z\d+.-]*:)/i.test(name)) {
        const prefix = Object.keys(bareImports).filter(key => key.endsWith('/') && name.startsWith(key)).sort((a, b) => b.length - a.length)[0];
        const mapped = bareImports[name] || (prefix ? bareImports[prefix] + name.slice(prefix.length) : '');
        if (!mapped) throw new Error(`裸模块 ${name} 需要 import map 或先构建项目`);
        name = resolve(mapped, base);
      }
      const url = resolve(name, from);
      if (new URL(url).origin !== HTML_PREVIEW_ORIGIN) throw new Error(`外部模块未加载：${name}`);
      modules.add(url);
      edits.push({ start: item.d >= 0 ? item.s : item.s - 1, end: item.d >= 0 ? item.e : item.e + 1, text: jsonScript(url) });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    return result;
  };
  for (const node of doc.querySelectorAll('style, [style]')) {
    if (node.tagName === 'STYLE') node.textContent = await css(node.textContent || '', base);
    if (node.hasAttribute('style')) node.setAttribute('style', await css(node.getAttribute('style') || '', base));
  }
  for (const node of doc.querySelectorAll('link[href], script, img[src], input[src], source[src], video[src], audio[src], video[poster], image[href], image[xlink\\:href]')) {
    signal.throwIfAborted();
    try {
      if (node.tagName === 'LINK') {
        const rel = (node.getAttribute('rel') || '').toLowerCase();
        if (rel === 'stylesheet') {
          const url = resolve(node.getAttribute('href') || '', base);
          node.setAttribute('href', textUrl(await css(new TextDecoder().decode(await read(url)), url, [url]), 'text/css'));
        } else if (rel.includes('icon')) node.setAttribute('href', await asset(node.getAttribute('href') || '', base));
        else node.remove();
      } else if (node.tagName === 'SCRIPT') {
        const type = (node.getAttribute('type') || '').toLowerCase();
        if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
        if (type === 'module') {
          if (node.hasAttribute('src')) {
            const url = resolve(node.getAttribute('src') || '', base);
            modules.add(url); node.removeAttribute('src'); node.textContent = `import ${jsonScript(url)};`;
          } else node.textContent = moduleText(node.textContent || '', base);
        } else if (node.hasAttribute('src')) node.setAttribute('src', await asset(node.getAttribute('src') || '', base));
      } else {
        for (const attr of ['src', 'poster', 'href', 'xlink:href']) {
          if (node.hasAttribute(attr)) node.setAttribute(attr, await asset(node.getAttribute(attr) || '', base));
        }
      }
      node.removeAttribute('integrity'); node.removeAttribute('crossorigin');
    } catch (error) { warn(String(error)); node.remove(); }
  }
  for (const node of doc.querySelectorAll('[srcset]')) {
    const original = node.getAttribute('srcset') || '';
    if (original.startsWith('data:')) continue;
    const parts: string[] = [];
    for (const entry of original.split(',')) {
      const [url, ...descriptor] = entry.trim().split(/\s+/);
      try { parts.push(`${await asset(url, base)} ${descriptor.join(' ')}`.trim()); }
      catch (error) { warn(String(error)); }
    }
    node.setAttribute('srcset', parts.join(', '));
  }
  // Set 迭代会访问新增依赖；映射到绝对虚拟 URL 支持循环模块而无需无限内联。
  for (const url of modules) {
    if (modules.size > FILE_LIMIT) throw new Error('模块依赖过多');
    try { imports[url] = textUrl(moduleText(new TextDecoder().decode(await read(url)), url), 'text/javascript'); }
    catch (error) { warn(String(error)); imports[url] = textUrl(`throw new Error(${jsonScript(String(error))});`, 'text/javascript'); }
  }
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri https://awu-preview.invalid";
  const bootstrap = doc.createElement('script');
  bootstrap.textContent = `(${runtime})(${jsonScript(channel)},${jsonScript(base)},${jsonScript(options.fragment || '')});`;
  const map = doc.createElement('script'); map.type = 'importmap'; map.textContent = jsonScript({ imports });
  doc.head.prepend(policy, bootstrap, map);
  return {
    srcDoc: '<!doctype html>\n' + doc.documentElement.outerHTML, warnings,
    read: async (href: string) => {
      const url = resolve(href, base);
      const data = previewDataUrl(await read(url), previewMime(url));
      return { data: data.slice(data.indexOf(',') + 1), mime: previewMime(url) };
    },
  };
}
