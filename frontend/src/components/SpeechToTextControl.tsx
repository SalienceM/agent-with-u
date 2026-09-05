import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

type MicStatus = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'finalizing' | 'error';

interface Props {
  sessionId: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}

/** 与主聊天框相同的数据通道：实时 ASR 写入输入框，停止后做最终转写/精校，但不自动发送。 */
export const SpeechToTextControl: React.FC<Props> = ({ sessionId, value, onValueChange, disabled = false }) => {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<MicStatus>('idle');
  const [message, setMessage] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const prefixRef = useRef('');
  const stoppedRef = useRef(true);
  const flushResolveRef = useRef<(() => void) | null>(null);
  const valueRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  valueRef.current = value;
  onValueChangeRef.current = onValueChange;

  const applyTranscript = useCallback((transcript: string) => {
    const prefix = prefixRef.current.trimEnd();
    onValueChangeRef.current(prefix ? `${prefix}\n${transcript}` : transcript);
  }, []);

  const releaseLocalAudio = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (workletRef.current) {
      try { workletRef.current.port.close(); } catch { /* already closed */ }
      try { workletRef.current.disconnect(); } catch { /* already disconnected */ }
      workletRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
  }, []);

  const flushWorklet = useCallback(async () => {
    const worklet = workletRef.current;
    if (!worklet) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        flushResolveRef.current = null;
        resolve();
      };
      flushResolveRef.current = finish;
      worklet.port.postMessage({ type: 'flush' });
      window.setTimeout(finish, 150);
    });
  }, []);

  const stop = useCallback(async () => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    setStatus('finalizing');
    setMessage('正在确认最后一句…');
    await flushWorklet();
    releaseLocalAudio();
    try {
      const result = await api.sttStreamStop(sessionId);
      if (result.ok && result.text) {
        applyTranscript(result.text);
        setMessage(result.refinedByFlash
          ? '已完成语音转写与短音频精校'
          : result.refineError
            ? `已保留实时转写；精校失败：${result.refineError}`
            : result.refineSkipped || '语音已写入输入框');
      } else if (!result.ok && result.error !== 'No active STT stream') {
        setMessage(result.error || '语音转写停止失败');
        setStatus('error');
        setActive(false);
        return;
      }
      setStatus('idle');
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || '语音转写停止失败');
    } finally {
      setActive(false);
    }
  }, [applyTranscript, flushWorklet, releaseLocalAudio, sessionId]);

  const subscribe = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = api.onSttStreamText((data) => applyTranscript(data.text || ''));
  }, [applyTranscript]);

  const start = useCallback(async () => {
    if (!sessionId || disabled) return;
    stoppedRef.current = false;
    prefixRef.current = valueRef.current;
    setActive(true);
    setStatus('connecting');
    setMessage('正在连接语音识别…');
    let serverStarted = false;
    try {
      const config = await api.getSttConfig(sessionId);
      if (stoppedRef.current) return;
      const deviceId = config?.deviceId || '';
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        if (!deviceId) throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (stoppedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const result = await api.sttStreamStart(undefined, sessionId);
      if (!result.ok) throw new Error(result.error || 'STT stream start failed');
      serverStarted = true;
      if (stoppedRef.current) {
        await api.sttStreamStop(sessionId).catch(() => {});
        releaseLocalAudio();
        return;
      }
      subscribe();

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      await audioContext.resume();
      await audioContext.audioWorklet.addModule('./pcm-worklet.js');
      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioContext, 'pcm-processor');
      workletRef.current = worklet;
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer | { type?: string }>) => {
        if (!(event.data instanceof ArrayBuffer)) {
          if (event.data?.type === 'flushed') flushResolveRef.current?.();
          return;
        }
        if (stoppedRef.current && !flushResolveRef.current) return;
        api.sttStreamAudioBinary(event.data);
      };
      source.connect(worklet);
      const silentSink = audioContext.createGain();
      silentSink.gain.value = 0;
      worklet.connect(silentSink);
      silentSink.connect(audioContext.destination);
      setStatus('listening');
      setMessage('识别中；内容只写入输入框，不会自动发送');
    } catch (error: any) {
      stoppedRef.current = true;
      if (serverStarted) await api.sttStreamStop(sessionId).catch(() => {});
      releaseLocalAudio();
      setActive(false);
      setStatus('error');
      setMessage(error?.message || '无法启动语音识别');
    }
  }, [disabled, releaseLocalAudio, sessionId, subscribe]);

  const reconnect = useCallback(async () => {
    if (stoppedRef.current) return;
    setStatus('reconnecting');
    setMessage('语音连接中断，正在恢复…');
    prefixRef.current = valueRef.current;
    try {
      const result = await api.sttStreamStart(undefined, sessionId);
      if (!result.ok) throw new Error(result.error || '语音重连失败');
      subscribe();
      setStatus('listening');
      setMessage('识别中；内容只写入输入框，不会自动发送');
    } catch (error: any) {
      stoppedRef.current = true;
      releaseLocalAudio();
      setActive(false);
      setStatus('error');
      setMessage(error?.message || '语音连接已断开');
    }
  }, [releaseLocalAudio, sessionId, subscribe]);

  useEffect(() => api.onSttStreamEnd(() => { if (!stoppedRef.current) void reconnect(); }), [reconnect]);
  useEffect(() => () => {
    if (!stoppedRef.current) {
      stoppedRef.current = true;
      releaseLocalAudio();
      void api.sttStreamStop(sessionId).catch(() => {});
    }
  }, [releaseLocalAudio, sessionId]);

  const busy = status === 'connecting' || status === 'reconnecting' || status === 'finalizing';
  return (
    <div style={rootStyle}>
      <button
        type="button"
        onClick={() => { if (active) void stop(); else void start(); }}
        disabled={disabled && !active}
        style={{ ...buttonStyle, ...(active ? activeButtonStyle : {}), opacity: (disabled && !active) ? 0.42 : 1 }}
        title={active ? '停止并转成文字' : '语音转文字（不会自动发送）'}
        aria-label={active ? '停止语音转写' : '开始语音转文字'}
      >{busy ? '…' : '🎙️'}</button>
      {message && <div role={status === 'error' ? 'alert' : undefined} style={{ ...statusStyle, color: status === 'error' ? 'var(--theme-error, #ef4444)' : 'var(--theme-text-muted)' }}>{message}</div>}
    </div>
  );
};

const rootStyle: React.CSSProperties = { position: 'relative', flexShrink: 0 };
const buttonStyle: React.CSSProperties = {
  width: 42, height: 40, borderRadius: 10, border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)', fontSize: 16,
  cursor: 'pointer', display: 'grid', placeItems: 'center',
};
const activeButtonStyle: React.CSSProperties = {
  color: '#fff', background: '#e34b4f', borderColor: '#e34b4f',
  boxShadow: '0 0 0 4px rgba(227,75,79,.13)',
};
const statusStyle: React.CSSProperties = {
  position: 'absolute', right: 0, bottom: 47, zIndex: 4, width: 250,
  padding: '7px 9px', border: '1px solid var(--theme-border)', borderRadius: 8,
  background: 'var(--theme-bg-secondary)', boxShadow: '0 8px 24px rgba(0,0,0,.22)',
  fontSize: 10.5, lineHeight: 1.45,
};
