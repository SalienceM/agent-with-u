import React, { useCallback, useState } from 'react';
import { getConnectionTarget, setConnectionTarget, listRelayDevices } from '../api';

interface ConnectionPanelProps {
  onClose: () => void;
}

/**
 * 连接目标设置：本地直连 或 经中继 S 访问远程执行节点。
 * C–C/S 架构里,真实执行永远在执行节点上,本面板只决定 UI 连到哪个节点。
 */
export const ConnectionPanel: React.FC<ConnectionPanelProps> = ({ onClose }) => {
  const current = getConnectionTarget();
  const [mode, setMode] = useState<'local' | 'relay'>(current.mode);
  const [url, setUrl] = useState(current.mode === 'relay' ? current.url : '');
  const [token, setToken] = useState(current.mode === 'relay' ? current.token : '');
  const [deviceId, setDeviceId] = useState(current.mode === 'relay' ? current.deviceId : '');
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const handleRefresh = useCallback(async () => {
    if (!url.trim()) { setErr('请先填写中继地址'); return; }
    setBusy(true);
    setErr('');
    try {
      const list = await listRelayDevices(url.trim(), token.trim());
      setDevices(list);
      if (list.length === 0) {
        setErr('中继在线,但当前没有执行节点注册');
      } else if (!list.find((d) => d.id === deviceId)) {
        setDeviceId(list[0].id);
      }
    } catch (e: any) {
      setDevices([]);
      setErr(e?.message || '获取设备失败');
    } finally {
      setBusy(false);
    }
  }, [url, token, deviceId]);

  const handleSave = useCallback(async () => {
    if (mode === 'local') {
      await setConnectionTarget({ mode: 'local' });
      onClose();
      return;
    }
    if (!url.trim()) { setErr('请填写中继地址'); return; }
    if (!deviceId) { setErr('请选择一个执行节点'); return; }
    const dev = devices.find((d) => d.id === deviceId);
    await setConnectionTarget({
      mode: 'relay',
      url: url.trim(),
      token: token.trim(),
      deviceId,
      deviceName: dev?.name,
    });
    onClose();
  }, [mode, url, token, deviceId, devices, onClose]);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
            📡 连接
          </h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        <p style={{ fontSize: 12, color: 'var(--theme-text-muted)', margin: '0 0 14px' }}>
          真实执行永远在执行节点上。这里只决定当前 UI 连到哪个节点。
        </p>

        {/* 模式选择 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {(['local', 'relay'] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setErr(''); }}
              style={{
                ...modeBtnStyle,
                background: mode === m ? 'var(--theme-accent-bg)' : 'transparent',
                borderColor: mode === m ? 'var(--theme-accent)' : 'var(--theme-border)',
                color: mode === m ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
              }}
            >
              {m === 'local' ? '🏠 本地直连' : '🌐 远程(经中继)'}
            </button>
          ))}
        </div>

        {mode === 'local' && (
          <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.6 }}>
            直接连接本机 / 局域网内的执行节点,不经过中继。延迟最低,流量不出网。
          </div>
        )}

        {mode === 'relay' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={labelStyle}>中继地址</label>
              <input
                type="text"
                value={url}
                placeholder="wss://relay.example.com"
                onChange={(e) => setUrl(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>中继 Token</label>
              <input
                type="password"
                value={token}
                placeholder="与中继服务器一致的共享 token"
                onChange={(e) => setToken(e.target.value)}
                style={inputStyle}
              />
            </div>
            <button onClick={handleRefresh} disabled={busy} style={refreshBtnStyle}>
              {busy ? '获取中…' : '刷新执行节点列表'}
            </button>
            {devices.length > 0 && (
              <div>
                <label style={labelStyle}>执行节点</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {devices.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setDeviceId(d.id)}
                      style={{
                        ...deviceBtnStyle,
                        background: deviceId === d.id ? 'var(--theme-accent-bg)' : 'var(--theme-input-bg)',
                        borderColor: deviceId === d.id ? 'var(--theme-accent)' : 'var(--theme-border)',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{d.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginLeft: 8 }}>
                        {d.id}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {err && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-error, #f85149)' }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button onClick={handleSave} style={saveBtnStyle}>保存并连接</button>
          <button onClick={onClose} style={cancelBtnStyle}>取消</button>
        </div>
      </div>
    </div>
  );
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1200,
};

const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #1f202e)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  borderRadius: 12,
  padding: 20,
  width: '90%',
  maxWidth: 420,
  maxHeight: '85vh',
  overflowY: 'auto',
  boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--theme-text)',
  marginBottom: 4, display: 'block',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-input-bg, #fff)',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 12, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
};

const modeBtnStyle: React.CSSProperties = {
  flex: 1, padding: '8px 10px', borderRadius: 8,
  border: '1px solid', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};

const deviceBtnStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid',
  color: 'var(--theme-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left',
};

const refreshBtnStyle: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 8,
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)',
  color: 'var(--theme-accent)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
};

const saveBtnStyle: React.CSSProperties = {
  flex: 1, padding: '9px 12px', borderRadius: 8, border: 'none',
  background: 'var(--theme-accent, #0969da)', color: '#fff',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '9px 16px', borderRadius: 8,
  border: '1px solid var(--theme-border)', background: 'transparent',
  color: 'var(--theme-text-muted)', fontSize: 13, cursor: 'pointer',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none',
  color: 'var(--theme-text-muted)', fontSize: 16, cursor: 'pointer', padding: '2px 6px',
};
