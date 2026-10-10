import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import type { LoopRecord, LoopStateT, DetailTarget } from '../types/loopWorkbench';
import { loopRecordRevision } from '../utils/loopRecordDetail';
import { activeLoopSeq, mergeCallDiagnostics, type CallDiagnostic } from '../utils/loopDiagnostics';
import { mergeBlockerDetails } from '../utils/loopTaskBlockers';

function mergeLoopRecordDetail(summary: LoopRecord, detail?: LoopRecord): LoopRecord {
  if (summary.detailLoaded !== false) return summary;
  if (!detail) return summary;
  const detailSteps = new Map((detail.orchestration || []).map((step) => [step.index, step]));
  const orchestration = (summary.orchestration || []).map((step) => {
    const full = detailSteps.get(step.index);
    return full ? {
      ...full,
      ...step,
      output: full.output || step.output,
    } : step;
  });
  const analysis = summary.analysis && detail.analysis ? {
    ...detail.analysis,
    ...summary.analysis,
    notes: detail.analysis.notes || summary.analysis.notes,
    trend: detail.analysis.trend || summary.analysis.trend,
    challenges: detail.analysis.challenges || summary.analysis.challenges,
    verified: detail.analysis.verified || summary.analysis.verified,
    gaps: detail.analysis.gaps || summary.analysis.gaps,
    nextFocus: detail.analysis.nextFocus || summary.analysis.nextFocus,
  } : (summary.analysis || detail.analysis);
  return {
    ...detail,
    ...summary,
    result: detail.result || summary.result,
    manualMessages: detail.manualMessages || summary.manualMessages,
    manualContext: detail.manualContext || summary.manualContext,
    evolutionBasis: detail.evolutionBasis || summary.evolutionBasis,
    delivery: detail.delivery?.mode ? detail.delivery : summary.delivery,
    analysis,
    orchestration,
    stageDetails: Object.fromEntries(Object.entries(summary.stageDetails || detail.stageDetails || {}).map(
      ([stage, value]) => [stage, { ...detail.stageDetails?.[stage], ...value }],
    )),
    callDiagnostics: mergeCallDiagnostics(detail.callDiagnostics, summary.callDiagnostics),
    environmentChecks: loopRecordRevision(summary) === loopRecordRevision(detail) ? detail.environmentChecks : summary.environmentChecks,
    ...mergeBlockerDetails(summary, detail),
    detailLoaded: true,
  };
}


export function useLoopWorkbenchState(sessionId: string, execKey: string, identity: string, visible: boolean, detailsVisible: boolean) {
  const [state, setState] = useState<LoopStateT | null>(null);
  const statePushRevision = useRef(0);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [recordDetails, setRecordDetails] = useState<Record<number, LoopRecord>>({});
  const [callDiagnostics, setCallDiagnostics] = useState<Record<number, CallDiagnostic[]>>({});
  const [detailTarget, setDetailTarget] = useState<DetailTarget>('all');
  const [detailErrors, setDetailErrors] = useState<Record<number, { revision: string; message: string }>>({});
  const detailRequests = useRef(new Set<string>());
  const detailVersions = useRef<Record<number, string>>({});
  const detailGeneration = useRef(0);
  const [loadError, setLoadError] = useState('');

  // 子阶段实时流式文本：key = `${seq}:${subStage}`
  const [progress, setProgress] = useState<Record<string, string>>({});
  const pendingProgressRef = useRef<Record<string, string>>({});
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIdentityRef = useRef(identity);
  activeIdentityRef.current = identity;

  const refresh = useCallback(async () => {
    const requestedIdentity = identity;
    const revision = statePushRevision.current;
    let s: LoopStateT | null = null;
    try { s = await api.loopGetState(sessionId, execKey); } catch { /* 只提供只读重试 */ }
    if (activeIdentityRef.current !== requestedIdentity || statePushRevision.current !== revision) return;
    if (s) { setState(s); setLoadError(''); }
    else setLoadError('LOOP 工作台加载失败，请重试读取');
  }, [sessionId, identity, execKey]);

  const selectLoop = useCallback((seq: number | null, target: DetailTarget = 'all') => {
    setSelectedSeq(seq);
    setDetailTarget(target);
  }, []);

  const selectedSummary = state?.loops.find(record => record.seq === selectedSeq);
  const selectedRevision = selectedSummary ? loopRecordRevision(selectedSummary) : '';
  // 只对当前选中记录按版本按需取详情；完成步骤/切换阶段的 push 会使缓存失效。
  // 同一记录最多一个在途请求；请求期间出现的新版本等返回后补取，不并发重刷。
  useEffect(() => {
    if (!visible || !detailsVisible || state?.sessionId !== sessionId || !selectedSummary || selectedSummary.detailLoaded !== false) return;
    const seq = selectedSummary.seq;
    if (detailVersions.current[seq] === selectedRevision) return;
    if (detailErrors[seq]?.revision === selectedRevision) return;
    const generation = detailGeneration.current;
    const key = `${generation}:${sessionId}:${seq}`;
    if (detailRequests.current.has(key)) return;
    detailRequests.current.add(key);
    const requestedIdentity = identity;
    void api.loopGetRecord(sessionId, seq, execKey).then((result) => {
      if (activeIdentityRef.current !== requestedIdentity || detailGeneration.current !== generation) return;
      detailRequests.current.delete(key);
      if (result.status === 'ok' && result.record) {
        detailVersions.current[seq] = selectedRevision;
        detailRequests.current.delete(key);
        setDetailErrors(previous => { const next = { ...previous }; delete next[seq]; return next; });
        setRecordDetails((previous) => ({ ...previous, [seq]: result.record as LoopRecord }));
        if (result.progress) {
          setProgress((previous) => {
            const next = { ...previous };
            for (const [key, replay] of Object.entries(result.progress || {})) {
              const current = next[key] || '';
              if (!current || replay.includes(current)) next[key] = replay;
              else if (!current.includes(replay)) next[key] = (replay + current).slice(-50_000);
            }
            return next;
          });
        }
      } else {
        setDetailErrors(previous => ({ ...previous, [seq]: { revision: selectedRevision, message: result.message || '详情加载失败' } }));
      }
    }).catch(error => {
      if (activeIdentityRef.current === requestedIdentity && detailGeneration.current === generation) {
        setDetailErrors(previous => ({ ...previous, [seq]: { revision: selectedRevision, message: String(error) } }));
      }
    }).finally(() => { detailRequests.current.delete(key); });
  }, [sessionId, identity, execKey, selectedSeq, selectedRevision, recordDetails, detailErrors, visible, detailsVisible]);

  const retryDetail = useCallback(() => {
    if (selectedSeq == null) return;
    delete detailVersions.current[selectedSeq];
    setDetailErrors(previous => { const next = { ...previous }; delete next[selectedSeq]; return next; });
  }, [selectedSeq]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    setState(null);
    setSelectedSeq(null);
    setRecordDetails({});
    setCallDiagnostics({});
    setDetailErrors({});
    detailVersions.current = {};
    setDetailTarget('all');
    detailGeneration.current++;
    setProgress({});
    pendingProgressRef.current = {};
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    progressTimerRef.current = null;
    return () => { detailGeneration.current++; };
  }, [sessionId, identity, execKey]);

  // 订阅整份状态更新 + 子阶段流式文本（仅本 session）
  useEffect(() => {
    const un1 = api.onLoopUpdated((s: LoopStateT, executor) => {
      if (executor !== execKey || s.sessionId !== sessionId) return;
      statePushRevision.current++;
      setState(previous => (previous?.controlRevision || 0) > (s.controlRevision || 0) ? previous : s);
    });
    const un2 = api.onLoopProgress((d, executor) => {
      if (executor !== execKey || d.sessionId !== sessionId) return;
      if (d.diagnostic) {
        setCallDiagnostics(previous => {
          const next = { ...previous, [d.seq]: mergeCallDiagnostics(previous[d.seq], [d.diagnostic!]) };
          for (const seq of Object.keys(next).map(Number).sort((a, b) => b - a).slice(12)) delete next[seq];
          return next;
        });
        return;
      }
      const key = `${d.seq}:${d.subStage}`;
      pendingProgressRef.current[key] = (pendingProgressRef.current[key] || '') + d.text;
      if (!progressTimerRef.current) {
        progressTimerRef.current = setTimeout(() => {
          const batch = pendingProgressRef.current;
          pendingProgressRef.current = {};
          progressTimerRef.current = null;
          setProgress((prev) => {
            const next = { ...prev };
            for (const [batchKey, text] of Object.entries(batch)) {
              // 实时窗口只保留尾部 50KB；完整结果以后端持久化状态为准。
              next[batchKey] = ((next[batchKey] || '') + text).slice(-50_000);
            }
            return next;
          });
        }, 50);
      }
    });
    return () => {
      un1(); un2();
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
      pendingProgressRef.current = {};
    };
  }, [sessionId, identity, execKey]);


  const stateForView = state ? { ...state, loops: state.loops.map(record => {
    const merged = mergeLoopRecordDetail(record, recordDetails[record.seq]);
    return { ...merged, diagnosticLive: record.seq === activeLoopSeq(state),
      callDiagnostics: mergeCallDiagnostics(merged.callDiagnostics, callDiagnostics[record.seq]) };
  }) } : null;
  return { state: stateForView, loadError, refresh, selectedSeq, selectLoop, detailTarget, setDetailTarget, detailErrors, retryDetail, progress };
}
