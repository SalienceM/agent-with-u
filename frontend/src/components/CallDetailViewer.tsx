import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const SOURCES: Record<string, string> = {
  'qwen-assistant-turn': 'Qwen 本轮回复用量汇总（去重；可能不含 CLI 内部辅助请求）',
  'qwen-fresh-result': 'Qwen 新原生会话返回用量',
  'qwen-cumulative-result': 'Qwen 原生会话累计值差分',
  'qwen-native-delta': '旧版 Qwen 累计差分记账（不能直接等同于本轮回复）',
};

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '未知';
const AccountingDetails: React.FC<{ event: any }> = ({ event }) => {
  const audit = event?.qwenAccounting;
  if (!audit) return event?.usageSource === 'qwen-native-delta'
    ? <div role="note" style={warningStyle}>旧版记录没有保留差分前的基线，不能完整复算；历史账目未自动重写。请用新调用验证。</div> : null;
  const rows = [
    ['本轮回复 · SDK 上报', audit.replyUsage],
    ['原生累计增量 · 独立对账', audit.cumulativeDelta],
    ['未归因差额 · 增量减回复', audit.unattributedDelta],
    ['本笔记账 · 主图与累计', audit.countedUsage],
  ] as const;
  return <section aria-label="Qwen 用量对账" style={{ minWidth: 0 }}>
    <strong>回复用量与累计差分分开核对</strong>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums', margin: '8px 0' }}>
      <thead><tr><th style={cellStyle}>统计口径</th><th style={cellStyle}>输入 Token</th><th style={cellStyle}>输出 Token</th></tr></thead>
      <tbody>{rows.map(([label, counts]) => <tr key={label}><td style={cellStyle}>{label}</td><td style={cellStyle}>{number(counts?.inputTokens)}</td><td style={cellStyle}>{number(counts?.outputTokens)}</td></tr>)}</tbody>
    </table>
    {audit.cumulativeBefore && audit.cumulativeDelta ? <div aria-label="累计差分计算">
      <div>输入：{number(audit.cumulativeAfter.inputTokens)} − {number(audit.cumulativeBefore.inputTokens)} = {number(audit.cumulativeDelta.inputTokens)}</div>
      <div>输出：{number(audit.cumulativeAfter.outputTokens)} − {number(audit.cumulativeBefore.outputTokens)} = {number(audit.cumulativeDelta.outputTokens)}</div>
      <div style={noteStyle}>基线：{audit.baselineKind === 'fresh-zero' ? '确认新建原生会话，从零开始' : audit.baselineEventId || '已有基线（旧版未记录来源 ID）'}</div>
    </div> : <div role="note" style={warningStyle}>缺少上次原生累计基线，差分及未归因差额未知；没有假设基线为零。</div>}
    {audit.status === 'unattributed' && <div role="note" style={warningStyle}>差额尚未关联到具体模型请求，不计入本轮回复；不能仅凭差额断定是辅助调用。</div>}
    {['inconsistent', 'counter-reset'].includes(audit.status) && <div role="note" style={warningStyle}>累计计数回退或口径不一致；保留带符号差额供核查，不覆盖回复上报值。</div>}
    {!audit.replyUsage && <div role="note" style={warningStyle}>没有独立回复用量；本笔采用累计差分或标明的估算，不能视为单次模型请求。</div>}
    <div style={noteStyle}>SDK 用量事件 {number(audit.usageEventCount)} 个，其中零用量事件 {number(audit.zeroUsageEventCount)} 个；事件数不是网络请求数。缓存为输入细分项，不重复相加。</div>
  </section>;
};

const modelEntries = (attempt: any): any[] => (attempt.sent || []).filter((entry: any) =>
  (entry.scope === 'qwen-model-request' && entry.body?.body && !entry.body.omitted) || entry.scope?.endsWith('-http-body'));

export const CallDetailViewer: React.FC<{ sessionId: string; eventId: string }> = ({ sessionId, eventId }) => {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const load = async () => {
    if (loading) return;
    setOpen(true); setLoading(true); setError('');
    const current = ++generation.current;
    try {
      const value = await api.getSessionCallDetail(sessionId, eventId);
      if (alive.current && current === generation.current) setDetail(value || { message: '未找到此笔记录。' });
    } catch (err) {
      if (alive.current && current === generation.current) setError(String(err));
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  };
  const renderJSON = (value: unknown) => <pre style={preStyle}>{JSON.stringify(value, null, 2)}</pre>;
  const hasModelRequest = detail?.trace?.attempts?.some((attempt: any) => modelEntries(attempt).length > 0);
  return <div style={{ width: '100%', minWidth: 0 }}>
    <button type="button" style={buttonStyle} onClick={() => {
      if (open) setOpen(false);
      else if (detail) setOpen(true);
      else void load();
    }}>{open ? '收起输入 / 输出' : '查看此笔输入 / 输出'}</button>
    {open && <section aria-label="此笔调用输入输出" style={boxStyle}>
      {loading && <div role="status">正在从此 Session 执行端读取…</div>}
      {error && <div role="alert">读取失败：{error} <button style={buttonStyle} onClick={() => void load()}>重试读取</button></div>}
      {detail && <>
        <div>统计来源：{SOURCES[detail.event?.usageSource] || (detail.event?.estimated ? '文本估算' : 'Backend 返回；旧记录未注明具体口径')}</div>
        {detail.event?.usageWarning && <div role="note">{detail.event.usageWarning}</div>}
        <AccountingDetails event={detail.event} />
        <details><summary>用量字段与记账结果（providerUsage 为原始用量）</summary>{renderJSON(detail.event)}</details>
        {!detail.trace ? <p>{detail.message}</p> : <>
          <p role="note" style={hasModelRequest ? noteStyle : warningStyle}>{hasModelRequest ? '已捕获模型请求 JSON；以下逐次标明捕获范围，不能据此假设所有请求均已捕获。' : '未捕获完整模型输入：下面只有 SDK / Backend 参数，不能用它的字符数核对模型输入 Token。'}</p>
          <div>{detail.trace.redacted ? '已脱敏，认证头和二进制附件已省略；仍可能含项目敏感文本。' : '未检测到需脱敏的字段；仍可能含项目敏感文本。'}
            {detail.trace.truncated && <strong> 内容达到保留上限，部分已截断。</strong>}</div>
          {(detail.trace.attempts || []).map((attempt: any, index: number) => <div key={index} style={attemptStyle}>
            <strong>Backend 调用 {index + 1} · {attempt.status}（内部可能有多个模型请求）</strong>
            <div style={modelEntries(attempt).length ? noteStyle : warningStyle}>
              {modelEntries(attempt).length ? `已保留 ${modelEntries(attempt).length} 份模型请求 JSON（重试也可能单独记录），不等于已计费请求数。` : '本次调用只有 SDK / Backend 边界记录。'}
              {attempt.modelRequestCapture?.reason && <div>{attempt.modelRequestCapture.reason}</div>}
            </div>
            <details open><summary>发送内容</summary>
              {(attempt.sent || []).map((entry: any, i: number) => <div key={i}>
                <h4 style={headingStyle}>{entry.scope}{entry.body?.requestIndex ? ` · 请求 ${entry.body.requestIndex}` : ''}</h4><div style={noteStyle}>{entry.note}</div>
                {entry.body?.structure && <div style={noteStyle}>脱敏前 JSON：{number(entry.body.structure.jsonChars)} 字符；消息 {number(entry.body.structure.messageCount)} 条 / {number(entry.body.structure.messageJsonChars)} 字符；工具定义 {number(entry.body.structure.toolCount)} 个 / {number(entry.body.structure.toolJsonChars)} 字符。这些是字符统计，不是 Token，消息中可能含系统提示与历史。</div>}
                {renderJSON(entry.body)}
              </div>)}
            </details>
            <details open><summary>收到的回复正文</summary><pre style={preStyle}>{attempt.output || '没有收到正文。'}</pre></details>
            {attempt.thinking && <details><summary>Backend 返回的思考文本</summary><pre style={preStyle}>{attempt.thinking}</pre></details>}
            <details><summary>返回事件 / 原始用量字段（脱敏）</summary>{renderJSON(attempt.received)}</details>
          </div>)}
        </>}
      </>}
    </section>}
  </div>;
};

const buttonStyle: React.CSSProperties = { color: 'var(--theme-text)', background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' };
const boxStyle: React.CSSProperties = { display: 'grid', gap: 10, padding: '12px 0', minWidth: 0, overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.6 };
const preStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto', margin: '8px 0', padding: 10, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: 12 };
const noteStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', lineHeight: 1.6, margin: '6px 0' };
const attemptStyle: React.CSSProperties = { borderTop: '1px solid var(--theme-border)', paddingTop: 12, minWidth: 0 };
const headingStyle: React.CSSProperties = { margin: '10px 0 4px', fontSize: 12 };
const warningStyle: React.CSSProperties = { padding: '8px 10px', borderLeft: '3px solid #d97706', background: 'rgba(217,119,6,.08)', lineHeight: 1.6, margin: '8px 0', overflowWrap: 'anywhere' };
const cellStyle: React.CSSProperties = { textAlign: 'left', padding: '6px 4px', borderBottom: '1px solid var(--theme-border)', overflowWrap: 'anywhere' };
