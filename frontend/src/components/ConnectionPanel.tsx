import React, { useCallback, useEffect, useState } from 'react';
import {
  getConnectionTarget, setConnectionTarget, listRelayDevices,
  isTauri, getDesktopConfig, setDesktopConfig, type DesktopConfig,
  api, type ConnectedClient,
  getExecutors, addExecRoster, removeExecRoster, onExecStatus,
  type ExecutorInfo,
} from '../api';
import {
  listRelayProfiles, saveRelayProfile, deleteRelayProfile,
  type RelayProfile,
} from '../utils/relayProfiles';

interface ConnectionPanelProps {
  onClose: () => void;
}

/**
 * 连接面板。
 *
 * 视觉上分成两张独立卡片，避免「两段中继地址」让人混淆：
 *
 *   ┌─[ 卡片 A · 本机角色 ]──────────  仅 Tauri 桌面端可见
 *   │ 这台机器扮演什么：执行节点 / 纯客户端
 *   │ + 发布到中继的配置（让远程 UI 经中继找到本机）
 *   │ + 「正在连接本机的 UI」实时列表 + 计数
 *   └─────────────────────────────────
 *
 *   ┌─[ 卡片 B · 本 UI 连接到 ]─────────  所有端可见
 *   │ 当前这个窗口要连哪台执行节点：本地直连 / 经中继
 *   └─────────────────────────────────
 *
 * 卡片 A 是「我对外提供什么」，卡片 B 是「我自己要看哪台」，
 * 名字相近但目的完全不同。
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

  // 桌面端本机角色（仅 Tauri）：执行节点 / 纯客户端，改动需重启生效。
  const tauri = isTauri();
  const [role, setRole] = useState<'executor' | 'client'>('executor');
  const [pubUrl, setPubUrl] = useState('');
  const [pubToken, setPubToken] = useState('');
  const [pubDeviceName, setPubDeviceName] = useState('');
  const [savedDesktop, setSavedDesktop] = useState<DesktopConfig | null>(null);
  const [restartHint, setRestartHint] = useState(false);

  // 「正在连接本机的 UI」实时列表
  const [clients, setClients] = useState<ConnectedClient[]>([]);

  // ── 可分配执行节点（session 级模式）：home + 额外节点，新建会话时可选 ──
  const [executors, setExecutors] = useState<ExecutorInfo[]>(() => getExecutors());
  useEffect(() => onExecStatus(() => setExecutors(getExecutors())), []);

  // 把卡片 B 当前填好的中继 + 选中节点加入「可分配执行节点」（不切换 home）。
  const addSelectedAsExecutor = useCallback(() => {
    if (!url.trim()) { setErr('请先填写中继地址'); return; }
    if (!deviceId) { setErr('请先刷新并选择一个执行节点'); return; }
    const dev = devices.find((d) => d.id === deviceId);
    addExecRoster({ mode: 'relay', url: url.trim(), token: token.trim(), deviceId, deviceName: dev?.name });
    setErr('');
  }, [url, token, deviceId, devices]);

  // ── Relay 预设列表(localStorage 持久化) ──
  const [profiles, setProfiles] = useState<RelayProfile[]>(() => listRelayProfiles());
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
    // 启动时如果当前 url+token 命中某个预设,自动高亮它
    const c = getConnectionTarget();
    if (c.mode !== 'relay') return null;
    const hit = listRelayProfiles().find((p) => p.url === c.url && p.token === c.token);
    return hit?.id ?? null;
  });
  const refreshProfiles = useCallback(() => setProfiles(listRelayProfiles()), []);

  const selectProfile = useCallback((p: RelayProfile) => {
    setUrl(p.url);
    setToken(p.token);
    setActiveProfileId(p.id);
    setErr('');
    // 选了新的中继 → 设备列表清空,让用户重新刷一遍
    setDevices([]);
    setDeviceId('');
  }, []);

  const saveCurrentAsProfile = useCallback(() => {
    const u = url.trim();
    const t = token.trim();
    if (!u) { setErr('请先填写中继地址'); return; }
    const defaultLabel = (() => {
      try {
        const host = new URL(u.replace(/^ws/, 'http')).host;
        return host || u;
      } catch { return u; }
    })();
    const label = window.prompt('为这个中继取个名字', defaultLabel);
    if (!label) return;  // 用户取消
    const saved = saveRelayProfile({ id: activeProfileId ?? undefined, label, url: u, token: t });
    refreshProfiles();
    setActiveProfileId(saved.id);
  }, [url, token, activeProfileId, refreshProfiles]);

  const removeProfile = useCallback((id: string) => {
    if (!window.confirm('删除这个中继预设?')) return;
    deleteRelayProfile(id);
    refreshProfiles();
    if (activeProfileId === id) setActiveProfileId(null);
  }, [activeProfileId, refreshProfiles]);

  useEffect(() => {
    if (!tauri) return;
    getDesktopConfig().then((c) => {
      if (!c) return;
      setSavedDesktop(c);
      setRole(c.mode === 'client' ? 'client' : 'executor');
      setPubUrl(c.relayUrl || '');
      setPubToken(c.relayToken || '');
      setPubDeviceName(c.deviceName || '');
    });
  }, [tauri]);

  // 纯客户端不在本机起 sidecar，本地直连必然连不上 127.0.0.1:44321 → 自动切到中继。
  // 处理两种情况：用户在本会话切到「纯客户端」；以及上一次错存了 client+local 的组合。
  useEffect(() => {
    if (role === 'client' && mode === 'local') setMode('relay');
  }, [role, mode]);

  // 拉取一次并订阅在线 UI 列表（执行节点视角下才有意义；纯客户端列表里就一个自己）
  useEffect(() => {
    let cancelled = false;
    api.listConnectedClients().then((list) => {
      if (!cancelled) setClients(list);
    }).catch(() => { /* 后端未连上 / mock 时 list 为空 */ });
    const unsub = api.onClientsChanged((list) => {
      if (!cancelled) setClients(list);
    });
    return () => { cancelled = true; unsub(); };
  }, []);

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

  // 把卡片 A 里填好的发布中继配置复制到卡片 B 的「远程(经中继)」字段
  const copyFromPublish = useCallback(() => {
    if (pubUrl.trim()) setUrl(pubUrl.trim());
    if (pubToken.trim()) setToken(pubToken.trim());
    setMode('relay');
  }, [pubUrl, pubToken]);

  const handleSave = useCallback(async () => {
    // 1. 持久化桌面端本机角色（仅 Tauri）。改动需重启应用生效。
    let needRestart = false;
    if (tauri) {
      const next: DesktopConfig = {
        mode: role,
        relayUrl: pubUrl.trim(),
        relayToken: pubToken.trim(),
        deviceName: pubDeviceName.trim(),
      };
      needRestart = !savedDesktop
        || savedDesktop.mode !== next.mode
        || savedDesktop.relayUrl !== next.relayUrl
        || savedDesktop.relayToken !== next.relayToken
        || savedDesktop.deviceName !== next.deviceName;
      if (needRestart) {
        await setDesktopConfig(next);
        setSavedDesktop(next);
      }
    }
    // 2. 持久化当前 UI 的连接目标。
    if (mode === 'local') {
      await setConnectionTarget({ mode: 'local' });
    } else {
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
      // 顺手把当前 url+token 落进 profile 列表(同 url+token 已存在会去重,
      // 不会产生重复条目)。这样用户「保存并连接」一次,下次就能从预设列表
      // 一键回来,不用再输 url 和 token。
      try {
        const defaultLabel = (() => {
          try { return new URL(url.trim().replace(/^ws/, 'http')).host || url.trim(); }
          catch { return url.trim(); }
        })();
        const saved = saveRelayProfile({
          id: activeProfileId ?? undefined,
          label: profiles.find((p) => p.id === activeProfileId)?.label || defaultLabel,
          url: url.trim(),
          token: token.trim(),
        });
        refreshProfiles();
        setActiveProfileId(saved.id);
      } catch { /* 静默忽略,profile 持久化失败不影响连接 */ }
    }
    if (needRestart) setRestartHint(true);
    else onClose();
  }, [tauri, role, pubUrl, pubToken, pubDeviceName, savedDesktop,
      mode, url, token, deviceId, devices, onClose]);

  // 卡片 A 已配置好「发布中继」、卡片 B 选了 relay 但还没填地址：提示一键复制
  const canSuggestCopy = tauri && role === 'executor' && mode === 'relay'
    && pubUrl.trim() && (!url.trim() || url.trim() !== pubUrl.trim());

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
            📡 连接
          </h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        <div style={introStyle}>
          真实执行永远在<b>执行节点</b>上。
          {tauri && <> 下面两张卡片各管一件事：</>}
          {!tauri && <> 选择当前 UI 连到哪台执行节点：</>}
          {tauri && (
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              <li><b>本机角色</b> = 我这台机器对外提供什么</li>
              <li><b>本 UI 连接到</b> = 这个窗口里要看哪台执行节点</li>
            </ul>
          )}
        </div>

        {/* ════ 可分配执行节点（session 级模式管理）════════════════════
            home 节点(下面卡片 B 选的那台)是新建会话的默认落点;在这里额外加入
            的远端节点会与 home 同时在线,新建会话时可逐会话选择它执行。这样
            「某些会话本机自执行,某些走远端」就成了每会话的选择,而非整窗口的
            系统级开关。 */}
        {executors.length > 1 && (
          <div style={cardStyle}>
            <div style={cardTitleStyle}>
              {tauri && <span style={cardBadgeStyle}>★</span>}
              <span>可分配执行节点</span>
              <span style={cardSubtitleStyle}>新建会话时逐个选择</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {executors.map((ex) => (
                <div key={ex.key} style={execRowStyle}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: ex.connected ? '#22c55e' : '#9ca3af',
                  }} />
                  <span style={{ fontWeight: 600, color: 'var(--theme-text)' }}>
                    {ex.mode === 'local' ? ex.label : `🌐 ${ex.label}`}
                  </span>
                  {ex.isHome && (
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 8,
                      background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
                    }}>home · 默认</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                    {ex.connected ? '在线' : '离线'}
                  </span>
                  <div style={{ flex: 1 }} />
                  {!ex.isHome && (
                    <button
                      onClick={() => removeExecRoster(ex.key)}
                      style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 6,
                        border: '1px solid var(--theme-border)', background: 'transparent',
                        color: 'var(--theme-text-muted)', cursor: 'pointer',
                      }}
                      title="从可分配列表移除（不影响已建会话）"
                    >移除</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════ 卡片 A：本机角色（仅 Tauri） ════════════════════════ */}
        {tauri && (
          <div style={cardStyle}>
            <div style={cardTitleStyle}>
              <span style={cardBadgeStyle}>A</span>
              <span>本机角色</span>
              <span style={cardSubtitleStyle}>桌面端 · 重启生效</span>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {(['executor', 'client'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  style={{
                    ...modeBtnStyle,
                    background: role === r ? 'var(--theme-accent-bg)' : 'transparent',
                    borderColor: role === r ? 'var(--theme-accent)' : 'var(--theme-border)',
                    color: role === r ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
                  }}
                >
                  {r === 'executor' ? '🖥️ 执行节点' : '📱 纯客户端'}
                </button>
              ))}
            </div>

            {role === 'executor' && (
              <>
                <div style={hintStyle}>
                  本机在跑 Claude。填写中继可让远程 UI 经中继访问本机；留空则仅本地 / 局域网可用。
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 4px' }}>
                  <input
                    type="text"
                    value={pubUrl}
                    placeholder="中继地址 ws://relay.example.com:44360（可选）"
                    onChange={(e) => setPubUrl(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    type="password"
                    value={pubToken}
                    placeholder="中继 Token（可选）"
                    onChange={(e) => setPubToken(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    type="text"
                    value={pubDeviceName}
                    placeholder="本机显示名（远程设备列表里显示）"
                    onChange={(e) => setPubDeviceName(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                {/* —— 正在连接本机的 UI ——————————————————————————— */}
                <ConnectedClientsList clients={clients} />
              </>
            )}

            {role === 'client' && (
              <div style={hintStyle}>
                本应用只作 UI，不在本机运行执行节点。请在下方卡片 B 选择「远程(经中继)」连接到其它执行节点。
              </div>
            )}
          </div>
        )}

        {/* ════ 卡片 B：本 UI 连接到 ════════════════════════════════ */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>
            {tauri && <span style={cardBadgeStyle}>B</span>}
            <span>本 UI 连接到</span>
            <span style={cardSubtitleStyle}>这个窗口要看哪台执行节点</span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {(['local', 'relay'] as const).map((m) => {
              const blocked = m === 'local' && role === 'client';
              return (
                <button
                  key={m}
                  onClick={() => { if (blocked) return; setMode(m); setErr(''); }}
                  disabled={blocked}
                  title={blocked ? '纯客户端模式本机不跑 sidecar，本地直连必然连不上' : undefined}
                  style={{
                    ...modeBtnStyle,
                    background: mode === m ? 'var(--theme-accent-bg)' : 'transparent',
                    borderColor: mode === m ? 'var(--theme-accent)' : 'var(--theme-border)',
                    color: mode === m ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
                    ...(blocked ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
                  }}
                >
                  {m === 'local' ? '🏠 本地直连' : '🌐 远程(经中继)'}
                </button>
              );
            })}
          </div>

          {mode === 'local' && (
            <div style={hintStyle}>
              连本机 / 局域网内的 sidecar，不经中继。延迟最低，流量不出网。
              {tauri && role === 'executor'
                && <><br/>👉 这是执行节点自己的 UI 最常用的选项。</>}
            </div>
          )}

          {mode === 'relay' && (
            <>
              {canSuggestCopy && (
                <button onClick={copyFromPublish} style={suggestBtnStyle}>
                  ↑ 使用卡片 A 里填的中继地址 / Token
                </button>
              )}

              {/* 已保存的中继预设(点选即填入 url+token) */}
              {profiles.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <label style={labelStyle}>已保存的中继</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {profiles.map((p) => {
                      const active = activeProfileId === p.id;
                      return (
                        <span
                          key={p.id}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '4px 8px',
                            borderRadius: 14,
                            border: `1px solid ${active ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                            background: active ? 'var(--theme-accent-bg)' : 'transparent',
                            color: active ? 'var(--theme-accent)' : 'var(--theme-text)',
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                          onClick={() => selectProfile(p)}
                          title={p.url}
                        >
                          <span>{p.label}</span>
                          <span
                            onClick={(e) => { e.stopPropagation(); removeProfile(p.id); }}
                            style={{
                              opacity: 0.6, fontSize: 12, marginLeft: 2,
                              cursor: 'pointer',
                            }}
                            title="删除"
                          >×</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <div>
                  <label style={labelStyle}>中继地址</label>
                  <input
                    type="text"
                    value={url}
                    placeholder="ws://relay.example.com:44360"
                    onChange={(e) => { setUrl(e.target.value); setActiveProfileId(null); }}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>中继 Token</label>
                  <input
                    type="password"
                    value={token}
                    placeholder="与中继服务器一致的共享 token"
                    onChange={(e) => { setToken(e.target.value); setActiveProfileId(null); }}
                    style={inputStyle}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={saveCurrentAsProfile} style={{ ...refreshBtnStyle, flex: '0 0 auto' }}>
                    💾 {activeProfileId ? '更新预设' : '保存为预设'}
                  </button>
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
                    {/* 把所选节点加入「可分配执行节点」——不切换 home,只是让新建
                        会话时多一个可选的执行节点(session 级)。 */}
                    <button onClick={addSelectedAsExecutor} style={{ ...refreshBtnStyle, marginTop: 8 }}>
                      ➕ 加入可分配执行节点（新建会话时可选）
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {err && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-error, #f85149)' }}>
            {err}
          </div>
        )}

        {restartHint && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-accent)' }}>
            本机角色已保存，重启应用后生效。
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

// ── 子组件：正在连接本机的 UI 列表 ──────────────────────────────────
const ConnectedClientsList: React.FC<{ clients: ConnectedClient[] }> = ({ clients }) => {
  const count = clients.length;
  return (
    <div style={connectedBoxStyle}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)' }}>
          📊 正在连接本机的 UI
        </span>
        <span style={{
          marginLeft: 6, padding: '1px 8px', borderRadius: 10,
          fontSize: 11, fontWeight: 600,
          background: count > 0 ? 'var(--theme-accent-bg)' : 'var(--theme-bg-tertiary)',
          color: count > 0 ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
        }}>
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          (暂无连接)
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {clients.map((c, i) => <ClientRow key={i} c={c} />)}
        </div>
      )}
    </div>
  );
};

const ClientRow: React.FC<{ c: ConnectedClient }> = ({ c }) => {
  const since = c.since ? humanDuration(c.since) : '';
  const viaTag = c.via === 'relay' ? '🌐 中继' : '🏠 本地';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 8px', borderRadius: 6,
      background: 'var(--theme-bg-tertiary)',
      fontSize: 11,
    }}>
      <span style={{ fontWeight: 600, color: 'var(--theme-text)' }}>{viaTag}</span>
      <span style={{ color: 'var(--theme-text)' }}>{c.identity || '?'}</span>
      {c.peer && (
        <span style={{ color: 'var(--theme-text-muted)', fontFamily: 'monospace' }}>
          {c.peer}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {since && <span style={{ color: 'var(--theme-text-muted)' }}>{since}</span>}
    </div>
  );
};

/** 把 ISO 时间转成「3min / 12s / 2h」相对值。 */
function humanDuration(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}min`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d`;
  } catch { return ''; }
}

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
  maxWidth: 460,
  maxHeight: '85vh',
  overflowY: 'auto',
  boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
};

const introStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--theme-text-muted)',
  margin: '0 0 14px', lineHeight: 1.6,
};

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--theme-border)',
  borderRadius: 10,
  padding: 12,
  marginBottom: 12,
  background: 'var(--theme-bg, rgba(255,255,255,0.02))',
};

const cardTitleStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  marginBottom: 10,
  fontSize: 13, fontWeight: 600, color: 'var(--theme-text)',
};

const cardBadgeStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 20, height: 20, borderRadius: 4,
  background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
  fontSize: 11, fontWeight: 700,
};

const cardSubtitleStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11, fontWeight: 400, color: 'var(--theme-text-muted)',
};

const hintStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.6,
};

const execRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 8px', borderRadius: 6,
  background: 'var(--theme-bg-tertiary)',
  fontSize: 12,
};

const connectedBoxStyle: React.CSSProperties = {
  marginTop: 10, padding: 10, borderRadius: 8,
  background: 'var(--theme-bg-secondary)',
  border: '1px solid var(--theme-border)',
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

const suggestBtnStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6,
  border: '1px dashed var(--theme-accent)',
  background: 'transparent', color: 'var(--theme-accent)',
  fontSize: 11, cursor: 'pointer',
  marginBottom: 6,
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
