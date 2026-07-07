/**
 * DiffViewer — unified diff 语法高亮查看器。
 * 纯 CSS 实现行级高亮，无需外部依赖。
 */
import React, { useMemo } from 'react';

interface Props {
  diff: string;
  filename?: string;
  binary?: boolean;
}

export const DiffViewer: React.FC<Props> = ({ diff, filename, binary }) => {
  const lines = useMemo(() => {
    if (!diff) return [];
    return diff.split('\n');
  }, [diff]);

  if (binary && diff) {
    return (
      <div style={containerStyle}>
        <div style={binaryStyle}>📦 二进制文件差异（无法文本显示）{filename ? `: ${filename}` : ''}</div>
      </div>
    );
  }

  if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
    return (
      <div style={containerStyle}>
        <div style={emptyStyle}>无差异</div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {filename && <div style={filenameStyle}>{filename}</div>}
      <pre style={preStyle}>
        {lines.map((line, i) => {
          let cls = lineNormalStyle;
          let prefix = '';
          if (line.startsWith('++') || line.startsWith('--')) {
            cls = lineHeaderStyle;
          } else if (line.startsWith('+')) {
            cls = lineAddStyle;
            prefix = '+';
          } else if (line.startsWith('-')) {
            cls = lineRemoveStyle;
            prefix = '−';
          } else if (line.startsWith('@@')) {
            cls = lineHunkStyle;
          } else if (line.startsWith('diff ')) {
            cls = lineDiffHeaderStyle;
          } else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename')) {
            cls = lineMetaStyle;
          }
          return (
            <div key={i} style={cls}>
              <span style={prefixStyle}>{prefix || ' '}</span>
              <span>{line || '\n'}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
};

// ── 样式 ─────────────────────────────────────────────────────────────
const containerStyle: React.CSSProperties = {
  background: 'var(--theme-bg, #0d1117)',
  borderRadius: 8,
  overflow: 'auto',
  maxHeight: 400,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  lineHeight: 1.5,
};

const filenameStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--theme-text-muted, #8b949e)',
  background: 'var(--theme-bg-tertiary, #161b22)',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '4px 0',
  whiteSpace: 'pre',
  overflow: 'auto',
};

const lineNormalStyle: React.CSSProperties = {
  padding: '0 12px',
  color: 'var(--theme-text, #c9d1d9)',
};

const lineAddStyle: React.CSSProperties = {
  padding: '0 12px',
  background: 'rgba(46, 160, 67, 0.15)',
  color: '#3fb950',
};

const lineRemoveStyle: React.CSSProperties = {
  padding: '0 12px',
  background: 'rgba(248, 81, 73, 0.15)',
  color: '#f85149',
};

const lineHunkStyle: React.CSSProperties = {
  padding: '0 12px',
  color: 'var(--theme-accent, #58a6ff)',
  fontWeight: 600,
};

const lineDiffHeaderStyle: React.CSSProperties = {
  padding: '0 12px',
  color: 'var(--theme-accent, #d2a8ff)',
  fontWeight: 600,
};

const lineHeaderStyle: React.CSSProperties = {
  padding: '0 12px',
  color: 'var(--theme-text-muted, #8b949e)',
  fontWeight: 600,
};

const lineMetaStyle: React.CSSProperties = {
  padding: '0 12px',
  color: 'var(--theme-text-muted, #8b949e)',
  fontStyle: 'italic',
};

const prefixStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 16,
  textAlign: 'center',
  userSelect: 'none',
  opacity: 0.6,
};

const binaryStyle: React.CSSProperties = {
  padding: 24,
  textAlign: 'center',
  color: 'var(--theme-text-muted, #8b949e)',
  fontSize: 13,
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  textAlign: 'center',
  color: 'var(--theme-text-muted, #8b949e)',
  fontSize: 12,
};
