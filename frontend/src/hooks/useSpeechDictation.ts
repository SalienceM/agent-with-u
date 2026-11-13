import { useEffect, useRef, useState } from 'react';
import { api, onCurrentUserChanged } from '../api';

export type DictationStatus = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'finalizing' | 'error';
interface Snapshot { text: string; open: boolean; status: DictationStatus; error: string; notice: string; audioLevel: number; audioSeconds: number }
interface Microphone { id: string; label: string }
interface Capture {
  stopped: boolean;
  serverStarted: boolean;
  starting?: Promise<void>;
  reconnecting?: Promise<void>;
  finishing?: Promise<void>;
  stream?: MediaStream;
  context?: AudioContext;
  worklet?: AudioWorkletNode;
  flush?: () => void;
  unsubscribe?: () => void;
  unsubscribeEnd?: () => void;
  prefix: string;
  retries: number;
  healthTimer?: number;
  audioSamples: number;
  audioEnergy: number;
  audioPeak: number;
  recentLevel: number;
  lastAudioAt: number;
}

// 只保存本窗口、同一身份下尚未应用的转写；不写 Session、不发送，也不落浏览器磁盘。
const staged = new Map<string, string>();
let identityRevision = 0;
let microphoneOwner: Capture | undefined;
onCurrentUserChanged((_profile, changed) => {
  if (changed) { identityRevision++; staged.clear(); }
});
const join = (prefix: string, text: string) => prefix && text ? `${prefix}\n${text}` : prefix || text;
const message = (error: unknown) => error instanceof Error ? error.message : '实时语音连接失败，已保留识别文字';

function closeAudio(run: Capture) {
  window.clearInterval(run.healthTimer); run.healthTimer = undefined;
  run.flush?.();
  run.worklet?.port.close(); run.worklet?.disconnect(); run.worklet = undefined;
  run.stream?.getTracks().forEach(track => track.stop()); run.stream = undefined;
  void run.context?.close().catch(() => {}); run.context = undefined;
}

/** 调用组件必须按 owner/executor/Session scope 加 key；旧异步回执不进入新面板。 */
export function useSpeechDictation(scope: string, sessionId: string | undefined, enabled: boolean) {
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [deviceNotice, setDeviceNotice] = useState('');
  const [deviceChoice, setDeviceChoice] = useState<string | undefined>();
  const [state, setState] = useState<Snapshot>(() => ({ text: staged.get(scope) || '',
    open: staged.has(scope), status: 'idle', error: '', notice: '', audioLevel: 0, audioSeconds: 0 }));
  const stateRef = useRef(state);
  const runRef = useRef<Capture>();
  const alive = useRef(true);
  const revision = useRef(identityRevision);
  const current = () => alive.current && revision.current === identityRevision;
  const publish = (patch: Partial<Snapshot>) => {
    if (!current()) return;
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    if (next.text) staged.set(scope, next.text); else staged.delete(scope);
    setState(next);
  };
  const accept = (run: Capture, text: string) => {
    if (!current() || runRef.current !== run || !text) return;
    run.retries = 0;
    publish({ text: join(run.prefix, text), notice: '' });
  };
  const subscribe = (run: Capture) => {
    run.unsubscribe?.();
    run.unsubscribe = api.onSttStreamText(data => accept(run, data.text));
  };

  const finish = (run: Capture, error = ''): Promise<void> => {
    if (run.finishing) return run.finishing;
    run.stopped = true;
    publish({ status: 'finalizing', ...(error ? { error } : {}) });
    run.unsubscribeEnd?.();
    run.finishing = (async () => {
      // 开始/重连的迟到成功也由同一个停止流程收尾，不与下一次录音交叉。
      await run.starting?.catch(() => {});
      await run.reconnecting?.catch(() => {});
      if (run.worklet) await new Promise<void>(resolve => {
        const timeout = window.setTimeout(() => run.flush?.(), 150);
        run.flush = () => { window.clearTimeout(timeout); run.flush = undefined; resolve(); };
        run.worklet!.port.postMessage({ type: 'flush' });
      });
      closeAudio(run);
      try {
        if (run.serverStarted) {
          const result = await api.sttStreamStop(sessionId);
          if (result.ok) {
            if (result.text) accept(run, result.text);
            publish({
              ...(result.realtimeError ? { error: `实时识别异常，已保留转写：${result.realtimeError}` } : {}),
              notice: result.refinedByFlash ? '已完成语音精校' : result.refineSkipped
                || (result.refineError ? `精校失败，已保留实时文字：${result.refineError}` : ''),
            });
          } else publish({ error: result.error || '未能取得最终转写，已保留实时文字' });
        }
      } catch (e) { publish({ error: message(e) }); }
      finally {
        run.unsubscribe?.();
        if (microphoneOwner === run) microphoneOwner = undefined;
        if (runRef.current === run) {
          runRef.current = undefined;
          publish({ status: stateRef.current.error ? 'error' : 'idle' });
        }
      }
    })();
    return run.finishing;
  };

  const reconnect = (run: Capture) => {
    if (run.stopped || run.reconnecting || !current()) return;
    publish({ status: 'reconnecting' });
    run.unsubscribe?.(); run.unsubscribe = undefined;
    const prefix = stateRef.current.text;
    run.reconnecting = (async () => {
      if (run.retries++ >= 1) throw new Error('实时语音重连仍未恢复，请检查网络后继续录音；已识别文字保留。');
      run.serverStarted = false;
      const result = await api.sttStreamStart(undefined, sessionId);
      if (!result.ok) throw new Error(result.error || '实时语音重连失败');
      run.serverStarted = true;
      run.prefix = prefix;
      if (run.stopped || !current()) return;
      subscribe(run);
      publish({ status: 'listening' });
    })();
    void run.reconnecting.catch(e => { void finish(run, message(e)); }).finally(() => { run.reconnecting = undefined; });
  };

  const start = () => {
    if (!enabled || !current() || runRef.current) return;
    if (microphoneOwner) {
      publish({ open: true, status: 'error', error: '麦克风正在其他面板使用或收尾，请稍后再试。' });
      return;
    }
    const run: Capture = { stopped: false, serverStarted: false, prefix: stateRef.current.text, retries: 0,
      audioSamples: 0, audioEnergy: 0, audioPeak: 0, recentLevel: 0, lastAudioAt: Date.now() };
    microphoneOwner = run; runRef.current = run;
    publish({ open: true, status: 'connecting', error: '', notice: '', audioLevel: 0, audioSeconds: 0 });
    run.starting = (async () => {
      const config = await api.getSttConfig(sessionId);
      if (run.stopped || !current()) return;
      const deviceId = deviceChoice ?? config?.deviceId ?? '';
      let stream: MediaStream;
      let usedDefault = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        } });
      } catch (e) {
        // 保存的 deviceId 属于浏览器/设备，失效时必须显式说明回落，权限错误不重试。
        if (!deviceId || run.stopped || !current() || !(e instanceof DOMException)
          || !['NotFoundError', 'OverconstrainedError'].includes(e.name)) throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        usedDefault = true;
      }
      if (run.stopped || !current()) { stream.getTracks().forEach(track => track.stop()); return; }
      run.stream = stream;
      const track = stream.getAudioTracks()[0];
      const actualId = track?.getSettings().deviceId;
      setDeviceLabel(track?.label || '系统默认麦克风');
      setDeviceNotice(usedDefault ? '原选麦克风不可用，已使用系统默认设备；可停止后切换。' : '');
      if (actualId) setDeviceChoice(actualId);
      // 枚举失败不影响已经取得的音轨；只显示实际设备，不把缺失标签猜成目标麦克风。
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (current()) setMicrophones(devices.filter(item => item.kind === 'audioinput')
          .map((item, index) => ({ id: item.deviceId, label: item.label || `麦克风 ${index + 1}` })));
      } catch { /* 已获准的采音可继续 */ }
      if (run.stopped || !current()) return;
      const result = await api.sttStreamStart(undefined, sessionId);
      if (!result.ok) throw new Error(result.error || '无法启动实时语音识别');
      run.serverStarted = true;
      if (run.stopped || !current()) return;
      subscribe(run);
      run.unsubscribeEnd = api.onSttStreamEnd(() => { if (run.worklet) reconnect(run); });
      // 使用设备的原生时钟，避免 Windows/WebView2 在采音入口被强制降采样。
      // pcm-worklet 按实际 sampleRate 统一输出 16 kHz PCM16。
      const context = new AudioContext({ latencyHint: 'interactive' }); run.context = context;
      await context.resume();
      if (run.stopped || !current()) return;
      await context.audioWorklet.addModule('./pcm-worklet.js');
      if (run.stopped || !current()) return;
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'pcm-processor', {
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      }); run.worklet = worklet;
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer | { type?: string }>) => {
        if (!(event.data instanceof ArrayBuffer)) {
          if (event.data?.type === 'flushed') run.flush?.();
          return;
        }
        if (!current() || (run.stopped && !run.flush) || run.reconnecting) return;
        const pcm = new Int16Array(event.data);
        let energy = 0;
        for (const sample of pcm) { energy += sample * sample; run.audioPeak = Math.max(run.audioPeak, Math.abs(sample)); }
        run.audioSamples += pcm.length; run.audioEnergy += energy; run.lastAudioAt = Date.now();
        const db = 20 * Math.log10(Math.max(1, Math.sqrt(energy / Math.max(1, pcm.length))) / 32768);
        run.recentLevel = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
        api.sttStreamAudioBinary(event.data);
      };
      source.connect(worklet);
      // 活动输出图用于驱动 Worklet；零增益避免麦克风回放。
      const silentSink = context.createGain(); silentSink.gain.value = 0;
      worklet.connect(silentSink); silentSink.connect(context.destination);
      run.lastAudioAt = Date.now();
      run.healthTimer = window.setInterval(() => {
        if (!current() || run.stopped || run.reconnecting) return;
        const seconds = run.audioSamples / 16000;
        const silent = run.audioSamples > 0 && Math.sqrt(run.audioEnergy / run.audioSamples) < 10;
        const notice = Date.now() - run.lastAudioAt > 3000 ? '没有收到麦克风音频，请检查设备是否被占用。'
          : seconds >= 3 && silent ? '麦克风声音过低，请检查所选设备或输入音量。'
          : seconds >= 8 && stateRef.current.text === run.prefix ? '已采到音频，实时识别尚未返回文字。' : '';
        publish({ audioSeconds: seconds, audioLevel: Date.now() - run.lastAudioAt > 1500 ? 0 : run.recentLevel, notice });
      }, 1000);
      publish({ status: 'listening' });
    })();
    void run.starting.catch(e => { void finish(run, message(e)); });
  };

  useEffect(() => {
    if (!enabled && runRef.current) void finish(runRef.current);
  }, [enabled]);
  useEffect(() => {
    alive.current = true;
    const dispose = () => {
      alive.current = false;
      const run = runRef.current;
      if (run) { closeAudio(run); void finish(run); }
    };
    const unsubscribe = onCurrentUserChanged((_profile, changed) => {
      if (changed) {
        dispose();
        stateRef.current = { text: '', open: false, status: 'idle', error: '', notice: '', audioLevel: 0, audioSeconds: 0 };
        setState(stateRef.current);
      }
    });
    return () => { unsubscribe(); dispose(); };
  }, []);

  const busy = !['idle', 'error'].includes(state.status);
  const clear = () => { if (!runRef.current) publish({ text: '', open: false, status: 'idle', error: '', notice: '', audioLevel: 0, audioSeconds: 0 }); };
  return { ...state, busy, start, microphones, deviceLabel, deviceNotice, deviceChoice: deviceChoice ?? '',
    selectDevice: (id: string) => { if (!runRef.current) { setDeviceChoice(id); setDeviceNotice(''); } },
    stop: () => { if (runRef.current) void finish(runRef.current); },
    setOpen: (open: boolean) => publish({ open }),
    clear,
    apply: (append: (text: string) => boolean) => {
      if (!current() || runRef.current || !stateRef.current.text.trim()) return;
      if (append(stateRef.current.text)) clear();
    },
  };
}
