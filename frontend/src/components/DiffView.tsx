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

const PREFIX_COLOR: Record<string, string> = {
  added: '#4caf50',
  removed: '#f44336',
  context: '#888',
};

const BG_COLOR: Record<string, string> = {
  added: 'rgba(76,175,80,0.12)',
  removed: 'rgba(244,67,54,0.12)',
  context: 'transparent',
};

const PREFIX_CHAR: Record<string, string> = {
  added: '+',
  removed: '-',
  context: ' ',
};

export const DiffView: React.FC<Props> = ({ diff }) => {
  const [collapsed, setCollapsed] = useState(false);
  const lines = computeDiff(diff.old, diff.new, 3);
  const addedCount = lines.filter((l) => l.type === 'added').length;
  const removedCount = lines.filter((l) => l.type === 'removed').length;

  return (
    <div style={{
      borderRadius: 6,
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.1)',
      marginTop: 6,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          background: 'rgba(255,255,255,0.05)',
          cursor: 'pointer',
          userSelect: 'none',
          borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ opacity: 0.5 }}>{collapsed ? '▶' : '▼'}</span>
        <span style={{ color: '#ccc', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {diff.path || '(file)'}
        </span>
        <span style={{ color: '#4caf50', marginLeft: 4 }}>+{addedCount}</span>
        <span style={{ color: '#f44336', marginLeft: 4 }}>-{removedCount}</span>
      </div>

      {/* Diff lines */}
      {!collapsed && (
        <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
          {lines.length === 0 ? (
            <div style={{ padding: '6px 10px', color: '#888' }}>（无变更）</div>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  background: BG_COLOR[line.type],
                  padding: '0 8px',
                  whiteSpace: 'pre',
                  lineHeight: '1.6',
                }}
              >
                <span style={{
                  color: PREFIX_COLOR[line.type],
                  width: 14,
                  flexShrink: 0,
                  userSelect: 'none',
                }}>
                  {PREFIX_CHAR[line.type]}
                </span>
                <span style={{ color: line.type === 'context' ? '#aaa' : PREFIX_COLOR[line.type] }}>
                  {line.text}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
