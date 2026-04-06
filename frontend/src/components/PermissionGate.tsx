import React, { useState } from 'react';
import { api } from '../api';
import { DiffView, type DiffData } from './DiffView';

export interface PermissionRequestData {
  sessionId: string;
  messageId: string;
  tools: Array<{
    id?: string;
    name: string;
    input?: string;
    output?: string;
    status: string;
  }>;
}

interface Props {
  request: PermissionRequestData;
  onDismiss: () => void;
  onSkipRest: () => void;
}

const TOOL_ICON: Record<string, string> = {
  Bash: '💻',
  Edit: '✏️',
  Write: '📝',
  Read: '📖',
  Glob: '🔍',
  Grep: '🔎',
};

/** 从 Edit/MultiEdit/Write 工具的 input JSON 中解析 diff 数据 */
function tryParseDiff(name: string, input?: string): DiffData | null {
  if (!input) return null;
  if (!/^(Edit|MultiEdit|Write)$/i.test(name)) return null;
  try {
    const inp = JSON.parse(input);
    const oldStr = inp.old_string ?? inp.oldString ?? '';
    const newStr = inp.new_string ?? inp.newString ?? '';
    const filePath = inp.file_path ?? inp.filePath ?? inp.path ?? '';
    if (oldStr || newStr) return { path: filePath, old: oldStr, new: newStr };
  } catch { /* not JSON */ }
  return null;
}

/** 从 Bash 工具的 input JSON 中提取命令 */
function tryParseCommand(name: string, input?: string): string | null {
  if (!input || name !== 'Bash') return null;
  try {
    const inp = JSON.parse(input);
    return inp.command ?? inp.cmd ?? null;
  } catch { return null; }
}

export const PermissionGate: React.FC<Props> = ({ request, onDismiss, onSkipRest }) => {
  const [expandedTool, setExpandedTool] = useState<number | null>(0); // 默认展开第一个
  const [loading, setLoading] = useState(false);

  const isPreExecution = request.tools.some(t => t.status === 'pending');
  const title = isPreExecution ? '🔒 需要确认执行' : '🔄 继续执行？';
  const description = isPreExecution
    ? 'Claude 请求执行以下操作，请确认后继续：'
    : 'Claude 已执行以下操作并希望自动继续：';

  const handleGrant = async (granted: boolean) => {
    setLoading(true);
    try { await api.grantPermission(request.sessionId, granted); }
    catch (e) { console.error('[PermissionGate] grantPermission error:', e); }
    onDismiss();
  };

  const handleSkipRest = async () => {
    setLoading(true);
    try { await api.grantPermission(request.sessionId, true, true); }
    catch (e) { console.error('[PermissionGate] grantPermission error:', e); }
    onSkipRest();
    onDismiss();
  };

  return (
    <div style={{
      padding: '12px 16px',
      background: 'var(--theme-bg-secondary, #f6f8fa)',
      borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text, #1f2328)', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)', marginBottom: 10 }}>
        {description}
      </div>

      {/* 工具列表 */}
      <div style={{ marginBottom: 12 }}>
        {request.tools.map((tc, i) => {
          const isExpanded = expandedTool === i;
          const diffData = tryParseDiff(tc.name, tc.input);
          const command = tryParseCommand(tc.name, tc.input);
          // 预览文字：Edit 工具显示文件路径，Bash 显示命令，其他截断 input
          const previewText = diffData
            ? (diffData.path || '(查看 diff)')
            : command ?? (tc.input ? tc.input.slice(0, 120) + (tc.input.length > 120 ? '…' : '') : '');
          const isExpandable = !!(diffData || tc.input);

          return (
            <div
              key={tc.id || i}
              style={{
                background: 'var(--theme-bg-tertiary, #fff)',
                borderRadius: 8,
                marginBottom: 6,
                border: '1px solid var(--theme-border, rgba(0,0,0,0.1))',
                overflow: 'hidden',
              }}
            >
              {/* 工具头部 */}
              <div
                onClick={() => isExpandable && setExpandedTool(isExpanded ? null : i)}
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: isExpandable ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
              >
                <span style={{ fontSize: 16 }}>{TOOL_ICON[tc.name] || '🔧'}</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13, color: 'var(--theme-accent, #0969da)' }}>
                  {tc.name}
                </span>
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 4,
                  background: tc.status === 'done' ? 'rgba(47,129,63,0.15)' : 'rgba(203,132,25,0.15)',
                  color: tc.status === 'done' ? '#1a7f37' : '#9a6700',
                }}>
                  {tc.status === 'pending' ? '待确认' : tc.status}
                </span>
                {/* 预览文字（收起时） */}
                {!isExpanded && previewText && (
                  <span style={{
                    fontSize: 11, color: 'var(--theme-text-muted, #656d76)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>
                    {previewText}
                  </span>
                )}
                {isExpandable && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--theme-text-muted, #656d76)', flexShrink: 0 }}>
                    {isExpanded ? '收起 ▲' : '展开 ▼'}
                  </span>
                )}
              </div>

              {/* 展开内容 */}
              {isExpanded && (
                <div style={{ borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.08))', padding: '8px 12px' }}>
                  {diffData ? (
                    <DiffView diff={diffData} />
                  ) : command ? (
                    <pre style={{
                      margin: 0, fontSize: 12,
                      color: 'var(--theme-text, #1f2328)',
                      background: 'var(--theme-code-bg, #f6f8fa)',
                      borderRadius: 4, padding: '8px 10px',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                      maxHeight: 300, overflow: 'auto', fontFamily: 'monospace',
                    }}>
                      {command}
                    </pre>
                  ) : tc.input ? (
                    <pre style={{
                      margin: 0, fontSize: 11,
                      color: 'var(--theme-text, #1f2328)',
                      background: 'var(--theme-code-bg, #f6f8fa)',
                      borderRadius: 4, padding: '8px 10px',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                      maxHeight: 300, overflow: 'auto', fontFamily: 'monospace',
                    }}>
                      {tc.input}
                    </pre>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => handleGrant(false)}
          disabled={loading}
          style={{
            padding: '6px 14px', borderRadius: 6,
            border: '1px solid rgba(207,34,46,0.4)', background: 'rgba(207,34,46,0.08)',
            color: '#cf222e', cursor: loading ? 'wait' : 'pointer', fontSize: 12, fontWeight: 500, opacity: loading ? 0.6 : 1,
          }}
        >
          ⛔ {isPreExecution ? '拒绝' : '中止'}
        </button>
        <button
          onClick={handleSkipRest}
          disabled={loading}
          style={{
            padding: '6px 14px', borderRadius: 6,
            border: '1px solid rgba(154,103,0,0.4)', background: 'rgba(203,132,25,0.1)',
            color: '#9a6700', cursor: loading ? 'wait' : 'pointer', fontSize: 12, fontWeight: 500, opacity: loading ? 0.6 : 1,
          }}
        >
          ✅ 允许并跳过后续
        </button>
        <button
          onClick={() => handleGrant(true)}
          disabled={loading}
          style={{
            padding: '6px 14px', borderRadius: 6,
            border: 'none', background: 'var(--theme-accent, #0969da)',
            color: '#fff', cursor: loading ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, opacity: loading ? 0.6 : 1,
          }}
        >
          ▶ {isPreExecution ? '允许一次' : '继续'}
        </button>
      </div>
    </div>
  );
};
