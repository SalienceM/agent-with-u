import React, { useEffect, useRef, useState } from 'react';
import { api, kitUpdateScope, onCurrentUserChanged, onExecStatus } from '../api';
import type { WorkspaceKit } from '../types/workspaceKits';
import type { SshProbe, SshProfile } from '../types/sshConnections';

const field: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '7px 9px',
  borderRadius: 6, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', color: 'var(--theme-text)' };
const button: React.CSSProperties = { ...field, width: 'auto', cursor: 'pointer', fontSize: 12 };
const row: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
const muted: React.CSSProperties = { fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.6 };

export const KitSshConnection: React.FC<{
  sessionId: string; kit: WorkspaceKit; value: string; onChange: (value: string) => void; running: boolean;
}> = (props) => {
  const [scope, setScope] = useState(() => kitUpdateScope(props.sessionId));
  useEffect(() => {
    const refresh = () => setScope(kitUpdateScope(props.sessionId));
    refresh();
    const offUser = onCurrentUserChanged(refresh), offExec = onExecStatus(refresh);
    return () => { offUser(); offExec(); };
  }, [props.sessionId]);
  return <ConnectionForm key={`${props.sessionId}:${scope}:${props.kit.id}:${props.kit.activeVersionId}`} {...props} />;
};

const ConnectionForm: React.FC<React.ComponentProps<typeof KitSshConnection>> = ({ sessionId, kit, value, onChange, running }) => {
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [mode, setMode] = useState('');
  const [selected, setSelected] = useState(value);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState({ label: '', host: '', port: 22, user: '', authMode: 'agent' as 'agent' | 'key', keyPath: '' });
  const [probe, setProbe] = useState<SshProbe | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  const request = useRef('');
  const scope = kitUpdateScope(sessionId);
  const current = () => alive.current && scope === kitUpdateScope(sessionId);
  const profile = profiles.find(item => item.id === selected);
  const savedId = String(kit.inputs.find(item => item.key === 'ssh_connection')?.default || '');

  useEffect(() => {
    alive.current = true;
    void api.kitSshConnections(sessionId, kit.id).then(result => {
      if (!current()) return;
      if (result.status !== 'ok') throw new Error(result.message || '当前执行端暂不支持保存 SSH 连接，请更新执行端');
      setProfiles(result.profiles || []); setMode(result.mode || 'custom');
    }).catch(error => { if (current()) { setMessage(String(error.message || error)); setFailed(true); } });
    return () => { alive.current = false; };
  }, [sessionId, kit.id, kit.activeVersionId]);
  useEffect(() => { if (value) setSelected(value); }, [value]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setMessage(''); setFailed(false);
    try { await work(); }
    catch (error) { if (current()) { setMessage(error instanceof Error ? error.message : String(error)); setFailed(true); } }
    finally { if (current()) setBusy(false); }
  };
  const edit = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch }); setProbe(null); setConfirmed(false); request.current = '';
  };
  const select = (id: string) => { setSelected(id); setMessage(''); if (mode === 'key') onChange(id); };

  return <div style={{ marginBottom: 14, minWidth: 0 }}>
    <div style={{ ...row, justifyContent: 'space-between', marginBottom: 8 }}>
      <strong style={{ fontSize: 13 }}>Linux 连接</strong>
      <button type="button" style={button} disabled={busy || !mode || mode === 'custom'} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起配置' : '添加连接'}</button>
    </div>
    {mode === 'custom' ? <div style={muted}>此 Kit 的 SSH 命令经过自定义，无法自动替换。请新建标准 SSH 更新 Kit 后配置密钥连接。</div> : <>
      <select aria-label="已保存的 SSH 连接" style={field} value={selected} disabled={busy || !mode} onChange={e => select(e.target.value)}>
        <option value="">选择已保存的连接</option>
        {profiles.map(item => <option key={item.id} value={item.id}>{item.label} · {item.user}@{item.host}:{item.port}</option>)}
      </select>
      {profile && <div style={{ marginTop: 8 }}>
        <div style={{ ...muted, overflowWrap: 'anywhere' }}>{profile.algorithm} · {profile.fingerprint}</div>
        <div style={{ ...muted, overflowWrap: 'anywhere' }}>{profile.authMode === 'agent' ? '使用执行节点的 SSH Agent' : `执行节点私钥：${profile.keyPath}`}</div>
        <div style={{ ...row, marginTop: 8 }}>
          <button type="button" style={button} disabled={busy} onClick={() => void act(async () => {
            const result = await api.kitSshTest(sessionId, profile.id);
            if (!current()) return;
            setMessage(result.message || '测试未返回结果'); setFailed(result.status !== 'ok');
          })}>测试连接</button>
          {savedId !== selected && <button type="button" style={button} disabled={busy || running || kit.enabled} onClick={() => void act(async () => {
            const result = await api.kitSshUse(sessionId, kit.id, selected, kit.activeVersionId || '');
            if (!current()) return;
            if (result.status !== 'ok') throw new Error(result.message || '切换失败，请刷新 Kit 核对当前版本');
            onChange(selected); setMode('key'); setMessage('已保存为新的执行版本。启用 Kit 后即可使用。');
          })}>{mode === 'legacy' ? '保存为密钥版' : '设为默认连接'}</button>}
          {savedId === selected && <span style={muted}>默认连接 · 下次自动使用</span>}
        </div>
        {savedId !== selected && kit.enabled && <div style={muted}>先在上方停用 Kit，再保存新版本；原版本和运行记录会保留。</div>}
      </div>}
      {mode === 'legacy' && <div style={{ ...muted, marginTop: 8 }}>当前仍是密码版。配置连接并保存为密钥版后，下面的密码输入会自动移除。</div>}
      {expanded && <fieldset disabled={busy} style={{ minWidth: 0, border: '1px solid var(--theme-border)', borderRadius: 8, margin: '12px 0 0', padding: 12 }}>
        <legend style={muted}>保存连接</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <label style={muted}>名称<input style={field} value={form.label} onChange={e => edit({ label: e.target.value })} placeholder="例如：家里的 Linux" /></label>
          <label style={muted}>主机地址<input style={field} value={form.host} onChange={e => edit({ host: e.target.value })} placeholder="IP 或主机名" /></label>
          <label style={muted}>SSH 端口<input style={field} type="number" value={form.port} onChange={e => edit({ port: Number(e.target.value) })} /></label>
          <label style={muted}>SSH 账户<input style={field} value={form.user} onChange={e => edit({ user: e.target.value })} /></label>
          <label style={muted}>登录方式<select style={field} value={form.authMode} onChange={e => edit({ authMode: e.target.value as 'agent' | 'key' })}>
            <option value="agent">SSH Agent</option><option value="key">已有私钥文件</option></select></label>
          {form.authMode === 'key' && <label style={muted}>执行节点上的私钥路径<input style={field} value={form.keyPath} onChange={e => edit({ keyPath: e.target.value })} placeholder="C:\Users\…\.ssh\id_ed25519" /></label>}
        </div>
        <p style={muted}>公钥需已加入 Linux 账户的 authorized_keys。加密私钥请先加入并解锁 SSH Agent。只保存路径和服务器指纹，密码与私钥内容不会保存。</p>
        <button type="button" style={button} disabled={!form.host || !form.user} onClick={() => void act(async () => {
          setProbe(null); setConfirmed(false); request.current = '';
          const result = await api.kitSshProbe(sessionId, form);
          if (!current()) return;
          if (result.status !== 'ok') throw new Error(result.message || '未取得服务器指纹');
          setProbe(result);
        })}>读取服务器指纹</button>
        {probe && <div style={{ marginTop: 10 }}>
          <div style={{ ...muted, overflowWrap: 'anywhere' }}>{probe.algorithm} · {probe.fingerprint}</div>
          <label style={{ ...muted, display: 'block', margin: '8px 0' }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> 我已对照服务器管理端核对这个指纹</label>
          <button type="button" style={button} disabled={!confirmed} onClick={() => void act(async () => {
            request.current ||= crypto.randomUUID();
            const result = await api.kitSshSave(sessionId, { ...form, probeId: probe.probeId, fingerprint: probe.fingerprint, confirmed }, request.current);
            if (!current()) return;
            if (result.status !== 'ok' || !result.profile) throw new Error(result.message || '保存结果未确认，请重新打开连接列表核对');
            setProfiles(items => [...items.filter(item => item.id !== result.profile!.id), result.profile!]);
            select(result.profile.id); setExpanded(false); setProbe(null); setConfirmed(false);
            setMessage('连接已保存。可先测试登录，再将其设为此 Kit 的默认连接。');
          })}>确认指纹并保存</button>
        </div>}
      </fieldset>}
    </>}
    {busy && <div role="status" style={muted}>正在处理…</div>}
    {message && <div role={failed ? 'alert' : 'status'} style={{ ...muted, marginTop: 8, color: failed ? '#ff7b72' : undefined }}>{message}</div>}
  </div>;
};
