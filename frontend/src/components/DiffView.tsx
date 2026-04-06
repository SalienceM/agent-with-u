import React, { useState } from 'react';
import { computeDiff } from '../utils/diff';

export interface DiffData {
  path: string;
  old: string;
  new: string;
}

interface Props {
  diff: DiffData;
}

const LINE_BG: Record<string, string> = {
  added:   'rgba(46,160,67,0.15)',
  removed: 'rgba(248,81,73,0.15)',
  context: 'transparent',
};

const NUM_BG: Record<string, string> = {
  added:   'rgba(46,160,67,0.25)',
  removed: 'rgba(248,81,73,0.25)',
  context: 'transparent',
};

const PREFIX_COLOR: Record<string, string> = {
  added:   '#3fb950',
  removed: '#f85149',
  context: 'transparent',
};

const TEXT_COLOR: Record<string, string> = {
  added:   '#aff5b4',
  removed: '#ffdcd7',
  context: 'rgba(200,200,200,0.75)',
};

const PREFIX_CHAR: Record<string, string> = {
  added:   '+',
  removed: '-',
  context: ' ',
};

export const DiffView: React.FC<Props> = ({ diff }) => {
  const [collapsed, setCollapsed] = useState(false);
  const lines = computeDiff(diff.old, diff.new, 3);
  const addedCount   = lines.filter((l) => l.type === 'added').length;
  const removedCount = lines.filter((l) => l.type === 'removed').length;

  // Compute display width for line number columns
  const maxOldNum = Math.max(...lines.map((l) => l.oldNum ?? 0));
  const maxNewNum = Math.max(...lines.map((l) => l.newNum ?? 0));
  const numWidth = Math.max(String(maxOldNum).length, String(maxNewNum).length, 2);

  return (
    <div style={{
      borderRadius: 6,
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.1)',
      marginTop: 6,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      background: '#0d1117',
    }}>
      {/* ── Header ── */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
          background: 'rgba(255,255,255,0.04)',
          cursor: 'pointer',
          userSelect: 'none',
          borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontSize: 10, opacity: 0.45 }}>{collapsed ? '▶' : '▼'}</span>
        <span style={{ color: '#58a6ff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {diff.path || '(file)'}
        </span>
        <span style={{ color: '#3fb950', fontWeight: 600 }}>+{addedCount}</span>
        <span style={{ color: '#f85149', fontWeight: 600, marginLeft: 4 }}>-{removedCount}</span>
      </div>

      {/* ── Diff lines ── */}
      {!collapsed && (
        <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
          {lines.length === 0 ? (
            <div style={{ padding: '6px 10px', color: '#888' }}>（无变更）</div>
          ) : (
            lines.map((line, i) => {
              const isSep = line.text === '...';
              if (isSep) {
                return (
                  <div key={i} style={{
                    display: 'flex',
                    background: 'rgba(255,255,255,0.02)',
                    padding: '1px 0',
                    lineHeight: '1.5',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    {/* old num */}
                    <span style={{ width: numWidth * 7 + 8, flexShrink: 0, textAlign: 'right',
                      padding: '0 6px', color: '#555', background: 'rgba(255,255,255,0.02)', userSelect: 'none' }}>
                      ···
                    </span>
                    {/* new num */}
                    <span style={{ width: numWidth * 7 + 8, flexShrink: 0, textAlign: 'right',
                      padding: '0 6px', color: '#555', background: 'rgba(255,255,255,0.02)',
                      borderRight: '1px solid rgba(255,255,255,0.08)', userSelect: 'none' }}>
                      ···
                    </span>
                    {/* prefix */}
                    <span style={{ width: 18, flexShrink: 0, textAlign: 'center', color: '#555', userSelect: 'none' }} />
                    <span style={{ color: '#555', paddingLeft: 4 }}>···</span>
                  </div>
                );
              }

              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    background: LINE_BG[line.type],
                    lineHeight: '1.6',
                    whiteSpace: 'pre',
                  }}
                >
                  {/* old line number */}
                  <span style={{
                    width: numWidth * 7 + 8,
                    flexShrink: 0,
                    textAlign: 'right',
                    padding: '0 6px',
                    color: 'rgba(139,148,158,0.6)',
                    background: NUM_BG[line.type],
                    userSelect: 'none',
                    minWidth: 28,
                  }}>
                    {line.oldNum ?? ''}
                  </span>
                  {/* new line number */}
                  <span style={{
                    width: numWidth * 7 + 8,
                    flexShrink: 0,
                    textAlign: 'right',
                    padding: '0 6px',
                    color: 'rgba(139,148,158,0.6)',
                    background: NUM_BG[line.type],
                    borderRight: '1px solid rgba(255,255,255,0.08)',
                    userSelect: 'none',
                    minWidth: 28,
                  }}>
                    {line.newNum ?? ''}
                  </span>
                  {/* +/- prefix */}
                  <span style={{
                    width: 18,
                    flexShrink: 0,
                    textAlign: 'center',
                    color: PREFIX_COLOR[line.type],
                    userSelect: 'none',
                    fontWeight: 600,
                  }}>
                    {PREFIX_CHAR[line.type]}
                  </span>
                  {/* content */}
                  <span style={{ color: TEXT_COLOR[line.type], paddingLeft: 4, paddingRight: 8 }}>
                    {line.text}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
