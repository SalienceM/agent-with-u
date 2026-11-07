import { useEffect, useRef, useState } from 'react';
import { getPreviewIdentity } from '../api';
import { PreviewRegistry, PREVIEW_REGISTRY_KEY, type PreviewRegistration, type PreviewPhase } from '../utils/previewLifecycle';
import { PreviewAccess } from '../utils/previewAccess';
import { registerPreview, removePreviewRegistration } from '../utils/previewRegistration';
import type { PreviewWindowSnapshot } from '../utils/previewWindow';

export function useIndependentPreview(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<PreviewWindowSnapshot | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>('initializing');
  const [error, setError] = useState('');
  const access = useRef<PreviewAccess>();
  const registration = useRef<PreviewRegistration>();
  const channel = useRef<BroadcastChannel>();
  const uiSeq = useRef(0), pending = useRef(new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const initialize = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    const id = new URLSearchParams(location.search).get('filePreview') || '';
    if (!/^[\w-]{1,128}$/.test(id)) { setError('预览窗口标识无效'); return; }
    const bc = new BroadcastChannel(`awu-file-preview-${id}`); channel.current = bc;
    bc.postMessage({ kind: 'resuming' });
    // pagehide 可能是刷新：只让原界面有界释放导航协作，不删除自己的恢复登记。
    const pagehide = () => bc.postMessage({ kind: 'suspended' });
    window.addEventListener('pagehide', pagehide);
    let active = true, starting = false, off: (() => void) | undefined;
    const renew = setInterval(() => {
      const row = registration.current, phase = access.current?.life.phase;
      if (row && phase && !['revoked', 'closed'].includes(phase)) void registerPreview(row).catch(reason => { if (active) setError(`预览恢复登记未更新：${String(reason)}`); });
    }, 60_000);
    const init = async () => {
      if (!active || starting || access.current) return;
      try {
        const row = new PreviewRegistry(localStorage).get(id, getPreviewIdentity());
        if (!row) return;
        starting = true; registration.current = row;
        const controller = new PreviewAccess(row.source); access.current = controller;
        off = controller.life.subscribe(() => {
          if (!active) return;
          setPhase(controller.life.phase); setError(controller.life.reason);
          if (controller.life.phase === 'revoked') { setSnapshot(null); document.title = '文件预览 · 身份已变化'; }
        });
        await controller.connect();
        const preview = await controller.load();
        if (!active) return;
        setSnapshot({ preview, root: row.source.source === 'local' ? row.source.local!.root : row.source.workingDir,
          nodeLabel: row.source.source === 'local' ? '本机副本' : row.source.executor, theme: {}, dark: row.dark, initialView: row.initialView });
        setError(''); document.title = `${preview.name} · 预览 — AgentWithU`;
        bc.postMessage({ kind: 'initialized' });
      } catch (reason) { if (active) { setError(String(reason)); bc.postMessage({ kind: 'initializationFailed', message: String(reason) }); } }
      finally { starting = false; }
    };
    initialize.current = () => { void init(); };
    bc.onmessage = ({ data }) => {
      if (data?.kind === 'registered') void init();
      else if (data?.kind === 'registrationFailed') setError(String(data.message));
      else if (data?.kind === 'ui-result') {
        const request = pending.current.get(data.id); if (!request) return;
        pending.current.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(new Error(data.error)) : request.resolve();
      }
    };
    const storage = (event: StorageEvent) => { if (event.key === PREVIEW_REGISTRY_KEY) void init(); };
    window.addEventListener('storage', storage);
    void init();
    const timeout = setTimeout(() => { if (!access.current) setError('没有可核验的预览来源：登记不存在、已过期或初始化未完成。可重试读取登记或关闭窗口。'); }, 12000);
    return () => {
      active = false; clearTimeout(timeout); clearInterval(renew); off?.(); access.current?.dispose(); access.current = undefined;
      window.removeEventListener('storage', storage); window.removeEventListener('pagehide', pagehide); bc.close(); channel.current = undefined;
      for (const request of pending.current.values()) { clearTimeout(request.timer); request.reject(new Error('文件窗口已关闭')); } pending.current.clear();
    };
  }, [enabled]);
  const retry = async () => {
    setError('');
    try {
      const controller = access.current;
      if (!controller) { initialize.current(); return; }
      await controller.connect(true);
      // 有内容时只恢复访问，不重新解析或覆盖阅读/编辑状态。
      if (!snapshot) {
        const row = registration.current!, preview = await controller.load();
        setSnapshot({ preview, root: row.source.source === 'local' ? row.source.local!.root : row.source.workingDir,
          nodeLabel: row.source.source === 'local' ? '本机副本' : row.source.executor, theme: {}, dark: row.dark, initialView: row.initialView });
      }
    } catch (reason) { setError(String(reason)); }
  };
  const navigateUi = (method: 'reveal' | 'review', rel: string) => new Promise<void>((resolve, reject) => {
    if (!channel.current || phase !== 'ready') { reject(new Error('原工作台导航暂不可用；文件仍可阅读。')); return; }
    const id = ++uiSeq.current, timer = setTimeout(() => { pending.current.delete(id); reject(new Error('没有可用的原工作台导航目标；独立文件仍可阅读。')); }, 3000);
    pending.current.set(id, { resolve, reject, timer }); channel.current.postMessage({ kind: 'navigate-ui', id, method, rel });
  });
  const closed = async () => {
    const row = registration.current;
    if (row) await removePreviewRegistration(row.source.id, row.source.identity).catch(() => {});
    channel.current?.postMessage({ kind: 'closed' });
  };
  return { snapshot, setSnapshot, phase, error, setError, access, retry, navigateUi, closed, source: registration.current?.source };
}
