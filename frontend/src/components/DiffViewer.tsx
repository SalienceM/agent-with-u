/**
 * DiffViewer — Git diff 双窗口对比组件（带语法高亮）
 *
 * 将 unified diff 解析为左右对比视图：
 *   - 左侧：旧版本（红色高亮删除的行）
 *   - 右侧：新版本（绿色高亮新增的行）
 *   - 未修改的行在两侧都显示（灰色）
 *
 * 使用 highlight.js 进行语法高亮（根据文件扩展名）
 */
import React, { useMemo, useRef } from 'react';
import hljs from 'highlight.js';

const LANG_ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cxx: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
  zsh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', json: 'json',
  jsonc: 'json', xml: 'xml', html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', toml: 'ini', ini: 'ini',
  cfg: 'ini', conf: 'ini', md: 'markdown', markdown: 'markdown', swift: 'swift',
  dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', pl: 'perl',
};

function extOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return lower;
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function highlightCode(text: string, ext: string): string {
  const lang = LANG_ALIAS[ext] || ext;
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    }
    return text.length > 0 ? hljs.highlightAuto(text).value : '';
  } catch {
    return escapeHtml(text);
  }
}

interface DiffLine {
  type: 'old' | 'new' | 'same' | 'hunk';
  oldLineNum: number | null;
  newLineNum: number | null;
  content: string;
}

interface Props {
  diff: string;
  filename?: string;
  binary?: boolean;
}

/**
 * 解析 unified diff 为结构化数据
 */
function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split('\n');
  const result: DiffLine[] = [];
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLineNum = parseInt(match[1]);
        newLineNum = parseInt(match[2]);
      }
      result.push({ type: 'hunk', oldLineNum: null, newLineNum: null, content: line });
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      // File headers, skip
      continue;
    } else if (line.startsWith('-')) {
      result.push({ type: 'old', oldLineNum: oldLineNum++, newLineNum: null, content: line.slice(1) });
    } else if (line.startsWith('+')) {
      result.push({ type: 'new', oldLineNum: null, newLineNum: newLineNum++, content: line.slice(1) });
    } else if (line.startsWith(' ')) {
      result.push({ type: 'same', oldLineNum: oldLineNum++, newLineNum: newLineNum++, content: line.slice(1) });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      continue;
    } else {
      // Other (context, etc.)
      result.push({ type: 'same', oldLineNum: oldLineNum++, newLineNum: newLineNum++, content: line });
    }
  }

  return result;
}

export const DiffViewer: React.FC<Props> = ({ diff, filename, binary }) => {
  const ext = filename ? extOf(filename) : '';
  const diffLines = useMemo(() => parseUnifiedDiff(diff), [diff]);

  // 同步滚动：左右两面板 scrollTop 联动
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const scrolling = useRef<'left' | 'right' | null>(null);

  const handleLeftScroll = () => {
    if (scrolling.current === 'right') return;
    scrolling.current = 'left';
    if (leftRef.current && rightRef.current) {
      rightRef.current.scrollTop = leftRef.current.scrollTop;
    }
    requestAnimationFrame(() => { scrolling.current = null; });
  };

  const handleRightScroll = () => {
    if (scrolling.current === 'left') return;
    scrolling.current = 'right';
    if (rightRef.current && leftRef.current) {
      leftRef.current.scrollTop = rightRef.current.scrollTop;
    }
    requestAnimationFrame(() => { scrolling.current = null; });
  };

  // 二进制文件处理
  if (binary && diff) {
    return (
      <div style={binaryContainerStyle}>
         二进制文件差异（无法文本显示）{filename ? `: ${filename}` : ''}
      </div>
    );
  }

  // 空 diff 处理
  if (!diff || diffLines.length === 0) {
    return (
      <div style={binaryContainerStyle}>
        无差异
      </div>
    );
  }

  // 分离为左右两列
  const leftLines: DiffLine[] = [];
  const rightLines: DiffLine[] = [];

  for (const line of diffLines) {
    if (line.type === 'hunk') {
      // Hunk header 显示在两侧
      leftLines.push(line);
      rightLines.push(line);
    } else if (line.type === 'old') {
      leftLines.push(line);
      // 右侧用空行占位，保持行号对齐
      rightLines.push({ type: 'same', oldLineNum: null, newLineNum: null, content: '' });
    } else if (line.type === 'new') {
      // 左侧用空行占位
      leftLines.push({ type: 'same', oldLineNum: null, newLineNum: null, content: '' });
      rightLines.push(line);
    } else if (line.type === 'same') {
      leftLines.push(line);
      rightLines.push(line);
    }
  }

  const renderLine = (line: DiffLine, isLeft: boolean) => {
    const lineNum = isLeft ? line.oldLineNum : line.newLineNum;

    // Hunk header
    if (line.type === 'hunk') {
      return (
        <div key={`hunk-${isLeft ? 'l' : 'r'}-${line.content}`} style={hunkHeaderStyle}>
          <span style={lineNumStyle}>{lineNum !== null ? lineNum : ''}</span>
          <span style={hunkContentStyle}>{line.content}</span>
        </div>
      );
    }

    // 空行占位
    if (line.content === '' && line.type === 'same') {
      return (
        <div key={`empty-${isLeft ? 'l' : 'r'}`} style={emptyLineStyle}>
          <span style={lineNumStyle}>{''}</span>
          <span />
        </div>
      );
    }

    // 删除的行（只在左侧显示）
    if (line.type === 'old') {
      const highlighted = highlightCode(line.content, ext);
      return (
        <div key={`old-${line.oldLineNum}`} style={oldLineStyle}>
          <span style={lineNumStyle}>{lineNum}</span>
          <span style={oldContentStyle} dangerouslySetInnerHTML={{ __html: highlighted || escapeHtml(line.content) }} />
        </div>
      );
    }

    // 新增的行（只在右侧显示）
    if (line.type === 'new') {
      const highlighted = highlightCode(line.content, ext);
      return (
        <div key={`new-${line.newLineNum}`} style={newLineStyle}>
          <span style={lineNumStyle}>{lineNum}</span>
          <span style={newContentStyle} dangerouslySetInnerHTML={{ __html: highlighted || escapeHtml(line.content) }} />
        </div>
      );
    }

    // 相同的行
    const highlighted = line.content !== '' ? highlightCode(line.content, ext) : '';
    return (
      <div key={`same-${lineNum}`} style={sameLineStyle}>
        <span style={lineNumStyle}>{lineNum}</span>
        <span style={sameContentStyle} dangerouslySetInnerHTML={{ __html: highlighted || escapeHtml(line.content) }} />
      </div>
    );
  };

  return (
    <div style={containerStyle}>
      {/* 左侧：旧版本 */}
      <div style={paneStyle}>
        <div style={headerStyle}>← 旧版本</div>
        <div ref={leftRef} style={scrollAreaStyle} onScroll={handleLeftScroll}>
          {leftLines.map((line, idx) => (
            <React.Fragment key={`left-${idx}`}>
              {renderLine(line, true)}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* 分隔线 */}
      <div style={dividerStyle} />

      {/* 右侧：新版本 */}
      <div style={paneStyle}>
        <div style={headerStyle}>新版本 →</div>
        <div ref={rightRef} style={scrollAreaStyle} onScroll={handleRightScroll}>
          {rightLines.map((line, idx) => (
            <React.Fragment key={`right-${idx}`}>
              {renderLine(line, false)}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── 样式 ──

const containerStyle: React.CSSProperties = {
  display: 'flex',
  height: '100%',
  background: '#1e1e1e',
  fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
  fontSize: 12,
  overflow: 'hidden',
};

const paneStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 11,
  fontWeight: 600,
  color: '#c9d1d9',
  background: '#252526',
  borderBottom: '1px solid #333',
  flexShrink: 0,
};

const dividerStyle: React.CSSProperties = {
  width: 2,
  background: '#444',
  flexShrink: 0,
};

const scrollAreaStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  lineHeight: 1.5,
};

const lineNumStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 40,
  padding: '0 8px 0 4px',
  textAlign: 'right',
  color: '#858585',
  userSelect: 'none',
  flexShrink: 0,
  borderRight: '1px solid #333',
  fontSize: 11,
};

const hunkHeaderStyle: React.CSSProperties = {
  display: 'flex',
  background: '#264f78',
  color: '#c9d1d9',
};

const hunkContentStyle: React.CSSProperties = {
  padding: '0 8px',
  color: '#6cb6ff',
  fontStyle: 'italic',
  fontSize: 11,
};

const oldLineStyle: React.CSSProperties = {
  display: 'flex',
  background: 'rgba(248, 81, 73, 0.1)',
};

const oldContentStyle: React.CSSProperties = {
  padding: '0 8px',
  flex: 1,
  color: '#f85149',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'pre',
};

const newLineStyle: React.CSSProperties = {
  display: 'flex',
  background: 'rgba(63, 185, 80, 0.1)',
};

const newContentStyle: React.CSSProperties = {
  padding: '0 8px',
  flex: 1,
  color: '#3fb950',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'pre',
};

const sameLineStyle: React.CSSProperties = {
  display: 'flex',
  background: 'transparent',
};

const sameContentStyle: React.CSSProperties = {
  padding: '0 8px',
  flex: 1,
  color: '#c9d1d9',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'pre',
};

const emptyLineStyle: React.CSSProperties = {
  display: 'flex',
  background: '#1e1e1e',
  minHeight: 18,
};

const binaryContainerStyle: React.CSSProperties = {
  padding: 24,
  textAlign: 'center',
  color: '#8b949e',
  fontSize: 13,
  background: '#1e1e1e',
};
