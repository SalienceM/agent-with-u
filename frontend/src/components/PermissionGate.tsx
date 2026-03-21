/**
 * PermissionGate: 权限确认弹框。
 *
 * 场景1: 工具执行前的权限确认（tool.status === 'pending'）
 * 场景2: Auto-continue 时的权限确认（tool.status === 'done'）
 */
import React from 'react';
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
  onAllowSession: () => void; // 允许本次会话跳过后续确认
}

const TOOL_ICON: Record<string, string> = {
  Bash: '💻',
  Edit: '✏️',
  Write: '📝',
  Read: '📖',
  Glob: '🔍',
  Grep: '🔎',
};

export const PermissionGate: React.FC<Props> = ({ request, onDismiss, onAllowSession }) => {
  // ★ 判断场景：是否有 pending 状态的工具（工具执行前）还是 done 状态（auto-continue）
  const isPreExecution = request.tools.some(t => t.status === 'pending');
  const title = isPreExecution
    ? 'Allow this action?'
    : 'Continue with these actions?';
  const description = isPreExecution
    ? 'Claude wants to execute the following tool. Review and approve to continue.'
    : 'Claude ran the following tools and wants to auto-continue.';

  const handleGrant = async (granted: boolean) => {
    await api.grantPermission(request.sessionId, granted);
    onDismiss();
  };

  const handleAllowSession = async () => {
    await api.grantPermission(request.sessionId, true);
    onAllowSession();
    onDismiss();
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        background: '#1e2030',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.12)',
        width: 480,
        maxWidth: '90vw',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{ fontSize: 20 }}>🔒</span>
          <div>
            <div style={{ color: '#fff', fontWeight: 600, fontSize: 15 }}>
              {title}
            </div>
            <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
              {description}
            </div>
          </div>
        </div>

        {/* Tool list */}
        <div style={{ overflowY: 'auto', padding: '12px 20px', flex: 1 }}>
          {request.tools.map((tc, i) => (
            <div key={tc.id || i} style={{
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 6,
              padding: '8px 12px',
              marginBottom: 8,
              border: '1px solid rgba(255,255,255,0.07)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span>{TOOL_ICON[tc.name] || '🔧'}</span>
                <span style={{ color: '#a8d5ff', fontFamily: 'monospace', fontWeight: 600, fontSize: 13 }}>
                  {tc.name}
                </span>
                <span style={{
                  fontSize: 11,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: tc.status === 'done' ? 'rgba(76,175,80,0.2)' : tc.status === 'pending' ? 'rgba(255,193,7,0.2)' : 'rgba(244,67,54,0.2)',
                  color: tc.status === 'done' ? '#4caf50' : tc.status === 'pending' ? '#ffc107' : '#f44336',
                }}>
                  {tc.status === 'pending' ? 'pending' : tc.status}
                </span>
              </div>
              {tc.input && (
                <pre style={{
                  margin: 0,
                  fontSize: 11,
                  color: '#aaa',
                  background: 'rgba(0,0,0,0.3)',
                  borderRadius: 4,
                  padding: '4px 8px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 80,
                  overflowY: 'auto',
                }}>
                  {tc.input.length > 300 ? tc.input.slice(0, 300) + '…' : tc.input}
                </pre>
              )}
            </div>
          ))}
        </div>

        {/* Buttons */}
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
        }}>
          <button
            onClick={() => handleGrant(false)}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: '1px solid rgba(244,67,54,0.4)',
              background: 'rgba(244,67,54,0.1)',
              color: '#f44336',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            ⛔ {isPreExecution ? 'Deny' : 'Abort'}
          </button>
          <button
            onClick={handleAllowSession}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: '1px solid rgba(255,193,7,0.4)',
              background: 'rgba(255,193,7,0.1)',
              color: '#ffc107',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            ✅ Allow (Skip rest)
          </button>
          <button
            onClick={() => handleGrant(true)}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: 'none',
              background: 'rgba(99,102,241,0.8)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            ▶ {isPreExecution ? 'Allow once' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
};
