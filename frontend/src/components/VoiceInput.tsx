import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { api } from '../api';

const REALTIME_MODELS = new Set([
  'qwen3-asr-flash-realtime',
  'qwen3-asr-flash-realtime-2026-02-10',
  'qwen3-asr-flash-realtime-2025-10-27',
]);

function float32ToB64(floats: Float32Array): string {
  const pcm = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

async function convertToWavBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  const tempCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await tempCtx.decodeAudioData(arrayBuf);
  } finally {
    await tempCtx.close().catch(() => {});
  }

  const targetRate = 16000;
  const numSamples = Math.ceil(decoded.duration * targetRate);
  const offlineCtx = new OfflineAudioContext(1, numSamples, targetRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();
  const floats = rendered.getChannelData(0);

  const pcm = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const wavBuf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(wavBuf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, targetRate, true);
  dv.setUint32(28, targetRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, pcm.byteLength, true);
  new Uint8Array(wavBuf, 44).set(new Uint8Array(pcm.buffer));

  const bytes = new Uint8Array(wavBuf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

export interface VoiceInputHandle {
  stopRecording: () => void;
}

interface VoiceInputProps {
  onInsert: (text: string) => void;
  onClose: () => void;
  onPhaseChange?: (phase: string | null) => void;
}

const VoiceInput = forwardRef<VoiceInputHandle, VoiceInputProps>(function VoiceInput(
  { onInsert, onClose, onPhaseChange },
  ref,
) {
  const [phase, setPhaseRaw] = useState<'recording' | 'transcribing'>('recording');
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));

  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const animRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mountedRef = useRef(true);
  const isRealtimeRef = useRef(false);
  const stoppedRef = useRef(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const onPhaseChangeRef = useRef(onPhaseChange);
  onPhaseChangeRef.current = onPhaseChange;
  const onInsertRef = useRef(onInsert);
  onInsertRef.current = onInsert;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const setPhase = useCallback((p: 'recording' | 'transcribing') => {
    setPhaseRaw(p);
    onPhaseChangeRef.current?.(p);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearInterval(timerRef.current);
      cancelAnimationFrame(animRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close().catch(() => {});
      unsubRef.current?.();
      onPhaseChangeRef.current?.(null);
    };
  }, []);

  // ── Level meter (shared for both paths) ──
  const startLevelMeter = useCallback((analyser: AnalyserNode) => {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!mountedRef.current) return;
      analyser.getByteFrequencyData(buf);
      const bars = Array.from({ length: 16 }, (_, i) => {
        const idx = Math.floor((i / 16) * buf.length);
        return buf[idx] / 255;
      });
      setLevels(bars);
      animRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  // ── Realtime streaming path ──
  const startRealtimeStream = useCallback(async (stream: MediaStream) => {
    const res = await api.sttStreamStart();
    if (!res.ok) throw new Error(res.error || 'STT stream start failed');

    const unsub = api.onSttStreamText((data) => {
      if (!mountedRef.current) return;
      setLiveText(data.text);
      onInsertRef.current(data.text);
    });
    unsubRef.current = unsub;

    const audioCtx = new AudioContext({ sampleRate: 16000 });
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);

    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (stoppedRef.current) return;
      api.sttStreamAudio(float32ToB64(e.inputBuffer.getChannelData(0)));
    };
    analyser.connect(processor);
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    processor.connect(gain);
    gain.connect(audioCtx.destination);

    startLevelMeter(analyser);
  }, [startLevelMeter]);

  // ── Non-realtime MediaRecorder path ──
  const startMediaRecorder = useCallback((stream: MediaStream) => {
    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    startLevelMeter(analyser);

    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    chunksRef.current = [];
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.onstop = async () => {
      if (!mountedRef.current) return;
      setPhaseRaw('transcribing');
      onPhaseChangeRef.current?.('transcribing');
      try {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const b64 = await convertToWavBase64(blob);
        const res = await api.sttTranscribe(b64);
        if (!mountedRef.current) return;
        if (res.ok && res.text) {
          onInsertRef.current(res.text);
        } else {
          setError(res.error || '转写失败');
          return;
        }
      } catch (e: any) {
        if (!mountedRef.current) return;
        setError(e.message || '转写异常');
        return;
      }
      if (mountedRef.current) onCloseRef.current();
    };
    mr.start(250);
    mediaRecorderRef.current = mr;
  }, [startLevelMeter]);

  // ── Entry point ──
  const startRecording = useCallback(async () => {
    setError('');
    setLiveText('');
    stoppedRef.current = false;
    try {
      const cfg = await api.getSttConfig();
      if (!mountedRef.current) return;
      const deviceId = cfg?.deviceId || '';
      const isRealtime = REALTIME_MODELS.has(cfg?.apiModel || '');
      isRealtimeRef.current = isRealtime;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
      } catch (devErr) {
        if (deviceId) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw devErr;
        }
      }
      if (!mountedRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;

      if (isRealtime) {
        await startRealtimeStream(stream);
      } else {
        startMediaRecorder(stream);
      }

      setPhase('recording');
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(v => v + 1), 1000);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(`麦克风访问失败: ${e.message || e}`);
    }
  }, [startRealtimeStream, startMediaRecorder, setPhase]);

  const stopRecording = useCallback(async () => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    clearInterval(timerRef.current);
    cancelAnimationFrame(animRef.current);
    setLevels(Array(16).fill(0));

    if (isRealtimeRef.current) {
      setPhase('transcribing');
      unsubRef.current?.();
      unsubRef.current = null;
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      try {
        const res = await api.sttStreamStop();
        if (mountedRef.current && res.ok && res.text) {
          onInsertRef.current(res.text);
        }
      } catch {}
      if (mountedRef.current) onCloseRef.current();
    } else {
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    }
  }, [setPhase]);

  useImperativeHandle(ref, () => ({ stopRecording }), [stopRecording]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  useEffect(() => { startRecording(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={panelStyle}>
      <div style={recordBarStyle}>
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 20 }}>
          {levels.map((v, i) => (
            <div key={i} style={{
              width: 2.5, borderRadius: 1,
              background: `rgba(248,81,73,${0.4 + v * 0.6})`,
              height: `${Math.max(2, v * 18)}px`,
              transition: 'height 0.08s',
            }} />
          ))}
        </div>
        <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>
          {fmt(elapsed)}
        </span>
        {phase === 'transcribing' && (
          <span style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)' }}>转写中...</span>
        )}
        {phase === 'recording' && (
          <button onClick={stopRecording} style={inlineStopBtn} title="停止录音">
            ⏹ 停止
          </button>
        )}
      </div>

      {liveText && (
        <div style={interimStyle}>{liveText}</div>
      )}

      {error && (
        <div style={{ padding: '4px 8px', fontSize: 11, color: '#f85149', background: 'rgba(248,81,73,0.08)', borderRadius: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
});

export default VoiceInput;

const panelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6,
};

const recordBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '6px 12px', borderRadius: 8,
  background: 'rgba(248,81,73,0.06)',
  border: '1px solid rgba(248,81,73,0.15)',
};

const inlineStopBtn: React.CSSProperties = {
  marginLeft: 'auto', padding: '3px 10px', borderRadius: 6,
  border: '1px solid rgba(248,81,73,0.3)', background: 'rgba(248,81,73,0.1)',
  color: '#f85149', fontSize: 12, cursor: 'pointer', fontWeight: 500,
};

const interimStyle: React.CSSProperties = {
  padding: '4px 12px', fontSize: 13, lineHeight: 1.5,
  color: 'var(--theme-text-muted, #656d76)', fontStyle: 'italic',
  maxHeight: 80, overflow: 'auto',
  borderLeft: '2px solid rgba(248,81,73,0.3)',
};
