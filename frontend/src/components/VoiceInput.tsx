import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { api } from '../api';

export interface VoiceInputHandle {
  stopRecording: () => void;
}

interface VoiceInputProps {
  sessionId?: string;
  onInsert: (text: string) => void;
  onClose: () => void;
  onPhaseChange?: (phase: string | null) => void;
}

type Phase = 'recording' | 'transcribing' | 'editing' | 'refining';

const SPEECH_LANG_MAP: Record<string, string> = {
  zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
};

const SpeechRecognitionCtor: (new () => any) | null =
  typeof window !== 'undefined'
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

const VoiceInput = forwardRef<VoiceInputHandle, VoiceInputProps>(function VoiceInput(
  { sessionId, onInsert, onClose, onPhaseChange },
  ref,
) {
  const [phase, setPhaseRaw] = useState<Phase>('recording');
  const [transcript, setTranscript] = useState('');
  const [interimText, setInterimText] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const animRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mountedRef = useRef(true);
  const recognitionRef = useRef<any>(null);
  const speechFinalRef = useRef('');
  const speechInterimRef = useRef('');

  const onPhaseChangeRef = useRef(onPhaseChange);
  onPhaseChangeRef.current = onPhaseChange;

  const setPhase = useCallback((p: Phase) => {
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
      try { recognitionRef.current?.abort(); } catch {}
      onPhaseChangeRef.current?.(null);
    };
  }, []);

  const startLevelMeter = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
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
    } catch {}
  }, []);

  // ── Web Speech API for real-time interim text ──
  const startSpeechRecognition = useCallback((lang: string) => {
    if (!SpeechRecognitionCtor) return;
    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = SPEECH_LANG_MAP[lang] || lang || 'zh-CN';

      recognition.onresult = (event: any) => {
        if (!mountedRef.current) return;
        let finalAccum = '';
        let interim = '';
        for (let i = 0; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalAccum += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        speechFinalRef.current = finalAccum;
        speechInterimRef.current = interim;
        setInterimText(finalAccum + interim);
      };
      recognition.onerror = () => {};
      recognition.onend = () => {
        if (mountedRef.current && mediaRecorderRef.current?.state === 'recording') {
          try { recognition.start(); } catch {}
        }
      };
      recognition.start();
      recognitionRef.current = recognition;
    } catch {}
  }, []);

  const doTranscribe = useCallback(async () => {
    setPhase('transcribing');
    setError('');
    try {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
      }
      const b64 = btoa(binary);
      const res = await api.sttTranscribe(b64);
      if (!mountedRef.current) return;
      if (res.ok && res.text) {
        setTranscript(res.text);
        setPhase('editing');
      } else {
        // Backend failed — use Web Speech API result as fallback
        const fallback = (speechFinalRef.current + speechInterimRef.current).trim();
        if (fallback) {
          setTranscript(fallback);
          setPhase('editing');
        } else {
          setError(res.error || '转写失败');
          setPhase('editing');
        }
      }
    } catch (e: any) {
      if (!mountedRef.current) return;
      const fallback = (speechFinalRef.current + speechInterimRef.current).trim();
      if (fallback) {
        setTranscript(fallback);
        setPhase('editing');
      } else {
        setError(e.message || '转写异常');
        setPhase('editing');
      }
    }
  }, [setPhase]);

  const doTranscribeRef = useRef(doTranscribe);
  doTranscribeRef.current = doTranscribe;

  const startRecording = useCallback(async () => {
    setError('');
    setTranscript('');
    setInterimText('');
    speechFinalRef.current = '';
    speechInterimRef.current = '';
    try {
      const cfg = await api.getSttConfig();
      if (!mountedRef.current) return;
      const deviceId = cfg?.deviceId || '';
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      if (!mountedRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        clearInterval(timerRef.current);
        cancelAnimationFrame(animRef.current);
        setLevels(Array(16).fill(0));
        stream.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        try { recognitionRef.current?.stop(); } catch {}
        doTranscribeRef.current();
      };
      mr.start(250);
      mediaRecorderRef.current = mr;
      setPhase('recording');
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(v => v + 1), 1000);
      startLevelMeter(stream);
      startSpeechRecognition(cfg?.language || 'zh');
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(`麦克风访问失败: ${e.message || e}`);
    }
  }, [startLevelMeter, setPhase, startSpeechRecognition]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  useImperativeHandle(ref, () => ({ stopRecording }), [stopRecording]);

  const handleRefine = useCallback(async () => {
    if (!transcript.trim()) return;
    setPhase('refining');
    setError('');
    try {
      const res = await api.sttRefine(transcript, sessionId);
      if (!mountedRef.current) return;
      if (res.ok && res.text) setTranscript(res.text);
      else setError(res.error || '润色失败');
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e.message || '润色异常');
    } finally {
      if (mountedRef.current) setPhase('editing');
    }
  }, [transcript, sessionId, setPhase]);

  const handleInsert = useCallback(() => {
    if (transcript.trim()) onInsert(transcript.trim());
    onClose();
  }, [transcript, onInsert, onClose]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  useEffect(() => { startRecording(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={panelStyle}>
      {phase === 'recording' && (
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
          <button onClick={stopRecording} style={inlineStopBtn} title="停止录音">
            ⏹ 停止
          </button>
        </div>
      )}

      {/* Live interim text from Web Speech API — visible during recording & transcribing */}
      {(phase === 'recording' || phase === 'transcribing') && interimText && (
        <div style={interimStyle}>{interimText}</div>
      )}

      {phase === 'transcribing' && (
        <div style={recordBarStyle}>
          <span style={{ fontSize: 14, animation: 'chat-pulse 1.5s infinite' }}>⏳</span>
          <span style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)' }}>转写中...</span>
        </div>
      )}

      {(phase === 'editing' || phase === 'refining') && (
        <div style={editPanelStyle}>
          <textarea
            style={editTextareaStyle}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            disabled={phase === 'refining'}
            rows={2}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {phase === 'refining' && (
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>润色中...</span>
            )}
            <div style={{ flex: 1 }} />
            <button style={tinyBtnStyle} onClick={onClose} title="取消">✕</button>
            <button
              style={tinyBtnStyle}
              onClick={handleRefine}
              disabled={phase === 'refining' || !transcript.trim()}
              title="AI 润色"
            >✨</button>
            <button
              style={{ ...tinyBtnStyle, background: 'var(--theme-accent, #0969da)', color: '#fff', border: 'none' }}
              onClick={handleInsert}
              disabled={!transcript.trim()}
              title="插入到输入框"
            >↵ 插入</button>
          </div>
        </div>
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

const editPanelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  padding: '8px 12px', borderRadius: 8,
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
};

const editTextareaStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-input-bg, #fff)', color: 'var(--theme-text, #1f2328)',
  fontSize: 13, lineHeight: 1.5, resize: 'vertical', fontFamily: 'inherit',
  outline: 'none', boxSizing: 'border-box' as const, maxHeight: 120,
};

const tinyBtnStyle: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-bg, #fff)', color: 'var(--theme-text, #1f2328)',
  fontSize: 12, cursor: 'pointer', fontWeight: 500,
  transition: 'opacity 0.15s', whiteSpace: 'nowrap' as const,
};
