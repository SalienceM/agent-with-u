import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  api,
  SkillMarketCatalog,
  SkillMarketItem,
  SkillMarketLocation,
  getHomeExecKey,
  getExecutors,
  isTauri,
  onExecStatus,
  onCurrentUserChanged,
} from '../api';
import { SkillMarketExplanation } from './SkillMarketExplanation';
import { SkillMarketBatchDialog } from './SkillMarketBatchDialog';
import { filterMarketItems, marketVersion, type SkillMarketSort } from '../utils/skillMarketView';
import { skillInstallTargetLabel } from '../utils/skillInstallTarget';

if (typeof document !== 'undefined' && !document.getElementById('skill-market-css')) {
  const style = document.createElement('style');
  style.id = 'skill-market-css';
  style.textContent = `
    .skill-market-layout { display:grid; grid-template-columns:minmax(260px,.65fr) minmax(380px,1.35fr); gap:10px; min-height:0; flex:1; }
    .skill-market-item:hover { border-color:var(--theme-accent,#7aa2f7)!important; }
    .skill-market-source:hover .skill-market-source-remove { opacity:1!important; }
    .skill-market-source-inputs input { min-width:0; }
    .skill-market-detail { overflow-wrap:anywhere; }
    .skill-market-install-target { height:56px; flex:none; box-sizing:border-box; overflow:auto; }
    .skill-market-install-target[data-expanded="true"] { height:94px; }
    .skill-market-install-target-line { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:18px; min-width:0; }
    .skill-market-source-snapshot { height:84px; flex:none; display:flex; flex-direction:column; gap:7px; overflow:auto; scrollbar-gutter:stable; }
    .skill-market-source-snapshot > * { flex-shrink:0; }
    .skill-market-sync-slot { height:20px; flex:none; overflow:auto; scrollbar-gutter:stable; font-size:11px; line-height:18px; color:var(--theme-text-muted); }
    .skill-market-directories { height:16px; overflow:auto; align-content:flex-start; }
    .skill-market-list, .skill-market-detail { scrollbar-gutter:stable; }
    .skill-market-detail-switch { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin:8px 0; }
    .skill-market-workbench { container-type:inline-size; container-name:skill-market; }
    @container skill-market (max-width:740px) {
      .skill-market-dialog { overflow-y:auto; }
      .skill-market-layout { display:flex; flex-direction:column; flex:none; overflow:visible; }
      .skill-market-list { height:240px; max-height:240px!important; flex:none!important; }
      .skill-market-detail { height:max(540px,75dvh); min-height:0; flex:none; overflow:auto!important; }
      .skill-market-directories { height:34px; }
      .skill-market-audit { max-height:420px; flex:none!important; }
      .skill-market-sources { flex-shrink:0; }
      .skill-market-header { flex-wrap:wrap; }
      .skill-market-source-inputs { grid-template-columns:minmax(0,1fr) auto!important; }
      .skill-market-source-inputs input:first-child { grid-column:1/-1; }
      .skill-market-source-inputs button { grid-column:1/-1; }
      .skill-market-detail-switch button, .skill-market-detail-switch select { min-height:44px; }
      .skill-market-file-pages button { min-height:44px; }
      .skill-market-explanation { min-height:180px; }
    }
    @container skill-market (max-width:480px) {
      .skill-market-audit { grid-template-columns:minmax(0,1fr)!important; }
      .skill-market-footer { flex-wrap:wrap; }
      .skill-market-footer button { width:100%; min-height:44px; }
    }
    @media (max-width: 760px) {
      .skill-market-dialog { inset:8px!important; width:auto!important; max-height:none!important; }
      .skill-market-layout { grid-template-columns:1fr; overflow:auto; }
      .skill-market-list { height:240px; max-height:240px!important; flex:none!important; }
      .skill-market-detail { height:max(540px,75dvh); min-height:0; overflow:auto!important; }
      .skill-market-directories { height:34px; }
    }
  `;
  document.head.appendChild(style);
}

interface Props {
  embedded?: boolean;
  open: boolean;
  onClose: () => void;
  onInstalled: (name?: string, execKey?: string) => Promise<void> | void;
  onPrepare?: (names: string[], execKey: string) => void;
}

const EMPTY_CATALOG: SkillMarketCatalog = {
  status: 'ok',
  sources: [],
  directories: [],
  items: [],
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function riskLabel(item: SkillMarketItem): { text: string; color: string; background: string } {
  if (item.risk?.level === 'high') {
    return { text: '高风险提示', color: '#ef6b73', background: 'rgba(239,107,115,.12)' };
  }
  if (item.risk?.level === 'medium') {
    return { text: '需检查', color: '#d6a84b', background: 'rgba(214,168,75,.12)' };
  }
  return { text: '基础检查通过', color: '#4fb477', background: 'rgba(79,180,119,.12)' };
}

export const SkillMarketDialog: React.FC<Props> = ({ open, onClose, onInstalled, onPrepare, embedded }) => {
  const [catalog, setCatalog] = useState<SkillMarketCatalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [loadingText, setLoadingText] = useState('');
  const [installProgress, setInstallProgress] = useState('');
  const installOperation = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SkillMarketSort>('updates');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [targetExpanded, setTargetExpanded] = useState(false);
  const [batchSnapshot, setBatchSnapshot] = useState<{ items: SkillMarketItem[]; sourceName: string; execKey: string; targetName: string; libraryPath: string } | null>(null);
  const [batchVisible, setBatchVisible] = useState(false);
  const [lastInstalled, setLastInstalled] = useState<{ name: string; execKey: string } | null>(null);
  const closeBatch = useCallback(() => setBatchVisible(false), []);
  const loadGeneration = useRef(0);
  const marketScope = useRef(0);
  const [selectedId, setSelectedId] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceBranch, setSourceBranch] = useState('');
  const [explanationItemKey, setExplanationItemKey] = useState('');
  const [explanationBackends, setExplanationBackends] = useState<any[]>([]);
  const [backendsLoading, setBackendsLoading] = useState(true);
  const [explanationBackendId, setExplanationBackendId] = useState('');
  const [execKey, setExecKey] = useState(getHomeExecKey);
  const [executors, setExecutors] = useState(getExecutors);
  const [locationSnapshot, setLocationSnapshot] = useState<{ key: string; value: SkillMarketLocation } | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [locationError, setLocationError] = useState('');
  const [locationRevision, setLocationRevision] = useState(0);
  const [identityRevision, setIdentityRevision] = useState(0);
  const [addingSource, setAddingSource] = useState(false);
  const [installingId, setInstallingId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [filePage, setFilePage] = useState(0);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const executor = executors.find(item => item.key === execKey);
  const targetConnected = executor?.connected === true;
  const location = locationSnapshot?.key === execKey ? locationSnapshot.value : null;
  const targetLabel = skillInstallTargetLabel(execKey, executor, isTauri());
  const targetName = `${targetLabel}${location ? ` · ${location.host}` : ''}`;
  const targetReady = targetConnected && !!location && !locationLoading && !locationError;

  useEffect(() => onExecStatus(() => setExecutors(getExecutors())), []);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLocationLoading(targetConnected); setLocationError(''); setReviewed(false);
    if (targetConnected) void api.skillMarketLocation(execKey).then(value => {
      if (!cancelled) setLocationSnapshot({ key: execKey, value });
    }).catch((error: unknown) => {
      if (!cancelled) setLocationError(error instanceof Error ? error.message : '安装位置读取失败');
    }).finally(() => { if (!cancelled) setLocationLoading(false); });
    return () => { cancelled = true; };
  }, [open, execKey, targetConnected, identityRevision, locationRevision]);

  const load = useCallback(async (force = false) => {
    const generation = ++loadGeneration.current;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoading(true);
    setLoadingText('后台加载仓库，首次下载大仓库可能需要一些时间…');
    setMessage(null);
    try {
      const result = await api.skillMarketList('', force, text => {
        if (generation === loadGeneration.current) setLoadingText(text);
      }, controller.signal, execKey);
      if (generation !== loadGeneration.current) return;
      if (result.status !== 'ok') {
        setMessage({ kind: 'error', text: result.message || '技能市场加载失败' });
        return; // 刷新失败保留已同步内容，不能用空错误载荷替换整页。
      }
      setCatalog(result);
      setCatalogLoaded(true);
      setSelectedId(current => {
        if (current && result.items.some(item => item.id === current)) return current;
        return result.items[0]?.id || '';
      });
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : '技能市场加载失败',
      });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [execKey]);

  useEffect(() => {
    if (open) void load(false);
    return () => { loadGeneration.current += 1; loadAbort.current?.abort(); };
  }, [open, load, identityRevision]);

  useEffect(() => onCurrentUserChanged(() => {
    marketScope.current += 1;
    loadGeneration.current += 1;
    setCatalog(EMPTY_CATALOG);
    setCatalogLoaded(false);
    setLoading(true);
    setBackendsLoading(true);
    setAddingSource(false);
    loadAbort.current?.abort();
    setInstallingId('');
    setInstallProgress('');
    setBatchSnapshot(null);
    setLastInstalled(null);
    installOperation.current += 1;
    setExplanationItemKey('');
    setExplanationBackends([]);
    setExplanationBackendId('');
    setReviewed(false);
    setLocationSnapshot(null);
    setLocationLoading(true);
    setLocationError('');
    setExecutors(getExecutors());
    setExecKey(getHomeExecKey());
    setIdentityRevision(value => value + 1);
  }), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const key = execKey;
    setBackendsLoading(true);
    void api.getBackends(key).then(backends => {
      if (cancelled) return;
      const eligible = backends.filter(item => item.enabled !== false && [
        'openai-compatible', 'anthropic-api', 'codex-office', 'qwen-code-cli', 'claude-agent-sdk', 'claude-code-official',
      ].includes(item.type));
      setExplanationBackends(eligible);
      setExplanationBackendId(current => eligible.some(item => item.id === current) ? current : eligible[0]?.id || '');
    }).catch(() => { if (!cancelled) setExplanationBackends([]); })
      .finally(() => { if (!cancelled) setBackendsLoading(false); });
    return () => { cancelled = true; };
  }, [open, identityRevision, execKey]);

  const filteredItems = useMemo(() => filterMarketItems(catalog.items, query, sourceFilter, sort), [catalog.items, query, sourceFilter, sort]);

  const selected = useMemo(
    () => filteredItems.find(item => item.id === selectedId) || filteredItems[0] || null,
    [filteredItems, selectedId],
  );
  const detailKey = selected ? `${selected.id}:${selected.digest}` : '';
  // 批量入口按来源全量选择，搜索仅影响浏览，不缩小安装范围。
  const batchSourceId = sourceFilter || selected?.sourceId || '';
  const batchSource = catalog.sources.find(source => source.id === batchSourceId);
  const batchItems = catalog.items.filter(item => item.sourceId === batchSourceId);
  const matchingFiles = useMemo(() => {
    const needle = fileQuery.trim().toLocaleLowerCase();
    return (selected?.fileNames || []).filter(name => !needle || name.toLocaleLowerCase().includes(needle));
  }, [selected?.fileNames, fileQuery]);
  const filePageCount = Math.max(1, Math.ceil(matchingFiles.length / 100));
  const currentFilePage = Math.min(filePage, filePageCount - 1);
  // 同一 render 内按条目身份选择视图，避免 effect 重置前短暂挂载另一个 AI 请求。
  const detailView = detailKey && explanationItemKey === detailKey ? 'explanation' : 'original';

  useEffect(() => {
    setReviewed(false);
    setMessage(null);
    setExplanationItemKey('');
    setFileQuery('');
    setFilePage(0);
  }, [selected?.id, selected?.digest]);

  const addSource = useCallback(async () => {
    if (!sourceInput.trim() || addingSource) return;
    const scope = marketScope.current;
    setAddingSource(true);
    setMessage(null);
    try {
      const result = await api.skillMarketAddSource(sourceInput.trim(), sourceName.trim(), sourceBranch.trim(), execKey);
      if (scope !== marketScope.current) return;
      if (result.status !== 'ok') {
        setMessage({ kind: 'error', text: result.message || '来源添加失败' });
        return;
      }
      setSourceInput('');
      setSourceName('');
      setSourceBranch('');
      await load(true);
    } catch (error) {
      if (scope === marketScope.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : '来源添加失败' });
    } finally {
      if (scope === marketScope.current) setAddingSource(false);
    }
  }, [sourceInput, sourceName, sourceBranch, addingSource, load, execKey]);

  const removeSource = useCallback(async (sourceId: string) => {
    const scope = marketScope.current;
    try {
      const result = await api.skillMarketRemoveSource(sourceId, execKey);
      if (scope !== marketScope.current) return;
      if (result.status !== 'ok') {
        setMessage({ kind: 'error', text: result.message || '来源删除失败' });
        return;
      }
      if (sourceFilter === sourceId) setSourceFilter('');
      await load(false);
    } catch (error) {
      if (scope === marketScope.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : '来源删除失败' });
    }
  }, [load, sourceFilter, execKey]);

  const installSelected = useCallback(async () => {
    if (!selected || !reviewed || installingId || !targetReady) return;
    const operation = ++installOperation.current;
    setInstallingId(selected.id);
    setInstallProgress('后台检查并导入所选 Skill…');
    const generation = loadGeneration.current;
    setMessage(null);
    try {
      const result = await api.skillMarketInstall(selected, selected.conflict, text => {
        if (generation === loadGeneration.current) setInstallProgress(text);
      }, execKey);
      if (generation !== loadGeneration.current) return;
      if (result.status !== 'ok') {
        setMessage({ kind: 'error', text: result.message || '安装失败' });
        return;
      }
      setLastInstalled({ name: result.skill?.name || result.skill?.id || selected.name, execKey });
      await onInstalled(result.skill?.name || result.skill?.id || selected.name, execKey);
      if (generation === loadGeneration.current) {
        await load(false);
        if (installOperation.current === operation) setMessage({ kind: 'ok', text: `${selected.name} 已导入 ${targetName}；需要时点击“查看运行准备”，不会自动安装依赖或启用。` });
      }
    } catch (error) {
      if (generation === loadGeneration.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : '安装失败' });
    } finally {
      if (installOperation.current === operation) {
        setInstallingId('');
        setInstallProgress('');
      }
    }
  }, [selected, reviewed, installingId, onInstalled, load, execKey, targetReady, targetName]);

  if (!open) return null;

  const installDisabled = !selected || !reviewed || !targetReady || Boolean(installingId)
    || Boolean(selected?.installed && selected?.sameSource && !selected?.updateAvailable);
  const installText = !selected ? '选择一个 Skill'
    : installingId === selected.id ? '安装中…'
      : selected.conflict ? '覆盖同名 Skill'
        : selected.updateAvailable ? (selected.localModified ? '覆盖本地修改并更新' : '更新 Skill')
          : selected.installed && selected.sameSource ? '已是当前版本'
            : '安装到 Skill 库';
  const failedSources = catalog.sources.filter(source => Boolean(source.error));
  const warningSources = catalog.sources.filter(source => (source.skippedCount || 0) > 0);
  const allSourcesFailed = catalog.sources.length > 0
    && failedSources.length === catalog.sources.length;
  const skippedTotal = catalog.sources.reduce(
    (total, source) => total + (source.skippedCount || 0), 0,
  );
  const emptyMessage = query.trim()
    ? '没有匹配的标准 Skill'
    : allSourcesFailed
      ? '所有来源都加载失败了，请查看上方错误详情并重试'
      : skippedTotal > 0 && catalog.items.length === 0
        ? `来源已读取，但没有可安装的兼容 Skill（已跳过 ${skippedTotal} 个不合规条目）`
        : '当前来源中没有可安装的标准 Skill';
  const initialSync = loading && !catalogLoaded;
  const syncText = installingId ? installProgress : loading ? `同步中 · ${loadingText}`
    : message?.text || (catalogLoaded ? '同步完成' : '尚未同步，请点击刷新源重试');

  return (
    <div className={embedded ? 'skill-market-workbench' : undefined} style={embedded ? { display: 'flex', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' } : overlayStyle}>
      <section className="skill-market-dialog" style={embedded ? { ...dialogStyle, width: '100%', height: '100%', maxHeight: 'none', minHeight: 0, minWidth: 0, boxSizing: 'border-box', borderRadius: 0, border: 0, boxShadow: 'none' } : dialogStyle} aria-label="Agent Skills 市场">
        <header className="skill-market-header" style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 19 }}>🛍️</span>
              <h2 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text)' }}>Agent Skills 市场</h2>
              <span style={standardBadgeStyle}>开放格式兼容</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ ...secondaryButtonStyle, width: 86 }} onClick={() => void load(true)} disabled={loading}>
              {loading ? '刷新中…' : '↻ 刷新源'}
            </button>
            {!embedded && <button style={closeButtonStyle} onClick={onClose} aria-label="关闭">×</button>}
          </div>
        </header>

        <section className="skill-market-install-target" aria-label="Skill 安装位置" aria-busy={locationLoading} data-expanded={targetExpanded}
          style={{ padding: '7px 10px', border: '1px solid var(--theme-border)', borderRadius: 7, background: 'var(--theme-bg)', fontSize: 11 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 22 }}>
            <strong className="skill-market-install-target-line" style={{ flex: 1 }} title={`${targetName} · 节点 ID：${execKey}`}>
              安装节点：{targetName}
            </strong>
            <span style={{ flexShrink: 0, color: targetConnected ? '#4fb477' : '#ef6b73' }}>{targetConnected ? '在线' : '离线'}</span>
            <button style={{ ...secondaryButtonStyle, padding: '1px 6px' }} aria-label="安装目录与说明" aria-expanded={targetExpanded}
              onClick={() => setTargetExpanded(value => !value)}>{targetExpanded ? '收起' : '详情'}</button>
            <button style={{ ...secondaryButtonStyle, padding: '1px 6px' }} disabled={locationLoading || !targetConnected || !!installingId}
              onClick={() => setLocationRevision(value => value + 1)} aria-label="刷新安装位置">↻</button>
          </div>
          <div className="skill-market-install-target-line" title={locationError || location?.libraryPath} style={{ color: locationError ? '#ef6b73' : undefined }}>
            {locationError || <>文件目录：<code>{location?.libraryPath || (locationLoading ? '同步中…' : '未确认')}</code></>}
          </div>
          <div hidden={!targetExpanded}>
          <div className="skill-market-install-target-line" title={location?.runtimePath}>
            依赖目录：<code>{location?.runtimePath || (locationLoading ? '同步中…' : '未确认')}</code>（需另行确认）
          </div>
          <div className="skill-market-install-target-line" style={{ color: locationError ? '#ef6b73' : 'var(--theme-text-muted)' }}
            title={locationError || '市场使用默认执行节点，不随当前 Session 切换。文件导入与 Agent 启用是两步；不会复制到其它节点。浏览器仅负责操作，文件不会写入浏览器存储或下载目录。'}>
            {locationError || (!targetConnected ? '节点离线，暂不能安装；不会改装到其它节点。'
              : `使用默认节点，不随 Session 切换；${isTauri() ? '仅导入该节点 Skill 库，不自动启用。' : '文件写入上述节点，不存入浏览器。'}`)}
          </div>
          </div>
        </section>

        <div className="skill-market-sync-slot" role={loading || installingId ? 'status' : message?.kind === 'error' ? 'alert' : undefined}
          aria-live="polite" aria-atomic="true" title={syncText}
          style={{ color: !loading && !installingId && message ? (message.kind === 'error' ? '#ef6b73' : '#4fb477') : undefined }}>
          {syncText}
        </div>

        <div className="skill-market-sources" style={sourceAreaStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 4, alignItems: 'center', height: 50 }}>
          <button type="button" onClick={() => setSourcesExpanded(value => !value)} aria-expanded={sourcesExpanded}
            style={{ ...secondaryButtonStyle, textAlign: 'left', alignSelf: 'flex-start', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {sourcesExpanded ? '▾' : '▸'} 来源与添加 · {initialSync ? '同步中…' : `${catalog.sources.length} 个仓库`}{failedSources.length ? ` · ${failedSources.length} 个失败` : ''}{skippedTotal ? ` · ${skippedTotal} 个条目跳过` : ''}
          </button>
          <button style={secondaryButtonStyle} disabled={!batchSnapshot && (loading || !targetReady || !!installingId || !batchItems.length || batchItems.length > 500)}
            title={batchItems.length > 500 ? '单批最多 500 项，请分批单独安装' : `安装 ${batchSource?.name || selected?.sourceName || '所选仓库'} 的全部已扫描 Skill，不受搜索过滤`}
            onClick={() => { if (!batchSnapshot) setBatchSnapshot({ items: batchItems, sourceName: `${batchSource?.name || selected?.sourceName} · ${batchItems[0].repository}@${batchItems[0].ref}`, execKey, targetName, libraryPath: location!.libraryPath }); setBatchVisible(true); }}>
            {batchSnapshot ? '查看安装批次' : `安装此仓库全部（${batchItems.length}）`}
          </button>
          <span style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--theme-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>目标仓库：{batchSource?.name || selected?.sourceName || '请先选择来源'}</span>
          </div>
          <div hidden={!sourcesExpanded} style={{ display: sourcesExpanded ? 'flex' : 'none', flexDirection: 'column', gap: 7 }}>
          <div className="skill-market-source-snapshot" aria-busy={loading}>
          {initialSync && <div style={{ padding: '4px 2px', fontSize: 11, color: 'var(--theme-text-muted)' }}>
            来源信息同步中…
            <MarketSkeletonLines />
          </div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {catalog.sources.map(source => (
              <span key={source.id} className="skill-market-source" style={{
                ...sourceChipStyle,
                borderColor: source.error
                  ? 'rgba(239,107,115,.45)'
                  : (source.skippedCount || 0) > 0
                    ? 'rgba(214,168,75,.45)'
                    : 'var(--theme-border)',
              }} title={source.error || source.homepage}>
                {source.official ? '✓ ' : ''}{source.name} <span>@{source.effectiveRef || source.ref || 'main'}</span>
                <small style={{ opacity: .65 }}>
                  {source.error
                    ? ' · 加载失败'
                    : ` · ${source.skillCount || 0}${(source.skippedCount || 0) > 0 ? `（跳过 ${source.skippedCount}）` : ''}`}
                </small>
                {source.removable && (
                  <button
                    className="skill-market-source-remove"
                    onClick={() => void removeSource(source.id)}
                    title="移除来源"
                    style={sourceRemoveStyle}
                  >×</button>
                )}
              </span>
            ))}
          </div>
          {(failedSources.length > 0 || warningSources.length > 0) && (
            <div style={sourceProblemStyle} role="alert">
              <div style={{ minWidth: 0, flex: 1 }}>
                {failedSources.map(source => (
                  <div key={`${source.id}:error`} style={{ color: '#ef6b73' }}>
                    <strong>{source.name}：</strong>{source.error}
                  </div>
                ))}
                {warningSources.map(source => (
                  <div key={`${source.id}:warning`} style={{ color: '#d6a84b' }}>
                    <strong>{source.name}：</strong>
                    已跳过 {source.skippedCount} 个不符合规范的条目，有效 Skill 仍可正常安装。
                    {(source.issues || []).slice(0, 3).map((issue, index) => (
                      <div key={`${issue.path}:${index}`} style={{ paddingLeft: 10, opacity: .9 }}>
                        • {issue.path || '仓库根目录'}：{issue.message}
                      </div>
                    ))}
                    {(source.issues || []).length > 3 && (
                      <div style={{ paddingLeft: 10, opacity: .75 }}>
                        另有 {(source.issues || []).length - 3} 个条目未展开
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <button style={secondaryButtonStyle} onClick={() => void load(true)} disabled={loading}>
                {loading ? '重试中…' : '重试'}
              </button>
            </div>
          )}
          </div>
          <div className="skill-market-source-inputs" style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,1fr) minmax(110px,.35fr) minmax(110px,.35fr) auto', gap: 6 }}>
            <input
              value={sourceInput}
              onChange={event => setSourceInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void addSource(); }}
              placeholder="添加 GitHub 仓库：owner/repo 或 https://github.com/…"
              aria-label="GitHub 仓库地址"
              style={inputStyle}
            />
            <input value={sourceBranch} onChange={event => setSourceBranch(event.target.value)}
              aria-label="来源分支" placeholder="分支（如 main / master）" list="skill-market-branches"
              title="填写后严格使用此分支；留空沿用地址中的分支，普通仓库地址依次尝试 main、master。含 / 的分支请在此填写。"
              onKeyDown={event => { if (event.key === 'Enter') void addSource(); }} style={inputStyle} />
            <datalist id="skill-market-branches"><option value="main" /><option value="master" /></datalist>
            <input
              value={sourceName}
              onChange={event => setSourceName(event.target.value)}
              placeholder="显示名（可选）"
              style={inputStyle}
            />
            <button style={secondaryButtonStyle} onClick={() => void addSource()} disabled={addingSource || !sourceInput.trim()}>
              {addingSource ? '添加中…' : '＋ 添加源'}
            </button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>分支可填写 main、master 或自定义名称；留空使用地址中的分支，无分支地址尝试 main / master。指定分支不会自动换分支。</div>
          <div className="skill-market-directories" style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', fontSize: 10, color: 'var(--theme-text-muted)' }}>
            <span>公开目录：</span>
            {initialSync && <span>同步中…</span>}
            {catalog.directories.map(directory => (
              <a key={directory.url} href={directory.url} target="_blank" rel="noreferrer"
                title={directory.description} style={{ color: 'var(--theme-accent)', textDecoration: 'none' }}>
                {directory.name} ↗
              </a>
            ))}
          </div>
          </div>
        </div>

        <div className="skill-market-layout">
          <div style={listPaneStyle}>
            <input
              value={query}
              aria-label="搜索扩展"
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索名称、用途或仓库…"
              style={{ ...inputStyle, width: '100%' }}
              autoFocus
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <select aria-label="扩展排序" value={sort} onChange={event => setSort(event.target.value as SkillMarketSort)} style={{ ...inputStyle, flex: 1, minWidth: 120 }}>
                <option value="updates">可更新 / 官方优先</option><option value="name">名称 A–Z</option>
                <option value="stars">仓库 Star 多到少</option><option value="recent">仓库最近推送</option>
              </select>
              <select aria-label="扩展来源筛选" value={sourceFilter} onChange={event => setSourceFilter(event.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 120 }}>
                <option value="">全部来源</option>{catalog.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
              </select>
            </div>
            <div style={{ fontSize: 10, color: 'var(--theme-text-muted)', lineHeight: 1.5, height: 30, flexShrink: 0, overflow: 'auto' }}>
              {initialSync ? '扩展列表同步中…' : `${filteredItems.length} 个扩展`} · Star / 推送时间属于整个仓库，不是技能评分。基础检查通过不代表效果优秀。
            </div>
            <div className="skill-market-list" style={listStyle} aria-busy={loading}>
              {initialSync && <div data-testid="market-list-placeholder" aria-hidden="true">
                {[0, 1, 2].map(index => <div key={index} style={{ ...itemStyle, marginBottom: 6, cursor: 'default' }}><MarketSkeletonLines /></div>)}
              </div>}
              {!loading && filteredItems.length === 0 && <div style={emptyStyle}>{emptyMessage}</div>}
              {filteredItems.map(item => {
                const risk = riskLabel(item);
                return (
                  <button key={item.id} className="skill-market-item" onClick={() => setSelectedId(item.id)}
                    style={{ ...itemStyle, ...(selected?.id === item.id ? selectedItemStyle : {}) }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <strong style={{ fontSize: 13, color: 'var(--theme-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.name}
                      </strong>
                      {item.official && <span title="官方来源" style={officialBadgeStyle}>官方</span>}
                      {item.updateAvailable && <span style={updateBadgeStyle}>可更新</span>}
                      {item.installed && !item.updateAvailable && <span style={installedBadgeStyle}>已安装</span>}
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--theme-text-muted)', textAlign: 'left',
                      display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={item.description}>
                      {item.description || '未提供说明'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10 }}>
                      <span style={{ color: 'var(--theme-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.repository}
                      </span>
                      <span style={{ color: risk.color, whiteSpace: 'nowrap' }}>{risk.text}</span>
                    </div>
                    <div style={{ fontSize: 10, textAlign: 'left', color: 'var(--theme-text-muted)' }}>
                      {marketVersion(item)} · 仓库 ★ {item.repositoryInfo?.stars?.toLocaleString() ?? '未知'}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="skill-market-detail" style={detailPaneStyle} aria-busy={initialSync}>
            {!selected ? initialSync ? <div data-testid="market-detail-placeholder" style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>Skill 详情同步中…</div>
              <MarketSkeletonLines />
              <div style={{ ...auditBoxStyle, flex: 1 }}><MarketSkeletonLines /></div>
              <div aria-hidden="true" style={{ ...skeletonLineStyle, height: 36, width: '100%' }} />
            </div> : <div style={emptyStyle}>{catalogLoaded ? '从左侧选择一个 Skill 查看完整内容' : '同步未完成，请点击刷新源重试'}</div> : (() => {
              const risk = riskLabel(selected);
              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text)' }}>{selected.name}</h3>
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-text-muted)' }}>
                        {selected.sourceName} · {selected.repository}@{selected.ref}
                        {selected.path ? ` · ${selected.path}` : ''}
                      </div>
                    </div>
                    <span style={{ ...riskBadgeStyle, color: risk.color, background: risk.background }}>{risk.text}</span>
                  </div>
                  <div className="skill-market-detail-switch">
                    <div role="group" aria-label="Skill 详情视图" style={{ display: 'flex', gap: 4 }}>
                      <button type="button" aria-pressed={detailView === 'original'} onClick={() => setExplanationItemKey('')}
                        style={{ ...secondaryButtonStyle, ...(detailView === 'original' ? selectedItemStyle : {}) }}>原文</button>
                      <button type="button" aria-pressed={detailView === 'explanation'} onClick={() => setExplanationItemKey(detailKey)}
                        title="使用所选 Backend 生成中文用途、用法与注意事项，会产生模型用量"
                        style={{ ...secondaryButtonStyle, ...(detailView === 'explanation' ? selectedItemStyle : {}) }}>AI 中文解读</button>
                    </div>
                    <select aria-label="AI 解读 Backend" value={explanationBackendId} onChange={event => {
                      setExplanationBackendId(event.target.value); setExplanationItemKey('');
                    }} disabled={backendsLoading} aria-busy={backendsLoading} style={{ ...inputStyle, maxWidth: '100%', flex: 1 }}>
                      {backendsLoading && <option value={explanationBackendId}>Backend 同步中…</option>}
                      {!backendsLoading && !explanationBackends.length && <option value="">请启用一个解读 Backend</option>}
                      {!backendsLoading && explanationBackends.map(backend => <option key={backend.id} value={backend.id}>{backend.label || backend.id}</option>)}
                    </select>
                  </div>
                  {detailView === 'original' ? <>
                  <details style={{ fontSize: 11, color: 'var(--theme-text-muted)', padding: '6px 0', flexShrink: 0 }}>
                  <summary style={{ cursor: 'pointer' }}>版本与仓库信息 · {marketVersion(selected)} · {selected.fileCount} 个文件 · {formatBytes(selected.size)}</summary>
                  <p style={{ margin: '9px 0', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text)' }}>{selected.description}</p>
                  <div style={metaGridStyle}>
                    <span>技能版本：<b>{selected.version || '作者未声明'}</b></span>
                    <span title={selected.digest}>内容指纹：<b>{selected.digest.slice(0, 12)}</b></span>
                    <span>仓库 Star：<b>{selected.repositoryInfo?.stars?.toLocaleString() ?? '暂不可用'}</b></span>
                    <span>仓库最近推送：<b>{selected.repositoryInfo?.pushedAt ? new Date(selected.repositoryInfo.pushedAt).toLocaleDateString() : '未知'}</b></span>
                    <span>仓库发行版：<b>{selected.repositoryInfo?.latestRelease || '未获取到'}</b>（非此 Skill 版本）</span>
                    <a href={selected.homepage} target="_blank" rel="noreferrer" style={{ color: 'var(--theme-accent)' }}>查看源仓库 ↗</a>
                    <span>许可证：<b>{selected.license || '未声明'}</b></span>
                    <span>兼容说明：<b>{selected.compatibility || '标准 SKILL.md'}</b></span>
                    <span>文件：<b>{selected.fileCount}</b></span>
                    <span>大小：<b>{formatBytes(selected.size)}</b></span>
                  </div>
                  </details>
                  {selected.repositoryInfo?.archived && <div style={warningBoxStyle}>该源仓库已归档，维护可能已停止。</div>}
                  {selected.repositoryInfo?.error && <div style={warningBoxStyle}>{selected.repositoryInfo.error}</div>}
                  {(selected.conflict || selected.localModified || selected.warnings.length > 0) && (
                    <div style={warningBoxStyle}>
                      {selected.conflict && <div>本地已有同名 Skill，安装会先明确覆盖它。</div>}
                      {selected.localModified && <div>已安装版本被手动修改；更新会覆盖这些修改。</div>}
                      {selected.warnings.map((warning, index) => <div key={index}>{warning}</div>)}
                    </div>
                  )}
                  <div className="skill-market-audit" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,.6fr) minmax(0,1.4fr)', gap: 8, minHeight: 180, flex: 1 }}>
                    <div style={auditBoxStyle}>
                      <strong style={auditTitleStyle}>安装文件</strong>
                      {selected.fileNames.length > 100 && (
                        <div style={{ display: 'grid', gap: 4, marginBottom: 5 }}>
                          <input aria-label="搜索安装文件" placeholder="搜索文件名…" value={fileQuery}
                            onChange={event => { setFileQuery(event.target.value); setFilePage(0); }} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
                          <div className="skill-market-file-pages" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--theme-text-muted)' }}>
                            <span>共 {selected.fileCount} 个文件 · 匹配 {matchingFiles.length} · {currentFilePage + 1}/{filePageCount} 页</span>
                            <button style={secondaryButtonStyle} disabled={currentFilePage === 0} onClick={() => setFilePage(currentFilePage - 1)}>上一页</button>
                            <button style={secondaryButtonStyle} disabled={currentFilePage + 1 >= filePageCount} onClick={() => setFilePage(currentFilePage + 1)}>下一页</button>
                          </div>
                        </div>
                      )}
                      <div style={scrollTextStyle}>
                        {matchingFiles.slice(currentFilePage * 100, (currentFilePage + 1) * 100).map(name => <div key={name}>{name}</div>)}
                      </div>
                    </div>
                    <div style={auditBoxStyle}>
                      <strong style={auditTitleStyle}>自动风险提示</strong>
                      <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--theme-text-muted)', marginBottom: 7 }}>
                        {(selected.risk?.flags || []).map((flag, index) => <div key={index}>• {flag}</div>)}
                      </div>
                      <strong style={auditTitleStyle}>
                        SKILL.md 预览{selected.previewTruncated ? '（内容较长，仅显示前 32K）' : ''}
                      </strong>
                      <pre style={previewStyle}>{selected.preview}</pre>
                    </div>
                  </div>
                  </> : <SkillMarketExplanation key={`${identityRevision}:${selected.id}:${selected.digest}:${explanationBackendId}`}
                    item={selected} backendId={explanationBackendId} execKey={execKey} backendLoading={backendsLoading} />}
                  <footer className="skill-market-footer" style={detailFooterStyle}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11,
                      color: 'var(--theme-text-muted)', lineHeight: 1.4, flex: 1, minWidth: 0 }}>
                      <input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
                      <span style={{ minWidth: 0 }}>
                        <strong className="skill-market-install-target-line" style={{ display: 'block' }} title={targetName}>安装到：{targetName}</strong>
                        我已核对安装节点、来源、文件和 SKILL.md。Skill 可指导 Agent 运行命令，安装不代表内容绝对安全。
                      </span>
                    </label>
                    {onPrepare && (selected.installed || lastInstalled?.name === selected.name) && <button style={secondaryButtonStyle}
                      onClick={() => onPrepare([selected.name], lastInstalled?.name === selected.name ? lastInstalled.execKey : execKey)}>查看运行准备</button>}
                    <button style={{ ...primaryButtonStyle, opacity: installDisabled ? .55 : 1 }}
                      disabled={installDisabled} title={`安装到 ${targetName} 的 Skill 库；不会安装到其它节点`} onClick={() => void installSelected()}>
                      {installText}
                    </button>
                  </footer>
                </>
              );
            })()}
          </div>
        </div>
      </section>
      {batchSnapshot && <SkillMarketBatchDialog {...batchSnapshot} visible={batchVisible} onClose={closeBatch} onPrepare={onPrepare}
        onFinish={() => { setBatchVisible(false); setBatchSnapshot(null); }}
        onInstalled={() => { void onInstalled(undefined, batchSnapshot.execKey); if (batchSnapshot.execKey === execKey) void load(false); }} />}
    </div>
  );
};

const skeletonLineStyle: React.CSSProperties = {
  height: 10, borderRadius: 4, background: 'var(--theme-border)', opacity: .65,
};
const MarketSkeletonLines: React.FC = () => <div aria-hidden="true" style={{ display: 'grid', gap: 9, padding: '9px 0' }}>
  {[.6, .95, .8].map(width => <div key={width} style={{ ...skeletonLineStyle, width: `${width * 100}%` }} />)}
</div>;

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 2600, padding: 18,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,.62)', backdropFilter: 'blur(2px)',
};
const dialogStyle: React.CSSProperties = {
  width: 'min(1280px, calc(100vw - 36px))', height: 'calc(100dvh - 36px)', boxSizing: 'border-box',
  maxHeight: 'calc(100dvh - 36px)', display: 'flex', flexDirection: 'column', gap: 6,
  padding: 'var(--ui-space-md, 14px)', borderRadius: 12, border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-secondary)', boxShadow: '0 20px 70px rgba(0,0,0,.42)',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', flexShrink: 0, justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
};
const sourceAreaStyle: React.CSSProperties = {
  display: 'flex', flexShrink: 0, flexDirection: 'column', gap: 7, padding: 5,
  border: '1px solid var(--theme-border)', borderRadius: 9, background: 'var(--theme-bg)',
};
const sourceProblemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 8px',
  borderRadius: 7, border: '1px solid rgba(214,168,75,.28)',
  background: 'rgba(214,168,75,.07)', fontSize: 10, lineHeight: 1.5,
  overflowWrap: 'anywhere',
};
const standardBadgeStyle: React.CSSProperties = {
  fontSize: 10, padding: '2px 6px', borderRadius: 5,
  color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)',
};
const sourceChipStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 3, position: 'relative',
  padding: '3px 7px', borderRadius: 999, border: '1px solid var(--theme-border)',
  fontSize: 10, color: 'var(--theme-text-muted)', background: 'var(--theme-bg-secondary)',
};
const sourceRemoveStyle: React.CSSProperties = {
  border: 0, background: 'transparent', color: '#ef6b73', cursor: 'pointer',
  padding: 0, marginLeft: 2, opacity: .55, lineHeight: 1,
};
const inputStyle: React.CSSProperties = {
  minWidth: 0, boxSizing: 'border-box', border: '1px solid var(--theme-border)',
  borderRadius: 7, background: 'var(--theme-input-bg, var(--theme-bg))',
  color: 'var(--theme-text)', padding: '7px 9px', fontSize: 12, outline: 'none',
};
const secondaryButtonStyle: React.CSSProperties = {
  border: '1px solid var(--theme-border)', borderRadius: 7,
  background: 'var(--theme-bg)', color: 'var(--theme-text)', padding: '6px 9px',
  fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
};
const primaryButtonStyle: React.CSSProperties = {
  border: 0, borderRadius: 7, background: 'var(--theme-accent)', color: '#fff',
  padding: '8px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};
const closeButtonStyle: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 7, border: '1px solid var(--theme-border)',
  background: 'transparent', color: 'var(--theme-text-muted)', fontSize: 20, cursor: 'pointer',
};
const listPaneStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 0,
};
const listStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', flex: 1, gap: 6, minHeight: 0, overflowY: 'auto', paddingRight: 3,
};
const itemStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', flexShrink: 0, gap: 3, width: '100%', padding: '6px 8px',
  borderRadius: 8, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)',
  cursor: 'pointer', color: 'inherit', textAlign: 'left', transition: 'border-color .12s',
};
const selectedItemStyle: React.CSSProperties = {
  borderColor: 'var(--theme-accent)', background: 'var(--theme-accent-bg)',
};
const officialBadgeStyle: React.CSSProperties = {
  padding: '1px 5px', borderRadius: 4, fontSize: 9, color: '#4fb477', background: 'rgba(79,180,119,.12)',
};
const updateBadgeStyle: React.CSSProperties = {
  padding: '1px 5px', borderRadius: 4, fontSize: 9, color: '#d6a84b', background: 'rgba(214,168,75,.12)',
};
const installedBadgeStyle: React.CSSProperties = {
  padding: '1px 5px', borderRadius: 4, fontSize: 9, color: 'var(--theme-text-muted)', background: 'rgba(127,127,127,.12)',
};
const detailPaneStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, minHeight: 0,
  padding: 11, borderRadius: 9, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', overflow: 'auto', boxSizing: 'border-box',
};
const riskBadgeStyle: React.CSSProperties = {
  padding: '3px 7px', borderRadius: 6, fontSize: 10, whiteSpace: 'nowrap',
};
const metaGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '4px 12px',
  fontSize: 10, color: 'var(--theme-text-muted)', marginBottom: 7,
};
const warningBoxStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, fontSize: 10, lineHeight: 1.45,
  color: '#d6a84b', background: 'rgba(214,168,75,.1)', marginBottom: 5,
};
const auditBoxStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
  padding: 8, borderRadius: 7, border: '1px solid var(--theme-border)', overflow: 'hidden',
};
const auditTitleStyle: React.CSSProperties = {
  display: 'block', fontSize: 10, color: 'var(--theme-text)', marginBottom: 5,
};
const scrollTextStyle: React.CSSProperties = {
  minHeight: 0, overflow: 'auto', font: '10px/1.55 monospace', color: 'var(--theme-text-muted)', overflowWrap: 'anywhere',
};
const previewStyle: React.CSSProperties = {
  flex: 1, minHeight: 100, margin: 0, padding: 7, borderRadius: 6,
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text-muted)',
  font: '10px/1.5 monospace', whiteSpace: 'pre-wrap', overflow: 'auto', overflowWrap: 'anywhere',
};
const detailFooterStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, marginTop: 4,
  borderTop: '1px solid var(--theme-border)',
};
const emptyStyle: React.CSSProperties = {
  margin: 'auto', padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--theme-text-muted)',
};
