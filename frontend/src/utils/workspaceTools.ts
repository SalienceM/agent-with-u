/** 聊天应用工具的窄路由层；不接受模型提供的 RPC 方法名或连接参数。 */
export interface WorkspaceNode {
  id: string;
  name: string;
  connected: boolean;
  online?: boolean;
  isCurrent?: boolean;
  isDefault?: boolean;
  canCreate?: boolean;
}

export interface WorkspaceToolRequest {
  id: string;
  sessionId: string;
  phase: 'query' | 'prepare' | 'commit';
  arguments: Record<string, any>;
}

export interface WorkspaceDriver {
  nodes: (discover: boolean) => Promise<WorkspaceNode[]>;
  request: (node: string, method: string, params: unknown[]) => Promise<any>;
  assertCurrent: () => void;
}

export function resolveWorkspaceNode(nodes: WorkspaceNode[], value?: string): { node?: WorkspaceNode; status?: string; candidates?: WorkspaceNode[] } {
  if (!value) {
    const node = nodes.find(item => item.isCurrent);
    return node ? { node } : { status: 'unavailable', candidates: [] };
  }
  const exact = nodes.filter(item => item.id === value);
  const named = nodes.filter(item => item.name.toLocaleLowerCase() === value.toLocaleLowerCase());
  const partial = nodes.filter(item => item.name.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  const matches = exact.length ? exact : named.length ? named : partial;
  return matches.length === 1 ? { node: matches[0] }
    : { status: matches.length ? 'ambiguous' : 'not_found', candidates: matches };
}

export function workspaceSessionLink(nodeId: string, sessionId: string): string {
  return `#awu-session=${encodeURIComponent(sessionId)}&node=${encodeURIComponent(nodeId)}`;
}

export function parseWorkspaceSessionLink(href: string): { node: string; session: string } | null {
  if (!href.startsWith('#awu-session=')) return null;
  const params = new URLSearchParams(href.slice(1));
  const session = params.get('awu-session') || '';
  const node = params.get('node') || '';
  return session && node && session.length < 200 && node.length < 300 ? { node, session } : null;
}

export async function executeWorkspaceRequest(data: WorkspaceToolRequest, driver: WorkspaceDriver): Promise<Record<string, any>> {
  driver.assertCurrent();
  if (!data || !['query', 'prepare', 'commit'].includes(data.phase) || !data.sessionId || !data.arguments) {
    throw new Error('无效的应用操作请求');
  }
  const args = data.arguments;
  const nodes = await driver.nodes(data.phase === 'query' && args.action === 'nodes');
  driver.assertCurrent();
  if (data.phase === 'query' && args.action === 'nodes') return { status: 'ok', nodes };
  const selected = resolveWorkspaceNode(nodes, args.node);
  if (!selected.node) return { status: selected.status, candidates: selected.candidates, message: '请使用候选中的真实节点 ID；不自动选择重名节点' };
  const node = selected.node;
  const origin = `session:${data.sessionId}`;
  const routed: Record<string, any> = { ...args, node: node.id };
  if (node.isCurrent && !routed.session && ['files', 'read_file', 'write_files'].includes(args.action)) {
    routed.session = data.sessionId;
  }
  let method: string;
  let params: unknown[];
  if (data.phase === 'commit') {
    if (!args.requestId || typeof args.fingerprint !== 'string' || !args.node) throw new Error('缺少冻结计划信息');
    method = 'workspaceCommit';
    params = [origin, args.requestId, args.fingerprint];
  } else if (data.phase === 'prepare') {
    if (!['create_session', 'write_files'].includes(args.action)) throw new Error('不支持该写操作');
    if (args.action === 'create_session' && node.canCreate === false) throw new Error('该节点不接受新 Session');
    method = 'workspacePrepare';
    params = [origin, JSON.stringify(routed)];
  } else if (args.action === 'status') {
    method = 'workspaceOperationStatus';
    params = [origin, args.requestId];
  } else {
    if (!['sessions', 'backends', 'files', 'read_file'].includes(args.action)) throw new Error('不支持该查询');
    method = 'workspaceQuery';
    params = [JSON.stringify(routed)];
  }
  driver.assertCurrent();
  const raw = await driver.request(node.id, method, params);
  driver.assertCurrent();
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!result || typeof result.status !== 'string') throw new Error('目标节点未支持应用工具协议或没有返回有效回执，请升级该节点');
  const session = result.receipt?.session;
  return { ...result, node, ...(session?.id ? { sessionLink: workspaceSessionLink(node.id, session.id) } : {}) };
}
