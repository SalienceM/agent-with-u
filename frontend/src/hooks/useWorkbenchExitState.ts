import { useEffect } from 'react';
import { documentStore } from '../utils/documentStore';
import { isDesktopWindow } from '../utils/detachedWindow';
import { terminalResources } from '../utils/workspaceTerminals';
import { languageResources } from '../utils/workspaceLanguages';

/** 仅无正文计数供原生退出提示；没有回报的窗口不能被当作已安全退出。 */
export function useWorkbenchExitState() {
  useEffect(() => {
    if (!isDesktopWindow()) return;
    let timer: ReturnType<typeof setTimeout> | undefined, active = true;
    const report = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined; if (!active) return;
        const docs = documentStore.all();
        const state = { dirtyDocuments: docs.filter(d => d.dirty).length,
          pendingSaves: docs.filter(d => d.save && !['succeeded', 'failed'].includes(d.save.receipt?.status || '')).length,
          terminals: terminalResources.liveCount(), languageServices: languageResources.liveCount() };
        void import('@tauri-apps/api/core').then(({ invoke }) => active ? invoke('report_workbench_exit_state', { state }) : undefined).catch(() => {});
      }, 200);
    };
    report(); const off = documentStore.subscribe(report), offResources = terminalResources.subscribe(report), offLanguages = languageResources.subscribe(report);
    return () => { active = false; off(); offResources(); offLanguages(); clearTimeout(timer); };
  }, []);
}
