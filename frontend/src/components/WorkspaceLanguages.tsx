import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { WorkspaceLanguages, languageResources, providerForPath, type LanguageConfig, type LanguageDiagnostics, type LanguagePlan, type LanguageRecord } from '../utils/workspaceLanguages';
import { documentStore, type DocumentBuffer } from '../utils/documentStore';
import { sameWorkspace } from '../utils/workspaceDocuments';
import { resourceHandoff } from '../utils/resourceHandoff';
import { handoffScope } from '../utils/workbenchHandoffState';
import { useWindowWriteBlocked } from '../hooks/useWindowWriteBlocked';
import { WorkbenchPopover, workbenchButtonStyle, workbenchFieldStyle } from './WorkbenchChrome';
import { WorkbenchInteractionContext } from './AppModalPortal';

interface ContextValue {
  client: WorkspaceLanguages | null; rows: LanguageRecord[]; diagnostics: Record<string, LanguageDiagnostics[]>;
  blocked: boolean; error: string; sync(service: LanguageRecord): Promise<void>; refresh(): Promise<void>;
}
const Context = createContext<ContextValue | null>(null);
export const useWorkspaceLanguages = () => useContext(Context);
export function belongsToLanguage(doc: Readonly<DocumentBuffer>, row: LanguageRecord): boolean {
  return doc.identity.source === 'executor' && doc.read?.editable === true && sameWorkspace(row.workspace, doc.identity.workspace)
    && (providerForPath(doc.identity.relativePath) === row.provider || row.provider === 'vue' && providerForPath(doc.identity.relativePath) === 'react');
}
const style = workbenchButtonStyle;

export const WorkspaceLanguageProvider: React.FC<React.PropsWithChildren<{ user: string; executor: string; session: string; workingDir: string; ready: boolean }>> = props => {
  const { user, executor, session, workingDir, ready } = props;
  const scope = handoffScope(user, executor, session, workingDir);
  const [client, setClient] = useState<WorkspaceLanguages | null>(null), [rows, setRows] = useState<LanguageRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<Record<string, LanguageDiagnostics[]>>({}), [error, setError] = useState('');
  const blocked = useWindowWriteBlocked(executor, session);
  const epoch = useRef(0), rowsRef = useRef(rows), clientRef = useRef(client), blockedRef = useRef(blocked);
  rowsRef.current = rows; clientRef.current = client; blockedRef.current = blocked;
  const serial = useRef(Promise.resolve()), pendingSync = useRef(0);
  const remember = (records: LanguageRecord[]) => {
    records = records.map(row => { const old = rowsRef.current.find(r => r.resourceId === row.resourceId && r.generation === row.generation); return old && old.revision > row.revision ? old : row; });
    rowsRef.current = records; setRows(records); languageResources.set(scope, records);
  };
  const refresh = async () => {
    const selected = clientRef.current, version = epoch.current; if (!selected) return;
    const result = await selected.list(); if (version === epoch.current) remember(result.services);
  };
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  const reads = useRef(new Map<string, { promise: Promise<void>; wanted: LanguageRecord }>());
  const readDiagnostics = (row: LanguageRecord) => {
    const selected = clientRef.current, version = epoch.current; if (!selected) return Promise.resolve();
    const key = `${version}:${row.resourceId}:${row.generation}`;
    const existing = reads.current.get(key); if (existing) { existing.wanted = row; return existing.promise; }
    const entry = { promise: Promise.resolve(), wanted: row };
    entry.promise = (async () => {
      do {
        const wanted = entry.wanted;
        const result = await selected.diagnostics(wanted);
        if (version !== epoch.current) return;
        setDiagnostics(old => ({ ...old, [row.resourceId]: result }));
        if (wanted.revision === entry.wanted.revision) return;
      } while (version === epoch.current);
    })().finally(() => reads.current.delete(key));
    reads.current.set(key, entry); return entry.promise;
  };
  const sync = (row: LanguageRecord) => {
    const selected = clientRef.current, version = epoch.current;
    if (!selected || blockedRef.current) return Promise.reject(new Error('语言服务窗口归属未就绪'));
    if (pendingSync.current >= 16) return Promise.reject(new Error('语义同步队列已满'));
    pendingSync.current++;
    const result = serial.current.catch(() => {}).then(async () => {
      if (version !== epoch.current || blockedRef.current) throw new Error('语言服务窗口归属已变化');
      const current = rowsRef.current.find(r => r.resourceId === row.resourceId && r.generation === row.generation);
      if (current?.status !== 'ready') throw new Error('语言服务未就绪');
      const docs = documentStore.all().filter(doc => belongsToLanguage(doc, current));
      if (docs.length > 32) throw new Error('语义同步最多 32 个打开文件');
      for (const closed of current.documents.filter(old => !docs.some(doc =>
        doc.identity.relativePath === old.relativePath || current.workspace.workingDir.includes(':')
          && doc.identity.relativePath.toLowerCase() === old.relativePath.toLowerCase()))) {
        const response = await selected.request(current, 'close', closed);
        if (version !== epoch.current || blockedRef.current) throw new Error('语言服务身份或窗口归属已变化');
        remember(rowsRef.current.map(r => r.resourceId === row.resourceId ? response.service : r));
      }
      for (const doc of docs) {
        const response = await selected.request(current, 'sync', { relativePath: doc.identity.relativePath, revision: doc.revision, text: doc.text });
        if (version !== epoch.current) throw new Error('语言服务身份已变化');
        remember(rowsRef.current.map(r => r.resourceId === row.resourceId ? response.service : r));
      }
    }).finally(() => { pendingSync.current--; });
    serial.current = result; return result;
  };
  const syncRef = useRef(sync); syncRef.current = sync;
  useEffect(() => {
    const version = ++epoch.current; setClient(null); clientRef.current = null; setRows([]); setDiagnostics({}); setError('');
    if (!ready) return;
    void api.workspaceLanguages(session, executor, workingDir, () => epoch.current === version).then(value => {
      if (epoch.current !== version) return; setClient(value); clientRef.current = value; return refreshRef.current();
    }).catch(reason => { if (epoch.current === version) setError(String(reason)); });
    const off = api.onLanguageUpdated((data, from) => {
      if (from !== executor || data.sessionId !== session || epoch.current !== version || !clientRef.current) return;
      try {
        const row = clientRef.current.record(data);
        remember([...rowsRef.current.filter(r => r.resourceId !== row.resourceId), row]);
        void readDiagnostics(row).catch(reason => { if (epoch.current === version) setError(String(reason)); });
      } catch { /* 旧身份不改变当前状态 */ }
    });
    const offConnection = api.onSessionConnectionStatus(session, connected => {
      if (connected) void refreshRef.current().catch(reason => setError(String(reason)));
      else setError('语言服务连接中断；只读核对原实例，不自动重启。');
    });
    return () => { epoch.current++; off(); offConnection(); };
  }, [scope, ready]);
  const signature = rows.filter(r => r.status === 'ready').map(r => `${r.resourceId}:${r.generation}`).join(',');
  useEffect(() => {
    if (!client || blocked || !signature) return;
    let timer: ReturnType<typeof setTimeout> | undefined, running = false, wanted = false, active = true, last = '';
    const run = async () => {
      if (running) { wanted = true; return; }
      running = true;
      try {
        for (const row of rowsRef.current.filter(r => r.status === 'ready')) {
          if (!active || blockedRef.current) return;
          await syncRef.current(row);
          if (!active || blockedRef.current) return;
          await client.request(row, 'diagnostics');
          await readDiagnostics(row);
        }
      } catch (reason) { if (active) setError(String(reason)); }
      finally { running = false; if (wanted && active) { wanted = false; timer = setTimeout(() => void run(), 350); } }
    };
    const schedule = () => {
      const next = documentStore.all().filter(d => rowsRef.current.some(r => r.status === 'ready' && belongsToLanguage(d, r)))
        .map(d => `${d.key}:${d.lifecycleId}:${d.revision}`).join('|');
      if (next === last) return; last = next; clearTimeout(timer); timer = setTimeout(() => void run(), 350);
    };
    schedule(); const off = documentStore.subscribe(schedule);
    return () => { active = false; off(); clearTimeout(timer); };
  }, [client, signature, blocked]);
  useEffect(() => ready ? resourceHandoff.register(scope, 'languages', {
    export: async () => {
      if (pendingSync.current) throw new Error('语义缓冲区正在同步，请稍后移动');
      await refreshRef.current();
      return rowsRef.current.map(row => ({ resourceId: row.resourceId, generation: row.generation }));
    },
    import: async (value: any) => {
      if (!Array.isArray(value) || value.length > 64) throw new Error('语言资源交接无效');
      if (!value.length) return;
      if (!clientRef.current) { const version = epoch.current; clientRef.current = await api.workspaceLanguages(session, executor, workingDir, () => version === epoch.current); setClient(clientRef.current); }
      const result = await clientRef.current.list();
      if (value.some(ref => !result.services.some(row => row.resourceId === ref.resourceId && row.generation === ref.generation))) throw new Error('原语言实例不可恢复；不会重新启动或导入项目');
      remember(result.services);
    },
  }) : undefined, [scope, ready]);
  return <Context.Provider value={{ client, rows, diagnostics, blocked, error, sync, refresh }}>{props.children}</Context.Provider>;
};

export const WorkspaceLanguagePanel: React.FC<{ openSignal?: unknown }> = ({ openSignal }) => {
  const context = useWorkspaceLanguages();
  const frozen = useContext(WorkbenchInteractionContext);
  const [config, setConfig] = useState<LanguageConfig>({ provider: 'python' });
  const [plan, setPlan] = useState<LanguagePlan | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [code, setCode] = useState(false), [write, setWrite] = useState(false), [build, setBuild] = useState(false);
  useEffect(() => { setPlan(null); setCode(false); setWrite(false); setBuild(false); setMessage(''); }, [context?.client]);
  if (!context) return null;
  const { client, rows, blocked, error, refresh } = context;
  const fields = config.provider === 'java' ? [['javaPath', 'JDT LS 运行 Java 21 可执行文件'], ['projectJdk', '项目 JDK 目录'], ['jdtHome', 'JDT LS 1.42 目录'], ...(config.gradleImport ? [['gradleHome', '已安装 Gradle 目录（禁用 wrapper）']] : []), ...(config.mavenImport ? [['mavenRepository', '已准备 Maven 离线仓库目录']] : [])]
    : [['nodePath', '执行节点 Node 可执行文件'], ['toolsHome', '固定提供器 node_modules 目录'], ...(config.provider === 'python'
      ? [['pythonPath', '项目 Python 解释器'], ['ruffPath', 'Ruff 0.11.13 可执行文件']]
      : [['typescriptHome', '所选 TypeScript 5.7.3 包目录']])];
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setMessage(''); try { await action(); } catch (reason) { setMessage(String(reason)); } finally { setBusy(false); } };
  const readyCount = rows.filter(row => row.status === 'ready').length;
  return <WorkbenchPopover label="工程语言服务" icon="language" width={580} disabled={frozen} openSignal={openSignal}
    trigger={<span style={{ fontSize: 11, color: error || rows.some(row => row.status === 'failed') ? 'var(--theme-error)' : readyCount ? 'var(--theme-success)' : 'var(--theme-text-muted)' }}>{readyCount || '配置'}</span>}>
    {() => <div data-engine-language-panel style={{ padding: 6 }}>
    <div style={{ fontWeight: 600 }}>工程语言服务 · {readyCount} 就绪（需显式启用）</div>
    {(error || message) && <div role="status">{message || error}</div>}
    <p style={{ color: 'var(--theme-text-muted)' }}>所有路径都属于执行节点 {client?.target.executor || '尚未连接'}。不会自动安装、下载依赖或启动项目；基础编辑始终可用。</p>
    {rows.map(row => <div key={row.resourceId} style={{ padding: 10, marginBottom: 8, background: 'var(--theme-panel-solid)', border: '1px solid var(--theme-border)', borderRadius: 6, overflowWrap: 'anywhere' }}>
      <strong>{row.provider} · {row.status}</strong> · {row.reasonCode} · {row.workspace.workingDir}
      <details><summary>运行时 / 能力</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ config: row.config, versions: row.dependencies, capabilities: row.capabilities }, null, 2)}</pre></details>
      {!row.exitConfirmed && <button className="awu-wb-control" style={style} disabled={!client || blocked || busy} onClick={() => void run(async () => {
        const result = await client!.stop(row); await refresh(); setMessage(result.exitConfirmed ? '已确认语言服务及所属进程退出。' : '停止未确认，活动保护仍保留。');
      })}>停止语言服务及所属进程</button>}
    </div>)}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
    <select style={{ ...workbenchFieldStyle, flex: 1 }} aria-label="工程语言提供器" value={config.provider} disabled={busy} onChange={event => { setConfig({ provider: event.target.value as LanguageConfig['provider'] }); setPlan(null); }}>
      {['java', 'python', 'react', 'vue'].map(value => <option key={value}>{value}</option>)}
    </select>
    <button className="awu-wb-control" style={style} disabled={!client || busy} onClick={() => void run(refresh)}>只读核对原实例</button>
    </div>
    {fields.map(([key, label]) => <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}><span style={{ color: 'var(--theme-text-muted)' }}>{label}</span>
      <input aria-label={label} value={String(config[key] || '')} style={workbenchFieldStyle} onChange={event => { setConfig(old => ({ ...old, [key]: event.target.value })); setPlan(null); }} /></label>)}
    {config.provider === 'java' && (['mavenImport', 'gradleImport'] as const).map(key => <label key={key} style={{ marginRight: 10 }}>
      <input type="checkbox" checked={config[key] === true} onChange={event => { setConfig(old => ({ ...old, [key]: event.target.checked })); setPlan(null); }} />{key}（离线导入，另需许可）</label>)}
    <button className="awu-wb-control" style={{ ...style, color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', marginTop: 4 }} disabled={!client || busy || blocked} onClick={() => void run(async () => { setPlan(await client!.plan(config)); setCode(false); setWrite(false); setBuild(false); })}>检查依赖并生成启用计划</button>
    {plan && <div role="group" aria-label="语言服务启用确认" style={{ padding: 8, border: '1px solid var(--theme-border)' }}>
      <p>{plan.notice}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ node: client?.target.executor, workspace: plan.workspace.workingDir, config: plan.config, dependencies: plan.dependencies, effects: plan.effects }, null, 2)}</pre>
      <label><input type="checkbox" checked={code} onChange={e => setCode(e.target.checked)} />允许此固定提供器读取项目配置并执行其分析代码</label><br />
      <label><input type="checkbox" checked={write} onChange={e => setWrite(e.target.checked)} />允许该服务写入所列工作区/独立缓存（不是 OS 沙箱）</label><br />
      {plan.effects.buildImport && <label><input type="checkbox" checked={build} onChange={e => setBuild(e.target.checked)} />另行允许所列 Maven/Gradle 离线构建导入；可能执行项目构建代码</label>}
      <button className="awu-wb-control" style={style} disabled={!client || blocked || busy || !code || !write || plan.effects.buildImport && !build} onClick={() => void run(async () => {
        const listing = await client!.list(); await client!.start(plan, listing.controlRevision, { allowProjectCode: code, allowWorkspaceWrite: write, allowBuildImport: build });
        setPlan(null); await refresh(); setMessage('启用请求已提交；以实例就绪状态为准。');
      })}>按此计划启用</button>
      <button className="awu-wb-control" style={style} onClick={() => setPlan(null)}>取消计划</button>
    </div>}
  </div>}</WorkbenchPopover>;
};
