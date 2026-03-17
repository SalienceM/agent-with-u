import React, { useState } from 'react';
import { markdownToHtml } from '../utils/markdown';
import type { ChatMessage, ToolCall } from '../hooks/useChat';

// ── 注入全局动画样式 ──
if (typeof document !== 'undefined' && !document.getElementById('msg-bubble-css')) {
  const style = document.createElement('style');
  style.id = 'msg-bubble-css';
  style.textContent = `
    @keyframes cursor-blink { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes spin { to{transform:rotate(360deg)} }
    @keyframes pulse { 0%,100%{opacity:0.6} 50%{opacity:0.3} }
    @keyframes dots {
      0%, 20% { content: '.'; }
      40% { content: '..'; }
      60%, 100% { content: '...'; }
    }
  `;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════
//  ThinkingBlock
// ═══════════════════════════════════════
const ThinkingBlock: React.FC<{ content: string; isThinking?: boolean }> = ({
  content,
  isThinking,
}) => {
  const [expanded, setExpanded] = useState(false);
  if (!content && !isThinking) return null;
  return (
    <div style={sectionBox}>
      <div onClick={() => setExpanded(!expanded)} style={sectionHeader}>
        <span style={{ ...chevron, transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
        <span style={{ opacity: 0.7 }}>💭</span>
        <span>{isThinking ? 'Thinking…' : 'Thinking'}</span>
        {!expanded && content && (
          <span style={previewText}>
            {content.slice(0, 100)}
            {content.length > 100 ? '…' : ''}
          </span>
        )}
        {isThinking && <span style={spinnerStyle}>◌</span>}
      </div>
      {expanded && (
        <div style={sectionBody}>
          <div style={{ whiteSpace: 'pre-wrap', color: 'var(--theme-text, #1f2328)' }}>
            {content || '(thinking...)'}
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════
//  ToolCallBlock
// ═══════════════════════════════════════
const STATUS_COLOR: Record<string, string> = {
  running: '#58a6ff',     // GitHub blue, matches midnight accent
  done: '#3fb950',        // GitHub green, softer on eyes
  error: '#f85149',       // GitHub red, consistent saturation
};
const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  done: '✅',
  error: '❌',
};

const ToolCallBlock: React.FC<{ tc: ToolCall }> = ({ tc }) => {
  const [expanded, setExpanded] = useState(false);
  const color = STATUS_COLOR[tc.status] || '#888';
  const isRunning = tc.status === 'running';

  // Format duration for display
  const formatDuration = (ms?: number) => {
    if (ms === undefined) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div style={sectionBox}>
      <div onClick={() => setExpanded(!expanded)} style={sectionHeader}>
        <span style={{ ...chevron, transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
        <span style={isRunning ? spinnerStyle : undefined}>{STATUS_ICON[tc.status] || '🔧'}</span>
        <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{tc.name}</span>
        {isRunning && (
          <span style={{ fontSize: 10, color: 'var(--theme-text, #1f2328)', marginLeft: 4 }}>
            Executing...
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 4,
            background: `${color}22`,
            color,
          }}
        >
          {tc.status}
          {tc.duration !== undefined && ` · ${formatDuration(tc.duration)}`}
        </span>
      </div>
      {expanded && (
        <div style={sectionBody}>
          {tc.input && (
            <div style={{ marginBottom: 6 }}>
              <div style={labelStyle}>INPUT</div>
              <pre style={codeBlock}>{tc.input}</pre>
            </div>
          )}
          {tc.output && (
            <div>
              <div style={labelStyle}>OUTPUT</div>
              <pre
                style={{
                  ...codeBlock,
                  color: tc.status === 'error' ? 'var(--theme-error, #cf222e)' : 'var(--theme-text, #1f2328)',
                  maxHeight: 300,
                }}
              >
                {tc.output}
              </pre>
            </div>
          )}
          {isRunning && !tc.output && (
            <div style={{ fontSize: 11, color: 'var(--theme-text, #1f2328)', padding: '4px 0' }}>
              Waiting for result...
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════
//  ★ SystemMessage — 系统/命令消息
// ═══════════════════════════════════════
const SystemMessage: React.FC<{ message: ChatMessage; renderMarkdown?: boolean }> = ({
  message,
  renderMarkdown = true,
}) => {
  const contentHtml =
    renderMarkdown && message.content ? markdownToHtml(message.content) : null;

  return (
    <div style={{ padding: '6px 16px', display: 'flex', justifyContent: 'center' }}>
      <div style={systemBubbleStyle}>
        {contentHtml ? (
          <div dangerouslySetInnerHTML={{ __html: contentHtml }} />
        ) : (
          <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
        )}
        {message.timestamp && (
          <div style={{ fontSize: 10, color: 'var(--theme-text-muted, #656d76)', marginTop: 4, textAlign: 'right' }}>
            {new Date(message.timestamp * 1000).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════
//  MessageBubble — 主组件
// ═══════════════════════════════════════
interface Props {
  message: ChatMessage;
  fontSize?: number;
  renderMarkdown?: boolean;
}

export const MessageBubble: React.FC<Props> = ({
  message,
  fontSize = 14,
  renderMarkdown = true,
}) => {
  // ★ system 消息独立渲染
  if (message.role === 'system') {
    return <SystemMessage message={message} renderMarkdown={renderMarkdown} />;
  }

  const isUser = message.role === 'user';

  const thinkingContent =
    message.thinking ||
    (message as any).thinkingBlocks?.map((b: any) => b.content).join('\n\n') ||
    '';

  const isThinkingPhase = !!message.streaming && !!thinkingContent && !message.content;

  const contentHtml =
    !isUser && renderMarkdown && message.content ? markdownToHtml(message.content) : null;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        padding: '4px 16px',
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          minWidth: 60,
          padding: '10px 14px',
          borderRadius: 12,
          background: isUser ? 'var(--theme-user-message-bg, #0969da1a)' : 'var(--theme-message-bg, #f6f8fa)',
          border: `1px solid ${isUser ? 'var(--theme-accent, #0969da4d)' : 'var(--theme-border, rgba(0,0,0,0.12))'}`,
          fontSize,
          lineHeight: 1.6,
          wordBreak: 'break-word',
        }}
      >
        {/* 附件图片 */}
        {message.images && message.images.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {message.images.map((img: any, i: number) => {
              const src =
                typeof img === 'string'
                  ? img
                  : `data:${img.mimeType || img.mime_type || 'image/png'};base64,${img.base64}`;
              return (
                <img
                  key={i}
                  src={src}
                  alt="attachment"
                  style={{
                    maxWidth: '100%',
                    maxHeight: 300,
                    borderRadius: 8,
                    border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                  }}
                />
              );
            })}
          </div>
        )}

        {/* Thinking */}
        {!isUser && thinkingContent && (
          <ThinkingBlock content={thinkingContent} isThinking={isThinkingPhase} />
        )}

        {/* Tool Calls */}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div style={{ marginBottom: message.content ? 8 : 0 }}>
            {message.toolCalls.map((tc, i) => (
              <ToolCallBlock key={`${tc.id || tc.name}-${i}`} tc={tc} />
            ))}
          </div>
        )}

        {/* 正文 */}
        {contentHtml ? (
          <div dangerouslySetInnerHTML={{ __html: contentHtml }} />
        ) : message.content ? (
          <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
        ) : null}

        {/* 流式光标 */}
        {message.streaming && (
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 16,
              background: 'var(--theme-accent, rgba(122,162,247,0.6))',
              marginLeft: 2,
              borderRadius: 1,
              verticalAlign: 'text-bottom',
              animation: 'cursor-blink 1s infinite',
            }}
          />
        )}

        {/* Token 用量 */}
        {!isUser && message.usage && !message.streaming && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 4 }}>
            {message.usage.inputTokens != null && `↑${message.usage.inputTokens.toLocaleString()}`}
            {message.usage.outputTokens != null && ` ↓${message.usage.outputTokens.toLocaleString()}`}
          </div>
        )}

        {/* 时间戳 */}
        {message.timestamp && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 6, textAlign: 'right' }}>
            {new Date(message.timestamp * 1000).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════
//  共享样式
// ═══════════════════════════════════════
const sectionBox: React.CSSProperties = {
  marginBottom: 6,
  borderRadius: 8,
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  overflow: 'hidden',
};

const sectionHeader: React.CSSProperties = {
  padding: '6px 10px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--theme-text, #1f2328)',
  userSelect: 'none',
};

const sectionBody: React.CSSProperties = {
  padding: '8px 10px',
  borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  fontSize: 12,
  lineHeight: 1.5,
};

const chevron: React.CSSProperties = {
  fontSize: 10,
  transition: 'transform 0.15s',
  flexShrink: 0,
};

const previewText: React.CSSProperties = {
  color: 'var(--theme-text, #1f2328)',
  marginLeft: 4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  animation: 'spin 1s linear infinite',
  marginLeft: 4,
};

const labelStyle: React.CSSProperties = {
  color: 'var(--theme-text-muted, #656d76)',
  marginBottom: 2,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const codeBlock: React.CSSProperties = {
  margin: 0,
  padding: '6px 8px',
  background: 'var(--theme-code-bg, #eaeef2)',
  borderRadius: 4,
  color: 'var(--theme-text, #1f2328)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 200,
  overflow: 'auto',
  fontSize: 11,
  fontFamily: 'monospace',
};

// ★ 系统消息样式
const systemBubbleStyle: React.CSSProperties = {
  maxWidth: '85%',
  padding: '10px 16px',
  borderRadius: 10,
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--theme-text, #1f2328)',
  wordBreak: 'break-word',
};