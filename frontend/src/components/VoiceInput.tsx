/**
 * VoiceInput — 语音输入组件
 *
 * 功能：录音 → 转写 → 编辑 → AI 润色 → 插入到输入框
 */
import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { api } from '../api';

// ═══════════════════════════════════════
//  Types
// ═══════════════════════════════════════

interface VoiceInputProps {
  sessionId?: string;
  onInsert: (text: string) => void;
  onClose: () => void;
}

type Phase = 'idle' | 'recording' | 'transcribing' | 'editing' | 'refining';

// ═══════════════════════════════════════
//  Styles
// ═══════════════════════════════════════

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  zIndex: 9000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  borderRadius: 16,
  padding: 24,
  width: 520,
  maxWidth: '92vw',
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
  color: 'var(--theme-text, #1f2328)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const recBtnStyle: React.CSSProperties = {
  width: 80,
  height: 80,
  borderRadius: '50%',
  border: 'none',
  cursor: 'pointer',
  fontSize: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 0.15s, box-shadow 0.15s',
  alignSelf: 'center',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 120,
  maxHeight: 300,
  padding: 12,
  borderRadius: 8,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-input-bg, #fff)',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 14,
  lineHeight: 1.6,
  resize: 'vertical',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
};

const btnBase: React.CSSProperties = {
  padding: '6px 16px',
  borderRadius: 8,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-bg, #fff)',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 500,
  transition: 'opacity 0.15s',
};

const primaryBtn: React.CSSProperties = {
  ...btnBase,
  background: 'var(--theme-accent, #0969da)',
  color: '#fff',
  border: 'none',
};

const dangerBtn: React.CSSProperties = {
  ...btnBase,
  color: 'var(--theme-error, #cf222e)',
};

const statusStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--theme-text-muted, #656d76)',
  textAlign: 'center',
};

const timerStyle: React.CSSProperties = {
  fontSize: 24,
  fontFamily: 'monospace',
  fontWeight: 600,
  color: 'var(--theme-text, #1f2328)',
  textAlign: 'center',
};

const levelBarContainer: React.CSSProperties = {
  display: 'flex',
  gap: 3,
  justifyContent: 'center',
  alignItems: 'flex-end',
  height: 40,
};

// ═══════════════════════════════════════
//  Component
// ═══════════════════════════════════════

const VoiceInput: React.FC<VoiceInputProps> = memo(function VoiceInput({
  sessionId,
  onInsert,
  onClose,
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  // ── 清理 ────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      cancelAnimationFrame(animRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── 音量可视化 ────────────────────────────────
  const startLevelMeter = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
      analyserRef.current = analyser;

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const bars = Array.from({ length: 16 }, (_, i) => {
          const idx = Math.floor((i / 16) * buf.length);
          return buf[idx] / 255;
        });
        setLevels(bars);
        animRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // AudioContext not supported — ignore
    }
  }, []);

  // ── 开始录音 ─────────────────────────────────
  const startRecording = useCallback(async () => {
    setError('');
    setTranscript('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        clearInterval(timerRef.current);
        cancelAnimationFrame(animRef.current);
        setLevels(Array(16).fill(0));
        stream.getTracks().forEach((t) => t.stop());
        handleTranscribe();
      };
      mr.start(250);
      mediaRecorderRef.current = mr;
      setPhase('recording');
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((v) => v + 1), 1000);
      startLevelMeter(stream);
    } catch (e: any) {
      setError(`麦克风访问失败: ${e.message || e}`);
    }
  }, [startLevelMeter]);

  // ── 停止录音 ─────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // ── 转写 ─────────────────────────────────────
  const handleTranscribe = useCallback(async () => {
    setPhase('transcribing');
    setError('');
    try {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      const buf = await blob.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const res = await api.sttTranscribe(b64);
      if (res.ok && res.text) {
        setTranscript(res.text);
        setPhase('editing');
      } else {
        setError(res.error || '转写失败');
        setPhase('idle');
      }
    } catch (e: any) {
      setError(e.message || '转写异常');
      setPhase('idle');
    }
  }, []);

  // ── AI 润色 ──────────────────────────────────
  const handleRefine = useCallback(async () => {
    if (!transcript.trim()) return;
    setPhase('refining');
    setError('');
    try {
      const res = await api.sttRefine(transcript, sessionId);
      if (res.ok && res.text) {
        setTranscript(res.text);
      } else {
        setError(res.error || '润色失败');
      }
    } catch (e: any) {
      setError(e.message || '润色异常');
    } finally {
      setPhase('editing');
    }
  }, [transcript, sessionId]);

  // ── 插入到输入框 ──────────────────────────────
  const handleInsert = useCallback(() => {
    if (transcript.trim()) {
      onInsert(transcript.trim());
    }
    onClose();
  }, [transcript, onInsert, onClose]);

  // ── 重新录音 ──────────────────────────────────
  const handleReRecord = useCallback(() => {
    setTranscript('');
    setError('');
    setPhase('idle');
  }, []);

  // ── 格式化时间 ────────────────────────────────
  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ── Render ───────────────────────────────────
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={titleStyle}>
          🎙️ 语音输入
          {phase === 'recording' && (
            <span style={{ fontSize: 12, color: '#f85149', fontWeight: 400 }}>● 录音中</span>
          )}
        </h3>

        {/* ── 空闲 / 录音阶段 ── */}
        {(phase === 'idle' || phase === 'recording') && (
          <>
            {/* 音量条 */}
            <div style={levelBarContainer}>
              {levels.map((v, i) => (
                <div
                  key={i}
                  style={{
                    width: 4,
                    borderRadius: 2,
                    background: phase === 'recording'
                      ? `rgba(248,81,73,${0.4 + v * 0.6})`
                      : 'var(--theme-border, rgba(0,0,0,0.12))',
                    height: `${Math.max(4, v * 36)}px`,
                    transition: 'height 0.08s',
                  }}
                />
              ))}
            </div>

            {/* 计时器 */}
            {phase === 'recording' && <div style={timerStyle}>{fmt(elapsed)}</div>}

            {/* 录音按钮 */}
            <button
              style={{
                ...recBtnStyle,
                background: phase === 'recording' ? '#f85149' : 'var(--theme-accent, #0969da)',
                color: '#fff',
                boxShadow: phase === 'recording'
                  ? '0 0 0 6px rgba(248,81,73,0.25)'
                  : '0 0 0 4px rgba(9,105,218,0.15)',
              }}
              onClick={phase === 'recording' ? stopRecording : startRecording}
              title={phase === 'recording' ? '停止录音' : '开始录音'}
            >
              {phase === 'recording' ? '⏹' : '🎤'}
            </button>

            <div style={statusStyle}>
              {phase === 'idle' ? '点击开始录音' : '再次点击停止，将自动转写'}
            </div>
          </>
        )}

        {/* ── 转写中 ── */}
        {phase === 'transcribing' && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
            <div style={statusStyle}>正在转写语音...</div>
          </div>
        )}

        {/* ── 编辑 / 润色 阶段 ── */}
        {(phase === 'editing' || phase === 'refining') && (
          <>
            <textarea
              style={textareaStyle}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="转写结果将显示在这里..."
              disabled={phase === 'refining'}
            />
            {phase === 'refining' && (
              <div style={statusStyle}>AI 正在润色...</div>
            )}
            <div style={toolbarStyle}>
              <button style={dangerBtn} onClick={handleReRecord}>
                🔄 重新录音
              </button>
              <button
                style={btnBase}
                onClick={handleRefine}
                disabled={phase === 'refining' || !transcript.trim()}
                title="用 AI 整理口语化文本，去除语气词、补全标点、合并零散想法"
              >
                ✨ AI 润色
              </button>
              <button
                style={primaryBtn}
                onClick={handleInsert}
                disabled={!transcript.trim()}
              >
                📝 插入输入框
              </button>
            </div>
          </>
        )}

        {/* ── 错误提示 ── */}
        {error && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(248,81,73,0.1)',
              color: '#f85149',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {/* ── 底部关闭 ── */}
        <div style={{ textAlign: 'center' }}>
          <button style={{ ...btnBase, fontSize: 12 }} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
});

export default VoiceInput;
