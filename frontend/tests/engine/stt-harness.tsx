import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInput } from '../../src/components/ChatInput';
import { speechPanelHostStyle } from '../../src/components/SpeechDictation';
import { api } from '../../src/api';

export function mountSttFixture() {
  const texts = new Set<(data: any) => void>(), ends = new Set<(data: any) => void>();
  let resolveStop: (() => void) | undefined, resolveStart: (() => void) | undefined;
  const f = { starts: [] as unknown[], stops: [] as unknown[], sends: [] as unknown[], result: '最终识别结果',
    holdStop: false, holdStart: false, stopError: '', tracksStopped: 0,
    contextOptions: [] as unknown[], audioRequests: [] as unknown[], pcm: (_amplitude: number, _frames: number) => {},
    finishStop: () => resolveStop?.(), finishStart: () => resolveStart?.(),
    switchSession: (_id: string) => {}, visible: (_visible: boolean) => {},
    text: (text: string, isFinal = false) => texts.forEach(cb => cb({ text, isFinal })),
    end: () => ends.forEach(cb => cb({ reason: 'disconnected' })) };
  api.onSttStreamText = cb => { texts.add(cb); return () => { texts.delete(cb); }; };
  api.onSttStreamEnd = cb => { ends.add(cb); return () => { ends.delete(cb); }; };
  api.getSttConfig = async () => ({});
  api.sttStreamStart = async (_cfg, sid) => { f.starts.push(sid); if (f.holdStart) await new Promise<void>(resolve => { resolveStart = resolve; }); return { ok: true }; };
  api.sttStreamStop = async sid => { f.stops.push(sid); if (f.holdStop) await new Promise<void>(resolve => { resolveStop = resolve; }); return f.stopError ? { ok: false, error: f.stopError } : { ok: true, text: f.result }; };
  api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] }) as any;
  api.listPrompts = async () => []; api.listSkills = async () => [];
  api.followupSuggestionSettings = async () => ({ version: 1, enabled: false }) as any;
  api.onSessionUpdated = () => () => {};
  const node = () => ({ connect() {}, disconnect() {} });
  const track = { stop() { f.tracksStopped++; }, label: '测试麦克风', getSettings: () => ({ deviceId: 'mic-1', sampleRate: 48000 }) };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async (options: unknown) => { f.audioRequests.push(options); return { getTracks: () => [track], getAudioTracks: () => [track] }; },
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'mic-1', label: '测试麦克风' }, { kind: 'audioinput', deviceId: 'mic-2', label: '耳机麦克风' }],
  } });
  (window as any).AudioContext = class {
    constructor(options: unknown) { f.contextOptions.push(options); }
    destination = {}; audioWorklet = { addModule: async () => {} };
    resume = async () => {}; close = async () => {};
    createMediaStreamSource = node;
    createGain = () => ({ ...node(), gain: { value: 0 } });
  };
  (window as any).AudioWorkletNode = class {
    constructor() { f.pcm = (amplitude, frames) => { for (let index = 0; index < frames; index++) this.port.onmessage({ data: new Int16Array(1600).fill(amplitude).buffer }); }; }
    port = { onmessage: (_event: any) => {}, close() {}, postMessage: () => {
      queueMicrotask(() => this.port.onmessage({ data: { type: 'flushed' } }));
    } };
    connect() {} disconnect() {}
  };
  (window as any).sttFixture = f;
  const Pane = ({ id }: { id: string }) => {
    const [session, setSession] = useState(id), [visible, setVisible] = useState(true);
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    if (id === 'speaking') { f.switchSession = setSession; f.visible = setVisible; }
    return <section aria-label={id} className="fixture-pane" style={{ display: visible ? 'flex' : 'none' }}>
      <header style={{ padding: 18, borderBottom: '1px solid #dce1e8', fontWeight: 600 }}>{id === 'speaking' ? '当前会话' : '其他会话'}</header>
      <div className="fixture-messages" style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', padding: 20 }}>
        <p>可以在这里继续查看对话。</p><p style={{ color: '#687487' }}>语音转写独立显示，应用后才进入草稿。</p>
        <div ref={setHost} style={speechPanelHostStyle} />
      </div>
      <ChatInput sessionId={session} execKey="local" historyKey={`stt-fixture:${session}`} workingDir="C:\fixture"
        speechPanelHost={host} isVisible={visible} isMobile={window.innerWidth < 600}
        backends={[]} activeBackendId="test" isStreaming={false} onSend={(...args) => { f.sends.push(args); }} onAbort={() => {}} />
    </section>;
  };
  createRoot(document.getElementById('root')!).render(<main><Pane id="speaking" /><Pane id="idle" /></main>);
}
