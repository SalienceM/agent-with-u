import React, { useEffect, useState } from 'react';
import { api, type SkillMarketItem, type SkillMarketExplanation as Explanation } from '../api';

interface Props { item: SkillMarketItem; backendId: string; execKey: string; backendLoading?: boolean }

/** 原文/解读切换只停止读取进度；生成任务独立存活，服务端按内容指纹复用。 */
export const SkillMarketExplanation: React.FC<Props> = ({ item, backendId, execKey, backendLoading = false }) => {
  const [result, setResult] = useState<Explanation | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    setResult(null);
    if (backendLoading || !backendId) return;
    const accept = (next: Explanation) => {
      if (cancelled) return;
      setResult(next);
      if (next.status === 'ok' && next.state === 'running' && next.jobId) {
        if (Date.now() - startedAt > 200000) {
          setResult({ ...next, state: 'error', message: '等待解读超时，请重试查看或更换 Backend' });
          return;
        }
        timer = setTimeout(() => {
          void api.skillMarketExplainGet(next.jobId!, execKey).then(accept).catch(fail);
        }, 1000);
      }
    };
    const fail = (error: unknown) => {
      if (!cancelled) setResult({ status: 'error', message: error instanceof Error ? error.message : '解读失败，请重试' });
    };
    void api.skillMarketExplainStart(item, backendId, execKey, attempt > 0).then(accept).catch(fail);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [item.sourceId, item.path, item.digest, backendId, execKey, backendLoading, attempt]);
  if (backendLoading || !backendId) return <div className="skill-market-explanation" style={panelStyle}>
    <div role="status" style={noticeStyle}>{backendLoading ? 'Backend 同步中… 无需安装 Skill，同步完成后即可选择解读。' : <>
    请先在 Backend 管理中配置并启用 OpenAI 兼容或 Anthropic API，再选择解读 Backend。
    此功能使用纯文本请求，不启动 Codex / Qwen / Claude Agent 工具。
    </>}</div>
  </div>;
  const failed = result?.status === 'error' || result?.state === 'error';
  const busy = !result || result.state === 'running';
  return <div className="skill-market-explanation" style={panelStyle}>
    <div style={noticeStyle}>AI 中文解读 · 概括用途、用法和注意事项，并非逐句翻译或安全审计；请与原文核对。</div>
    {result?.truncated && <div style={noticeStyle}>原文较长，本次仅解读 SKILL.md 前 50K 字符，配套文档未展开。</div>}
    {busy && <div role="status" style={noticeStyle}>正在生成中文解读… 可随时切回原文，生成不会因此中断。</div>}
    {failed && <div role="alert" style={{ ...noticeStyle, color: '#ef6b73' }}>{result?.message || '解读失败'}</div>}
    {result?.text && <div style={{ fontSize: 12, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
      {result.text.split('\n').map((line, i) => /^#{1,3}\s/.test(line)
        ? <h4 key={i} style={{ fontSize: 13, margin: '12px 0 5px' }}>{line.replace(/^#{1,3}\s+/, '')}</h4>
        : <div key={i} style={{ whiteSpace: 'pre-wrap', minHeight: line ? undefined : 7 }}>{line}</div>)}
    </div>}
    {!busy && <button type="button" onClick={() => setAttempt(value => value + 1)} style={{ alignSelf: 'flex-start', padding: '6px 10px', borderRadius: 6,
      border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer' }}>
      {failed ? '重试解读' : '重新生成'}
    </button>}
  </div>;
};
const panelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 180, overflow: 'auto', gap: 8 };
const noticeStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.55 };
