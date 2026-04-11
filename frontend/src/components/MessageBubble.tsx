import React, { useState, useCallback, useEffect, useRef, memo, useMemo } from 'react';
import { markdownToHtml } from '../utils/markdown';
import type { ChatMessage, ToolCall, ContentBlock } from '../hooks/useChat';
import { DiffView, type DiffData } from './DiffView';

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
    @keyframes msgSlideIn {
      from { opacity: 0; transform: translateY(10px) scale(0.98); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }
    @keyframes cursorGlow {
      0%,100% { opacity: 1; }
      50%     { opacity: 0.15; }
    }
    /* ── 气泡内图片约束 ── */
    .msg-content img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      display: block;
      cursor: zoom-in;
      margin: 4px 0;
    }
    /* ── 懒加载图片样式 ── */
    .msg-content img.lazy,
    .msg-content img[loading="lazy"] {
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    .msg-content img.lazy.loaded,
    .msg-content img[loading="lazy"].loaded {
      opacity: 1;
    }
    /* ── 气泡操作按钮 ── */
    .bubble-action-btn {
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .message-bubble-wrapper:hover .bubble-action-btn {
      opacity: 1;
    }
    /* ── 代码块复制按钮 ── */
    pre.md-pre {
      position: relative;
    }
    .code-copy-btn {
      position: absolute;
      bottom: 6px;
      right: 6px;
      padding: 2px 8px;
      font-size: 11px;
      line-height: 1.6;
      border-radius: 4px;
      border: 1px solid rgba(128,128,128,0.35);
      background: rgba(255,255,255,0.12);
      color: rgba(200,200,200,0.85);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
      font-family: inherit;
      user-select: none;
    }
    pre.md-pre:hover .code-copy-btn {
      opacity: 1;
    }
    .code-copy-btn.copied {
      color: #3fb950;
      border-color: #3fb95066;
      background: rgba(63,185,80,0.12);
      opacity: 1;
    }
    /* ── 图片懒加载占位符 ── */
    .img-lazy-placeholder {
      background: linear-gradient(135deg, rgba(128,128,128,0.1) 25%, transparent 25%, transparent 50%, rgba(128,128,128,0.1) 50%, rgba(128,128,128,0.1) 75%, transparent 75%, transparent);
      background-size: 20px 20px;
      min-height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(128,128,128,0.5);
      font-size: 12px;
    }
    .img-lazy-placeholder img {
      max-height: 200px;
      border-radius: 8px;
      display: none; /* 隐藏真实图片，等加载后再显示 */
    }
    .img-lazy-placeholder.loaded img {
      display: block;
      animation: msgSlideIn 0.2s ease-out;
    }
    .img-lazy-placeholder img.lazy {
      display: block;
    }
  `;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════
//  ImageLightbox — 点击放大预览
// ═══════════════════════════════════════
const ImageLightbox: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <div style={{
        position: 'relative',
        maxWidth: '92vw', maxHeight: '92vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {!loaded && (
          <div className="img-lazy-placeholder" style={{
            width: '200px', height: '200px',
            background: 'linear-gradient(135deg, rgba(128,128,128,0.1) 25%, transparent 25%, transparent 50%, rgba(128,128,128,0.1) 50%, rgba(128,128,128,0.1) 75%, transparent 75%, transparent)',
            backgroundSize: '20px 20px',
          }}>
            <span>Loading...</span>
          </div>
        )}
        <img
          src={src}
          alt="preview"
          onClick={(e) => e.stopPropagation()}
          onLoad={() => setLoaded(true)}
          style={{
            maxWidth: '92vw', maxHeight: '92vh',
            borderRadius: 8,
            boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            cursor: 'default',
            display: loaded ? 'block' : 'none',
          }}
        />
      </div>
      <button
        onClick={onClose}
        style={{
          position: 'fixed', top: 16, right: 20,
          background: 'rgba(255,255,255,0.15)', border: 'none',
          color: '#fff', fontSize: 22, lineHeight: 1,
          width: 36, height: 36, borderRadius: '50%',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >×</button>
    </div>
  );
};

// ═══════════════════════════════════════
//  ThinkingBlock
// ═══════════════════════════════════════
const ThinkingBlock: React.FC<{ content: string; isThinking?: boolean }> = memo(function ThinkingBlock({
  content,
  isThinking,
}) {
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
        {isThinking && <span style={spinnerStyle} />}
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
});

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

/** 尝试从 Edit/MultiEdit/Write 工具的 input JSON 中解析出 diff 数据 */
function tryParseDiffFromInput(tc: ToolCall): DiffData | null {
  if (!tc.input) return null;
  const isEditTool = /^(Edit|MultiEdit|Write)$/i.test(tc.name || '');
  if (!isEditTool) return null;
  try {
    const inp = JSON.parse(tc.input);
    const oldStr = inp.old_string ?? inp.oldString ?? '';
    const newStr = inp.new_string ?? inp.newString ?? '';
    const filePath = inp.file_path ?? inp.filePath ?? inp.path ?? '';
    if (oldStr || newStr) {
      return { path: filePath, old: oldStr, new: newStr };
    }
  } catch {
    // input 不是合法 JSON，跳过
  }
  return null;
}

/** 从 tool output 中提取 markdown 图片（返回 {images, text}） */
function extractImagesFromOutput(output: string): { images: Array<{src: string; alt: string}>; text: string } {
  const images: Array<{src: string; alt: string}> = [];
  // Match markdown image: ![alt](url)
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  let lastEnd = 0;
  const textParts: string[] = [];
  while ((match = regex.exec(output)) !== null) {
    if (match.index > lastEnd) {
      textParts.push(output.slice(lastEnd, match.index));
    }
    images.push({ alt: match[1], src: match[2] });
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < output.length) {
    textParts.push(output.slice(lastEnd));
  }
  return { images, text: textParts.join('\n').trim() };
}

const ToolCallBlock: React.FC<{ tc: ToolCall }> = memo(function ToolCallBlock({ tc }) {
  const [expanded, setExpanded] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const color = STATUS_COLOR[tc.status] || '#888';
  const isRunning = tc.status === 'running';

  // ★ 优先用后端注入的 diff，否则从 input JSON 中解析
  const diffData: DiffData | null = tc.diff || tryParseDiffFromInput(tc);

  // ★ 从 tool output 中提取 markdown 图片，支持 generate-image 等 skill 结果
  const { images: outputImages, text: outputText } = tc.output ? extractImagesFromOutput(tc.output) : { images: [], text: tc.output || '' };

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
        <span>{STATUS_ICON[tc.status] || '🔧'}</span>
        <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{tc.name}</span>
        {isRunning && <span style={spinnerStyle} />}
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
          {/* ★ Edit/Write 工具优先展示 Diff 视图，支持后端注入和前端解析两种来源 */}
          {diffData ? (
            <DiffView diff={diffData} />
          ) : (
            tc.input && (
              <div style={{ marginBottom: 6 }}>
                <div style={labelStyle}>INPUT</div>
                <pre style={codeBlock}>{tc.input}</pre>
              </div>
            )
          )}
          {tc.output && (
            <div style={{ marginTop: diffData ? 6 : 0 }}>
              <div style={labelStyle}>OUTPUT</div>
              {/* ★ 如果 output 中包含 markdown 图片（如 generate-image skill 结果），优先渲染图片 */}
              {outputImages.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: outputText ? 6 : 0 }}>
                  {outputImages.map((img, idx) => (
                    <img
                      key={idx}
                      src={img.src}
                      alt={img.alt || 'generated image'}
                      style={{
                        maxWidth: '100%',
                        maxHeight: 400,
                        borderRadius: 8,
                        cursor: 'zoom-in',
                        border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                      }}
                      onClick={() => setLightboxSrc(img.src)}
                    />
                  ))}
                </div>
              )}
              {/* 剩余文本（进度提示等非图片内容） */}
              {outputText && (
                <pre
                  style={{
                    ...codeBlock,
                    color: tc.status === 'error' ? 'var(--theme-error, #cf222e)' : 'var(--theme-text, #1f2328)',
                    maxHeight: 300,
                  }}
                >
                  {outputText}
                </pre>
              )}
            </div>
          )}
          {isRunning && !tc.output && (
            <div style={{ fontSize: 11, color: 'var(--theme-text, #1f2328)', padding: '4px 0' }}>
              Waiting for result...
            </div>
          )}
        </div>
      )}
      {/* Lightbox for tool output images */}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
});

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
  animateIn?: boolean;
}

// 复制气泡内容到剪贴板
const copyToClipboard = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    // Fallback: 使用传统的 execCommand 方式
    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
};

// 气泡操作菜单组件
const BubbleActionMenu: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedFull, setCopiedFull] = useState(false);

  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const copyFullTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { clearTimeout(copyTimerRef.current); clearTimeout(copyFullTimerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    const success = await copyToClipboard(message.content || '');
    if (success) {
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
    setMenuOpen(false);
  }, [message.content]);

  const handleCopyFull = useCallback(async () => {
    // 构建完整内容：thinking + tool calls + text
    const parts: string[] = [];
    // Thinking
    const thinking = message.thinking ||
      (message as any).thinkingBlocks?.map((b: any) => b.content).join('\n\n') || '';
    if (thinking) {
      parts.push(`[Thinking]\n${thinking}`);
    }
    // Tool calls
    if ((message as any).toolCalls) {
      for (const tc of (message as any).toolCalls) {
        let toolSection = `[Tool: ${tc.name || 'unknown'}]`;
        if (tc.input) toolSection += `\nINPUT: ${tc.input}`;
        if (tc.output) toolSection += `\nOUTPUT: ${tc.output}`;
        if (tc.status) toolSection += `\nSTATUS: ${tc.status}`;
        parts.push(toolSection);
      }
    }
    // Text content
    if (message.content) {
      parts.push(message.content);
    }
    const fullText = parts.join('\n\n');
    const success = await copyToClipboard(fullText);
    if (success) {
      setCopiedFull(true);
      clearTimeout(copyFullTimerRef.current);
      copyFullTimerRef.current = setTimeout(() => setCopiedFull(false), 2000);
    }
    setMenuOpen(false);
  }, [message]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.bubble-action-menu')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <div className="bubble-action-menu" style={{
      position: 'absolute',
      bottom: 6,
      right: 6,
      zIndex: 100,
    }}>
      {/* 三点菜单按钮（横向） */}
      <button
        onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
        title="操作菜单"
        className="bubble-action-btn"
        style={{
          width: 28,
          height: 20,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--theme-bg-tertiary, #fff)',
          border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
          borderRadius: 4,
          cursor: 'pointer',
          color: 'var(--theme-text-muted, #656d76)',
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        ⋯
      </button>

      {/* 上弹菜单 */}
      {menuOpen && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          right: 0,
          marginBottom: 4,
          minWidth: 120,
          background: 'var(--theme-bg-tertiary, #fff)',
          border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          overflow: 'hidden',
        }}>
          <button
            onClick={handleCopy}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'none',
              border: 'none',
              borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: 12,
              color: copied ? 'var(--theme-success, #3fb950)' : 'var(--theme-text, #1f2328)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{copied ? '✓' : '📋'}</span>
            <span>{copied ? '已复制' : '复制内容'}</span>
          </button>
          <button
            onClick={handleCopyFull}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'none',
              border: 'none',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: 12,
              color: copiedFull ? 'var(--theme-success, #3fb950)' : 'var(--theme-text, #1f2328)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{copiedFull ? '✓' : '📑'}</span>
            <span>{copiedFull ? '已复制' : '复制完整信息'}</span>
          </button>
        </div>
      )}
    </div>
  );
};

function MessageBubbleInner({
  message,
  fontSize = 14,
  renderMarkdown = true,
  animateIn = false,
}: Props) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // 委托捕获气泡内 markdown 渲染出的 img 点击
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      setLightboxSrc((target as HTMLImageElement).src);
    }
  }, []);

  // ★ 为 markdown 渲染出的代码块注入复制按钮，图片添加 loaded 类
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const pres = el.querySelectorAll<HTMLElement>('pre.md-pre');
    pres.forEach(pre => {
      if (pre.querySelector('.code-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = '复制';
      btn.title = '复制代码';
      btn.onclick = async (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        if (!code) return;
        // 克隆后移除语言标签，避免语言名混入复制内容
        const clone = code.cloneNode(true) as HTMLElement;
        clone.querySelector('.md-code-lang')?.remove();
        await copyToClipboard(clone.textContent?.trimEnd() ?? '');
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 2000);
      };
      pre.appendChild(btn);
    });

    // ★ 为 markdown 中的图片添加 lazy loading 支持
    const imgs = el.querySelectorAll<HTMLImageElement>('img');
    imgs.forEach(img => {
      // 添加 loading="lazy" 属性
      if (!img.hasAttribute('loading')) {
        img.setAttribute('loading', 'lazy');
      }
      // 图片加载完成后添加 loaded 类
      if (img.complete) {
        img.classList.add('loaded');
      } else {
        img.addEventListener('load', () => {
          img.classList.add('loaded');
        });
        img.addEventListener('error', () => {
          img.classList.add('loaded'); // 加载失败也添加，避免一直透明
        });
      }
    });
  }, [message.content]);

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

  // ★ useMemo 避免每次渲染重新解析 Markdown（message.content 不变则复用缓存）
  const contentHtml = useMemo(
    () => !isUser && renderMarkdown && message.content ? markdownToHtml(message.content) : null,
    [isUser, renderMarkdown, message.content],
  );

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        padding: '4px 16px',
        animation: animateIn ? 'msgSlideIn 0.22s ease-out' : undefined,
      }}
    >
      {/* ★ 角色标签 */}
      {!isUser && (
        <div style={{
          width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
          background: 'var(--theme-accent, #7aa2f7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, color: '#fff', fontWeight: 700, marginRight: 8, marginTop: 2,
        }}>A</div>
      )}
      <div
        className="message-bubble-wrapper"
        style={{
          position: 'relative',
          maxWidth: '80%',
          minWidth: 60,
          padding: '10px 14px',
          borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
          background: isUser ? 'var(--theme-user-bubble-bg, #ddf4ff)' : 'var(--theme-message-bg, #f6f8fa)',
          border: `1px solid ${isUser ? 'var(--theme-user-bubble-border, #0969da44)' : 'var(--theme-border, rgba(0,0,0,0.12))'}`,
          fontSize,
          lineHeight: 1.6,
          wordBreak: 'break-word',
          overflow: 'visible',
        }}
      >
        {/* 操作菜单（悬停显示） */}
        <BubbleActionMenu message={message} />
        {/* 附件图片 */}
        {message.images && message.images.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {message.images.map((img: any, i: number) => {
              const src =
                typeof img === 'string'
                  ? img
                  : `data:${img.mimeType || img.mime_type || 'image/png'};base64,${img.base64}`;
              return (
                <div key={i} className="img-lazy-placeholder" style={{
                  width: 120, height: 120,
                  borderRadius: 8,
                  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                  overflow: 'hidden',
                  position: 'relative',
                  cursor: 'zoom-in',
                }} onClick={() => setLightboxSrc(src)}>
                  {/* 小尺寸图片直接显示，大图片懒加载 */}
                  <img
                    className="lazy"
                    src={src}
                    alt="attachment"
                    loading="lazy"
                    style={{
                      width: '100%', height: '100%',
                      objectFit: 'contain',
                      display: 'block',
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* ★ 按 contentBlocks 顺序交替渲染 thinking / tool / text */}
        {!isUser && message.contentBlocks && message.contentBlocks.length > 0 ? (
          message.contentBlocks.map((block, i) => {
            if (block.type === 'thinking' && thinkingContent) {
              return <ThinkingBlock key={`blk-${i}`} content={thinkingContent} isThinking={isThinkingPhase} />;
            }
            if (block.type === 'tool' && message.toolCalls && block.toolIndex !== undefined) {
              const tc = message.toolCalls[block.toolIndex];
              return tc ? <ToolCallBlock key={`blk-${i}`} tc={tc} /> : null;
            }
            if (block.type === 'text') {
              return contentHtml ? (
                <div
                  key={`blk-${i}`}
                  ref={contentRef}
                  className="msg-content"
                  onClick={handleContentClick}
                  dangerouslySetInnerHTML={{ __html: contentHtml }}
                />
              ) : message.content ? (
                <div key={`blk-${i}`} style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
              ) : null;
            }
            return null;
          })
        ) : (
          /* Fallback：历史消息没有 contentBlocks 时保持原有顺序 */
          <>
            {!isUser && thinkingContent && (
              <ThinkingBlock content={thinkingContent} isThinking={isThinkingPhase} />
            )}
            {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
              <div style={{ marginBottom: message.content ? 8 : 0 }}>
                {message.toolCalls.map((tc, i) => (
                  <ToolCallBlock key={`${tc.id || tc.name}-${i}`} tc={tc} />
                ))}
              </div>
            )}
            {contentHtml ? (
              <div
                ref={contentRef}
                className="msg-content"
                onClick={handleContentClick}
                dangerouslySetInnerHTML={{ __html: contentHtml }}
              />
            ) : message.content ? (
              <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
            ) : null}
          </>
        )}

        {/* 流式光标 */}
        {message.streaming && (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: 15,
              background: 'var(--theme-accent, rgba(122,162,247,0.9))',
              marginLeft: 3,
              borderRadius: 2,
              verticalAlign: 'text-bottom',
              willChange: 'opacity',
              animation: 'cursorGlow 0.9s ease-in-out infinite',
            }}
          />
        )}

        {/* Token 用量 + 耗时 */}
        {!isUser && (message.usage || message.elapsed) && !message.streaming && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 4 }}>
            {message.usage?.inputTokens != null && `↑${message.usage.inputTokens.toLocaleString()}`}
            {message.usage?.outputTokens != null && ` ↓${message.usage.outputTokens.toLocaleString()}`}
            {message.elapsed != null && ` · ${message.elapsed < 1000 ? `${message.elapsed}ms` : `${(message.elapsed / 1000).toFixed(1)}s`}`}
          </div>
        )}

        {/* 时间戳 */}
        {message.timestamp && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 6, textAlign: 'right' }}>
            {new Date(message.timestamp * 1000).toLocaleTimeString()}
          </div>
        )}
      </div>
      {/* ★ 用户头像 */}
      {isUser && (
        <div style={{
          width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
          background: 'var(--theme-success, #2da44e)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, color: '#fff', fontWeight: 700, marginLeft: 8, marginTop: 2,
        }}>U</div>
      )}
    </div>
    </>
  );
}

// ★ memo + 自定义比较：streaming 消息不跳过（内容持续变化），已完成消息只在内容实际变化时才重渲染
function bubblePropsEqual(prev: Props, next: Props): boolean {
  // 任一处于流式中 → 允许更新
  if (prev.message.streaming || next.message.streaming) return false;
  return (
    prev.message.id        === next.message.id        &&
    prev.message.content   === next.message.content   &&
    prev.message.elapsed   === next.message.elapsed   &&
    prev.message.usage     === next.message.usage     &&
    prev.fontSize          === next.fontSize          &&
    prev.renderMarkdown    === next.renderMarkdown    &&
    prev.animateIn         === next.animateIn
  );
}

export const MessageBubble = memo(MessageBubbleInner, bubblePropsEqual);

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
  width: 12,
  height: 12,
  border: '2px solid rgba(255,255,255,0.15)',
  borderTopColor: 'rgba(255,255,255,0.75)',
  borderRadius: '50%',
  animation: 'spin 0.7s linear infinite',
  marginLeft: 6,
  verticalAlign: 'middle',
  flexShrink: 0,
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