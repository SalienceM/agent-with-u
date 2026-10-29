import React, { useEffect, useRef, useState } from 'react';
import type { LoopRecord, LoopStateT } from '../types/loopWorkbench';
import { AIMEIN_OUTPUT_LIMIT, aimeinRecords, aimeinRuntime, aimeinObservation } from '../utils/aimeinRuntime';
import { AimeinReviewSummary } from './AimeinReviewSummary';

const muted: React.CSSProperties = { color: '#91b3aa', fontSize: 11, lineHeight: 1.6 };
const button: React.CSSProperties = { border: '1px solid #355954', background: '#16322f', color: '#cce3d8', borderRadius: 6, padding: '6px 9px', fontSize: 11, cursor: 'pointer' };
const phases: Record<string, string> = { local_prepare: '正在准备技能与引用', environment_check: '正在检查运行环境', environment_wait: '等待运行环境', backend_dispatch: '正在连接执行器', runner_start: '正在启动执行器', runner_ready: '正在初始化会话', turn_accepted: '任务已接收，等待响应', request: '请求已发出，等待响应', response_headers: '已连接，等待输出', sdk_request: '等待模型响应', sdk_response: '响应流已建立', thinking: '模型正在思考', text: '正在输出', tools: '正在调用工具', retry_wait: '等待后端重试', done: '调用已结束', error: '调用失败', stalled: '等待超时', cancelled: '调用已中断' };
const statuses: Record<string, string> = { done: '已结束', completed: '已结束', running: '进行中', pending: '等待', error: '失败', cancelled: '已中断', unconfirmed: '状态待核对' };

/** 复用控制器收到的真实事件，不发请求、不补造进度；阅读历史时不会被新流抢走。 */
export const AimeinRuntimePanel: React.FC<{
  state: LoopStateT; current?: LoopRecord; progress: Record<string, string>; connected: boolean;
  onSelect: (seq: number) => void; detailError?: string; onRetry: () => void; compact?: boolean;
}> = ({ state, current, progress, connected, onSelect, detailError, onRetry, compact }) => {
  const runtime = aimeinRuntime(state, current, progress, connected);
  const observation = aimeinObservation(state, current, connected);
  const [expanded, setExpanded] = useState(false);
  const records = aimeinRecords(state);
  const [pin, setPin] = useState<{ seq?: number; id: string }>();
  const [archive, setArchive] = useState<{ seq?: number; id?: string; page: number }>();
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(Date.now() / 1000);
  const [visible, setVisible] = useState(!document.hidden);
  const output = useRef<HTMLDivElement>(null);
  const channel = (pin?.seq === current?.seq && runtime.channels.find(item => item.id === pin?.id)) || runtime.channel;
  const call = channel?.call;
  const saved = (channel && (current?.stageDetails?.[channel.id]?.rawOutput || current?.stageDetails?.[channel.id]?.partialOutput || current?.orchestration.find(step => `step${step.index}` === channel.id)?.output)) || '';
  const paging = !!saved && archive?.seq === current?.seq && archive?.id === channel?.id;
  const pages = Math.ceil(saved.length / AIMEIN_OUTPUT_LIMIT);
  const displayed = paging ? saved.slice(archive!.page * AIMEIN_OUTPUT_LIMIT, (archive!.page + 1) * AIMEIN_OUTPUT_LIMIT) : channel?.text;
  useEffect(() => { setFollow(true); }, [current?.seq]);
  useEffect(() => { const changed = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed); }, []);
  useEffect(() => {
    if (!runtime.live || !visible) return;
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [runtime.live, visible]);
  useEffect(() => { if (follow && !paging && output.current) output.current.scrollTop = output.current.scrollHeight; }, [follow, channel?.id, channel?.text, paging]);
  useEffect(() => { if (paging && output.current) output.current.scrollTop = 0; }, [paging, archive?.page]);
  const elapsed = call ? Math.max(0, Math.floor((call.endedAt || (runtime.live ? now : call.observedAt || call.lastActivityAt || call.startedAt)) - call.startedAt)) : 0;
  const quiet = runtime.live && call?.lastActivityAt ? Math.max(0, Math.floor(now - call.lastActivityAt)) : 0;
  const phase = channel?.active ? phases[call?.phase || ''] || '正在执行' : statuses[channel?.status || ''] || '等待输出';
  const stage = /review|analysis|verify/.test(runtime.phase) ? 3 : /step|execute/.test(runtime.phase) ? 2 : /aimein-plan|aimein-prepare/.test(runtime.phase) ? 1 : 0;
  const history = <select aria-label="运行记录" style={{ ...button, minWidth: 0, maxWidth: compact ? 115 : '60%' }} value={current?.seq || ''} onChange={e => onSelect(Number(e.target.value))}>
    {!records.length && <option value="">尚无执行记录</option>}
    {records.slice().reverse().map(record => <option key={record.seq} value={record.seq}>#{record.seq} · {record.aimeinSummary?.title || (record.completed ? '准备记录' : '正在准备')}</option>)}
  </select>;
  const followButton = <button style={{ ...button, marginLeft: compact ? 0 : 'auto', ...(compact ? { padding: '3px 6px' } : {}) }} aria-pressed={follow} onClick={() => { setArchive(undefined); setFollow(value => !value); }}>{follow ? '暂停跟随' : '回到最新'}</button>;
  return <section aria-label="运行现场" data-testid="aimein-runtime" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: '#d5e9de', background: '#102827' }}>
    <div style={{ padding: compact ? '5px 9px' : '15px 16px 11px', borderBottom: '1px solid #2b4c44', flexShrink: 0 }}>
      <div style={{ ...muted, display: compact ? 'none' : 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ letterSpacing: 2 }}>RUN FIELD</span><span>{runtime.historical ? 'REPLAY' : runtime.live ? '● LIVE' : connected ? 'STANDBY' : 'OFFLINE'} · {current ? `#${current.seq}` : '准备'}</span></div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}><h2 data-testid="aimein-runtime-title" title={runtime.goal} style={{ margin: compact ? 0 : '7px 0', fontSize: compact ? 13 : 19, color: runtime.error ? '#f1c986' : '#dce9c1' }}>{runtime.title}</h2>{compact && history}</div>
      <div title={runtime.goal} style={{ ...muted, display: compact ? 'none' : '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>{runtime.goal || '在灯塔定义你要建设的目标。'}</div>
      <ol aria-label="当前执行阶段" style={{ display: compact ? 'none' : 'flex', gap: 4, listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
        {['准备', '拆解', '建设', '评审'].map((name, index) => <li key={name} aria-current={runtime.live && index === stage ? 'step' : undefined} style={{ flex: 1, borderTop: `2px solid ${runtime.live && index === stage ? '#a6dfb1' : '#35554b'}`, paddingTop: 6, fontSize: 11, color: runtime.live && index === stage ? '#c4efbe' : '#7c9d90' }}>{index + 1} · {name}</li>)}
      </ol>
      {runtime.message && (!compact || observation.health === 'attention' || observation.health === 'offline') && <div role="status" style={{ ...muted, color: runtime.error ? '#e2bb83' : '#abc4b2', marginTop: compact ? 2 : 10, maxHeight: compact ? 18 : 75, overflow: 'auto' }}>{runtime.message}</div>}
    </div>
    {!expanded && <div data-testid="aimein-observation" data-health={observation.health} style={{ padding: compact ? '6px 9px' : '18px 16px', flex: compact ? '0 1 auto' : '1 1 140px', minHeight: 0, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: compact ? 10 : 20, justifyContent: 'space-between' }}>
        <div style={compact ? { display: 'flex', gap: 6, alignItems: 'baseline' } : undefined}><div style={muted}>{compact ? '已保存步骤' : '本阶段 · 已保存步骤'}</div><strong style={{ fontSize: compact ? 18 : 40, fontWeight: 500, color: '#dbe5bd', fontVariantNumeric: 'tabular-nums' }}>{observation.total ? `${observation.saved} / ${observation.total}` : '规划中'}</strong></div>
        <div style={{ textAlign: 'right', ...(compact ? { display: 'flex', gap: 6, alignItems: 'baseline' } : {}) }}><div style={muted}>{compact ? '核实覆盖' : '整体目标 · 核实覆盖'}</div><strong style={{ fontSize: compact ? 14 : 23, color: '#afc8b9', fontWeight: 400 }}>{observation.coverage.known ? `${observation.coverage.verified} / ${observation.coverage.total}` : '待核实'}</strong></div>
      </div>
      {!!observation.total && <div aria-label={`本阶段 ${observation.saved} / ${observation.total} 步已保存`} style={{ display: 'flex', gap: 3, marginTop: compact ? 4 : 12 }}>{current?.orchestration.map(step => <span key={step.index} title={`${step.desc} · ${step.status}`} style={{ flex: 1, height: compact ? 3 : 5, borderRadius: 2, background: step.status === 'done' && step.output?.trim() ? '#b1cda3' : step.status === 'error' ? '#d79675' : step.status === 'running' ? '#74b5ab' : '#2c4b43' }} />)}</div>}
      <div style={{ marginTop: compact ? 5 : 16, display: compact ? 'flex' : 'block', alignItems: 'baseline', gap: 7, fontSize: compact ? 11 : 13, color: ['attention', 'offline'].includes(observation.health) ? '#e4b98d' : '#bdd7c4', overflowWrap: 'anywhere' }}>
        <span style={{ flexShrink: 0 }}>{({ working: '● 当前', waiting: '◇ 等待响应', attention: '⚠ 需留意', offline: '◇ 连接中断', history: '◇ 历史观察', idle: '◇ 当前状态' })[observation.health]}</span>
        <div style={{ marginTop: compact ? 0 : 3, display: '-webkit-box', WebkitLineClamp: compact ? 1 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{observation.issue || observation.current}</div>
      </div>
      {!compact && <p style={{ ...muted, marginTop: 14 }}>已保存步骤表示建设进展，核实覆盖来自完整评审。<br />{observation.measurement}</p>}
    </div>}
    {(stage === 3 || current?.completed) && !!current?.aimeinSummary?.reviews.length && <div style={{ padding: '8px 12px 0', flexShrink: 0 }}><AimeinReviewSummary compact summary={current.aimeinSummary} detail={current.aimeinRun} /></div>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: compact ? '3px 8px' : '8px 12px', flexShrink: 0, borderTop: '1px solid #2b4c44' }}><span style={muted}>{expanded ? '执行细节' : '最新输出'}</span><button style={{ ...button, marginLeft: 'auto', padding: compact ? '3px 6px' : '5px 8px' }} aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? '收起运行细节' : '查看完整输出'}</button>{compact && followButton}</div>
    {expanded && !compact && <div style={{ padding: '8px 12px', flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, borderBottom: '1px solid #2b4c44' }}>
      {history}
      {runtime.historical && <button style={button} onClick={() => onSelect(records.at(-1)!.seq)}>返回现场</button>}
      <button style={{ ...button, marginLeft: 'auto' }} aria-pressed={!pin || pin.seq !== current?.seq} onClick={() => { setPin(undefined); setFollow(true); }}>跟随阶段</button>
    </div>}
    <nav aria-label="输出通道" style={{ display: expanded ? 'flex' : 'none', gap: 5, padding: compact ? '3px 7px' : '9px 12px', overflowX: 'auto', flexShrink: 0 }}>
      {compact && <button style={{ ...button, whiteSpace: 'nowrap', padding: '4px 6px' }} aria-label={runtime.historical ? '返回现场' : '跟随阶段'} onClick={() => { if (runtime.historical) onSelect(records.at(-1)!.seq); setPin(undefined); setFollow(true); }}>{runtime.historical ? '返回现场' : '跟随'}</button>}
      {runtime.channels.map(item => <button key={item.id} aria-pressed={item.id === channel?.id} style={{ ...button, whiteSpace: 'nowrap', borderColor: item.id === channel?.id ? '#9cbb8c' : '#355954', background: item.id === channel?.id ? '#294439' : '#16322f' }} onClick={() => { setPin({ seq: current?.seq, id: item.id }); setFollow(true); }}>
        <span style={{ color: item.active ? '#a6efb4' : '#79988d' }}>{item.active ? '●' : '◇'}</span> {item.label}
      </button>)}
    </nav>
    <div data-testid="aimein-call-activity" style={{ ...muted, padding: compact ? '0 8px 3px' : '0 14px 9px', flexShrink: 0, fontSize: compact ? 10 : 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{phase}</span>{call && <span>{Math.floor(elapsed / 60)}m {elapsed % 60}s</span>}</div>
      {call && !compact && expanded && <div style={{ overflowWrap: 'anywhere' }}>{call.model || call.backendId || '执行器'} · 工具 {call.eventCounts?.tool_start || 0} 次 · 正文 {call.textChars || 0} 字</div>}
      {quiet >= 15 && <div>距上次活动 {quiet} 秒 · 等待新事件</div>}
    </div>
    <div ref={output} data-testid="aimein-live-output" tabIndex={0} aria-label="执行输出" onScroll={event => { const el = event.currentTarget; if (!paging) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 28); }}
      style={{ flex: expanded ? 1 : compact ? '1 1 40px' : '0 1 150px', minHeight: compact ? 48 : 80, overflow: 'auto', overflowAnchor: 'none', overscrollBehavior: 'contain', padding: compact ? '6px 9px' : '12px 16px', background: '#0b1e20', borderTop: '1px solid #2b4c44', outlineOffset: -3 }}>
      {channel?.truncated && !paging && <p style={muted}>显示最近 50,000 字符。{!!saved && <button style={button} onClick={() => { setArchive({ seq: current?.seq, id: channel.id, page: 0 }); setFollow(false); }}>分段查看已保存内容</button>}</p>}
      {paging && <div style={muted}><button style={button} disabled={!archive!.page} onClick={() => setArchive({ ...archive!, page: archive!.page - 1 })}>上一段</button> {archive!.page + 1}/{pages} <button style={button} disabled={archive!.page + 1 >= pages} onClick={() => setArchive({ ...archive!, page: archive!.page + 1 })}>下一段</button></div>}
      <pre style={{ font: '12px/1.85 ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, color: '#c5dbcd' }}>{displayed || (runtime.live ? `${phase}。收到正文后会显示在这里。` : '该通道暂无保存的正文。')}</pre>
      {detailError && <p role="alert" style={muted}>{detailError} <button style={button} onClick={onRetry}>重新读取详情</button></p>}
    </div>
    {!compact && <footer style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexShrink: 0, ...muted }}><span>{paging ? '正在阅读保存内容' : runtime.historical ? '保存的执行记录' : follow ? '跟随最新输出' : '已暂停跟随'}</span>{followButton}</footer>}
  </section>;
};
