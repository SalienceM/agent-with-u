import { WorkflowButton, workflowHeaderStyle, workflowNavStyle, workflowDialogStyle, workflowFieldStyle } from './WorkflowControls';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CollaborationSummary, RoleProfile } from '../types/sessionCollaboration';
import { BackendRuntimeFields, isRuntimeConfigurableBackend } from './CodexRuntimeFields';
import { AppModalPortal } from './AppModalPortal';
import { uuid } from '../utils/uuid';

interface Props { session: string; executor: string; backends: any[]; backendId: string; onClose: () => void }
const empty = (): RoleProfile => ({ id: '', revision: 0, name: '', instructions: '', backendId: '', runtime: {}, enabled: true, archived: false });
const fieldStyle = workflowFieldStyle;

export const RoleLibrary: React.FC<Props> = ({ session, executor, backends, backendId, onClose }) => {
  const [rows, setRows] = useState<CollaborationSummary[]>([]), [next, setNext] = useState<number | null>(null);
  const [draft, setDraft] = useState<RoleProfile>(empty), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const version = useRef(0), panel = useRef<HTMLDivElement>(null), busyRef = useRef(false), edited = useRef(false);
  const actual = backends.find(item => item.id === (draft.backendId || backendId));
  const load = async (offset = 0) => {
    const v = ++version.current;
    try { const result = await api.collaborationList(session, executor, 'role', offset);
      if (v === version.current) { setRows(old => offset ? [...old, ...result.items] : result.items); setNext(result.nextOffset); }
    } catch (error) { if (v === version.current) setNotice(String(error)); }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    void load(); panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { version.current++; previous?.focus(); };
  }, [session, executor]);
  const select = async (row: CollaborationSummary) => {
    if (busyRef.current) return;
    if (edited.current) { setNotice('请先保存当前编辑，或点击“放弃编辑”后切换角色。'); return; }
    const v = ++version.current;
    try { const role = await api.collaborationGet(session, executor, 'role', row.id, row.revision);
      if (v === version.current) { setDraft(role); setNotice(''); edited.current = false; }
    } catch (error) { if (v === version.current) setNotice(String(error)); }
  };
  const edit = (fields: Partial<RoleProfile>) => { edited.current = true; setDraft(old => ({ ...old, ...fields })); };
  const save = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice('');
    const v = version.current;
    try {
      const { revision, ...profile } = draft;
      // 只送白名单字段，不把 lastRequestId 或旧回执变成新模板配置。
      const result = await api.roleProfileSave(session, executor, uuid(), { id: profile.id, name: profile.name, instructions: profile.instructions,
        backendId: profile.backendId, runtime: profile.runtime, enabled: profile.enabled, archived: profile.archived }, revision);
      if (v !== version.current) return;
      if (result.state !== 'succeeded' || !result.role) { setNotice(result.reason || '保存结果未知，请刷新核对'); return; }
      edited.current = false; setDraft(result.role); setNotice('已保存；后续评议使用此版本，历史意见保留。'); void load();
    } catch { if (v === version.current) setNotice('保存结果未知，请刷新角色库核对；没有重复提交。'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 32000, background: '#0008', display: 'grid', placeItems: 'center', padding: 10 }}>
    <div role="dialog" aria-modal="true" aria-label="角色库" ref={panel} style={{ ...workflowDialogStyle, width: 'min(960px, 100%)', height: 'min(760px, 90vh)', background: 'var(--theme-bg-secondary, white)', color: 'var(--theme-text, black)', borderRadius: 16, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current && !edited.current) onClose(); else setNotice('当前有编辑或保存操作，请先保存或放弃编辑。'); }
        if (event.key === 'Tab') {
          const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select')];
          const first = items[0], last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header style={workflowHeaderStyle}>
        <strong style={{ flex: 1 }}>角色库</strong>
        <WorkflowButton disabled={busy} onClick={() => { if (edited.current) { setNotice('请先保存或放弃编辑'); return; } setDraft(empty()); }}>新增角色</WorkflowButton>
        <WorkflowButton disabled={busy} onClick={() => void load()}>刷新</WorkflowButton>
        <WorkflowButton disabled={busy} onClick={() => { if (edited.current) setNotice('请先保存或放弃编辑'); else onClose(); }}>关闭角色库</WorkflowButton>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav aria-label="已维护角色" style={{ ...workflowNavStyle, width: 'clamp(90px, 25%, 220px)', flexShrink: 0, padding: 6, overflow: 'auto', borderRight: '1px solid var(--theme-border)' }}>
          {!rows.length && <p style={{ fontSize: 12 }}>暂无角色</p>}
          {rows.map(row => <WorkflowButton tone="quiet" key={row.id} aria-pressed={draft.id === row.id} onClick={() => void select(row)} style={{ display: 'block', width: '100%', padding: 8, marginBottom: 6, overflowWrap: 'anywhere' }}>{row.name}{row.archived ? ' · 已归档' : ''}</WorkflowButton>)}
          {next !== null && <WorkflowButton onClick={() => void load(next)}>更多角色</WorkflowButton>}
        </nav>
        <section style={{ padding: 20, flex: 1, minWidth: 0, overflow: 'auto' }}>
          <label>名称<input aria-label="角色名称" value={draft.name} disabled={busy} maxLength={80} style={fieldStyle} onChange={e => edit({ name: e.target.value })} /></label>
          <label style={{ display: 'block', marginTop: 12 }}>职责<textarea aria-label="角色职责" value={draft.instructions} disabled={busy} maxLength={8000} rows={6} style={fieldStyle} onChange={e => edit({ instructions: e.target.value })} /></label>
          <label style={{ display: 'block', marginTop: 12 }}>运行 Backend<select aria-label="角色 Backend" value={draft.backendId} disabled={busy} style={fieldStyle} onChange={e => edit({ backendId: e.target.value, runtime: {} })}>
            <option value="">跟随来源会话</option>{backends.filter(item => item.enabled !== false && item.type !== 'dashscope-image').map(item => <option value={item.id} key={item.id}>{item.label || item.id}</option>)}
          </select></label>
          {actual && isRuntimeConfigurableBackend(actual) && <BackendRuntimeFields backend={actual} value={draft.runtime} onChange={runtime => edit({ runtime })} execKey={executor} />}
          <div style={{ margin: '12px 0', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label><input type="checkbox" checked={draft.enabled} disabled={busy || draft.archived} onChange={e => edit({ enabled: e.target.checked })} />启用</label>
            <label><input type="checkbox" checked={draft.archived} disabled={busy} onChange={e => edit({ archived: e.target.checked, enabled: !e.target.checked })} />归档（保留历史）</label>
          </div>
          <p style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>维护模板不会启动模型。输入 # 选择角色后，发送才发起评议；每个来源会话保留独立评议上下文。</p>
          <WorkflowButton tone="primary" disabled={busy || !draft.name.trim() || !draft.instructions.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存角色'}</WorkflowButton>
          <WorkflowButton disabled={busy} style={{ marginLeft: 8 }} onClick={() => { edited.current = false; setDraft(empty()); setNotice(''); }}>放弃编辑</WorkflowButton>
          {notice && <p role="status" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{notice}</p>}
        </section>
      </div>
    </div>
  </div></AppModalPortal>;
};
