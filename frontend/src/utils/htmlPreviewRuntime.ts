/** 在 opaque-origin iframe 内运行；只通过受限消息读取资源，不暴露 API、凭据或写文件入口。 */
export function htmlPreviewRuntime(channel: string, base: string, fragment: string): void {
  let seq = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>();
  const post = (kind: string, extra: object) => parent.postMessage({ type: 'awu-html-preview', channel, kind, ...extra }, '*');
  const request = (url: string): Promise<{ data: string; mime: string }> => new Promise((resolve, reject) => {
    if (pending.size >= 8) { reject(new Error('预览并发读取过多')); return; }
    const id = ++seq;
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error('资源读取超时')); }, 30_000);
    pending.set(id, { resolve, reject, timer }); post('read', { id, url });
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'awu-html-preview-result' || event.data.channel !== channel) return;
    const job = pending.get(event.data.id);
    if (!job) return;
    pending.delete(event.data.id); clearTimeout(job.timer);
    if (event.data.error) job.reject(new Error(event.data.error)); else job.resolve(event.data);
  });
  const report = (error: unknown) => post('notice', { message: String(error).slice(0, 500) });
  const scroll = (hash: string) => {
    try { document.getElementById(decodeURIComponent(hash.replace(/^#/, '')))?.scrollIntoView(); }
    catch (error) { report(error); }
  };
  if (fragment) document.addEventListener('DOMContentLoaded', () => scroll(fragment));
  window.addEventListener('error', event => report(event.message || '页面资源加载失败'));
  window.addEventListener('unhandledrejection', event => report(event.reason));
  window.addEventListener('securitypolicyviolation', () => report('部分资源被隔离策略阻止；外部 CDN、联网 API 或服务器路由请使用实际运行服务。'));
  // fetch 的相对路径必须相对于执行端 HTML，而不是 srcdoc 的控制端地址。
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) throw new Error('静态预览不执行写入 API；请使用实际运行服务');
    if (init?.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, base);
    if (url.origin !== new URL(base).origin) throw new Error('静态预览不访问外部 API');
    const result = await request(url.href);
    const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
    return new Response(method === 'HEAD' ? null : bytes, { status: 200, headers: { 'Content-Type': result.mime } });
  };
  // 点击后仍在同一执行节点打开关联文件；锚点留给原生浏览器，保留页面事件处理器。
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null;
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!href || /^javascript:/i.test(href)) return;
    event.preventDefault();
    try {
      const url = new URL(href, base);
      if (href.startsWith('#') || (url.pathname === new URL(base).pathname && url.hash)) scroll(url.hash);
      else post('navigate', { url: url.href });
    } catch (error) { report(error); }
  });
  document.addEventListener('submit', event => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    report('该表单需要真实后端服务；预览不会把表单提交给 AgentWithU 接口。');
  });
  // 动态插入的图片也按原目录读，不轮询目录。脚本模块依赖由外层 import map 解析。
  const inflight = new WeakMap<Element, string>();
  const hydrate = (node: Element) => {
    const attr = node.matches('img, source, video, audio') ? 'src' : null;
    const value = attr ? node.getAttribute(attr) : null;
    if (!attr || !value || /^(?:data:|blob:)/i.test(value) || inflight.get(node) === value) return;
    inflight.set(node, value);
    void request(new URL(value, base).href).then(result => {
      if (node.getAttribute(attr) === value) node.setAttribute(attr, `data:${result.mime};base64,${result.data}`);
    }).catch(report);
  };
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') hydrate(record.target as Element);
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        hydrate(node); node.querySelectorAll('img[src], source[src], video[src], audio[src]').forEach(hydrate);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
}
