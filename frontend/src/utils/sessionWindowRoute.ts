export interface SessionWindowRoute { session: string; executor: string; windowId: string; homeWindow: string }
export function readSessionWindowRoute(search: string): SessionWindowRoute | null {
  const p = new URLSearchParams(search), session = p.get('windowSession') || '', executor = p.get('windowExecutor') || '';
  const windowId = p.get('workbenchWindow') || '', homeWindow = p.get('workbenchHome') || '';
  if (p.get('sessionWindow') !== '1' || ![session, windowId, homeWindow].every(v => /^[\w-]{1,128}$/.test(v))
    || !executor || executor.length > 512) return null;
  return { session, executor, windowId, homeWindow };
}
export function sessionWindowUrl(pathname: string, route: SessionWindowRoute): string {
  // 从 pathname 新建，绝不复制来源 URL 中可能存在的 token 或正文参数。
  const p = new URLSearchParams({ sessionWindow: '1', windowSession: route.session, windowExecutor: route.executor,
    workbenchWindow: route.windowId, workbenchHome: route.homeWindow });
  if (!readSessionWindowRoute('?' + p.toString())) throw new Error('会话窗口路由无效');
  return `${pathname}?${p}`;
}
