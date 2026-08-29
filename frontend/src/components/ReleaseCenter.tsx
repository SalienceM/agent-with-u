import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api, getExecutors, onExecStatus,
  type ExecutorInfo, type ReleaseArtifact, type ReleaseCandidate,
  type ReleaseCenterConfig, type ReleaseCenterState, type ReleasePlan,
} from '../api';

interface Props {
  onClose: () => void;
}

type View = 'release' | 'config' | 'history';

interface ConfigDraft {
  projectRoot: string;
  scanRoots: string;
  channel: string;
  baseUrl: string;
  qiniuBucket: string;
  prefix: string;
  manifestKey: string;
  stableManifestUrl: string;
  qshell: string;
  requireSignature: boolean;
}

const EMPTY_CONFIG: ConfigDraft = {
  projectRoot: '',
  scanRoots: 'src-tauri/target/release/bundle\ndist',
  channel: 'stable',
  baseUrl: '',
  qiniuBucket: '',
  prefix: 'agentwithu/releases',
  manifestKey: 'agentwithu/releases/stable/manifest.json',
  stableManifestUrl: '',
  qshell: 'qshell',
  requireSignature: false,
};

function toDraft(config?: ReleaseCenterConfig): ConfigDraft {
  if (!config) return EMPTY_CONFIG;
  return {
    projectRoot: config.projectRoot || '',
    scanRoots: (config.scanRoots || []).join('\n'),
    channel: config.channel || 'stable',
    baseUrl: config.baseUrl || '',
    qiniuBucket: config.qiniuBucket || '',
    prefix: config.prefix || 'agentwithu/releases',
    manifestKey: config.manifestKey || 'agentwithu/releases/stable/manifest.json',
    stableManifestUrl: config.stableManifestUrl || '',
    qshell: config.qshell || 'qshell',
    requireSignature: !!config.requireSignature,
  };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDate(value?: number): string {
  if (!value) return '—';
  return new Date(value * 1000).toLocaleString();
}

function formatDelta(value: number | null): string {
  if (value === null) return '新制品';
  if (!value) return '大小未变';
  return `${value > 0 ? '+' : '−'}${formatBytes(Math.abs(value))}`;
}

function statusMeta(status: ReleaseCandidate['status']): { label: string; color: string } {
  if (status === 'published') return { label: '已发布', color: '#3fb950' };
  if (status === 'discarded') return { label: '已废弃', color: '#8b949e' };
  return { label: '待发布', color: '#58a6ff' };
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 840);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 839px)');
    const listener = () => setNarrow(media.matches);
    listener();
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);
  return narrow;
}

export const ReleaseCenter: React.FC<Props> = ({ onClose }) => {
  const narrow = useNarrow();
  const [executors, setExecutors] = useState<ExecutorInfo[]>(() => getExecutors());
  const [execKey, setExecKey] = useState(() => {
    const all = getExecutors();
    return all.find((item) => item.key === 'local' && item.connected)?.key
      || all.find((item) => item.isHome && item.connected)?.key
      || all.find((item) => item.connected)?.key
      || 'local';
  });
  const [state, setState] = useState<ReleaseCenterState | null>(null);
  const [draft, setDraft] = useState<ConfigDraft>(EMPTY_CONFIG);
  const [view, setView] = useState<View>('release');
  const [candidateId, setCandidateId] = useState('');
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [plan, setPlan] = useState<ReleasePlan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [qiniuAccountName, setQiniuAccountName] = useState('agentwithu-release');
  const [qiniuAccessKey, setQiniuAccessKey] = useState('');
  const [qiniuSecretKey, setQiniuSecretKey] = useState('');
  const [showQiniuCredentials, setShowQiniuCredentials] = useState(false);

  const refresh = useCallback(async (syncConfig = false) => {
    if (!execKey) return;
    try {
      const next = await api.releaseStatus(execKey);
      if (next.status !== 'ok') throw new Error(next.message || '无法读取发布中心状态');
      setState(next);
      if (syncConfig) setDraft(toDraft(next.config));
      setCandidateId((current) => {
        if (current && next.candidates.some((item) => item.id === current)) return current;
        return next.candidates.find((item) => item.status === 'candidate')?.id
          || next.candidates[0]?.id || '';
      });
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [execKey]);

  useEffect(() => {
    setState(null);
    setCandidateId('');
    setArtifactIds([]);
    setPlan(null);
    setAcknowledged(false);
    setQiniuAccountName('agentwithu-release');
    setQiniuAccessKey('');
    setQiniuSecretKey('');
    setShowQiniuCredentials(false);
    void refresh(true);
  }, [execKey, refresh]);

  useEffect(() => {
    const unsubscribe = onExecStatus(() => {
      const next = getExecutors();
      setExecutors(next);
      if (!next.some((item) => item.key === execKey && item.connected)) {
        const fallback = next.find((item) => item.key === 'local' && item.connected)
          || next.find((item) => item.isHome && item.connected)
          || next.find((item) => item.connected);
        if (fallback) setExecKey(fallback.key);
      }
    });
    return unsubscribe;
  }, [execKey]);

  const activeJob = state?.activeJob || null;
  useEffect(() => {
    if (!activeJob || !['queued', 'running'].includes(activeJob.status)) return;
    const timer = window.setInterval(() => void refresh(false), 1000);
    return () => window.clearInterval(timer);
  }, [activeJob?.id, activeJob?.status, refresh]);

  const candidate = useMemo(
    () => state?.candidates.find((item) => item.id === candidateId) || null,
    [candidateId, state?.candidates],
  );

  useEffect(() => {
    if (!candidate) {
      setArtifactIds([]);
      return;
    }
    const fresh = candidate.artifacts.filter((item) => item.fresh).map((item) => item.id);
    setArtifactIds(fresh.length ? fresh : candidate.artifacts.map((item) => item.id));
    setPlan(null);
    setAcknowledged(false);
  }, [candidate?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidatePlan = () => {
    setPlan(null);
    setAcknowledged(false);
  };

  const configPayload = (): Partial<ReleaseCenterConfig> => ({
    projectRoot: draft.projectRoot.trim(),
    scanRoots: draft.scanRoots.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
    channel: draft.channel.trim() || 'stable',
    baseUrl: draft.baseUrl.trim(),
    qiniuBucket: draft.qiniuBucket.trim(),
    prefix: draft.prefix.trim(),
    manifestKey: draft.manifestKey.trim(),
    stableManifestUrl: draft.stableManifestUrl.trim(),
    qshell: draft.qshell.trim() || 'qshell',
    requireSignature: draft.requireSignature,
  });

  const saveConfig = async (quiet = false): Promise<boolean> => {
    setBusy('config');
    if (!quiet) setNotice('');
    try {
      const config = await api.releaseConfigure(execKey, configPayload());
      if (config.status === 'error') throw new Error(config.message || '发布配置保存失败');
      setDraft(toDraft(config));
      invalidatePlan();
      if (!quiet) setNotice('发布配置已保存到当前执行节点；未保存任何七牛账号密钥。');
      await refresh(false);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy('');
    }
  };

  const configureQiniuAccount = async () => {
    const accessKey = qiniuAccessKey.trim();
    const secretKey = qiniuSecretKey.trim();
    if (!accessKey || !secretKey) {
      setNotice('请同时填写 ACCESS_KEY 和 SECRET_KEY。');
      return;
    }
    setBusy('qiniu-account');
    setNotice('');
    try {
      // 账号必须由真正承担上传的节点保存；先只同步 qshell 路径，避免配置到旧命令。
      const config = await api.releaseConfigure(execKey, {
        qshell: draft.qshell.trim() || 'qshell',
      });
      if (config.status === 'error') throw new Error(config.message || 'qshell 路径保存失败');
      if (!config.qshellAvailable) throw new Error('当前执行节点找不到 qshell，请先填写正确路径');
      const result = await api.releaseConfigureQiniuAccount(
        execKey, accessKey, secretKey, qiniuAccountName.trim() || 'agentwithu-release',
      );
      if (result.status !== 'ok' || !result.configured) {
        throw new Error(result.message || '七牛账号配置失败');
      }
      setQiniuAccessKey('');
      setQiniuSecretKey('');
      setShowQiniuCredentials(false);
      invalidatePlan();
      await refresh(false);
      setNotice(result.message || '当前执行节点的七牛账号已配置。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const scan = async () => {
    setNotice('');
    if (!await saveConfig(true)) return;
    setBusy('scan');
    try {
      const result = await api.releaseScan(execKey, draft.projectRoot.trim());
      if (result.status !== 'ok' || !result.candidate) throw new Error(result.message || '没有登记候选构建');
      await refresh(false);
      setCandidateId(result.candidate.id);
      setView('release');
      setNotice(`已登记 ${result.candidate.artifacts.length} 个候选制品；尚未发布任何内容。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const preview = async () => {
    if (!candidate) return;
    setNotice('');
    if (!await saveConfig(true)) return;
    setBusy('preview');
    try {
      const result = await api.releasePreview(execKey, candidate.id, artifactIds, {
        notes, channel: draft.channel.trim() || 'stable', requireSignature: draft.requireSignature,
      });
      if (!result.plan) throw new Error(result.message || '发布预检没有生成冻结计划');
      setPlan(result.plan);
      setAcknowledged(false);
      setNotice(result.plan.blockers.length
        ? `预检完成：还有 ${result.plan.blockers.length} 个阻断项。`
        : '预检通过：已冻结文件哈希和发布清单，尚未上传。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    if (!plan || plan.blockers.length || !acknowledged) return;
    const target = `${plan.channel} · ${plan.candidate.buildId || candidate?.buildId}`;
    if (!window.confirm(
      `正式发布 ${target}\n\n将上传 ${plan.uploadJobs.length} 个制品，并在最后切换 ${plan.manifestKey}。\n此操作会让节点看到新版本，确定继续吗？`,
    )) return;
    setBusy('publish');
    setNotice('');
    try {
      const result = await api.releasePublish(execKey, plan.id);
      if (!result.job) throw new Error(result.message || '后台发布任务没有启动');
      setNotice(`后台发布任务已启动：${result.job.id.slice(0, 8)}。可以留在此页查看进度。`);
      await refresh(false);
      setView('history');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const discard = async () => {
    if (!candidate || candidate.status !== 'candidate') return;
    if (!window.confirm(`废弃候选 ${candidate.buildId}？本地安装包不会被删除。`)) return;
    setBusy('discard');
    try {
      const result = await api.releaseDiscard(execKey, candidate.id);
      if (result.status !== 'ok') throw new Error(result.message || '无法废弃候选');
      await refresh(false);
      invalidatePlan();
      setNotice('候选已标记为废弃；本地文件未删除。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const updateArtifact = async (artifact: ReleaseArtifact, patch: Partial<ReleaseArtifact>) => {
    if (!candidate) return;
    setBusy(`artifact:${artifact.id}`);
    setNotice('');
    try {
      const result = await api.releaseUpdateArtifact(execKey, candidate.id, artifact.id, patch);
      if (result.status !== 'ok') throw new Error(result.message || '制品设置保存失败');
      await refresh(false);
      invalidatePlan();
      setNotice(`${artifact.fileName} 的发布元数据已保存，请重新预检。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const cancelJob = async () => {
    if (!activeJob) return;
    if (!window.confirm('取消当前发布任务？已上传的不可变对象会保留，但不会主动切换 stable manifest。')) return;
    try {
      await api.releaseCancel(execKey, activeJob.id);
      await refresh(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const comparisonByArtifact = useMemo(() => new Map(
    (plan?.comparison.artifacts || []).map((item) => [item.artifactId, item]),
  ), [plan]);

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="发布工作台">
      <div style={panelStyle}>
        <header style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 17, color: 'var(--theme-text)' }}>🚀 发布工作台</strong>
              <span style={tagStyle}>按需加载</span>
              <span style={tagStyle}>全局候选</span>
            </div>
            <div style={{ marginTop: 3, color: 'var(--theme-text-muted)', fontSize: 10 }}>
              打包只登记候选；预检、选择和明确确认后才会正式发布
            </div>
          </div>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <select value={execKey} onChange={(event) => setExecKey(event.target.value)} style={headerSelectStyle}>
              {executors.map((item) => (
                <option key={item.key} value={item.key} disabled={!item.connected}>
                  {item.label}{item.connected ? '' : '（离线）'}
                </option>
              ))}
            </select>
            <button type="button" style={buttonStyle} onClick={() => void refresh(false)}>刷新</button>
            <button type="button" style={closeButtonStyle} onClick={onClose} aria-label="关闭发布工作台">✕</button>
          </div>
        </header>

        <div style={tabBarStyle}>
          {([
            ['release', '候选与发布'], ['config', '发布配置'], ['history', '任务与历史'],
          ] as Array<[View, string]>).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setView(id)} style={{
              ...tabStyle,
              color: view === id ? 'var(--theme-text)' : 'var(--theme-text-muted)',
              borderBottomColor: view === id ? 'var(--theme-accent)' : 'transparent',
            }}>
              {label}{id === 'history' && activeJob ? ' · 运行中' : ''}
            </button>
          ))}
        </div>

        {activeJob && (
          <div style={jobBannerStyle}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 }}>
                <strong style={{ color: 'var(--theme-text)' }}>{activeJob.message}</strong>
                <span style={{ color: 'var(--theme-text-muted)' }}>{activeJob.progress || 0}%</span>
              </div>
              <div style={progressTrackStyle}>
                <div style={{ ...progressFillStyle, width: `${Math.max(2, activeJob.progress || 0)}%` }} />
              </div>
            </div>
            <button type="button" style={dangerButtonStyle} onClick={() => void cancelJob()}>取消发布</button>
          </div>
        )}

        {notice && <div style={{
          ...noticeStyle,
          borderColor: /失败|错误|无法|阻断/.test(notice) ? 'rgba(248,81,73,.45)' : 'var(--theme-border)',
        }}>{notice}</div>}

        <main style={contentStyle}>
          {!state && !notice && <div style={emptyStyle}>正在读取发布状态…</div>}

          {state && view === 'release' && (
            <div style={{
              display: 'grid', minHeight: '100%', gap: 12,
              gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(230px, 290px) minmax(0, 1fr)',
              alignItems: 'start',
            }}>
              <aside style={candidateRailStyle}>
                <div style={railHeaderStyle}>
                  <div>
                    <strong style={{ color: 'var(--theme-text)', fontSize: 12 }}>候选构建</strong>
                    <div style={{ marginTop: 2, color: 'var(--theme-text-muted)', fontSize: 9 }}>
                      {state.candidates.length} 条记录
                    </div>
                  </div>
                  <button type="button" style={primarySmallStyle} disabled={!!busy || !!activeJob}
                    onClick={() => void scan()}>{busy === 'scan' ? '扫描中…' : '扫描打包结果'}</button>
                </div>
                <div style={{ display: 'flex', flexDirection: narrow ? 'row' : 'column', gap: 6, overflowX: 'auto' }}>
                  {state.candidates.map((item) => {
                    const meta = statusMeta(item.status);
                    const selected = item.id === candidateId;
                    return (
                      <button key={item.id} type="button" onClick={() => setCandidateId(item.id)} style={{
                        ...candidateButtonStyle,
                        minWidth: narrow ? 230 : 0,
                        borderColor: selected ? 'var(--theme-accent)' : 'var(--theme-border)',
                        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-input-bg)',
                      }}>
                        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <strong style={{ color: 'var(--theme-text)', fontSize: 11 }}>{item.version}</strong>
                          <span style={{ color: meta.color, fontSize: 9 }}>{meta.label}</span>
                        </span>
                        <span style={monoLineStyle}>{item.buildId}</span>
                        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--theme-text-muted)', fontSize: 9 }}>
                          <span>{item.artifacts.length} 个制品</span>
                          <span>{formatDate(item.createdAt)}</span>
                        </span>
                      </button>
                    );
                  })}
                  {!state.candidates.length && (
                    <div style={{ ...emptyStyle, padding: 20 }}>
                      还没有候选。手动打包完成后点击“扫描打包结果”。
                    </div>
                  )}
                </div>
              </aside>

              <section style={detailCardStyle}>
                {!candidate && <div style={emptyStyle}>请选择一个候选构建。</div>}
                {candidate && <>
                  <div style={detailHeaderStyle}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <strong style={{ color: 'var(--theme-text)', fontSize: 15 }}>{candidate.version}</strong>
                        <span style={{ ...tagStyle, color: statusMeta(candidate.status).color }}>
                          {statusMeta(candidate.status).label}
                        </span>
                        {candidate.dirty && <span style={{ ...tagStyle, color: '#d29922' }}>工作区未提交</span>}
                      </div>
                      <div style={{ ...monoLineStyle, marginTop: 5 }}>{candidate.buildId} · {candidate.commit || '无 commit'}</div>
                      <div style={{ marginTop: 5, color: 'var(--theme-text-muted)', fontSize: 10 }}>
                        {candidate.source} · {candidate.branch || '无分支'} · {candidate.projectRoot}
                      </div>
                    </div>
                    {candidate.status === 'candidate' && (
                      <button type="button" style={dangerButtonStyle} disabled={!!busy || !!activeJob}
                        onClick={() => void discard()}>废弃候选</button>
                    )}
                  </div>

                  <div style={sectionHeaderStyle}>
                    <div>
                      <strong>选择本次发布制品</strong>
                      <span style={{ marginLeft: 8, color: 'var(--theme-text-muted)', fontWeight: 400 }}>
                        已选 {artifactIds.length}/{candidate.artifacts.length}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" style={linkButtonStyle} onClick={() => {
                        setArtifactIds(candidate.artifacts.map((item) => item.id)); invalidatePlan();
                      }}>全选</button>
                      <button type="button" style={linkButtonStyle} onClick={() => {
                        setArtifactIds([]); invalidatePlan();
                      }}>清空</button>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {candidate.artifacts.map((artifact) => (
                      <ArtifactRow
                        key={artifact.id}
                        artifact={artifact}
                        selected={artifactIds.includes(artifact.id)}
                        disabled={candidate.status !== 'candidate' || !!activeJob}
                        busy={busy === `artifact:${artifact.id}`}
                        comparison={comparisonByArtifact.get(artifact.id)}
                        onToggle={(checked) => {
                          setArtifactIds((current) => checked
                            ? [...new Set([...current, artifact.id])]
                            : current.filter((id) => id !== artifact.id));
                          invalidatePlan();
                        }}
                        onSave={(patch) => updateArtifact(artifact, patch)}
                      />
                    ))}
                  </div>

                  <label style={{ ...fieldStyle, marginTop: 14 }}>
                    <span>更新说明</span>
                    <textarea value={notes} onChange={(event) => { setNotes(event.target.value); invalidatePlan(); }}
                      placeholder="这次稳定版本包含什么、需要注意什么……" style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }} />
                  </label>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                    <button type="button" style={primaryButtonStyle}
                      disabled={!!busy || !!activeJob || candidate.status !== 'candidate' || !artifactIds.length}
                      onClick={() => void preview()}>
                      {busy === 'preview' ? '正在校验文件…' : '预检并冻结发布计划'}
                    </button>
                    <span style={{ color: 'var(--theme-text-muted)', fontSize: 10 }}>
                      预检只读取 stable manifest、计算哈希，不上传任何内容
                    </span>
                  </div>

                  {plan && (
                    <div style={planCardStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <div>
                          <strong style={{ color: 'var(--theme-text)', fontSize: 12 }}>
                            冻结计划 {plan.fingerprint.slice(0, 12)}
                          </strong>
                          <div style={{ marginTop: 3, color: 'var(--theme-text-muted)', fontSize: 9 }}>
                            {plan.channel} · {plan.uploadJobs.length} 个制品 · {plan.signatureConfigured ? '将签名' : '无签名'}
                          </div>
                        </div>
                        <span style={{ ...tagStyle, color: plan.blockers.length ? '#f85149' : '#3fb950' }}>
                          {plan.blockers.length ? `${plan.blockers.length} 个阻断项` : '可以正式发布'}
                        </span>
                      </div>

                      {plan.comparison.available ? (
                        <div style={compareGridStyle}>
                          <div><span>当前 stable</span><strong>{plan.comparison.release.version || '未知'}</strong></div>
                          <div><span>候选版本</span><strong>{candidate.version}</strong></div>
                          <div><span>Commit</span><strong>{plan.comparison.commitChanged ? '有变化' : '未变化'}</strong></div>
                        </div>
                      ) : (
                        <div style={inlineHintStyle}>没有取得当前 stable manifest；请核对配置和网络。</div>
                      )}

                      {!!plan.blockers.length && <IssueList title="阻断项" items={plan.blockers} color="#f85149" />}
                      {!!plan.warnings.length && <IssueList title="提醒" items={plan.warnings} color="#d29922" />}

                      <details style={{ marginTop: 10 }}>
                        <summary style={summaryStyle}>查看最终 manifest 与对象路径</summary>
                        <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
                          {plan.uploadJobs.map((item) => (
                            <code key={item.key} style={codeLineStyle}>{item.key} · {formatBytes(item.size)}</code>
                          ))}
                          <code style={codeLineStyle}>{plan.versionedManifestKey} · 版本快照</code>
                          <code style={{ ...codeLineStyle, color: '#d29922' }}>{plan.manifestKey} · 最后切换</code>
                        </div>
                        <pre style={manifestStyle}>{JSON.stringify(plan.manifest, null, 2)}</pre>
                      </details>

                      {!plan.blockers.length && candidate.status === 'candidate' && (
                        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--theme-border)' }}>
                          <label style={ackStyle}>
                            <input type="checkbox" checked={acknowledged}
                              onChange={(event) => setAcknowledged(event.target.checked)} />
                            我已核对版本、制品、channel 和最终 manifest；确认这是要对节点公开的版本
                          </label>
                          <button type="button" style={{ ...publishButtonStyle, opacity: acknowledged ? 1 : 0.5 }}
                            disabled={!acknowledged || !!busy || !!activeJob} onClick={() => void publish()}>
                            {busy === 'publish' ? '启动后台任务…' : `正式发布到 ${plan.channel}`}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>}
              </section>
            </div>
          )}

          {state && view === 'config' && (
            <section style={{ ...detailCardStyle, maxWidth: 860, margin: '0 auto' }}>
              <div style={detailHeaderStyle}>
                <div>
                  <strong style={{ color: 'var(--theme-text)', fontSize: 14 }}>当前执行节点的发布配置</strong>
                  <div style={{ marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 10 }}>
                    发布参数保存在当前节点；七牛密钥只交给该节点的 qshell，签名密钥只从环境变量读取。
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ ...tagStyle, color: state.config.qshellAvailable ? '#3fb950' : '#f85149' }}>
                    qshell {state.config.qshellAvailable ? '可用' : '未找到'}
                  </span>
                  <span style={{ ...tagStyle, color: state.config.qiniuAccountConfigured ? '#3fb950' : '#f85149' }}>
                    七牛账号 {state.config.qiniuAccountConfigured ? '已配置' : '未配置'}
                  </span>
                  <span style={{ ...tagStyle, color: state.config.signingKeyConfigured ? '#3fb950' : '#d29922' }}>
                    签名 {state.config.signingKeyConfigured ? '已配置' : '未配置'}
                  </span>
                </div>
              </div>

              <div style={{
                marginBottom: 14, padding: 12, border: '1px solid var(--theme-border)', borderRadius: 6,
                background: 'var(--theme-input-bg)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div>
                    <strong style={{ color: 'var(--theme-text)', fontSize: 11 }}>七牛上传账号（当前执行节点）</strong>
                    <div style={{ marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 9, lineHeight: 1.5 }}>
                      {state.config.qiniuAccountMessage || '尚未检查账号状态'}。每个发布节点需要分别配置一次；输入值不会写入发布配置、候选或任务日志。
                    </div>
                  </div>
                  <button type="button" style={linkButtonStyle} onClick={() => setShowQiniuCredentials((value) => !value)}>
                    {showQiniuCredentials ? '隐藏输入' : '显示输入'}
                  </button>
                </div>
                <div style={{ ...formGridStyle, marginTop: 10 }}>
                  <label style={fieldStyle}>
                    <span>账号别名</span>
                    <input value={qiniuAccountName} onChange={(event) => setQiniuAccountName(event.target.value)}
                      autoComplete="off" placeholder="agentwithu-release" style={inputStyle} />
                  </label>
                  <label style={fieldStyle}>
                    <span>ACCESS_KEY</span>
                    <input type={showQiniuCredentials ? 'text' : 'password'} value={qiniuAccessKey}
                      onChange={(event) => setQiniuAccessKey(event.target.value)} autoComplete="new-password"
                      spellCheck={false} placeholder="七牛 AccessKey" style={inputStyle} />
                  </label>
                  <label style={fieldStyle}>
                    <span>SECRET_KEY</span>
                    <input type={showQiniuCredentials ? 'text' : 'password'} value={qiniuSecretKey}
                      onChange={(event) => setQiniuSecretKey(event.target.value)} autoComplete="new-password"
                      spellCheck={false} placeholder="七牛 SecretKey" style={inputStyle} />
                  </label>
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" style={primaryButtonStyle}
                    disabled={!!busy || !!activeJob || !qiniuAccessKey.trim() || !qiniuSecretKey.trim()}
                    onClick={() => void configureQiniuAccount()}>
                    {busy === 'qiniu-account' ? '正在交给 qshell…' : state.config.qiniuAccountConfigured ? '更新七牛账号' : '保存七牛账号'}
                  </button>
                  <span style={{ color: 'var(--theme-text-muted)', fontSize: 9 }}>
                    保存成功后输入框会立即清空；AgentWithU 不会回显已有密钥。
                  </span>
                </div>
              </div>

              <div style={formGridStyle}>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span>项目根目录</span>
                  <input value={draft.projectRoot} onChange={(event) => { setDraft({ ...draft, projectRoot: event.target.value }); invalidatePlan(); }}
                    placeholder="C:\\path\\to\\agent-with-u" style={inputStyle} />
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span>制品扫描目录（每行一个，相对项目根目录）</span>
                  <textarea value={draft.scanRoots} onChange={(event) => { setDraft({ ...draft, scanRoots: event.target.value }); invalidatePlan(); }}
                    style={{ ...inputStyle, minHeight: 58, resize: 'vertical', fontFamily: 'monospace' }} />
                </label>
                <label style={fieldStyle}>
                  <span>Channel</span>
                  <input value={draft.channel} onChange={(event) => { setDraft({ ...draft, channel: event.target.value }); invalidatePlan(); }}
                    placeholder="stable" style={inputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span>七牛 Bucket</span>
                  <input value={draft.qiniuBucket} onChange={(event) => { setDraft({ ...draft, qiniuBucket: event.target.value }); invalidatePlan(); }}
                    placeholder="your-bucket" style={inputStyle} />
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span>CDN / 公网 Base URL</span>
                  <input value={draft.baseUrl} onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }); invalidatePlan(); }}
                    placeholder="https://cdn.example.com" style={inputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span>对象前缀</span>
                  <input value={draft.prefix} onChange={(event) => { setDraft({ ...draft, prefix: event.target.value }); invalidatePlan(); }}
                    placeholder="agentwithu/releases" style={inputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span>Channel manifest key</span>
                  <input value={draft.manifestKey} onChange={(event) => { setDraft({ ...draft, manifestKey: event.target.value }); invalidatePlan(); }}
                    placeholder="agentwithu/releases/stable/manifest.json" style={inputStyle} />
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span>当前稳定版 manifest URL（可选）</span>
                  <input value={draft.stableManifestUrl} onChange={(event) => { setDraft({ ...draft, stableManifestUrl: event.target.value }); invalidatePlan(); }}
                    placeholder="留空时由 Base URL + manifest key 推导" style={inputStyle} />
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span>qshell 命令或绝对路径</span>
                  <input value={draft.qshell} onChange={(event) => { setDraft({ ...draft, qshell: event.target.value }); invalidatePlan(); }}
                    placeholder="qshell" style={inputStyle} />
                </label>
              </div>

              <label style={{ ...ackStyle, marginTop: 14 }}>
                <input type="checkbox" checked={draft.requireSignature}
                  onChange={(event) => { setDraft({ ...draft, requireSignature: event.target.checked }); invalidatePlan(); }} />
                没有 AGENT_WITH_U_UPDATE_SIGNING_KEY 时阻止正式发布
              </label>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" style={primaryButtonStyle} disabled={!!busy || !!activeJob}
                  onClick={() => void saveConfig(false)}>{busy === 'config' ? '保存中…' : '保存发布配置'}</button>
                <button type="button" style={buttonStyle} disabled={!!busy || !!activeJob}
                  onClick={() => void scan()}>{busy === 'scan' ? '扫描中…' : '保存并扫描候选'}</button>
              </div>
              <div style={{ ...inlineHintStyle, marginTop: 14 }}>
                发布数据目录：<code>{state.config.dataRoot || '—'}</code>
              </div>
            </section>
          )}

          {state && view === 'history' && (
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: narrow ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <section style={detailCardStyle}>
                <div style={sectionHeaderStyle}><strong>发布任务</strong><span>{state.jobs.length}</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {state.jobs.map((job) => (
                    <details key={job.id} style={historyRowStyle} open={job.id === activeJob?.id}>
                      <summary style={summaryStyle}>
                        <span style={{ color: job.status === 'succeeded' ? '#3fb950' : job.status === 'failed' ? '#f85149' : '#d29922' }}>
                          {job.status}
                        </span>
                        <strong>{job.buildId || job.candidateId}</strong>
                        <span>{job.progress || 0}% · {formatDate(job.createdAt)}</span>
                      </summary>
                      <div style={{ marginTop: 8, color: 'var(--theme-text-muted)', fontSize: 10, lineHeight: 1.55 }}>
                        {job.message}{job.error ? `：${job.error}` : ''}
                      </div>
                      {!!job.log?.length && <pre style={{ ...manifestStyle, maxHeight: 180 }}>{job.log.join('\n')}</pre>}
                    </details>
                  ))}
                  {!state.jobs.length && <div style={emptyStyle}>还没有正式发布任务。</div>}
                </div>
              </section>

              <section style={detailCardStyle}>
                <div style={sectionHeaderStyle}><strong>成功发布历史</strong><span>{state.history.length}</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {state.history.map((item) => (
                    <div key={item.id} style={historyRowStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <strong style={{ color: 'var(--theme-text)', fontSize: 11 }}>{item.version}</strong>
                        <span style={{ ...tagStyle, color: '#3fb950' }}>{item.channel}</span>
                      </div>
                      <div style={monoLineStyle}>{item.buildId}</div>
                      <div style={{ color: 'var(--theme-text-muted)', fontSize: 9 }}>
                        {item.artifactCount} 个制品 · {formatDate(item.publishedAt)}
                      </div>
                      {item.manifestUrl && <a href={item.manifestUrl} target="_blank" rel="noreferrer"
                        style={{ marginTop: 4, fontSize: 9, color: 'var(--theme-accent)', wordBreak: 'break-all' }}>
                        {item.manifestUrl}
                      </a>}
                    </div>
                  ))}
                  {!state.history.length && <div style={emptyStyle}>还没有成功发布记录。</div>}
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

const ArtifactRow: React.FC<{
  artifact: ReleaseArtifact;
  selected: boolean;
  disabled: boolean;
  busy: boolean;
  comparison?: { previousSize: number; sizeDelta: number | null; hashChanged: boolean; isNew: boolean };
  onToggle: (checked: boolean) => void;
  onSave: (patch: Partial<ReleaseArtifact>) => Promise<void>;
}> = ({ artifact, selected, disabled, busy, comparison, onToggle, onSave }) => {
  const [platform, setPlatform] = useState(artifact.platform);
  const [arch, setArch] = useState(artifact.arch);
  const [target, setTarget] = useState(artifact.target);
  const [kind, setKind] = useState(artifact.kind);
  const [key, setKey] = useState(artifact.key || '');
  const [install, setInstall] = useState(() => artifact.install ? JSON.stringify(artifact.install, null, 2) : '');
  const [error, setError] = useState('');

  useEffect(() => {
    setPlatform(artifact.platform); setArch(artifact.arch); setTarget(artifact.target);
    setKind(artifact.kind); setKey(artifact.key || '');
    setInstall(artifact.install ? JSON.stringify(artifact.install, null, 2) : '');
  }, [artifact]);

  const save = async () => {
    setError('');
    let parsed: Record<string, unknown> | undefined;
    if (install.trim()) {
      try {
        parsed = JSON.parse(install);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('必须是 JSON 对象');
      } catch (caught) {
        setError(`install JSON 无效：${caught instanceof Error ? caught.message : String(caught)}`);
        return;
      }
    }
    await onSave({ platform, arch, target, kind, key, install: (parsed ?? null) as any });
  };

  return (
    <div style={{
      ...artifactRowStyle,
      borderColor: selected ? 'color-mix(in srgb, var(--theme-accent) 55%, var(--theme-border))' : 'var(--theme-border)',
      opacity: disabled && !selected ? 0.64 : 1,
    }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => onToggle(event.target.checked)}
          style={{ marginTop: 3, accentColor: 'var(--theme-accent)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ color: 'var(--theme-text)', fontSize: 11, wordBreak: 'break-all' }}>{artifact.fileName}</strong>
            <span style={{ color: artifact.fresh ? '#3fb950' : '#d29922', fontSize: 9 }}>
              {artifact.fresh ? '本次构建' : '可能是旧包'}
            </span>
          </div>
          <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', color: 'var(--theme-text-muted)', fontSize: 9 }}>
            <span>{artifact.platform}/{artifact.arch}</span><span>{artifact.target}/{artifact.kind}</span>
            <span>{formatBytes(artifact.size)}</span><span>{artifact.sha256.slice(0, 10)}</span>
            {comparison && <span style={{ color: comparison.isNew ? '#58a6ff' : comparison.hashChanged ? '#d29922' : '#3fb950' }}>
              {formatDelta(comparison.sizeDelta)} · {comparison.isNew ? '新增' : comparison.hashChanged ? '内容有变化' : '哈希相同'}
            </span>}
          </div>
          <details style={{ marginTop: 6 }}>
            <summary style={{ ...summaryStyle, fontSize: 9 }}>安装与对象存储元数据</summary>
            <div style={{ marginTop: 7, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))', gap: 6 }}>
              <select value={platform} onChange={(event) => setPlatform(event.target.value)} style={miniInputStyle} disabled={disabled}>
                {['windows', 'linux', 'macos', 'any'].map((value) => <option key={value}>{value}</option>)}
              </select>
              <select value={arch} onChange={(event) => setArch(event.target.value)} style={miniInputStyle} disabled={disabled}>
                {['x86_64', 'aarch64', 'any'].map((value) => <option key={value}>{value}</option>)}
              </select>
              <select value={target} onChange={(event) => setTarget(event.target.value)} style={miniInputStyle} disabled={disabled}>
                {['desktop', 'executor', 'docker'].map((value) => <option key={value}>{value}</option>)}
              </select>
              <input value={kind} onChange={(event) => setKind(event.target.value)} style={miniInputStyle}
                disabled={disabled} placeholder="kind: msi/nsis/custom" />
            </div>
            <input value={key} onChange={(event) => setKey(event.target.value)} style={{ ...miniInputStyle, width: '100%', marginTop: 6, boxSizing: 'border-box' }}
              disabled={disabled} placeholder="对象 key（留空自动生成）" />
            <textarea value={install} onChange={(event) => setInstall(event.target.value)}
              disabled={disabled} placeholder={'非 Windows 自定义包必须填写，例如：\n{"program":"/opt/agentwithu/install-release","args":["{artifact}"]}'}
              style={{ ...miniInputStyle, width: '100%', minHeight: 66, marginTop: 6, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'monospace' }} />
            {error && <div style={{ marginTop: 5, color: '#f85149', fontSize: 9 }}>{error}</div>}
            {!disabled && <button type="button" style={{ ...buttonStyle, marginTop: 6 }} disabled={busy}
              onClick={() => void save()}>{busy ? '保存中…' : '保存制品元数据'}</button>}
          </details>
        </div>
      </div>
    </div>
  );
};

const IssueList: React.FC<{ title: string; items: string[]; color: string }> = ({ title, items, color }) => (
  <div style={{ marginTop: 10 }}>
    <strong style={{ color, fontSize: 10 }}>{title}</strong>
    <ul style={{ margin: '5px 0 0', paddingLeft: 18, color: 'var(--theme-text-muted)', fontSize: 10, lineHeight: 1.5 }}>
      {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
    </ul>
  </div>
);

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1400, padding: 10, boxSizing: 'border-box',
  display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,6,12,.76)',
};
const panelStyle: React.CSSProperties = {
  width: 'min(1220px, calc(100vw - 20px))', height: 'min(860px, calc(100dvh - 20px))',
  minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8,
  boxShadow: '0 24px 80px rgba(0,0,0,.45)',
};
const headerStyle: React.CSSProperties = {
  minHeight: 64, padding: '10px 14px', boxSizing: 'border-box', flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
};
const headerSelectStyle: React.CSSProperties = {
  ...({} as React.CSSProperties), minWidth: 140, maxWidth: 230, height: 30, padding: '0 8px',
  border: '1px solid var(--theme-border)', borderRadius: 4,
  background: 'var(--theme-input-bg)', color: 'var(--theme-text)', fontSize: 10,
};
const closeButtonStyle: React.CSSProperties = {
  width: 30, height: 30, border: 'none', background: 'transparent', color: 'var(--theme-text-muted)',
  fontSize: 16, cursor: 'pointer',
};
const tabBarStyle: React.CSSProperties = {
  minHeight: 38, flexShrink: 0, display: 'flex', alignItems: 'stretch', padding: '0 12px',
  borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', overflowX: 'auto',
};
const tabStyle: React.CSSProperties = {
  padding: '0 14px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent',
  fontFamily: 'inherit', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
};
const contentStyle: React.CSSProperties = {
  flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, boxSizing: 'border-box',
  overscrollBehavior: 'contain',
};
const noticeStyle: React.CSSProperties = {
  margin: '8px 12px 0', padding: '8px 10px', border: '1px solid var(--theme-border)', borderRadius: 4,
  background: 'var(--theme-input-bg)', color: 'var(--theme-text-muted)', fontSize: 10, lineHeight: 1.45,
};
const jobBannerStyle: React.CSSProperties = {
  margin: '8px 12px 0', padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  border: '1px solid rgba(210,153,34,.38)', borderRadius: 5, background: 'rgba(210,153,34,.08)',
};
const progressTrackStyle: React.CSSProperties = {
  height: 4, marginTop: 6, overflow: 'hidden', borderRadius: 4, background: 'var(--theme-bg-tertiary)',
};
const progressFillStyle: React.CSSProperties = { height: '100%', background: '#d29922', transition: 'width .25s ease' };
const candidateRailStyle: React.CSSProperties = {
  minWidth: 0, padding: 9, border: '1px solid var(--theme-border)', borderRadius: 6,
  background: 'var(--theme-bg-secondary)',
};
const railHeaderStyle: React.CSSProperties = {
  marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
};
const candidateButtonStyle: React.CSSProperties = {
  width: '100%', padding: 9, border: '1px solid var(--theme-border)', borderRadius: 4,
  display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
};
const detailCardStyle: React.CSSProperties = {
  minWidth: 0, padding: 13, border: '1px solid var(--theme-border)', borderRadius: 6,
  background: 'var(--theme-bg-secondary)', boxSizing: 'border-box',
};
const detailHeaderStyle: React.CSSProperties = {
  paddingBottom: 11, marginBottom: 11, borderBottom: '1px solid var(--theme-border)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
};
const sectionHeaderStyle: React.CSSProperties = {
  margin: '10px 0 7px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  color: 'var(--theme-text)', fontSize: 11,
};
const artifactRowStyle: React.CSSProperties = {
  padding: 9, border: '1px solid var(--theme-border)', borderRadius: 4, background: 'var(--theme-input-bg)',
};
const planCardStyle: React.CSSProperties = {
  marginTop: 12, padding: 12, border: '1px solid color-mix(in srgb, var(--theme-accent) 38%, var(--theme-border))',
  borderRadius: 5, background: 'color-mix(in srgb, var(--theme-accent-bg) 35%, var(--theme-input-bg))',
};
const compareGridStyle: React.CSSProperties = {
  marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6,
};
const formGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10,
};
const fieldStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--theme-text-muted)', fontSize: 10,
};
const inputStyle: React.CSSProperties = {
  width: '100%', minWidth: 0, padding: '7px 8px', boxSizing: 'border-box', border: '1px solid var(--theme-border)',
  borderRadius: 4, outline: 'none', background: 'var(--theme-input-bg)', color: 'var(--theme-text)',
  fontFamily: 'inherit', fontSize: 11,
};
const miniInputStyle: React.CSSProperties = {
  minWidth: 0, padding: '5px 6px', border: '1px solid var(--theme-border)', borderRadius: 3,
  background: 'var(--theme-bg)', color: 'var(--theme-text)', fontFamily: 'inherit', fontSize: 9,
};
const buttonStyle: React.CSSProperties = {
  minHeight: 28, padding: '5px 9px', border: '1px solid var(--theme-border)', borderRadius: 4,
  background: 'var(--theme-input-bg)', color: 'var(--theme-text)', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer',
};
const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle, background: 'var(--theme-accent)', borderColor: 'var(--theme-accent)', color: '#fff', fontWeight: 650,
};
const primarySmallStyle: React.CSSProperties = { ...primaryButtonStyle, minHeight: 26, padding: '4px 7px', fontSize: 9 };
const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle, color: '#f85149', borderColor: 'rgba(248,81,73,.34)', background: 'rgba(248,81,73,.07)',
};
const publishButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle, width: '100%', marginTop: 9, minHeight: 34, background: '#16865a', borderColor: '#16865a',
};
const linkButtonStyle: React.CSSProperties = {
  padding: 0, border: 'none', background: 'none', color: 'var(--theme-accent)', fontSize: 9, cursor: 'pointer',
};
const tagStyle: React.CSSProperties = {
  padding: '2px 5px', border: '1px solid var(--theme-border)', borderRadius: 3,
  color: 'var(--theme-text-muted)', background: 'var(--theme-input-bg)', fontSize: 9, whiteSpace: 'nowrap',
};
const monoLineStyle: React.CSSProperties = {
  display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: 'var(--theme-text-muted)', fontFamily: 'monospace', fontSize: 9,
};
const emptyStyle: React.CSSProperties = {
  padding: 30, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.55,
};
const inlineHintStyle: React.CSSProperties = {
  marginTop: 9, padding: '7px 8px', border: '1px solid var(--theme-border)', borderRadius: 4,
  color: 'var(--theme-text-muted)', background: 'var(--theme-input-bg)', fontSize: 9, lineHeight: 1.45,
};
const ackStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 7, color: 'var(--theme-text-muted)', fontSize: 10, lineHeight: 1.45,
};
const summaryStyle: React.CSSProperties = {
  color: 'var(--theme-accent)', fontSize: 10, cursor: 'pointer', userSelect: 'none',
};
const codeLineStyle: React.CSSProperties = {
  display: 'block', padding: '5px 6px', borderRadius: 3, background: 'var(--theme-bg)',
  color: 'var(--theme-text-muted)', fontSize: 9, wordBreak: 'break-all',
};
const manifestStyle: React.CSSProperties = {
  margin: '8px 0 0', padding: 9, maxHeight: 260, overflow: 'auto', border: '1px solid var(--theme-border)',
  borderRadius: 4, background: 'var(--theme-bg)', color: 'var(--theme-text-muted)', fontSize: 9, lineHeight: 1.45,
};
const historyRowStyle: React.CSSProperties = {
  padding: 9, border: '1px solid var(--theme-border)', borderRadius: 4,
  background: 'var(--theme-input-bg)', color: 'var(--theme-text-muted)', fontSize: 10,
};

export default ReleaseCenter;
