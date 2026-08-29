import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, getExecutors, onExecStatus,
  type ExecutorInfo, type NodeUpdateStatus,
} from '../api';

const UPDATE_FEED_KEY = 'awu.updateFeed.v1';

interface FeedDraft {
  manifestUrl: string;
  channel: string;
  requireSignature: boolean;
}

const emptyFeed: FeedDraft = { manifestUrl: '', channel: 'stable', requireSignature: false };

function loadFeed(): FeedDraft {
  try {
    const value = JSON.parse(localStorage.getItem(UPDATE_FEED_KEY) || '{}');
    return {
      manifestUrl: String(value?.manifestUrl || ''),
      channel: String(value?.channel || 'stable'),
      requireSignature: !!value?.requireSignature,
    };
  } catch {
    return emptyFeed;
  }
}

function saveFeed(value: FeedDraft): void {
  try { localStorage.setItem(UPDATE_FEED_KEY, JSON.stringify(value)); } catch { /* */ }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function phaseLabel(status?: NodeUpdateStatus): string {
  switch (status?.phase) {
    case 'checking': return '检查中';
    case 'current': return '已是最新';
    case 'available': return '可更新';
    case 'downloading': return '下载中';
    case 'staged': return '已校验，待安装';
    case 'installing': return '安装/重启中';
    case 'installed': return '安装完成';
    case 'cancelled': return '已取消';
    case 'error': return '失败';
    default: return '未检查';
  }
}

function phaseColor(status?: NodeUpdateStatus): string {
  switch (status?.phase) {
    case 'current': case 'installed': return '#3fb950';
    case 'available': case 'staged': return '#58a6ff';
    case 'checking': case 'downloading': case 'installing': return '#d29922';
    case 'error': return '#f85149';
    default: return 'var(--theme-text-muted)';
  }
}

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export const UpdateCenter: React.FC = () => {
  const [executors, setExecutors] = useState<ExecutorInfo[]>(() => getExecutors());
  const [statuses, setStatuses] = useState<Record<string, NodeUpdateStatus>>({});
  const [feed, setFeed] = useState<FeedDraft>(() => loadFeed());
  const [signatureKey, setSignatureKey] = useState('');
  const [busyNodes, setBusyNodes] = useState<Set<string>>(new Set());
  const [globalBusy, setGlobalBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const mountedRef = useRef(true);
  const feedSeededRef = useRef(Boolean(feed.manifestUrl.trim()));

  const updateStatus = useCallback((key: string, value: NodeUpdateStatus) => {
    if (!mountedRef.current) return;
    setStatuses((current) => ({ ...current, [key]: value }));
  }, []);

  const updateStatusError = useCallback((key: string, error: unknown) => {
    if (!mountedRef.current) return;
    setStatuses((current) => {
      const previous = current[key];
      const fallback: NodeUpdateStatus = {
        platform: 'unknown', arch: 'unknown', desktop: false,
        current: { version: 'unknown' },
        config: { manifestUrl: '', channel: 'stable', requireSignature: false, hasSignatureKey: false, hasRequestHeaders: false },
        phase: 'idle', busy: false,
      };
      return {
        ...current,
        [key]: {
          ...(previous || fallback),
          phase: 'error', busy: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    });
  }, []);

  const markInstalling = useCallback((key: string) => {
    if (!mountedRef.current) return;
    setStatuses((current) => {
      const status = current[key];
      if (!status) return current;
      return {
        ...current,
        [key]: { ...status, phase: 'installing', busy: true, message: '安装并重启中' },
      };
    });
  }, []);

  const updateBusy = useCallback((key: string, value: boolean) => {
    if (!mountedRef.current) return;
    setBusyNodes((current) => {
      const next = new Set(current);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const refresh = useCallback(async (nodes = getExecutors()) => {
    const online = nodes.filter((node) => node.connected);
    const resolved = await Promise.all(online.map(async (node) => {
      try {
        const status = await api.nodeUpdateStatus(node.key);
        updateStatus(node.key, status);
        return { node, status };
      } catch (error) {
        updateStatusError(node.key, error);
        return null;
      }
    }));
    if (!feedSeededRef.current) {
      const available = resolved.filter((item): item is NonNullable<typeof item> => !!item);
      const preferred = available.find((item) => item.node.isHome && item.status.config.manifestUrl)
        || available.find((item) => item.node.key === 'local' && item.status.config.manifestUrl)
        || available.find((item) => item.status.config.manifestUrl);
      if (preferred) {
        feedSeededRef.current = true;
        setFeed((current) => current.manifestUrl.trim() ? current : {
          manifestUrl: preferred.status.config.manifestUrl,
          channel: preferred.status.config.channel || 'stable',
          requireSignature: preferred.status.config.requireSignature,
        });
      }
    }
  }, [updateStatus, updateStatusError]);

  useEffect(() => {
    mountedRef.current = true;
    const initial = getExecutors();
    setExecutors(initial);
    void refresh(initial);
    const unsubscribe = onExecStatus(() => {
      const next = getExecutors();
      setExecutors(next);
      void refresh(next);
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveFeed(feed);
  }, [feed]);

  const onlineNodes = useMemo(() => executors.filter((node) => node.connected), [executors]);

  const manifestUrl = feed.manifestUrl.trim();
  const requireFeed = () => {
    if (!manifestUrl) throw new Error('请先填写版本清单 URL（可使用七牛云/CDN HTTPS 地址）');
  };

  const configureNode = async (node: ExecutorInfo) => {
    requireFeed();
    const result = await api.nodeUpdateConfigure(node.key, {
      manifestUrl,
      channel: feed.channel.trim() || 'stable',
      requireSignature: feed.requireSignature,
      ...(feed.requireSignature && signatureKey ? { signatureKey } : {}),
      ...(!feed.requireSignature ? { clearSignatureKey: true } : {}),
    });
    if (result.status !== 'ok') throw new Error(result.message || '保存更新源失败');
  };

  const configureAll = async () => {
    if (globalBusy) return;
    setGlobalBusy(true);
    setNotice('');
    try {
      requireFeed();
      const results = await Promise.allSettled(onlineNodes.map(configureNode));
      const failures = results.filter((item) => item.status === 'rejected');
      if (failures.length) {
        throw new Error(`${onlineNodes.length - failures.length} 个节点已保存，${failures.length} 个失败；失败节点可能不是当前 Relay 用户的主节点`);
      }
      setSignatureKey('');
      setNotice(`更新源已保存到 ${onlineNodes.length} 个在线节点。`);
      await refresh(onlineNodes);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setGlobalBusy(false);
    }
  };

  const checkNode = async (node: ExecutorInfo): Promise<NodeUpdateStatus> => {
    requireFeed();
    updateBusy(node.key, true);
    try {
      // “一键更新”同时把当前控制端的 feed 写入目标节点；以后人在目标机上
      // 打开同一页面时无需重新配置，也避免 beta/stable 通道不一致。
      await configureNode(node);
      const status = await api.nodeUpdateCheck(node.key, manifestUrl);
      updateStatus(node.key, status);
      return status;
    } finally {
      updateBusy(node.key, false);
    }
  };

  const waitForStage = async (node: ExecutorInfo): Promise<NodeUpdateStatus> => {
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(850);
      const status = await api.nodeUpdateStatus(node.key);
      updateStatus(node.key, status);
      if (status.phase === 'staged') return status;
      if (status.phase === 'error' || status.phase === 'cancelled') {
        throw new Error(status.error || status.message || `${node.label} 下载失败`);
      }
    }
    throw new Error(`${node.label} 下载等待超过 2 小时`);
  };

  const stageNode = async (node: ExecutorInfo): Promise<NodeUpdateStatus> => {
    updateBusy(node.key, true);
    try {
      const started = await api.nodeUpdateStage(node.key, manifestUrl);
      updateStatus(node.key, started);
      if (started.phase === 'current') return started;
      if (started.phase === 'error') throw new Error(started.error || '无法开始下载');
      return await waitForStage(node);
    } finally {
      updateBusy(node.key, false);
    }
  };

  const applyNode = async (node: ExecutorInfo) => {
    updateBusy(node.key, true);
    try {
      const result = await api.nodeUpdateApply(node.key);
      if (result.status !== 'restarting') throw new Error(result.message || '节点未进入重启流程');
      markInstalling(node.key);
    } finally {
      updateBusy(node.key, false);
    }
  };

  const oneClickNode = async (node: ExecutorInfo) => {
    if (globalBusy || busyNodes.has(node.key)) return;
    setNotice('');
    try {
      const checked = await checkNode(node);
      if (!checked.available) {
        setNotice(`${node.label} 已是最新版本。`);
        return;
      }
      const target = checked.release?.version || '新版本';
      if (!window.confirm(`将 ${node.label} 更新到 ${target}。节点会短暂离线并自动重启，是否继续？`)) return;
      await stageNode(node);
      await applyNode(node);
      setNotice(`${node.label} 已进入安装重启流程。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const updateAll = async () => {
    if (globalBusy) return;
    setGlobalBusy(true);
    setNotice('');
    try {
      requireFeed();
      if (!onlineNodes.length) throw new Error('当前没有在线执行节点');
      const checks = await Promise.allSettled(onlineNodes.map(async (node) => ({ node, status: await checkNode(node) })));
      const dockerWithoutUpdater = checks.flatMap((item) => (
        item.status === 'fulfilled'
          && item.value.status.runtime === 'docker'
          && item.value.status.dockerUpdaterAvailable === false
          ? [item.value.node]
          : []
      ));
      const available = checks.flatMap((item) => (
        item.status === 'fulfilled'
          && item.value.status.available
          && !(item.value.status.runtime === 'docker' && item.value.status.dockerUpdaterAvailable === false)
          ? [item.value.node]
          : []
      ));
      const checkFailures = checks.filter((item) => item.status === 'rejected').length;
      if (!available.length) {
        if (dockerWithoutUpdater.length) {
          throw new Error(`${dockerWithoutUpdater.length} 个 Docker 节点尚未启动升级器；请先用新版 Compose 手动重建一次`);
        }
        if (checkFailures) throw new Error(`${checkFailures} 个节点检查失败，其余节点已是最新版本`);
        setNotice('所有在线节点都已是最新版本。');
        return;
      }
      if (!window.confirm(
        `将先并行下载并校验 ${available.length} 个节点的更新，再逐个安装重启。控制端所在的本机最后更新。是否继续？`,
      )) return;

      const stages = await Promise.allSettled(available.map(async (node) => ({ node, status: await stageNode(node) })));
      const staged = stages.flatMap((item) => (
        item.status === 'fulfilled' && item.value.status.phase === 'staged' ? [item.value.node] : []
      ));
      const stageFailures = stages.length - staged.length;
      // 控制端本机必须最后退出，否则尚未下发的远端安装命令会丢失。
      staged.sort((left, right) => Number(left.key === 'local') - Number(right.key === 'local'));
      let applied = 0;
      for (const node of staged) {
        try {
          await applyNode(node);
          applied += 1;
          await sleep(350);
        } catch (error) {
          updateStatusError(node.key, error);
        }
      }
      setNotice(
        `${applied} 个节点已进入安装重启流程`
        + (stageFailures ? `，${stageFailures} 个节点下载/校验失败` : '')
        + (dockerWithoutUpdater.length ? `，跳过 ${dockerWithoutUpdater.length} 个升级器离线的 Docker 节点` : '')
        + '。',
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setGlobalBusy(false);
    }
  };

  const cancelNode = async (node: ExecutorInfo) => {
    updateBusy(node.key, true);
    try {
      updateStatus(node.key, await api.nodeUpdateCancel(node.key));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      updateBusy(node.key, false);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={headingRowStyle}>
        <div>
          <div style={titleStyle}>节点在线更新</div>
          <div style={descriptionStyle}>
            单节点一键更新；也可从当前控制端并行暂存、逐台重启全部节点。制品直接由目标节点从对象存储下载。
          </div>
        </div>
        <button type="button" style={smallButtonStyle} disabled={globalBusy} onClick={() => void refresh()}>
          刷新状态
        </button>
      </div>

      <div style={feedGridStyle}>
        <label style={fieldStyle}>
          <span>版本清单 URL</span>
          <input
            value={feed.manifestUrl}
            onChange={(event) => setFeed({ ...feed, manifestUrl: event.target.value })}
            placeholder="https://cdn.example.com/agentwithu/stable/manifest.json"
            style={inputStyle}
          />
        </label>
        <label style={{ ...fieldStyle, flex: '0 1 120px' }}>
          <span>通道</span>
          <input
            value={feed.channel}
            onChange={(event) => setFeed({ ...feed, channel: event.target.value })}
            placeholder="stable"
            style={inputStyle}
          />
        </label>
      </div>
      <div style={securityRowStyle}>
        <label style={checkStyle}>
          <input
            type="checkbox"
            checked={feed.requireSignature}
            onChange={(event) => setFeed({ ...feed, requireSignature: event.target.checked })}
          />
          强制校验 HMAC-SHA256 清单签名
        </label>
        {feed.requireSignature && (
          <input
            type="password"
            value={signatureKey}
            onChange={(event) => setSignatureKey(event.target.value)}
            placeholder="签名密钥（留空保留节点原密钥）"
            autoComplete="off"
            style={{ ...inputStyle, flex: '1 1 220px' }}
          />
        )}
      </div>
      <div style={buttonRowStyle}>
        <button type="button" style={smallButtonStyle} disabled={globalBusy || !onlineNodes.length} onClick={() => void configureAll()}>
          保存更新源到在线节点
        </button>
        <button type="button" style={primaryButtonStyle} disabled={globalBusy || !onlineNodes.length} onClick={() => void updateAll()}>
          {globalBusy ? '批量处理中…' : `更新全部在线节点（${onlineNodes.length}）`}
        </button>
      </div>

      <div style={nodeListStyle}>
        {executors.map((node) => {
          const status = statuses[node.key];
          const nodeBusy = globalBusy || busyNodes.has(node.key) || !!status?.busy;
          const downloaded = Number(status?.downloadedBytes || 0);
          const total = Number(status?.totalBytes || 0);
          const progress = total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : 0;
          const dockerUpdaterMissing = status?.runtime === 'docker' && status.dockerUpdaterAvailable === false;
          return (
            <div key={node.key} style={nodeRowStyle}>
              <div style={nodeMainStyle}>
                <div style={nodeTitleRowStyle}>
                  <strong style={{ color: 'var(--theme-text)', fontSize: 12 }}>{node.label}</strong>
                  {node.key === 'local' && <span style={tagStyle}>当前设备</span>}
                  {node.isHome && <span style={tagStyle}>默认</span>}
                  <span style={{ ...tagStyle, color: node.connected ? '#3fb950' : '#8b949e' }}>
                    {node.connected ? '在线' : '离线'}
                  </span>
                  {status?.runtime === 'docker' && (
                    <span style={{
                      ...tagStyle,
                      color: status.dockerUpdaterAvailable ? '#3fb950' : '#f85149',
                    }}>
                      Docker · {status.dockerUpdaterAvailable ? '升级器在线' : '升级器离线'}
                    </span>
                  )}
                </div>
                <div style={metaStyle}>
                  {status ? `${status.platform}/${status.arch} · 当前 ${status.current?.version || 'unknown'}` : '尚未读取版本'}
                  {status?.release?.version ? ` · 目标 ${status.release.version}` : ''}
                  {status?.artifact ? ` · ${status.artifact.target}/${status.artifact.kind}` : ''}
                </div>
                <div style={{ ...metaStyle, color: phaseColor(status) }}>
                  {phaseLabel(status)}{status?.message ? ` · ${status.message}` : ''}
                  {status?.error ? ` · ${status.error}` : ''}
                </div>
                {status?.phase === 'downloading' && (
                  <div style={progressTrackStyle} title={`${formatBytes(downloaded)} / ${formatBytes(total)}`}>
                    <div style={{ ...progressBarStyle, width: `${progress}%` }} />
                  </div>
                )}
              </div>
              <div style={nodeActionsStyle}>
                {status?.artifact?.url && (
                  <a href={status.artifact.url} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                    下载安装包
                  </a>
                )}
                {status?.phase === 'downloading' ? (
                  <button type="button" style={smallButtonStyle} onClick={() => void cancelNode(node)}>取消</button>
                ) : (
                  <>
                    <button
                      type="button" style={smallButtonStyle}
                      disabled={!node.connected || nodeBusy || !manifestUrl}
                      onClick={() => void checkNode(node).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}
                    >检查</button>
                    <button
                      type="button" style={nodePrimaryButtonStyle}
                      disabled={!node.connected || nodeBusy || !manifestUrl || dockerUpdaterMissing}
                      title={dockerUpdaterMissing
                        ? '该 Docker 节点尚未启动 awu-updater；先在宿主机用新版 Compose 手动重建一次'
                        : undefined}
                      onClick={() => void oneClickNode(node)}
                    >一键更新</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {notice && <div style={noticeStyle}>{notice}</div>}
      <div style={footnoteStyle}>
        更新清单和安装命令由发布者生成；每个制品必须带 SHA-256。任意格式通过 install.program + args 安装，参数不会经过 Shell。
        Docker 节点只接受 target=docker、kind=docker-bundle 的镜像包，由隔离的 awu-updater 健康检查并在失败时回滚。
        共享执行节点只有本机或 Relay 主用户可发起更新。七牛云只需提供可访问的 HTTPS/CDN URL；安装包链接仍可手工下载。
      </div>
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  marginBottom: 12, padding: 14, border: '1px solid var(--theme-border)', borderRadius: 5,
  background: 'color-mix(in srgb, var(--theme-bg-secondary) 74%, transparent)',
};
const headingRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 };
const titleStyle: React.CSSProperties = { color: 'var(--theme-text)', fontSize: 13, fontWeight: 650 };
const descriptionStyle: React.CSSProperties = { marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 10.5, lineHeight: 1.5 };
const feedGridStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 };
const fieldStyle: React.CSSProperties = { flex: '1 1 300px', display: 'grid', gap: 5, color: 'var(--theme-text-muted)', fontSize: 10.5 };
const inputStyle: React.CSSProperties = {
  minWidth: 0, padding: '7px 9px', boxSizing: 'border-box', borderRadius: 4,
  border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text)',
  fontSize: 11, outline: 'none', fontFamily: 'inherit',
};
const securityRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 9 };
const checkStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--theme-text-muted)', fontSize: 10.5 };
const buttonRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 10 };
const smallButtonStyle: React.CSSProperties = {
  padding: '6px 9px', border: '1px solid var(--theme-border)', borderRadius: 4,
  background: 'var(--theme-input-bg)', color: 'var(--theme-text)', fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit',
};
const primaryButtonStyle: React.CSSProperties = {
  ...smallButtonStyle, background: 'var(--theme-accent-bg)', borderColor: 'var(--theme-accent)', color: 'var(--theme-accent)', fontWeight: 650,
};
const nodePrimaryButtonStyle: React.CSSProperties = { ...primaryButtonStyle, whiteSpace: 'nowrap' };
const nodeListStyle: React.CSSProperties = { marginTop: 12, border: '1px solid var(--theme-border)', borderRadius: 4, overflow: 'hidden' };
const nodeRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
  padding: '10px 11px', borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
};
const nodeMainStyle: React.CSSProperties = { flex: '1 1 320px', minWidth: 0 };
const nodeTitleRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const tagStyle: React.CSSProperties = { padding: '1px 5px', border: '1px solid var(--theme-border)', borderRadius: 999, color: 'var(--theme-text-muted)', fontSize: 8.5 };
const metaStyle: React.CSSProperties = { marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 9.5, lineHeight: 1.4, overflowWrap: 'anywhere' };
const nodeActionsStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' };
const linkStyle: React.CSSProperties = { color: 'var(--theme-accent)', fontSize: 10, textDecoration: 'none', padding: '5px 2px' };
const progressTrackStyle: React.CSSProperties = { height: 4, marginTop: 7, overflow: 'hidden', borderRadius: 2, background: 'color-mix(in srgb, var(--theme-border) 70%, transparent)' };
const progressBarStyle: React.CSSProperties = { height: '100%', borderRadius: 2, background: 'var(--theme-accent)', transition: 'width .2s ease' };
const noticeStyle: React.CSSProperties = { marginTop: 10, padding: '8px 9px', borderLeft: '2px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-text)', fontSize: 10.5, lineHeight: 1.5 };
const footnoteStyle: React.CSSProperties = { marginTop: 10, color: 'var(--theme-text-muted)', fontSize: 9.5, lineHeight: 1.55 };

export default UpdateCenter;
