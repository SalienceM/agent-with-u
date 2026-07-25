import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TextAttachment } from '../types/attachments';

interface Props {
  attachments: TextAttachment[];
  compact?: boolean;
  onRemove?: (id: string) => void;
  onRestore?: (id: string) => void;
  onUpdate?: (attachment: TextAttachment) => void;
}

function formatChars(size: number): string {
  if (size < 1000) return `${size} 字`;
  if (size < 10_000) return `${(size / 1000).toFixed(1)}k 字`;
  return `${Math.round(size / 1000)}k 字`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try {
      return document.execCommand('copy');
    } finally {
      el.remove();
    }
  }
}

export const TextAttachmentPreview: React.FC<Props> = ({
  attachments,
  compact = false,
  onRemove,
  onRestore,
  onUpdate,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const selected = attachments.find((item) => item.id === selectedId) || null;

  const close = useCallback(() => {
    setSelectedId(null);
    setCopied(false);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedId, close]);

  useEffect(() => {
    if (selectedId && !selected) close();
  }, [selectedId, selected, close]);

  if (!attachments.length) return null;

  return (
    <>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: compact ? 6 : 8,
        marginBottom: compact ? 8 : 6,
      }}>
        {attachments.map((item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedId(item.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelectedId(item.id);
              }
            }}
            title="点击查看文本附件"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: compact ? 150 : 180,
              maxWidth: 'min(100%, 320px)',
              padding: compact ? '6px 8px' : '8px 10px',
              borderRadius: 9,
              border: '1px solid var(--theme-border, rgba(0,0,0,.14))',
              background: 'var(--theme-bg-secondary, #f6f8fa)',
              color: 'var(--theme-text, #1f2328)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <span style={{ fontSize: compact ? 16 : 18, flexShrink: 0 }}>📄</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: compact ? 11.5 : 12,
                fontWeight: 600,
              }}>
                {item.name}
              </span>
              <span style={{ display: 'block', marginTop: 1, fontSize: 10, color: 'var(--theme-text-muted, #656d76)' }}>
                {formatChars(item.size || item.content.length)} · 点击查看
              </span>
            </span>
            {onRemove && (
              <button
                type="button"
                aria-label={`删除 ${item.name}`}
                title="删除附件"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(item.id);
                }}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'var(--theme-text-muted, #656d76)',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  fontSize: 15,
                  flexShrink: 0,
                }}
              >×</button>
            )}
          </div>
        ))}
      </div>

      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`文本附件 ${selected.name}`}
          onClick={close}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            background: 'rgba(0,0,0,.62)',
            backdropFilter: 'blur(5px)',
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(860px, 96vw)',
              height: 'min(720px, 88vh)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderRadius: 12,
              border: '1px solid var(--theme-border, rgba(255,255,255,.15))',
              background: 'var(--theme-bg, #fff)',
              boxShadow: '0 20px 60px rgba(0,0,0,.38)',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              borderBottom: '1px solid var(--theme-border, rgba(0,0,0,.12))',
            }}>
              <span>📄</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 650 }}>
                  {selected.name}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--theme-text-muted, #656d76)' }}>
                  {formatChars(selected.size || selected.content.length)}
                </div>
              </div>
              <button type="button" onClick={close} aria-label="关闭" style={plainButtonStyle}>×</button>
            </div>
            <textarea
              key={selected.id}
              ref={editorRef}
              defaultValue={selected.content}
              readOnly={!onUpdate}
              spellCheck={false}
              style={{
                flex: 1,
                minHeight: 0,
                resize: 'none',
                outline: 'none',
                border: 0,
                padding: 16,
                background: 'var(--theme-input-bg, #fff)',
                color: 'var(--theme-text, #1f2328)',
                font: '13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace',
                whiteSpace: 'pre-wrap',
              }}
            />
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              padding: '10px 14px',
              borderTop: '1px solid var(--theme-border, rgba(0,0,0,.12))',
            }}>
              <button
                type="button"
                onClick={async () => {
                  if (await copyText(editorRef.current?.value ?? selected.content)) {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }
                }}
                style={secondaryButtonStyle}
              >{copied ? '已复制' : '复制全文'}</button>
              {onRestore && (
                <button
                  type="button"
                  onClick={() => {
                    onRestore(selected.id);
                    close();
                  }}
                  style={secondaryButtonStyle}
                >还原到输入框</button>
              )}
              {onUpdate && (
                <button
                  type="button"
                  onClick={() => {
                    const content = editorRef.current?.value ?? selected.content;
                    onUpdate({ ...selected, content, size: content.length });
                    close();
                  }}
                  style={primaryButtonStyle}
                >保存修改</button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const plainButtonStyle: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  color: 'var(--theme-text-muted, #656d76)',
  cursor: 'pointer',
  padding: '2px 6px',
  fontSize: 20,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '6px 11px',
  borderRadius: 7,
  border: '1px solid var(--theme-border, rgba(0,0,0,.14))',
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  color: 'var(--theme-text, #1f2328)',
  cursor: 'pointer',
  fontSize: 12,
};

const primaryButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  borderColor: 'var(--theme-accent, #0969da)',
  background: 'var(--theme-accent, #0969da)',
  color: '#fff',
};
