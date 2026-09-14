import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, getCurrentUserProfile } from '../api';
import { AppModalPortal } from './AppModalPortal';
import { directionalTokens, tokenCount as count, tokenTrendStats } from '../utils/tokenUsageTrend';

interface UsageEvent {
  id?: string;
  at?: number;
  source?: 'chat' | 'loop';
  stage?: string;
  backendId?: string;
  model?: string;
  seq?: number;
  estimated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextApprox?: boolean;
  contextDrop?: boolean;
}

interface ContextEvent {
  id?: string;
  at?: number;
  type?: string;
  label?: string;
  removed?: number;
}

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
  actualTurns: number;
  estimatedTurns: number;
  turnCount: number;
  coverage: number;
  events: UsageEvent[];
  contextEvents: ContextEvent[];
  contextEventCount?: number;
  latestContext?: UsageEvent | null;
}

interface TokenMonitorPreference {
  enabled: boolean;
  warningPercent: number;
}

const EMPTY: TokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  actualTurns: 0,
  estimatedTurns: 0,
  turnCount: 0,
  coverage: 0,
  events: [],
  contextEvents: [],
  latestContext: null,
};

function normalizeSummary(value: any): TokenUsageSummary {
  if (!value || typeof value !== 'object') return EMPTY;
  const actualTurns = count(value.actualTurns);
  const estimatedTurns = count(value.estimatedTurns);
  const turnCount = count(value.turnCount) || actualTurns + estimatedTurns;
  return {
    inputTokens: count(value.inputTokens),
    outputTokens: count(value.outputTokens),
    cachedInputTokens: count(value.cachedInputTokens),
    reasoningOutputTokens: count(value.reasoningOutputTokens),
    totalTokens: count(value.totalTokens) || count(value.inputTokens) + count(value.outputTokens),
    actualTurns,
    estimatedTurns,
    turnCount,
    coverage: Number.isFinite(Number(value.coverage))
      ? Math.max(0, Math.min(1, Number(value.coverage)))
      : (turnCount ? actualTurns / turnCount : 0),
    events: Array.isArray(value.events) ? value.events.slice(-24) : [],
    contextEvents: Array.isArray(value.contextEvents) ? value.contextEvents.slice(-12) : [],
    contextEventCount: count(value.contextEventCount),
    latestContext: value.latestContext && typeof value.latestContext === 'object'
      ? value.latestContext : null,
  };
}

function formatTokens(value: number): string {
  const number = count(value);
  if (number >= 100_000_000) return `${trimNumber(number / 100_000_000, number >= 1_000_000_000 ? 1 : 2)}亿`;
  if (number >= 10_000) return `${trimNumber(number / 10_000, number >= 1_000_000 ? 1 : 2)}万`;
  return number.toLocaleString();
}

function trimNumber(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

function exactTokens(value: number): string {
  return `${count(value).toLocaleString()} Token`;
}

function preferenceKey(): string {
  const profile = getCurrentUserProfile();
  return `awu.token-monitor.v1:${profile.mode}:${profile.userId || 'local'}`;
}

function loadPreference(): TokenMonitorPreference {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey()) || '{}');
    const warningPercent = Number(saved.warningPercent);
    return {
      enabled: saved.enabled !== false,
      warningPercent: Number.isFinite(warningPercent)
        ? Math.max(50, Math.min(95, Math.round(warningPercent))) : 80,
    };
  } catch {
    return { enabled: true, warningPercent: 80 };
  }
}

function savePreference(value: TokenMonitorPreference): void {
  try { localStorage.setItem(preferenceKey(), JSON.stringify(value)); } catch { /* private mode */ }
}

const STAGE_LABELS: Record<string, string> = {
  reply: '普通对话', manual: '人工接管', idea: '构思', goal: '整理目标',
  prepare: '规划', execute: '执行', summary: '总结', analysis: '评审', aside: '旁路问答',
};

function callLabel(event?: UsageEvent): string {
  if (!event) return '暂无调用';
  const stage = STAGE_LABELS[event.stage || ''] || event.stage || '模型调用';
  return event.source === 'loop' ? `LOOP · ${stage}` : stage;
}

const UsageLineChart: React.FC<{ events: UsageEvent[] }> = ({ events }) => {
  const [view, setView] = useState<'both' | 'input' | 'output'>('both');
  const [selectedKey, setSelectedKey] = useState('');
  const [width, setWidth] = useState(760);
  const svgRef = useRef<SVGSVGElement>(null);
  const hasEvents = events.length > 0;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.max(180, Math.round(entry.contentRect.width)));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [hasEvents]);
  const visible = events.slice(-16);
  const series = TOKEN_SERIES.filter(item => view === 'both' || item.direction === view);
  // 单独查看时重新缩放，避免较小的输出量始终贴着横轴。
  const maximum = Math.max(1, ...series.flatMap(item => visible.map(event => directionalTokens(event, item.direction))));
  if (!visible.length) {
    return <div style={emptyTrendStyle}>完成一轮后显示趋势</div>;
  }
  const eventKey = (event: UsageEvent, index: number) => event.id || `${event.at}-${index}`;
  const selectedIndex = selectedKey ? visible.findIndex((event, index) => eventKey(event, index) === selectedKey) : -1;
  const detailIndex = selectedIndex < 0 ? visible.length - 1 : selectedIndex;
  const detail = visible[detailIndex];

  const height = 210;
  const left = 58;
  const right = 24;
  const top = 20;
  const bottom = 35;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const xAt = (index: number) => visible.length === 1
    ? left + chartWidth / 2
    : left + (index / (visible.length - 1)) * chartWidth;
  const yAt = (value: number) => top + chartHeight - (value / maximum) * chartHeight;
  const gridLevels = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div style={lineChartWrapStyle}>
      <div role="group" aria-label="Token 趋势显示范围" style={lineLegendStyle}>
        {(['both', 'input', 'output'] as const).map(value => (
          <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}
            style={{ ...chartToggleStyle, ...(view === value ? { color: 'var(--theme-accent)', borderColor: 'var(--theme-accent)', background: 'var(--theme-accent-bg)' } : {}) }}>
            {value === 'both' ? '输入 + 输出' : value === 'input' ? '只看输入' : '只看输出'}
          </button>
        ))}
      </div>
      <div style={lineLegendStyle}>
        {series.map(item => <span key={item.direction} style={{ color: item.color }}>
          <i style={{ display: 'inline-block', width: 20, marginRight: 5, verticalAlign: 'middle', borderTop: `2px ${item.direction === 'output' ? 'dashed' : 'solid'} ${item.color}` }} />
          {item.label} · {item.direction === 'input' ? '实线' : '虚线'}
        </span>)}
        <span>{view === 'both' ? '同一纵轴 · Token / 次' : '纵轴按当前类型自动缩放'}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`最近调用趋势：${series.map(item => item.label).join('与')}`} style={lineChartStyle}>
        {gridLevels.map((ratio) => {
          const y = top + chartHeight - ratio * chartHeight;
          return (
            <g key={ratio}>
              <line x1={left} y1={y} x2={left + chartWidth} y2={y}
                stroke="var(--theme-border)" strokeWidth="1" strokeDasharray={ratio ? '4 5' : undefined} />
              <text x={left - 10} y={y + 4} textAnchor="end" fill="var(--theme-text-muted)" fontSize="10">
                {formatTokens(Math.round(maximum * ratio))}
              </text>
            </g>
          );
        })}
        {series.map(item => (
          <polyline key={item.direction} data-token-series={item.direction}
            points={visible.map((event, index) => `${xAt(index)},${yAt(directionalTokens(event, item.direction))}`).join(' ')}
            fill="none" stroke={item.color} strokeWidth="3" strokeDasharray={item.direction === 'output' ? '7 4' : undefined}
            strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {visible.map((event, index) => {
          const x = xAt(index);
          const label = `第 ${index + 1} 次 · ${callLabel(event)}：输入 ${exactTokens(count(event.inputTokens))}，输出 ${exactTokens(count(event.outputTokens))}，合计 ${exactTokens(directionalTokens(event, 'total'))}${event.estimated ? '（文本估算）' : '（Backend 实报）'}`;
          const tickEvery = Math.max(1, Math.ceil((visible.length - 1) / Math.max(1, Math.floor(chartWidth / 40))));
          const showTick = index % tickEvery === 0 || index === visible.length - 1;
          return (
            <g key={event.id || `${event.at}-${index}`}>
              <title>{label}</title>
              {series.map(item => <circle key={item.direction} cx={x} cy={yAt(directionalTokens(event, item.direction))} r={event.estimated ? 5 : 4.5}
                fill={event.estimated ? 'var(--theme-bg-secondary)' : item.color}
                stroke={item.color} strokeWidth={event.estimated ? 2.5 : 1.5}
                strokeDasharray={event.estimated ? '2 1' : undefined} />)}
              {showTick && (
                <text x={x} y={height - 11} textAnchor="middle" fill="var(--theme-text-muted)" fontSize="9.5">
                  {index + 1}
                </text>
              )}
            </g>
          );
        })}
        <text x={left} y={height - 1} fill="var(--theme-text-muted)" fontSize="9.5">较早</text>
        <text x={left + chartWidth} y={height - 1} textAnchor="end" fill="var(--theme-text-muted)" fontSize="9.5">最近</text>
      </svg>
      <div style={lineLegendStyle}>
        <span><i style={{ ...legendPointStyle, background: 'var(--theme-text-muted)' }} />实心点：Backend 实报</span>
        <span><i style={{ ...legendPointStyle, background: 'transparent', border: '2px dashed var(--theme-text-muted)' }} />空心点：文本估算</span>
        <span>横轴数字 = 最近第几次模型调用</span>
      </div>
      <div style={callDetailStyle}>
        <label style={callPickerStyle}>调用明细
          <select aria-label="查看某次调用的 Token" value={selectedIndex < 0 ? '' : selectedKey}
            onChange={event => setSelectedKey(event.target.value)} style={callSelectStyle}>
            <option value="">最近一次</option>
            {visible.map((event, index) => <option key={eventKey(event, index)} value={eventKey(event, index)}>
              第 {index + 1} 次 · {callLabel(event)}{event.estimated ? '（估算）' : ''}
            </option>)}
          </select>
        </label>
        <div aria-label="所选调用统计" style={detailNumbersStyle}>
          <span>第 {detailIndex + 1} 次 · {callLabel(detail)} · {detail.estimated ? '文本估算' : 'Backend 实报'}</span>
          <span style={{ color: INPUT_COLOR }}>输入 {exactTokens(count(detail.inputTokens))}</span>
          <span style={{ color: OUTPUT_COLOR }}>输出 {exactTokens(count(detail.outputTokens))}</span>
          <span>合计 {exactTokens(directionalTokens(detail, 'total'))}</span>
        </div>
      </div>
    </div>
  );
};

export const TokenUsageMonitor: React.FC<{
  sessionId: string;
  placement?: 'floating' | 'header';
}> = ({ sessionId, placement = 'header' }) => {
  const [summary, setSummary] = useState<TokenUsageSummary>(EMPTY);
  const [open, setOpen] = useState(false);
  const [preference, setPreference] = useState<TokenMonitorPreference>(() => loadPreference());
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(EMPTY);
    void api.getSessionTokenUsage(sessionId).then((value) => {
      if (!cancelled) setSummary(normalizeSummary(value));
    });
    const unsubscribe = api.onSessionUpdated((event: any) => {
      if (event?.sessionId !== sessionId) return;
      if (event.tokenUsage) {
        setSummary(normalizeSummary(event.tokenUsage));
      } else if (event.type === 'session_compacted' || event.type === 'context_cleared') {
        void api.getSessionTokenUsage(sessionId).then((value) => {
          if (!cancelled) setSummary(normalizeSummary(value));
        });
      }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const contextTokens = count(summary.latestContext?.contextTokens);
  const contextWindow = count(summary.latestContext?.contextWindow);
  const contextPercent = contextTokens && contextWindow
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
  const warning = preference.enabled && contextPercent >= preference.warningPercent;
  const inferredDrops = useMemo(
    () => summary.events.filter((event) => event.contextDrop).length,
    [summary.events],
  );
  const latestEvent = summary.events.at(-1);
  const inputStats = tokenTrendStats(summary.events, 'input');
  const outputStats = tokenTrendStats(summary.events, 'output');
  const totalStats = tokenTrendStats(summary.events, 'total');
  const exactPercent = Math.round(summary.coverage * 100);
  const warningDistance = Math.max(0, preference.warningPercent - contextPercent);
  const nearWarning = preference.enabled && contextPercent >= Math.max(1, preference.warningPercent - 10);
  const contextStatus = !preference.enabled
    ? '上下文预警已关闭'
    : warning
    ? `已达到 ${preference.warningPercent}% 预警线`
    : nearWarning
      ? `接近预警线，还差 ${warningDistance}%`
      : contextPercent
        ? `使用正常，距预警线还有 ${warningDistance}%`
        : '';

  const updatePreference = (patch: Partial<TokenMonitorPreference>) => {
    const next = { ...preference, ...patch };
    setPreference(next);
    savePreference(next);
  };

  return (
    <div ref={rootRef} style={placement === 'floating' ? floatingRootStyle : headerRootStyle}
      onClick={(event) => event.stopPropagation()}>
      <button type="button" onClick={() => setOpen((value) => !value)}
        title={contextPercent
          ? `当前上下文已使用 ${contextPercent}%，点击查看 Token 详情`
          : `累计输入 ${exactTokens(summary.inputTokens)}，累计输出 ${exactTokens(summary.outputTokens)}，合计 ${exactTokens(summary.totalTokens)}，点击查看详情`}
        style={{ ...triggerStyle, ...(warning ? triggerWarningStyle : {}) }}>
        <span style={triggerDotStyle} />
        {contextPercent
          ? <span><b>上下文</b> {contextPercent}%</span>
          : <span><b>累计</b> {formatTokens(summary.totalTokens)} Token</span>}
        {warning && <span aria-label="达到预警线">⚠</span>}
      </button>

      {open && (
        <AppModalPortal>
        <div style={panelOverlayStyle} onClick={() => setOpen(false)}>
        <div ref={panelRef} role="dialog" aria-modal="true" aria-label="本会话 Token 使用情况"
          style={panelStyle} onClick={(event) => event.stopPropagation()}>
          <div style={panelHeaderStyle}>
            <div>
              <div style={titleStyle}>本会话 Token 使用情况</div>
              <div style={subtitleStyle}>普通对话与 LOOP 中的模型调用统一统计</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} style={closeStyle}>×</button>
          </div>

          <div style={overviewGridStyle}>
          <section style={contextSectionStyle}>
            <div style={sectionHeadingStyle}>
              <span>当前上下文占用</span>
              {contextPercent > 0 && (
                <span style={{
                  ...statusBadgeStyle,
                  color: warning ? '#f59e0b' : nearWarning ? '#fbbf24' : preference.enabled ? '#4ade80' : 'var(--theme-text-muted)',
                }}>
                  {warning ? '需要注意' : nearWarning ? '接近预警' : preference.enabled ? '正常' : '预警已关闭'}
                </span>
              )}
            </div>
            {contextTokens && contextWindow ? (
              <>
                <div style={contextLineStyle}>
                  <strong style={{ ...contextPercentStyle, color: warning ? '#f59e0b' : 'var(--theme-text)' }}>
                    {contextPercent}%
                  </strong>
                  <div style={contextNumbersStyle}>
                    <strong>{formatTokens(contextTokens)} / {formatTokens(contextWindow)} Token</strong>
                    <span>{contextStatus}</span>
                  </div>
                </div>
                <div style={trackStyle}>
                  <div style={{
                    width: `${contextPercent}%`, height: '100%', borderRadius: 999,
                    background: warning ? '#f59e0b' : 'linear-gradient(90deg, #22c55e, var(--theme-accent))',
                  }} />
                  {preference.enabled && <span style={{ ...thresholdMarkStyle, left: `${preference.warningPercent}%` }} />}
                </div>
                <div style={contextFootStyle}>
                  <span>{summary.latestContext?.contextApprox ? '近似值：由最近一次输入 Token 推算' : 'Backend 实报的最近上下文'}</span>
                  <span>{preference.enabled ? `预警线 ${preference.warningPercent}%` : '预警已关闭'}</span>
                </div>
                <div style={contextSourceStyle}>
                  <strong>这个比例从哪里来？</strong>
                  <span>
                    {summary.latestContext?.contextApprox
                      ? 'Backend 返回了最近一轮输入 Token，窗口上限来自 Backend 配置；一轮 Agent 任务可能含多次模型请求，所以标记为近似值。'
                      : 'Backend 在运行时直接上报“最近一次请求的上下文 Token”和“模型窗口上限”；AgentWithU 不根据聊天字数猜测。'}
                  </span>
                  <code style={contextFormulaStyle}>
                    {contextTokens.toLocaleString()} ÷ {contextWindow.toLocaleString()} = {contextPercent}%
                  </code>
                </div>
              </>
            ) : (
              <div style={unavailableStyle}>
                <strong style={unavailableTitleStyle}>暂时无法读取当前上下文占用了多少</strong>
                <span>当前 Backend 没有同时报告“上下文大小”和“窗口上限”。下面的累计消耗仍可统计，但它不等于当前上下文大小。</span>
              </div>
            )}
          </section>

          <section style={cumulativeSectionStyle}>
            <div style={cumulativeHeaderStyle}>
              <div>
                <div style={sectionHeadingStyle}><span>本会话累计消耗 · 输入 + 输出</span></div>
                <strong style={cumulativeValueStyle} title={exactTokens(summary.totalTokens)}>
                  {formatTokens(summary.totalTokens)} <small style={tokenUnitStyle}>Token</small>
                </strong>
              </div>
              <span style={lifetimeBadgeStyle}>压缩后不清零</span>
            </div>
            <div style={plainExplanationStyle}>
              这是从会话开始到现在所有模型调用的总和，不是模型此刻正在携带的上下文。一个 Agent 任务内部可能调用模型多次，所以累计值可以远大于上下文窗口。
            </div>
            <div style={metricGridStyle}>
              <div aria-label="累计输入统计" style={{ ...metricStyle, color: INPUT_COLOR }} title={exactTokens(summary.inputTokens)}><span>累计输入</span><strong style={directionValueStyle}>{formatTokens(summary.inputTokens)}</strong><span>Token · 发给模型</span></div>
              <div aria-label="累计输出统计" style={{ ...metricStyle, color: OUTPUT_COLOR }} title={exactTokens(summary.outputTokens)}><span>累计输出</span><strong style={directionValueStyle}>{formatTokens(summary.outputTokens)}</strong><span>Token · 模型生成</span></div>
            </div>
            <div style={finePrintStyle}>共 {summary.turnCount} 次记录 · {summary.actualTurns} 次实报 / {summary.estimatedTurns} 次估算。缓存输入、推理输出为细分项，不重复计入总量。</div>
          </section>
          </div>

          <section style={sectionStyle}>
            <div style={sectionHeadingStyle}>
              <span>最近调用趋势</span>
            </div>
            <div style={directionTrendStyle}>
              <span style={{ color: INPUT_COLOR }}>输入：{inputStats.trend}</span>
              <span style={{ color: OUTPUT_COLOR }}>输出：{outputStats.trend}</span>
              <span>比较近 6 次记录的前后半段</span>
            </div>
            <div style={trendMetricGridStyle}>
              {([
                ['latest', `最近一次 · ${callLabel(latestEvent)}${latestEvent?.estimated ? '（估算）' : ''}`],
                ['average', '近 6 次平均'],
                ['peak', '近 16 次各项峰值'],
              ] as const).map(([key, label]) => <div key={key} aria-label={label} style={trendMetricStyle}>
                <span>{label}</span>
                <strong style={{ color: INPUT_COLOR }} title={exactTokens(inputStats[key])}>输入 {formatTokens(inputStats[key])} Token</strong>
                <strong style={{ color: OUTPUT_COLOR }} title={exactTokens(outputStats[key])}>输出 {formatTokens(outputStats[key])} Token</strong>
                <span title={exactTokens(totalStats[key])}>{key === 'peak' ? '单次合计峰值' : '合计'} {formatTokens(totalStats[key])} Token</span>
              </div>)}
            </div>
            <UsageLineChart events={summary.events} />
            <div style={finePrintStyle}>
              折线展示最近最多 16 次模型调用的连续变化，纵轴是单次调用消耗的 Token。
              输入和输出分别统计，峰值可能来自不同调用；选择“只看输出”可放大输出趋势。
              当前 {summary.actualTurns}/{summary.turnCount} 次为精确数据（{exactPercent}%）。
            </div>
          </section>

          <section style={sectionStyle}>
            <div style={sectionHeadingStyle}><span>上下文压缩记录</span></div>
            <div style={eventSummaryStyle}>
              <span><strong>{summary.contextEventCount || summary.contextEvents.length}</strong> 次明确压缩/重置</span>
              <span><strong>{inferredDrops}</strong> 次疑似自动压缩</span>
            </div>
            {(summary.contextEvents.length > 0 || inferredDrops > 0) ? (
              <div style={finePrintStyle}>
                {summary.contextEvents.at(-1)?.label || '检测到上下文规模明显下降，可能发生自动压缩或切换了新线程。'}
              </div>
            ) : <div style={finePrintStyle}>目前没有发现压缩、清空或明显的上下文回落。</div>}
          </section>

          <section style={{ ...sectionStyle, marginBottom: 0 }}>
            <div style={sectionHeadingStyle}><span>上下文预警设置</span></div>
            <div style={preferenceRowStyle}>
              <label style={checkboxLabelStyle}>
                <input type="checkbox" checked={preference.enabled}
                  onChange={(event) => updatePreference({ enabled: event.target.checked })} />
                当前上下文达到
              </label>
              <input type="number" min={50} max={95} step={5} value={preference.warningPercent}
                disabled={!preference.enabled}
                onChange={(event) => updatePreference({
                  warningPercent: Math.max(50, Math.min(95, Number(event.target.value) || 80)),
                })}
                style={numberInputStyle} />
              <span>% 时提醒我</span>
            </div>
            <div style={finePrintStyle}>该偏好只保存在当前控制端和当前用户下，不会写入共享执行节点。</div>
          </section>
        </div>
        </div>
        </AppModalPortal>
      )}
    </div>
  );
};

const headerRootStyle: React.CSSProperties = { position: 'relative', flexShrink: 0 };
const INPUT_COLOR = 'var(--theme-accent)';
const OUTPUT_COLOR = 'var(--theme-success, #2da44e)';
const TOKEN_SERIES = [
  { direction: 'input', label: '输入', color: INPUT_COLOR },
  { direction: 'output', label: '输出', color: OUTPUT_COLOR },
] as const;
const floatingRootStyle: React.CSSProperties = { position: 'absolute', top: 10, right: 96, zIndex: 70 };
const triggerStyle: React.CSSProperties = {
  minWidth: 132, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '0 13px',
  borderRadius: 10, border: '1px solid color-mix(in srgb, var(--theme-accent) 38%, var(--theme-border))',
  background: 'color-mix(in srgb, var(--theme-bg-secondary) 90%, var(--theme-accent) 10%)',
  color: 'var(--theme-text)', fontSize: 12.5, fontWeight: 650,
  fontVariantNumeric: 'tabular-nums', cursor: 'pointer', whiteSpace: 'nowrap',
  boxShadow: '0 4px 14px rgba(0,0,0,.18)',
};
const triggerDotStyle: React.CSSProperties = {
  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
  background: 'var(--theme-accent)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--theme-accent) 20%, transparent)',
};
const triggerWarningStyle: React.CSSProperties = {
  color: '#f59e0b', borderColor: 'rgba(245,158,11,.55)', background: 'rgba(245,158,11,.10)',
};
const panelOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10070, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  padding: 'clamp(14px, 5vh, 48px) 14px 14px', background: 'rgba(3, 8, 18, .52)',
  backdropFilter: 'blur(4px)', boxSizing: 'border-box',
};
const panelStyle: React.CSSProperties = {
  position: 'relative', width: 'min(860px, calc(100vw - 28px))',
  maxHeight: 'calc(100vh - clamp(28px, 10vh, 96px))', overflow: 'auto', padding: 22,
  border: '1px solid var(--theme-border)', borderRadius: 16,
  background: 'var(--theme-popover-bg, var(--theme-bg-secondary))', color: 'var(--theme-text)', opacity: 1,
  boxShadow: '0 26px 80px rgba(0,0,0,.52)', boxSizing: 'border-box',
};
const panelHeaderStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 18 };
const titleStyle: React.CSSProperties = { fontSize: 19, fontWeight: 780, letterSpacing: '.01em' };
const subtitleStyle: React.CSSProperties = { marginTop: 5, color: 'var(--theme-text-muted)', fontSize: 12 };
const closeStyle: React.CSSProperties = { marginLeft: 'auto', width: 34, height: 34, border: '1px solid var(--theme-border)', borderRadius: 8, background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text-muted)', fontSize: 21, cursor: 'pointer', lineHeight: 1 };
const overviewGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 14, alignItems: 'stretch' };
const contextSectionStyle: React.CSSProperties = {
  padding: 16, border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, var(--theme-border))',
  borderRadius: 11, background: 'color-mix(in srgb, var(--theme-bg-tertiary) 84%, var(--theme-accent) 16%)',
};
const cumulativeSectionStyle: React.CSSProperties = { padding: 16, border: '1px solid var(--theme-border)', borderRadius: 11, background: 'var(--theme-bg-tertiary)' };
const metricGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 11 };
const directionValueStyle: React.CSSProperties = { fontSize: 22, fontVariantNumeric: 'tabular-nums' };
const metricStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, padding: '10px 9px', borderRadius: 8, background: 'color-mix(in srgb, var(--theme-bg-secondary) 76%, transparent)', minWidth: 0, fontSize: 10.5, color: 'var(--theme-text-muted)' };
const sectionStyle: React.CSSProperties = { padding: '17px 0', borderTop: '1px solid var(--theme-border)' };
const sectionHeadingStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9, fontSize: 13, fontWeight: 740 };
const statusBadgeStyle: React.CSSProperties = { marginLeft: 'auto', padding: '3px 7px', borderRadius: 999, background: 'rgba(255,255,255,.06)', fontSize: 10.5, fontWeight: 700 };
const directionTrendStyle: React.CSSProperties = { display: 'flex', gap: '6px 16px', flexWrap: 'wrap', marginBottom: 9, color: 'var(--theme-text-muted)', fontSize: 11 };
const emptyTrendStyle: React.CSSProperties = { height: 54, display: 'grid', placeItems: 'center', color: 'var(--theme-text-muted)', fontSize: 10.5, border: '1px dashed var(--theme-border)', borderRadius: 7 };
const finePrintStyle: React.CSSProperties = { marginTop: 8, color: 'var(--theme-text-muted)', fontSize: 10.5, lineHeight: 1.55 };
const contextLineStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 13, fontVariantNumeric: 'tabular-nums' };
const contextPercentStyle: React.CSSProperties = { fontSize: 32, lineHeight: 1, letterSpacing: '-.04em' };
const contextNumbersStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--theme-text-muted)' };
const trackStyle: React.CSSProperties = { position: 'relative', height: 10, marginTop: 12, borderRadius: 999, overflow: 'hidden', background: 'rgba(255,255,255,.08)' };
const thresholdMarkStyle: React.CSSProperties = { position: 'absolute', top: 0, bottom: 0, width: 2, background: '#f59e0b', boxShadow: '0 0 0 1px rgba(0,0,0,.22)' };
const contextFootStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 7, color: 'var(--theme-text-muted)', fontSize: 10.5 };
const contextSourceStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 12, padding: '9px 10px', borderRadius: 8, background: 'rgba(0,0,0,.12)', color: 'var(--theme-text-muted)', fontSize: 10.5, lineHeight: 1.45 };
const contextFormulaStyle: React.CSSProperties = { alignSelf: 'flex-start', padding: '3px 6px', borderRadius: 5, background: 'rgba(0,0,0,.16)', color: 'var(--theme-text)', fontSize: 11, fontVariantNumeric: 'tabular-nums' };
const unavailableStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, padding: 11, borderRadius: 8, background: 'rgba(255,255,255,.045)', color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.55 };
const unavailableTitleStyle: React.CSSProperties = { color: 'var(--theme-text)', fontSize: 12.5 };
const cumulativeHeaderStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const cumulativeValueStyle: React.CSSProperties = { display: 'block', fontSize: 28, lineHeight: 1, letterSpacing: '-.035em', fontVariantNumeric: 'tabular-nums' };
const tokenUnitStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 12, fontWeight: 650, letterSpacing: 0 };
const lifetimeBadgeStyle: React.CSSProperties = { padding: '4px 7px', borderRadius: 6, background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text-muted)', fontSize: 10.5, whiteSpace: 'nowrap' };
const plainExplanationStyle: React.CSSProperties = { marginTop: 8, color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.5 };
const trendMetricGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 9, marginBottom: 9 };
const trendMetricStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, padding: '9px 10px', borderRadius: 8, background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text-muted)', fontSize: 10.5 };
const lineChartWrapStyle: React.CSSProperties = { padding: '8px 10px 6px', border: '1px solid var(--theme-border)', borderRadius: 10, background: 'color-mix(in srgb, var(--theme-bg-tertiary) 76%, transparent)' };
const lineChartStyle: React.CSSProperties = { display: 'block', width: '100%', height: 210, overflow: 'visible' };
const chartToggleStyle: React.CSSProperties = { padding: '7px 9px', border: '1px solid var(--theme-border)', borderRadius: 6, background: 'var(--theme-bg-secondary)', color: 'var(--theme-text-muted)', fontSize: 11, cursor: 'pointer' };
const callDetailStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--theme-border)', padding: '10px 7px 5px' };
const callPickerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--theme-text-muted)' };
const callSelectStyle: React.CSSProperties = { minWidth: 0, maxWidth: '100%', padding: 6, border: '1px solid var(--theme-border)', borderRadius: 5, background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', fontSize: 11 };
const detailNumbersStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '6px 16px', color: 'var(--theme-text-muted)', fontSize: 11, fontVariantNumeric: 'tabular-nums' };
const lineLegendStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 16, padding: '3px 7px 5px', color: 'var(--theme-text-muted)', fontSize: 10.5, flexWrap: 'wrap' };
const legendPointStyle: React.CSSProperties = { display: 'inline-block', width: 8, height: 8, marginRight: 5, borderRadius: '50%', boxSizing: 'border-box' };
const eventSummaryStyle: React.CSSProperties = { display: 'flex', gap: 16, color: 'var(--theme-text-muted)', fontSize: 11.5, flexWrap: 'wrap' };
const preferenceRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, flexWrap: 'wrap' };
const checkboxLabelStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5 };
const numberInputStyle: React.CSSProperties = { width: 58, padding: '5px 6px', border: '1px solid var(--theme-border)', borderRadius: 5, background: 'var(--theme-input-bg)', color: 'var(--theme-text)', fontSize: 12 };
