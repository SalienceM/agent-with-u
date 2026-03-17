import React, { useRef, useCallback, useEffect, memo, useState } from 'react';
import { ImagePreview } from './ImagePreview';
import { useClipboardImage } from '../hooks/useClipboardImage';
import type { ImageAttachment } from '../hooks/useClipboardImage';
import { SLASH_COMMANDS } from '../hooks/useChat';
import type { SlashCommand } from '../hooks/useChat';

interface Props {
  onSend: (content: string, images?: ImageAttachment[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  backends: any[];
  activeBackendId: string;
  autoContinue?: boolean;
  onAutoContinueChange?: (enabled: boolean) => void;
  skipPermissions?: boolean;
  onSkipPermissionsChange?: (enabled: boolean) => void;
}

const ChatInputInner: React.FC<Props> = ({
  onSend, onAbort, isStreaming, backends, activeBackendId, autoContinue,
  onAutoContinueChange, skipPermissions = true, onSkipPermissionsChange,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage();

  // ── 稳定 refs ──
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const clearImagesRef = useRef(clearImages);
  clearImagesRef.current = clearImages;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const composingRef = useRef(false);

  // ═══════════════════════════════════════
  //  ★ 斜杠命令自动补全状态
  // ═══════════════════════════════════════
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);

  // 稳定 refs for keyboard handler
  const showCommandsRef = useRef(false);
  showCommandsRef.current = showCommands;
  const filteredCommandsRef = useRef<SlashCommand[]>([]);
  filteredCommandsRef.current = filteredCommands;
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;

  // ── 发送 ──
  const handleSend = useCallback(() => {
    const text = ref.current?.value.trim() || '';
    const imgs = imagesRef.current;
    if (!text && imgs.length === 0) return;
    onSendRef.current(text, imgs.length > 0 ? imgs : undefined);
    if (ref.current) {
      ref.current.value = '';
      ref.current.style.height = 'auto';
    }
    clearImagesRef.current();
    setShowCommands(false);
  }, []);

  // ── 键盘事件 ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229)
        return;

      // ★ 命令弹窗打开时的键盘导航
      if (showCommandsRef.current && filteredCommandsRef.current.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) =>
            Math.min(filteredCommandsRef.current.length - 1, prev + 1)
          );
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          // Tab: 只自动补全，不执行
          const cmd = filteredCommandsRef.current[selectedIndexRef.current];
          if (cmd && ref.current) {
            ref.current.value = cmd.name + ' ';
            setShowCommands(false);
            // 触发 auto-resize
            ref.current.style.height = 'auto';
            ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + 'px';
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowCommands(false);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          // Enter: 补全并执行
          const cmd = filteredCommandsRef.current[selectedIndexRef.current];
          if (cmd && ref.current) {
            ref.current.value = cmd.name;
          }
          setShowCommands(false);
          if (!isStreamingRef.current) handleSend();
          return;
        }
      }

      // 普通 Enter 发送
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isStreamingRef.current) handleSend();
      }
    },
    [handleSend]
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  // ── 输入变化：auto-resize + 斜杠命令检测 ──
  const handleInput = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // auto-resize
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';

    // ★ 斜杠命令检测
    const text = el.value;
    if (text.startsWith('/') && !text.includes(' ') && text.length > 0) {
      const query = text.toLowerCase();
      const matched = SLASH_COMMANDS.filter((cmd) =>
        cmd.name.startsWith(query)
      );
      setFilteredCommands(matched);
      setShowCommands(matched.length > 0);
      setSelectedIndex(0);
    } else {
      setShowCommands(false);
    }
  }, []);

  // ── 点击选择命令 ──
  const handleSelectCommand = useCallback((cmd: SlashCommand) => {
    if (ref.current) {
      ref.current.value = cmd.name;
      ref.current.focus();
    }
    setShowCommands(false);
    if (!isStreamingRef.current) handleSend();
  }, [handleSend]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // 滚动选中项到可见区域
  useEffect(() => {
    if (showCommands && popupRef.current) {
      const items = popupRef.current.children;
      if (items[selectedIndex]) {
        (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showCommands]);

  return (
    <div style={{ padding: '8px 16px 12px', borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.12))', background: 'var(--theme-bg, #ffffff)', position: 'relative' }}>
      {/* 顶部栏：自动续跑指示器 + 权限模式 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {autoContinue && (
          <span style={{ fontSize: 10, color: 'var(--theme-accent, #0969da)', display: 'flex', alignItems: 'center', gap: 3 }}>
            ⟳ 自动续跑
          </span>
        )}
        <label style={{ fontSize: 10, color: 'var(--theme-text-muted, #656d76)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={skipPermissions}
            onChange={(e) => onSkipPermissionsChange?.(e.target.checked)}
            style={{ accentColor: 'var(--theme-accent, #0969da)', width: 14, height: 14 }}
          />
          ⚡ 跳过确认
        </label>
      </div>

      <ImagePreview images={images} onRemove={removeImage} />

      {/* ★ 斜杠命令弹窗 */}
      {showCommands && filteredCommands.length > 0 && (
        <div ref={popupRef} style={commandPopupStyle}>
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.name}
              style={{
                ...commandItemStyle,
                background: i === selectedIndex ? 'var(--theme-bg-tertiary, #eaeef2)' : 'transparent',
              }}
              onClick={() => handleSelectCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--theme-accent, #0969da)', minWidth: 120, display: 'inline-block' }}>
                {cmd.name}
              </span>
              <span style={{ color: 'var(--theme-text-muted, #656d76)', fontSize: 12 }}>
                {cmd.description}
              </span>
            </div>
          ))}
          <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--theme-text-muted, #656d76)', borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.08))' }}>
            ↑↓ 导航 · Tab 补全 · Enter 执行 · Esc 关闭
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={ref}
          placeholder="输入消息… 输入 / 查看命令 · Ctrl+V 粘贴图片"
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleInput}
          style={textareaStyle}
          rows={1}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button onClick={onAbort} style={abortBtnStyle} title="Stop">■</button>
        ) : (
          <button onClick={handleSend} style={sendBtnStyle} title="Send (Enter)">↑</button>
        )}
      </div>
    </div>
  );
};

export const ChatInput = memo(ChatInputInner);

// ═══════════════════════════════════════
//  样式
// ═══════════════════════════════════════

const textareaStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 10,
  color: 'var(--theme-text, #1f2328)',
  padding: '10px 14px',
  fontSize: 14,
  lineHeight: 1.5,
  resize: 'none',
  outline: 'none',
  fontFamily: 'inherit',
  maxHeight: 200,
  overflow: 'auto',
};

const btnBase: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: '50%',
  border: 'none',
  color: '#fff',
  fontSize: 18,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const sendBtnStyle: React.CSSProperties = { ...btnBase, background: 'var(--theme-accent, #0969da)' };
const abortBtnStyle: React.CSSProperties = { ...btnBase, background: 'var(--theme-error, #cf222e)', fontSize: 14 };

const commandPopupStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 16,
  right: 16,
  marginBottom: 4,
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 10,
  maxHeight: 280,
  overflowY: 'auto',
  zIndex: 100,
  boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
  backdropFilter: 'blur(12px)',
};

const commandItemStyle: React.CSSProperties = {
  padding: '8px 12px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  transition: 'background 0.1s',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
};