/**
 * PermissionGate: 行内权限确认组件（嵌入聊天气泡）
 *
 * 场景1: 工具执行前的权限确认（tool.status === 'pending'）
 * 场景2: Auto-continue 时的权限确认（tool.status === 'done'）
 *
 * 特点：
 * - 不使用弹窗，直接嵌入消息流中
 * - 展示工具执行的详细内容，支持展开/收起
 * - Skip rest 点击后即时生效
 */
import React, { useState } from 'react';
import { api } from '../api';

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
  onSkipRest: () => void; // 允许本次会话跳过后续确认
}

const TOOL_ICON: Record<string, string> = {
  Bash: '💻',
  Edit: '✏️',
  Write: '📝',
  Read: '📖',
  Glob: '🔍',
  Grep: '🔎',
};

export const PermissionGate: React.FC<Props> = ({ request, onDismiss, onSkipRest }) => {
  const [expandedTool, setExpandedTool] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // 判断场景：是否有 pending 状态的工具（工具执行前）还是 done 状态（auto-continue）
  const isPreExecution = request.tools.some(t => t.status === 'pending');
  const title = isPreExecution
    ? '🔒 需要确认执行'
    : '🔄 继续执行？';
  const description = isPreExecution
    ? 'Claude 请求执行以下操作，请确认后继续：'
    : 'Claude 已执行以下操作并希望自动继续：';

  const handleGrant = async (granted: boolean) => {
    setLoading(true);
    try {
      await api.grantPermission(request.sessionId, granted);
    } catch (e) {
      console.error('[PermissionGate] grantPermission error:', e);
    }
    onDismiss();
  };

  const handleSkipRest = async () => {
    setLoading(true);
    try {
      await api.grantPermission(request.sessionId, true, true);  // 第三个参数 skipRest=true
    } catch (e) {
      console.error('[PermissionGate] grantPermission error:', e);
    }
    onSkipRest(); // 即时通知父组件更新 skipPermissions
    onDismiss();
  };

  return (
    <div style={{
      padding: '12px 16px',
      background: 'var(--theme-bg-secondary, #f6f8fa)',
      borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
    }}>
      {/* 标题 */}
      <div style={{
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--theme-text, #1f2328)',
        marginBottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        {title}
      </div>
      <div style={{
        fontSize: 12,
        color: 'var(--theme-text-muted, #656d76)',
        marginBottom: 10,
      }}>
        {description}
      </div>

      {/* 工具列表 */}
      <div style={{ marginBottom: 12 }}>
        {request.tools.map((tc, i) => {
          const isExpanded = expandedTool === i;
          const hasLongInput = tc.input && tc.input.length > 100;

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
                onClick={() => setExpandedTool(isExpanded ? null : i)}
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: hasLongInput ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
              >
                <span style={{ fontSize: 16 }}>{TOOL_ICON[tc.name] || '🔧'}</span>
                <span style={{
                  fontFamily: 'monospace',
                  fontWeight: 600,
                  fontSize: 13,
                  color: 'var(--theme-accent, #0969da)',
                }}>
                  {tc.name}
                </span>
                <span style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: tc.status === 'done' ? 'rgba(47,129,63,0.15)' : 'rgba(203,132,25,0.15)',
                  color: tc.status === 'done' ? '#1a7f37' : '#9a6700',
                }}>
                  {tc.status === 'pending' ? '待确认' : tc.status}
                </span>
                {hasLongInput && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: 10,
                    color: 'var(--theme-text-muted, #656d76)',
                  }}>
                    {isExpanded ? '收起' : '展开详情'}
                  </span>
                )}
              </div>

              {/* 工具输入详情 */}
              {tc.input && (
                <div style={{
                  padding: isExpanded ? '8px 12px' : '0 12px 8px',
                  borderTop: isExpanded ? '1px solid var(--theme-border, rgba(0,0,0,0.08))' : 'none',
                }}>
                  {isExpanded ? (
                    <pre style={{
                      margin: 0,
                      fontSize: 11,
                      color: 'var(--theme-text, #1f2328)',
                      background: 'var(--theme-code-bg, #f6f8fa)',
                      borderRadius: 4,
                      padding: '8px 10px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      maxHeight: 300,
                      overflow: 'auto',
                      fontFamily: 'monospace',
                    }}>
                      {tc.input}
                    </pre>
                  ) : (
                    <div style={{
                      fontSize: 11,
                      color: 'var(--theme-text-muted, #656d76)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {tc.input.slice(0, 100)}
                      {tc.input.length > 100 ? '…' : ''}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 操作按钮 */}
      <div style={{
        display: 'flex',
        gap: 8,
        justifyContent: 'flex-end',
      }}>
        <button
          onClick={() => handleGrant(false)}
          disabled={loading}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid rgba(207,34,46,0.4)',
            background: 'rgba(207,34,46,0.08)',
            color: '#cf222e',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: 12,
            fontWeight: 500,
            opacity: loading ? 0.6 : 1,
          }}
        >
          ⛔ {isPreExecution ? '拒绝' : '中止'}
        </button>
        <button
          onClick={handleSkipRest}
          disabled={loading}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid rgba(154,103,0,0.4)',
            background: 'rgba(203,132,25,0.1)',
            color: '#9a6700',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: 12,
            fontWeight: 500,
            opacity: loading ? 0.6 : 1,
          }}
        >
          ✅ 允许并跳过后续
        </button>
        <button
          onClick={() => handleGrant(true)}
          disabled={loading}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--theme-accent, #0969da)',
            color: '#fff',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
            opacity: loading ? 0.6 : 1,
          }}
        >
          ▶ {isPreExecution ? '允许一次' : '继续'}
        </button>
      </div>
    </div>
  );
};