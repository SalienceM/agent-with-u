import { useEffect, useState } from 'react';
import { api, getCurrentUserProfile, getSessionExecKey } from '../api';
import { readCodexReasoning, type CodexReasoningCapability } from '../utils/codexReasoning';

export function useCodexReasoning(backend: any, sessionId?: string, execKey?: string) {
  const executor = execKey || getSessionExecKey(sessionId);
  const owner = JSON.stringify(getCurrentUserProfile());
  // 连接配置只用于内存身份比较，不记录或持久化，其中可能包含认证字段。
  const key = JSON.stringify([owner, executor, sessionId, backend?.id, backend?.type,
    backend?.cliPath, backend?.workingDir, backend?.apiKey, backend?.baseUrl, backend?.env]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; loading: boolean; error: string; rows: CodexReasoningCapability[] }>({
    key: '', loading: false, error: '', rows: [],
  });
  useEffect(() => {
    if (backend?.type !== 'codex-office') return;
    let alive = true;
    setState({ key, loading: true, error: '', rows: [] });
    const current = () => alive && JSON.stringify(getCurrentUserProfile()) === owner;
    void readCodexReasoning(key, () => api.codexRuntimeCatalog(backend.id, executor, sessionId)).then(rows => {
      if (current()) setState({ key, loading: false, error: '', rows });
    }, () => {
      if (current()) setState({ key, loading: false,
        error: '未能读取 Codex 档位，请检查当前节点、权限及 Codex 版本。未使用固定列表。', rows: [] });
    });
    return () => { alive = false; };
  }, [key, attempt]);
  return { ...(state.key === key ? state : { loading: true, error: '', rows: [] }),
    retry: () => setAttempt(value => value + 1) };
}
