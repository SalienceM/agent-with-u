import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { catalogConnectionSaved, parseCodexCatalogResult } from '../utils/codexCatalogSync';
import type { CodexModelOption } from '../utils/codexModelOptions';

interface Draft {
  id: string; type: string; cliPath?: string; apiKey?: string; baseUrl?: string;
  workingDir?: string; env?: Record<string, string>; modelOptions?: CodexModelOption[] | null;
}

export const CodexCatalogSync: React.FC<{
  draft: Draft; saved?: Draft | null; execKey: string; disabled: boolean;
  onChange: (rows: CodexModelOption[]) => void;
}> = ({ draft, saved, execKey, disabled, onChange }) => {
  const latest = useRef(draft);
  latest.current = draft;
  const alive = useRef(true);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [received, setReceived] = useState<{ rows: CodexModelOption[]; time: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const connectionSaved = catalogConnectionSaved(draft, saved);
  const sync = async () => {
    if (inFlight.current || disabled || !connectionSaved) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    const basis = draft;
    try {
      // 严格路由到编辑目标；查询无持久化，迟到结果只能被丢弃。
      const raw = await api.codexModelCatalog(draft.id, execKey);
      if (!alive.current) return;
      if (latest.current !== basis) { setMessage('草稿已变化，未应用旧结果；可重新同步。'); return; }
      const result = parseCodexCatalogResult(raw);
      setReceived({ rows: result.modelOptions, time: result.fetchedAt });
      onChange(result.modelOptions);
      setMessage('已填入草稿，保存后生效。');
    } catch (error) {
      if (alive.current) setMessage(latest.current !== basis ? '草稿已变化，未应用旧结果；可重新同步。'
        : error instanceof Error ? error.message : '同步失败，原草稿未修改。');
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <div aria-label="Codex 目录同步" style={{ margin: '10px 0', fontSize: 11, lineHeight: 1.6 }}>
    <button type="button" onClick={() => void sync()} disabled={busy || disabled || !connectionSaved}
      style={{ minHeight: 36, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--theme-border)',
        color: 'var(--theme-text)', background: 'var(--theme-bg-secondary)' }}>
      {busy ? '正在读取 Codex 目录…' : '从 Codex 同步'}
    </button>
    {!connectionSaved && <div>请先保存 Backend 及连接配置，再同步；候选仍可手工编辑。</div>}
    {message && <div role="status">{message}</div>}
    {received && <div style={{ color: 'var(--theme-text-muted)' }}>
      来源：目标节点 Codex app-server；上游来源与新鲜度未知（可能为缓存或内置目录）。
      读取时间：{new Date(received.time).toLocaleString('zh-CN')}，不等于上游更新时间；不保证账号可用。
      {draft.modelOptions !== received.rows && ' 同步后草稿已修改。'}
    </div>}
  </div>;
};
