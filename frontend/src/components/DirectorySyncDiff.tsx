import React, { useEffect, useMemo, useRef, useState } from 'react';
import { foldedReviewRows, type ReviewDiff } from '../utils/syncReviewDiff';

const ROW = 24;
const controlStyle: React.CSSProperties = { minHeight: 32, padding: '4px 8px', border: '1px solid var(--theme-border)', borderRadius: 4,
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer' };
export const DirectorySyncDiff: React.FC<{ diff: Extract<ReviewDiff, { status: 'ok' }>; narrow: boolean; localMissing?: boolean; remoteMissing?: boolean }> = ({ diff, narrow, localMissing, remoteMissing }) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set()), [top, setTop] = useState(0);
  const [hunk, setHunk] = useState(0), [side, setSide] = useState<'left' | 'right'>('left');
  const left = useRef<HTMLDivElement>(null), right = useRef<HTMLDivElement>(null);
  const mirroredScroll = useRef(new WeakMap<HTMLDivElement, { top: number; left: number }>());
  const rows = useMemo(() => foldedReviewRows(diff.rows, expanded), [diff, expanded]);
  useEffect(() => { setExpanded(new Set()); setTop(0); setHunk(0); if (left.current) left.current.scrollTop = 0; if (right.current) right.current.scrollTop = 0; }, [diff]);
  const scroll = (from: HTMLDivElement, other: HTMLDivElement | null) => {
    const mirrored = mirroredScroll.current.get(from);
    if (mirrored) {
      mirroredScroll.current.delete(from);
      if (mirrored.top === from.scrollTop && mirrored.left === from.scrollLeft) return;
    }
    setTop(from.scrollTop);
    if (other && (other.scrollTop !== from.scrollTop || other.scrollLeft !== from.scrollLeft)) {
      const previousTop = other.scrollTop, previousLeft = other.scrollLeft;
      other.scrollTop = from.scrollTop; other.scrollLeft = from.scrollLeft;
      // 短侧会夹紧横向位置；忽略其程序滚动反馈，不能把长侧拖回去而遮住长行。
      if (other.scrollTop !== previousTop || other.scrollLeft !== previousLeft) {
        mirroredScroll.current.set(other, { top: other.scrollTop, left: other.scrollLeft });
      }
    }
  };
  const jump = (change: number) => {
    const index = Math.max(0, Math.min(diff.hunks.length - 1, hunk + change)); setHunk(index);
    const row = rows.findIndex(r => r.kind === 'row' && r.index === diff.hunks[index]);
    for (const ref of [left, right]) if (ref.current) ref.current.scrollTop = Math.max(0, row * ROW - ROW * 2);
    setTop(Math.max(0, row * ROW - ROW * 2));
  };
  const start = Math.max(0, Math.floor(top / ROW) - 10), end = Math.min(rows.length, start + 100);
  const renderSide = (which: 'left' | 'right') => {
    const text = diff[which];
    const missing = which === 'left' ? localMissing : remoteMissing;
    return <section style={{ minWidth: 0, flex: 1, display: narrow && side !== which ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '6px 10px', fontSize: 12, borderBottom: '1px solid var(--theme-border)' }}>
        <strong>{which === 'left' ? '本机副本' : '执行端'}</strong> · {missing ? '该端不存在（不是空文件）' : `${text.encoding} · BOM ${text.bom || '无'} · ${text.eol.toUpperCase()} · 末尾换行${text.finalNewline ? '有' : '无'}`}
      </div>
      <div ref={which === 'left' ? left : right} tabIndex={0} aria-label={`${which === 'left' ? '本机' : '执行端'}差异正文`}
        onScroll={e => scroll(e.currentTarget, which === 'left' ? right.current : left.current)}
        style={{ overflow: 'auto', flex: 1, minHeight: 0, font: '12px/24px Consolas, monospace', position: 'relative' }}>
        <div style={{ height: rows.length * ROW, minWidth: '100%', width: 'max-content', position: 'relative' }}>
          <div style={{ position: 'absolute', top: start * ROW, minWidth: '100%' }}>
            {rows.slice(start, end).map((display, i) => {
              if (display.kind === 'fold') return <button key={start + i} style={{ height: ROW, width: '100%', display: 'block', color: 'var(--theme-text-secondary, var(--theme-text-muted))',
                background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)', cursor: 'pointer' }}
                onClick={() => setExpanded(v => new Set([...v, display.start]))}>展开 {display.end - display.start - 6} 行未改内容</button>;
              const row = diff.rows[display.index], line = row[which];
              return <div key={start + i} data-diff-kind={row.kind} style={{ height: ROW, whiteSpace: 'pre', minWidth: '100%', display: 'flex',
                background: row.kind === 'change' && line !== null ? which === 'left' ? 'rgba(239,68,68,.15)' : 'rgba(34,197,94,.15)' : 'transparent' }}>
                <span aria-hidden style={{ width: 52, flexShrink: 0, textAlign: 'right', paddingRight: 10, color: 'var(--theme-text-secondary)', userSelect: 'none' }}>{line === null ? '' : line + 1}</span>
                <span>{line === null ? '' : text.lines[line]}</span>
              </div>;
            })}
          </div>
        </div>
      </div>
    </section>;
  };
  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 6, flexWrap: 'wrap' }}>
      {narrow && <><button style={controlStyle} aria-pressed={side === 'left'} onClick={() => setSide('left')}>本机副本</button><button style={controlStyle} aria-pressed={side === 'right'} onClick={() => setSide('right')}>执行端</button></>}
      <button style={controlStyle} disabled={!diff.hunks.length} onClick={() => jump(-1)}>上一差异块</button>
      <span>{diff.hunks.length ? hunk + 1 : 0}/{diff.hunks.length}</span>
      <button style={controlStyle} disabled={!diff.hunks.length} onClick={() => jump(1)}>下一差异块</button>
      {diff.formatDifferent && <span role="status">编码、BOM 或换行格式不同（传输保留原字节）</span>}
    </div>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, borderTop: '1px solid var(--theme-border)' }}>{renderSide('left')}{renderSide('right')}</div>
  </div>;
};
