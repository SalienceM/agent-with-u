import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SkillCommandConfig } from '../utils/skillCommands';
import { AppModalPortal } from './AppModalPortal';
import { libraryActionStyle as buttonStyle } from './AbilityLibraryRow';

export const SkillCommandConfigDialog: React.FC<{ name: string; execKey: string; onClose: () => void }> = ({ name, execKey, onClose }) => {
  const [data, setData] = useState<SkillCommandConfig | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = !!data && data.content !== draft;
  const load = useCallback(async () => {
    const id = ++generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.getSkillCommandConfig(name, execKey);
      if (id === generation.current) { setData(result); setDraft(result.content); }
    } catch (reason) { if (id === generation.current) setError(String(reason)); }
    finally { if (id === generation.current) setBusy(false); }
  }, [name, execKey]);
  useEffect(() => { void load(); return () => { ++generation.current; }; }, [load]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const save = async () => {
    if (!data || busy) return;
    const id = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.saveSkillCommandConfig(name, draft, data.revision, execKey);
      if (id !== generation.current) return;
      setData(result); setDraft(result.content);
      setNotice('已保存到 Skill 包内。重新打开聊天 / 菜单读取新配置；没有执行命令或安装依赖。');
      window.dispatchEvent(new Event('awu-skill-commands-changed'));
    } catch (reason) { if (id === generation.current) setError(String(reason)); }
    finally { if (id === generation.current) setBusy(false); }
  };
  const close = () => {
    if (busy || (dirty && !window.confirm('放弃未保存的命令配置？'))) return;
    onClose();
  };
  const exportDraft = () => {
    try {
      JSON.parse(draft);
      const url = URL.createObjectURL(new Blob([draft], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awu.commands.json';
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('已导出当前草稿。把 awu.commands.json 与 SKILL.md 一起提交，或放在仓库共同祖先目录；导出不会保存或执行。');
    } catch (reason) { setError(String(reason)); }
  };
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 10080, background: '#0009', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
    <section role="dialog" aria-modal="true" aria-label="Skill 命令配置" style={{ width: 'min(940px, 100%)', height: 'min(800px, 92vh)', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 16, boxSizing: 'border-box', borderRadius: 12, overflowY: 'auto', overflowWrap: 'anywhere', color: 'var(--theme-text)', background: 'var(--theme-panel-bg, #20202c)', border: '1px solid var(--theme-border)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong style={{ flex: 1 }}>/ 命令配置</strong><button style={buttonStyle} disabled={busy} onClick={close}>关闭</button></header>
      <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', overflowWrap: 'anywhere' }}>{data?.displayName || name} · 节点 {execKey} · awu.commands.json</div>
      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
        按稳定 Skill ID 关联，安装后注册，卸载后移除。kind=skill 调用已绑定的子 Skill；kind=project 声明 CLI 和参数，发送时才执行。
        {data && <div>保存目标：{data.owners.join('、')}。{data.owners.length > 1 ? '保存会统一这些子 Skill 的共享配置。' : ''}
          {data.origin === 'compatibility' && '当前为 AWU 兼容配置；保存或导出后即可随 Skill 分享。'}</div>}
      </div>
      {error && <div role="alert" style={{ color: '#ee7777', fontSize: 12 }}>{error}</div>}
      {data?.warnings.map((warning, index) => <div key={index} style={{ color: '#e8b768', fontSize: 12 }}>{warning}</div>)}
      {notice && <div role="status" style={{ color: 'var(--theme-accent)', fontSize: 12 }}>{notice}</div>}
      <textarea aria-label="命令配置 JSON" spellCheck={false} value={draft} disabled={busy || !data} onChange={event => { setDraft(event.target.value); setNotice(''); }} style={{ flex: 1, minHeight: 120, width: '100%', boxSizing: 'border-box', resize: 'none', border: '1px solid var(--theme-border)', borderRadius: 6, padding: 12, color: 'var(--theme-text)', background: 'var(--theme-input-bg)', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }} />
      <details style={{ fontSize: 12, maxHeight: '30vh', overflowY: 'auto', flexShrink: 0 }}><summary>最小声明示例与分享说明</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ schemaVersion: 1, id: 'my-tools', skillIds: data?.owners || ['my-skill'], commands: [{ name: '/my-review', description: '检查当前项目', kind: 'skill', skillId: data?.owners[0] || 'my-skill' }] }, null, 2)}</pre>仓库共享配置列出所有子 Skill ID；同 ID、同内容的副本会去重，不一致则停用。应用命令不能覆盖。清空 commands 数组可关闭该配置的快捷入口，不影响 /skill。</details>
      <footer style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button style={buttonStyle} disabled={busy} onClick={() => { if (!dirty || window.confirm('放弃草稿并刷新？')) void load(); }}>重新读取</button>
        <button style={buttonStyle} disabled={busy || !data} onClick={() => fileInput.current?.click()}>导入 JSON</button>
        <button style={buttonStyle} disabled={busy || !data} onClick={exportDraft}>导出 JSON</button>
        <button style={{ ...buttonStyle, marginLeft: 'auto' }} disabled={busy || !data} onClick={() => void save()}>{busy ? '处理中…' : '校验并保存'}</button>
        <input ref={fileInput} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
          const id = generation.current;
          try {
            if (file.size > 128000) throw new Error('命令配置超过 128 KB');
            const content = await file.text(); JSON.parse(content);
            if (id === generation.current) { setDraft(content); setNotice('已导入草稿，请核对 Skill ID 后保存。'); setError(''); }
          } catch (reason) { if (id === generation.current) setError(String(reason)); }
        }} />
      </footer>
    </section>
  </div></AppModalPortal>;
};
