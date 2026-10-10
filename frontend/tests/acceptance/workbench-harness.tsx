import React from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../../src/api';
import { LoopPanel } from '../../src/components/LoopPanel';

// 仅供浏览器回归：绕过真实 RPC，检查同 Session 的节点身份切换与迟到详情。
export function mountWorkbenchHarness() {
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '99999', background: '#202126' });
  document.body.appendChild(host);
  const root = createRoot(host);
  const saved = { get: api.loopGetState, record: api.loopGetRecord };
  const pending: Array<() => void> = [];
  const reads: string[] = [];
  api.loopGetState = async (sessionId, execKey) => ({ sessionId, stage: 'loopexecute', round: 1, goal: `节点 ${execKey}`,
    running: false, resumable: false, auto: false, stopReason: '', ideas: [],
    addons: [{ id: 'pending-image', text: '尚未纳入的图片补充', status: 'pending', images: [{ id: 'synthetic-image',
      mime_type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }] }], goalHistory: [], asides: [],
    loops: [{ seq: 1, round: 1, subStage: 'done', completed: true, orchestration: [], analysis: null, result: '', error: '', detailLoaded: false }] });
  api.loopGetRecord = async (_sessionId, _seq, execKey) => {
    reads.push(execKey || '');
    return new Promise(resolve => pending.push(() => resolve({ status: 'ok', record: {
      seq: 1, round: 1, subStage: 'done', completed: true, orchestration: [], result: `节点 ${execKey} 的独立原文`,
      analysis: null, error: '', detailLoaded: true } })));
  };
  return {
    render: (executor: string) => root.render(<LoopPanel embedded inspectOnly sessionId="same-synthetic-session" execKey={executor} />),
    release: () => { pending.splice(0).forEach(reply => reply()); },
    reads,
    close: () => { root.unmount(); host.remove(); api.loopGetState = saved.get; api.loopGetRecord = saved.record; },
  };
}
