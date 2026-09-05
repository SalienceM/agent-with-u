import React, { useEffect, useRef, useState } from 'react';
import { api, type TtsStreamAudioEvent } from '../api';
import {
  ToolAwareSpeechGate,
  VoiceSummaryProjector,
  base64ToArrayBuffer,
  computeTurnEndSilenceMs,
  createVoiceStreamId,
  echoProtectedBargeIn,
  isLikelyPlaybackEcho,
  isSpeakableAgentDelta,
  matchWakeDirectedInterruption,
  matchWakePhrase,
  normalizeContinuousVoiceWindowMs,
  pcm16Rms,
  pickWakeAcknowledgement,
  resolveRealtimeVoiceInteractionMode,
  resolveWakeUtteranceCommand,
  shouldRelockContinuousVoice,
  systemSpeechRate,
  updatePlaybackEchoFloor,
  type RealtimeVoiceInteractionMode,
  type WakePhraseMatch,
} from '../utils/realtimeVoice';

type VoicePhase =
  | 'idle'
  | 'starting'
  | 'standby'
  | 'listening'
  | 'finalizing'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'interrupted'
  | 'error';

type WakeFeedback = 'locked' | 'acknowledging' | 'ready';

interface Props {
  sessionId: string;
  backendLabel: string;
  isStreaming: boolean;
  isFocused: boolean;
  voice: string;
  rate: number;
  turnEndSilenceMs?: number;
  continuousWindowMs?: number;
  wakeWord?: string;
  ttsEngine?: 'system' | 'edge' | 'dashscope';
  systemVoice?: string;
  dashscopeModel?: string;
  dashscopeVoice?: string;
  vadThreshold?: number;
  bargeIn?: boolean;
  onSend: (text: string, interactionMode: RealtimeVoiceInteractionMode) => void;
  onAbort: () => void;
  onActiveChange?: (active: boolean) => void;
  /** 可把主对话 streamDelta 换成旁路/其它确定来源，同时复用整套 STT/TTS 体验。 */
  subscribeToReply?: (handler: (delta: any) => void) => () => void;
  /** 同一页面只允许一个实时语音所有者，新的所有者会让旧链路自动收声。 */
  voiceOwnerId?: string;
  compact?: boolean;
}

const PHASE_LABELS: Record<VoicePhase, string> = {
  idle: '未开启',
  starting: '正在建立语音链路',
  standby: '等待唤醒',
  listening: '正在听',
  finalizing: '正在确认转写',
  thinking: '模型生成中',
  working: 'Agent 正在使用工具',
  speaking: '正在播放',
  interrupted: '已打断，重新听取',
  error: '语音链路异常',
};

const MAX_PREROLL_FRAMES = 8;
const MAX_STARTUP_FRAMES = 30;
const TTS_EVENT_TIMEOUT_MS = 30_000;
const DASHSCOPE_FINISH_TIMEOUT_MS = 45_000;
const TTS_LOOKAHEAD_CHUNKS = 4;
const MAX_QUEUED_SPEECH_CHUNKS = 160;
const SYSTEM_SPEECH_TIMEOUT_MS = 12_000;
const SPEECH_COMMIT_DELAY_MS = 260;
const ECHO_SETTLE_MS = 380;
const BARGE_PROBE_MAX_MS = 8_000;
const WAKE_ACK_ECHO_BLOCK_MS = 800;
const WAKE_ACK_TIMEOUT_MS = 3_500;

function systemSpeechAvailable(): boolean {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof SpeechSynthesisUtterance !== 'undefined';
}

function selectSystemSpeechVoice(
  preferredVoice: string,
  edgeVoice: string,
): SpeechSynthesisVoice | null {
  if (!systemSpeechAvailable()) return null;
  const voices = window.speechSynthesis.getVoices();
  const exactPreference = preferredVoice.trim();
  if (exactPreference) {
    const exact = voices.find((item) => (
      item.voiceURI === exactPreference || item.name === exactPreference
    ));
    if (exact) return exact;
  }
  const chinese = voices.filter((item) => /^zh(?:-|_)/i.test(item.lang));
  const preferredName = /-([A-Za-z]+)Neural$/i.exec(edgeVoice)?.[1]?.toLowerCase() || '';
  return chinese.find((item) => preferredName && item.name.toLowerCase().includes(preferredName))
    || chinese.find((item) => /microsoft/i.test(item.name))
    || chinese[0]
    || voices[0]
    || null;
}

export const RealtimeVoiceBar: React.FC<Props> = ({
  sessionId,
  backendLabel,
  isStreaming,
  isFocused,
  voice,
  rate,
  turnEndSilenceMs = 1500,
  continuousWindowMs = 30_000,
  wakeWord = 'Yuki',
  ttsEngine = 'system',
  systemVoice = '',
  dashscopeModel = 'cosyvoice-v3-flash',
  dashscopeVoice = 'longxiaochun',
  vadThreshold = 0.018,
  bargeIn = true,
  onSend,
  onAbort,
  onActiveChange,
  subscribeToReply,
  voiceOwnerId = `main:${sessionId}`,
  compact = false,
}) => {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [asrModel, setAsrModel] = useState('Fun-ASR Realtime');
  const [firstAudioMs, setFirstAudioMs] = useState<number | null>(null);
  const [heardSpeech, setHeardSpeech] = useState(false);
  const [silenceRemainingMs, setSilenceRemainingMs] = useState<number | null>(null);
  const [playbackEngineLabel, setPlaybackEngineLabel] = useState('本机系统语音');
  const [agentActivity, setAgentActivity] = useState('');
  const [wakeFeedback, setWakeFeedback] = useState<WakeFeedback>('locked');

  const activeRef = useRef(false);
  const phaseRef = useRef<VoicePhase>('idle');
  const generationRef = useRef(0);
  const isStreamingRef = useRef(isStreaming);
  const onSendRef = useRef(onSend);
  const onAbortRef = useRef(onAbort);
  const onActiveChangeRef = useRef(onActiveChange);
  const turnEndSilenceMsRef = useRef(turnEndSilenceMs);
  const continuousWindowMsRef = useRef(continuousWindowMs);
  const wakeWordRef = useRef(wakeWord);
  const ttsEngineRef = useRef<'system' | 'edge' | 'dashscope'>(ttsEngine);
  const edgeVoiceRef = useRef(voice);
  const speechRateRef = useRef(rate);
  const systemVoiceRef = useRef(systemVoice);
  const dashscopeModelRef = useRef(dashscopeModel);
  const dashscopeVoiceRef = useRef(dashscopeVoice);
  const vadThresholdRef = useRef(vadThreshold);
  const bargeInRef = useRef(bargeIn);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const captureContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackGainRef = useRef<GainNode | null>(null);
  const playbackDuckedRef = useRef(false);
  const playbackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const pcmPlaybackSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const pcmPlaybackCursorRef = useRef(0);

  const sttActiveRef = useRef(false);
  const sttStartingRef = useRef(false);
  const finalizingRef = useRef(false);
  const latestTranscriptRef = useRef('');
  const preRollRef = useRef<ArrayBuffer[]>([]);
  const startupFramesRef = useRef<ArrayBuffer[]>([]);
  const speechFramesRef = useRef(0);
  const silenceAccumRef = useRef(0);
  const silenceRemainingRef = useRef<number | null>(null);
  const silenceUiUpdatedAtRef = useRef(0);
  const utteranceStartedAtRef = useRef(0);
  const bargeFramesRef = useRef(0);
  const bargeBusyRef = useRef(false);
  const bargeProbeStartingRef = useRef(false);
  const bargeProbeActiveRef = useRef(false);
  const bargeProbeFinalizingRef = useRef(false);
  const bargeProbeFramesRef = useRef<ArrayBuffer[]>([]);
  const bargeProbeTranscriptRef = useRef('');
  const bargeProbeStartedAtRef = useRef(0);
  const bargeProbeSilenceRef = useRef(0);
  const bargeProbeThresholdRef = useRef(0.04);
  const bargeProbeTimerRef = useRef<number | null>(null);
  const bargeProbeMatchRef = useRef<WakePhraseMatch | null>(null);
  const bargeAbortCommittedRef = useRef(false);
  const pendingBargeCommandRef = useRef<{ command: string } | null>(null);
  const ignoreSttEndUntilRef = useRef(0);
  const playbackStartedAtRef = useRef(0);
  const lastPlaybackEndedAtRef = useRef(0);
  const playbackEchoFloorRef = useRef(0);
  const startupAudioBlockedUntilRef = useRef(0);
  const replySpeechTextRef = useRef('');
  const echoReferenceRef = useRef('');
  const armedRef = useRef(false);
  const wakeMatchedUtteranceRef = useRef(false);
  const wakeTransitioningRef = useRef(false);
  const wakeRemainderRef = useRef('');
  const continuousLeaseTimerRef = useRef<number | null>(null);
  const continuousIdleStartedAtRef = useRef(0);

  const speechGateRef = useRef(new ToolAwareSpeechGate());
  const voiceSummaryProjectorRef = useRef(new VoiceSummaryProjector());
  const replyInteractionModeRef = useRef<RealtimeVoiceInteractionMode>(
    'realtime-voice-foreground',
  );
  const speechCommitTimerRef = useRef<number | null>(null);
  const activeToolIdsRef = useRef(new Set<string>());
  const replyExpectedRef = useRef(false);
  const replyMessageIdRef = useRef<string | null>(null);
  const ignoredMessageIdRef = useRef<string | null>(null);
  const suppressStreamUntilRef = useRef(0);
  const llmDoneRef = useRef(false);
  const replyStartedAtRef = useRef(0);
  const resumeScheduledRef = useRef(false);

  const ttsStreamIdRef = useRef('');
  const ttsSessionIdRef = useRef('');
  const firstAudioMsRef = useRef<number | null>(null);
  const nextTtsSeqRef = useRef(0);
  const expectedPlaybackSeqRef = useRef(0);
  const pendingTtsRef = useRef(new Set<number>());
  const ttsTimeoutsRef = useRef(new Map<number, number>());
  const decodedBuffersRef = useRef(new Map<number, AudioBuffer | null>());
  const speechChunkQueueRef = useRef<string[]>([]);
  const replyTtsEngineRef = useRef<'system' | 'edge' | 'dashscope'>('system');
  const dashscopeHadInputRef = useRef(false);
  const dashscopeFinishRequestedRef = useRef(false);
  const dashscopeFinishedRef = useRef(false);
  const dashscopeFailedRef = useRef(false);
  const dashscopeFinishTimeoutRef = useRef<number | null>(null);
  const systemSpeechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const systemSpeechTimeoutRef = useRef<number | null>(null);
  const wakeAcknowledgementRef = useRef<SpeechSynthesisUtterance | null>(null);
  const wakeAcknowledgementSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const wakeAcknowledgementCacheRef = useRef(new Map<string, AudioBuffer>());
  const wakeAcknowledgementPromiseRef = useRef(new Map<string, Promise<AudioBuffer>>());
  const wakeAcknowledgementRequestRef = useRef(0);
  const lastWakeAcknowledgementRef = useRef('');
  const wakeFeedbackRef = useRef<WakeFeedback>('locked');
  const wakeReadyTimerRef = useRef<number | null>(null);

  isStreamingRef.current = isStreaming;
  onSendRef.current = onSend;
  onAbortRef.current = onAbort;
  onActiveChangeRef.current = onActiveChange;
  turnEndSilenceMsRef.current = Math.max(900, Math.min(3000, turnEndSilenceMs));
  continuousWindowMsRef.current = normalizeContinuousVoiceWindowMs(continuousWindowMs);
  wakeWordRef.current = wakeWord;
  ttsEngineRef.current = ttsEngine;
  edgeVoiceRef.current = voice;
  speechRateRef.current = rate;
  systemVoiceRef.current = systemVoice;
  dashscopeModelRef.current = dashscopeModel;
  dashscopeVoiceRef.current = dashscopeVoice;
  vadThresholdRef.current = Math.max(0.004, Math.min(0.12, vadThreshold));
  bargeInRef.current = bargeIn;

  const updatePhase = (value: VoicePhase): void => {
    phaseRef.current = value;
    setPhase(value);
  };

  const updateWakeFeedback = (value: WakeFeedback): void => {
    wakeFeedbackRef.current = value;
    setWakeFeedback(value);
  };

  const clearWakeReadyTimer = (): void => {
    if (wakeReadyTimerRef.current !== null) {
      window.clearTimeout(wakeReadyTimerRef.current);
      wakeReadyTimerRef.current = null;
    }
  };

  const updateSilenceRemaining = (value: number | null): void => {
    const normalized = value === null ? null : Math.max(0, Math.round(value));
    if (silenceRemainingRef.current === normalized) return;
    silenceRemainingRef.current = normalized;
    setSilenceRemainingMs(normalized);
  };

  const clearTtsTimeout = (seq: number): void => {
    const timer = ttsTimeoutsRef.current.get(seq);
    if (timer !== undefined) window.clearTimeout(timer);
    ttsTimeoutsRef.current.delete(seq);
  };

  const clearSpeechCommitTimer = (): void => {
    if (speechCommitTimerRef.current !== null) {
      window.clearTimeout(speechCommitTimerRef.current);
      speechCommitTimerRef.current = null;
    }
  };

  const setPlaybackDucked = (ducked: boolean): void => {
    if (playbackDuckedRef.current === ducked) return;
    playbackDuckedRef.current = ducked;
    const context = playbackContextRef.current;
    const gain = playbackGainRef.current;
    if (context && gain) {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(Math.max(0.001, gain.gain.value), now);
      gain.gain.linearRampToValueAtTime(ducked ? 0.14 : 1, now + 0.035);
    }
    // Browser/system speech does not pass through Web Audio. Pause it while a
    // wake-word probe is listening, then resume if the probe was only echo.
    if (systemSpeechAvailable() && systemSpeechUtteranceRef.current) {
      if (ducked) window.speechSynthesis.pause();
      else window.speechSynthesis.resume();
    }
  };

  const clearPlaybackQueue = (): void => {
    if (playbackSourceRef.current) {
      try { playbackSourceRef.current.stop(); } catch { /* already ended */ }
      playbackSourceRef.current.onended = null;
      playbackSourceRef.current.disconnect();
      playbackSourceRef.current = null;
    }
    pcmPlaybackSourcesRef.current.forEach((source) => {
      try { source.stop(); } catch { /* already ended */ }
      source.onended = null;
      try { source.disconnect(); } catch { /* already disconnected */ }
    });
    pcmPlaybackSourcesRef.current.clear();
    pcmPlaybackCursorRef.current = 0;
    if (dashscopeFinishTimeoutRef.current !== null) {
      window.clearTimeout(dashscopeFinishTimeoutRef.current);
      dashscopeFinishTimeoutRef.current = null;
    }
    ttsTimeoutsRef.current.forEach((timer) => window.clearTimeout(timer));
    ttsTimeoutsRef.current.clear();
    pendingTtsRef.current.clear();
    decodedBuffersRef.current.clear();
    speechChunkQueueRef.current = [];
    nextTtsSeqRef.current = 0;
    expectedPlaybackSeqRef.current = 0;
    dashscopeHadInputRef.current = false;
    dashscopeFinishRequestedRef.current = false;
    dashscopeFinishedRef.current = false;
    dashscopeFailedRef.current = false;
    playbackEchoFloorRef.current = 0;
    setPlaybackDucked(false);
  };

  const cancelCurrentTts = (preserveWakeAcknowledgement = false): void => {
    const streamId = ttsStreamIdRef.current;
    const streamSessionId = ttsSessionIdRef.current || sessionId;
    ttsStreamIdRef.current = '';
    ttsSessionIdRef.current = '';
    const activeSystemReply = systemSpeechUtteranceRef.current;
    const activeWakeSource = wakeAcknowledgementSourceRef.current;
    const cancelSystemSpeech = !preserveWakeAcknowledgement || !!activeSystemReply;
    const hadPlayback = !!(
      playbackStartedAtRef.current
      || playbackSourceRef.current
      || pcmPlaybackSourcesRef.current.size > 0
      || activeSystemReply
      || (!preserveWakeAcknowledgement && wakeAcknowledgementRef.current)
      || (!preserveWakeAcknowledgement && activeWakeSource)
    );
    systemSpeechUtteranceRef.current = null;
    if (!preserveWakeAcknowledgement) {
      wakeAcknowledgementRequestRef.current += 1;
      wakeAcknowledgementRef.current = null;
      wakeAcknowledgementSourceRef.current = null;
      if (activeWakeSource) {
        activeWakeSource.onended = null;
        try { activeWakeSource.stop(); } catch { /* already ended */ }
        try { activeWakeSource.disconnect(); } catch { /* already disconnected */ }
      }
    }
    if (systemSpeechTimeoutRef.current !== null) {
      window.clearTimeout(systemSpeechTimeoutRef.current);
      systemSpeechTimeoutRef.current = null;
    }
    if (systemSpeechAvailable() && cancelSystemSpeech) window.speechSynthesis.cancel();
    clearPlaybackQueue();
    playbackStartedAtRef.current = 0;
    if (hadPlayback) lastPlaybackEndedAtRef.current = Date.now();
    if (streamId) void api.ttsStreamCancel(streamSessionId, streamId);
  };

  const resetVad = (assumeSpeech = false): void => {
    speechFramesRef.current = assumeSpeech ? 2 : 0;
    silenceAccumRef.current = 0;
    silenceUiUpdatedAtRef.current = 0;
    utteranceStartedAtRef.current = assumeSpeech ? Date.now() : 0;
    bargeFramesRef.current = 0;
    setHeardSpeech(assumeSpeech);
    updateSilenceRemaining(null);
  };

  const clearContinuousLease = (): void => {
    if (continuousLeaseTimerRef.current !== null) {
      window.clearTimeout(continuousLeaseTimerRef.current);
      continuousLeaseTimerRef.current = null;
    }
    continuousIdleStartedAtRef.current = 0;
  };

  const scheduleContinuousLease = (): void => {
    clearContinuousLease();
    const configuredWake = wakeWordRef.current.trim();
    if (
      !activeRef.current
      || !configuredWake
      || !armedRef.current
      || replyExpectedRef.current
      || wakeTransitioningRef.current
      || bargeProbeStartingRef.current
      || bargeProbeActiveRef.current
      || bargeProbeFinalizingRef.current
      || utteranceStartedAtRef.current
      || (phaseRef.current !== 'listening' && phaseRef.current !== 'standby')
    ) return;

    continuousIdleStartedAtRef.current = Date.now();
    continuousLeaseTimerRef.current = window.setTimeout(() => {
      continuousLeaseTimerRef.current = null;
      const busy = !!(
        replyExpectedRef.current
        || finalizingRef.current
        || wakeTransitioningRef.current
        || utteranceStartedAtRef.current
        || bargeProbeStartingRef.current
        || bargeProbeActiveRef.current
        || bargeProbeFinalizingRef.current
      );
      if (!activeRef.current || !armedRef.current) return;
      if (!shouldRelockContinuousVoice(
        wakeWordRef.current,
        Date.now() - continuousIdleStartedAtRef.current,
        continuousWindowMsRef.current,
        busy,
      )) {
        if (!busy) scheduleContinuousLease();
        return;
      }
      continuousIdleStartedAtRef.current = 0;
      armedRef.current = false;
      wakeMatchedUtteranceRef.current = false;
      wakeRemainderRef.current = '';
      updateWakeFeedback('locked');
      clearWakeReadyTimer();
      latestTranscriptRef.current = '';
      resetVad(false);
      setTranscript('');
      updatePhase('standby');
      setNotice(`连续对话已结束，请说“${wakeWordRef.current.trim()}”重新唤醒`);
    }, continuousWindowMsRef.current);
  };

  const clearBargeProbeTimer = (): void => {
    if (bargeProbeTimerRef.current !== null) {
      window.clearTimeout(bargeProbeTimerRef.current);
      bargeProbeTimerRef.current = null;
    }
  };

  const playWakeCue = (): void => {
    const context = playbackContextRef.current;
    if (!context) return;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(720, now);
      oscillator.frequency.linearRampToValueAtTime(920, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
      oscillator.connect(gain);
      gain.connect(playbackGainRef.current || context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.14);
    } catch { /* acknowledgement cue is best-effort */ }
  };

  const markWakeReady = (): void => {
    if (!activeRef.current || !armedRef.current) return;
    updateWakeFeedback('ready');
    if (
      phaseRef.current === 'listening'
      || phaseRef.current === 'interrupted'
      || phaseRef.current === 'standby'
    ) {
      setNotice('✓ 已唤醒 · 请说出你的问题');
    }
    // For directed interruption, finalizeBargeProbe may finish before or after
    // the acknowledgement. Dispatching from both edges makes the hand-off
    // independent of abort/TTS timing while the guards prevent duplicates.
    dispatchPendingBargeCommand();
  };

  const wakeAcknowledgementCacheKey = (
    acknowledgement: string,
    engine: 'edge' | 'dashscope',
  ): string => {
    const selectedVoice = engine === 'dashscope'
      ? dashscopeVoiceRef.current
      : edgeVoiceRef.current;
    const selectedModel = engine === 'dashscope'
      ? dashscopeModelRef.current
      : '';
    return [
      sessionId, engine, selectedModel, selectedVoice, speechRateRef.current, acknowledgement,
    ].join('|');
  };

  const loadBackendWakeAcknowledgement = (
    acknowledgement: string,
    engine: 'edge' | 'dashscope',
  ): Promise<AudioBuffer> => {
    const key = wakeAcknowledgementCacheKey(acknowledgement, engine);
    const cached = wakeAcknowledgementCacheRef.current.get(key);
    if (cached) return Promise.resolve(cached);
    const loading = wakeAcknowledgementPromiseRef.current.get(key);
    if (loading) return loading;
    const context = playbackContextRef.current;
    if (!context) return Promise.reject(new Error('播放设备不可用'));
    const selectedVoice = engine === 'dashscope'
      ? dashscopeVoiceRef.current
      : edgeVoiceRef.current;
    const selectedModel = engine === 'dashscope'
      ? dashscopeModelRef.current
      : '';
    const request = api.ttsSynthesize(
      acknowledgement,
      selectedVoice,
      speechRateRef.current,
      engine,
      selectedModel,
      sessionId,
    )
      .then(async (result) => {
        if (!result?.ok || !result.base64) {
          throw new Error(result?.error || '唤醒反馈语音未返回音频');
        }
        const buffer = await context.decodeAudioData(base64ToArrayBuffer(result.base64));
        const cache = wakeAcknowledgementCacheRef.current;
        if (cache.size >= 16) cache.delete(cache.keys().next().value as string);
        cache.set(key, buffer);
        return buffer;
      })
      .finally(() => {
        wakeAcknowledgementPromiseRef.current.delete(key);
      });
    wakeAcknowledgementPromiseRef.current.set(key, request);
    return request;
  };

  const playWakeAcknowledgement = (onReady: () => void = markWakeReady): void => {
    const generation = generationRef.current;
    const requestId = ++wakeAcknowledgementRequestRef.current;
    // Keep the first acknowledgement deterministic so it can be pre-warmed;
    // subsequent wakes retain the friendly non-repeating variants.
    const acknowledgement = lastWakeAcknowledgementRef.current
      ? pickWakeAcknowledgement(lastWakeAcknowledgementRef.current)
      : '我在';
    lastWakeAcknowledgementRef.current = acknowledgement;
    echoReferenceRef.current = acknowledgement;
    startupAudioBlockedUntilRef.current = Math.max(
      startupAudioBlockedUntilRef.current,
      Date.now() + WAKE_ACK_ECHO_BLOCK_MS,
    );
    // Immediate, deterministic feedback remains available while a first cloud
    // synthesis is warming. The spoken acknowledgement itself uses the engine,
    // model and voice selected for the conversation.
    playWakeCue();
    let settled = false;
    let watchdog = window.setTimeout(() => {
      watchdog = 0;
      settle();
    }, WAKE_ACK_TIMEOUT_MS);
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (watchdog) window.clearTimeout(watchdog);
      if (
        !activeRef.current
        || generation !== generationRef.current
        || requestId !== wakeAcknowledgementRequestRef.current
      ) return;
      const captureReadyIn = Math.max(0, startupAudioBlockedUntilRef.current - Date.now());
      clearWakeReadyTimer();
      wakeReadyTimerRef.current = window.setTimeout(() => {
        wakeReadyTimerRef.current = null;
        onReady();
      }, captureReadyIn);
    };

    const effectiveEngine = ttsEngineRef.current === 'system' && !systemSpeechAvailable()
      ? 'edge'
      : ttsEngineRef.current;
    if (effectiveEngine === 'system') {
      try {
        const utterance = new SpeechSynthesisUtterance(acknowledgement);
        const selectedVoice = selectSystemSpeechVoice(
          systemVoiceRef.current,
          edgeVoiceRef.current,
        );
        if (selectedVoice) {
          utterance.voice = selectedVoice;
          utterance.lang = selectedVoice.lang || 'zh-CN';
        } else {
          utterance.lang = /[\u3400-\u9fff]/.test(acknowledgement) ? 'zh-CN' : 'en-US';
        }
        utterance.rate = Math.max(
          0.85,
          Math.min(1.3, systemSpeechRate(speechRateRef.current)),
        );
        wakeAcknowledgementRef.current = utterance;
        const clear = () => {
          if (wakeAcknowledgementRef.current === utterance) {
            wakeAcknowledgementRef.current = null;
            lastPlaybackEndedAtRef.current = Date.now();
            startupAudioBlockedUntilRef.current = Date.now() + 220;
          }
        };
        utterance.onstart = () => {
          if (wakeAcknowledgementRef.current !== utterance) return;
          if (watchdog) window.clearTimeout(watchdog);
          watchdog = window.setTimeout(settle, 1800);
          startupAudioBlockedUntilRef.current = Date.now() + 1500;
        };
        utterance.onerror = () => { clear(); settle(); };
        utterance.onend = () => { clear(); settle(); };
        window.speechSynthesis.speak(utterance);
      } catch {
        wakeAcknowledgementRef.current = null;
        startupAudioBlockedUntilRef.current = Date.now() + 170;
        settle();
      }
      return;
    }

    void loadBackendWakeAcknowledgement(acknowledgement, effectiveEngine)
      .then((buffer) => {
        if (
          settled
          || !activeRef.current
          || generation !== generationRef.current
          || requestId !== wakeAcknowledgementRequestRef.current
        ) return;
        const context = playbackContextRef.current;
        if (!context) {
          settle();
          return;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(playbackGainRef.current || context.destination);
        wakeAcknowledgementSourceRef.current = source;
        source.onended = () => {
          if (wakeAcknowledgementSourceRef.current !== source) return;
          wakeAcknowledgementSourceRef.current = null;
          try { source.disconnect(); } catch { /* already disconnected */ }
          lastPlaybackEndedAtRef.current = Date.now();
          startupAudioBlockedUntilRef.current = Date.now() + 220;
          settle();
        };
        if (watchdog) window.clearTimeout(watchdog);
        watchdog = window.setTimeout(settle, Math.max(1200, buffer.duration * 1000 + 800));
        startupAudioBlockedUntilRef.current = Date.now() + buffer.duration * 1000 + 350;
        void context.resume().then(() => {
          if (
            !settled
            && activeRef.current
            && requestId === wakeAcknowledgementRequestRef.current
            && wakeAcknowledgementSourceRef.current === source
          ) source.start();
        }).catch(() => {
          if (wakeAcknowledgementSourceRef.current === source) {
            wakeAcknowledgementSourceRef.current = null;
            try { source.disconnect(); } catch { /* already disconnected */ }
          }
          settle();
        });
      })
      .catch(() => {
        // The rising cue is the fail-safe acknowledgement. Do not silently fall
        // back to a different local voice when a cloud engine was explicitly chosen.
        startupAudioBlockedUntilRef.current = Date.now() + 170;
        settle();
      });
  };

  const prepareReplyState = (
    interactionMode: RealtimeVoiceInteractionMode = 'realtime-voice-background',
  ): void => {
    clearContinuousLease();
    // The wake acknowledgement is deliberately allowed to finish. Any Agent
    // speech queues behind this very short utterance, preserving the immediate
    // “I heard you” feedback even when Yuki and the command arrive together.
    cancelCurrentTts(true);
    clearSpeechCommitTimer();
    speechGateRef.current.reset();
    voiceSummaryProjectorRef.current.reset();
    replyInteractionModeRef.current = interactionMode;
    activeToolIdsRef.current.clear();
    replySpeechTextRef.current = '';
    echoReferenceRef.current = '';
    startupAudioBlockedUntilRef.current = 0;
    setAgentActivity('');
    replyExpectedRef.current = true;
    replyMessageIdRef.current = null;
    suppressStreamUntilRef.current = 0;
    llmDoneRef.current = false;
    replyStartedAtRef.current = performance.now();
    resumeScheduledRef.current = false;
    replyTtsEngineRef.current = ttsEngineRef.current === 'system'
      ? (systemSpeechAvailable() ? 'system' : 'edge')
      : ttsEngineRef.current;
    setPlaybackEngineLabel(
      replyTtsEngineRef.current === 'system'
        ? '本机系统语音'
        : replyTtsEngineRef.current === 'dashscope'
          ? 'DashScope 流式 TTS'
          : 'Edge TTS',
    );
    ttsStreamIdRef.current = replyTtsEngineRef.current === 'system'
      ? ''
      : createVoiceStreamId();
    ttsSessionIdRef.current = sessionId;
    firstAudioMsRef.current = null;
    setFirstAudioMs(null);
    updatePhase('thinking');
  };

  const stopStt = async (): Promise<{ ok: boolean; text?: string; error?: string }> => {
    if (!sttActiveRef.current && !sttStartingRef.current) {
      return { ok: false, error: 'No active STT stream' };
    }
    sttActiveRef.current = false;
    sttStartingRef.current = false;
    return api.sttStreamStop(sessionId);
  };

  const startStt = async (assumeSpeech = false, seedFrames: ArrayBuffer[] = []): Promise<void> => {
    if (
      !activeRef.current
      || sttStartingRef.current
      || bargeProbeStartingRef.current
      || bargeProbeActiveRef.current
      || bargeProbeFinalizingRef.current
    ) return;
    if (!assumeSpeech && startupAudioBlockedUntilRef.current <= Date.now()) {
      startupAudioBlockedUntilRef.current = 0;
    }
    const generation = generationRef.current;
    sttStartingRef.current = true;
    startupFramesRef.current = seedFrames.map((frame) => frame.slice(0));
    updatePhase(assumeSpeech ? 'interrupted' : 'starting');
    try {
      const response = await api.sttStreamStart(
        { flashRefineEnabled: false },
        sessionId,
      );
      if (!activeRef.current || generation !== generationRef.current) {
        if (response.ok) void api.sttStreamStop(sessionId);
        return;
      }
      if (replyExpectedRef.current) {
        sttStartingRef.current = false;
        if (response.ok) void api.sttStreamStop(sessionId);
        return;
      }
      if (!response.ok) throw new Error(response.error || 'Fun-ASR Realtime 启动失败');
      sttStartingRef.current = false;
      sttActiveRef.current = true;
      if (response.model) setAsrModel(response.model);
      latestTranscriptRef.current = '';
      wakeMatchedUtteranceRef.current = false;
      wakeRemainderRef.current = '';
      setTranscript('');
      resetVad(assumeSpeech);
      const buffered = startupFramesRef.current.splice(0);
      buffered.forEach((frame) => api.sttStreamAudioBinary(frame));
      const listeningPhase: VoicePhase = armedRef.current ? 'listening' : 'standby';
      updatePhase(listeningPhase);
      setNotice(assumeSpeech
        ? '已打断上一轮，请继续说'
        : armedRef.current
          ? '请开始说话'
          : `请说“${wakeWordRef.current.trim()}”开始`);
      if (armedRef.current && !assumeSpeech) scheduleContinuousLease();
    } catch (cause: any) {
      sttStartingRef.current = false;
      sttActiveRef.current = false;
      setError(cause?.message || '无法启动实时语音识别');
      updatePhase('error');
    }
  };

  const scheduleListeningAfterReply = (): void => {
    if (
      !activeRef.current
      || resumeScheduledRef.current
      || bargeProbeStartingRef.current
      || bargeProbeActiveRef.current
      || bargeProbeFinalizingRef.current
    ) return;
    resumeScheduledRef.current = true;
    replyExpectedRef.current = false;
    replyMessageIdRef.current = null;
    const sincePlaybackEnded = lastPlaybackEndedAtRef.current
      ? Date.now() - lastPlaybackEndedAtRef.current
      : Number.POSITIVE_INFINITY;
    const resumeDelay = Number.isFinite(sincePlaybackEnded)
      ? Math.max(140, ECHO_SETTLE_MS - sincePlaybackEnded)
      : 140;
    window.setTimeout(() => {
      resumeScheduledRef.current = false;
      if (!activeRef.current || sttActiveRef.current || sttStartingRef.current) return;
      lastPlaybackEndedAtRef.current = 0;
      playbackStartedAtRef.current = 0;
      void startStt(false);
    }, resumeDelay);
  };

  const maybeCompleteReply = (): void => {
    const dashscopePending = replyTtsEngineRef.current === 'dashscope'
      && dashscopeHadInputRef.current
      && !dashscopeFinishedRef.current;
    const edgePending = replyTtsEngineRef.current === 'edge'
      && expectedPlaybackSeqRef.current < nextTtsSeqRef.current;
    if (
      !replyExpectedRef.current
      || !llmDoneRef.current
      || pendingTtsRef.current.size > 0
      || speechChunkQueueRef.current.length > 0
      || playbackSourceRef.current
      || pcmPlaybackSourcesRef.current.size > 0
      || systemSpeechUtteranceRef.current
      || dashscopePending
      || edgePending
    ) return;
    scheduleListeningAfterReply();
  };

  const maybeFinishDashscopeStream = (): void => {
    if (
      replyTtsEngineRef.current !== 'dashscope'
      || !llmDoneRef.current
      || dashscopeFinishRequestedRef.current
      || dashscopeFinishedRef.current
      || pendingTtsRef.current.size > 0
      || speechChunkQueueRef.current.length > 0
    ) return;
    if (!dashscopeHadInputRef.current || dashscopeFailedRef.current) {
      dashscopeFinishedRef.current = true;
      maybeCompleteReply();
      return;
    }
    const streamId = ttsStreamIdRef.current;
    const streamSessionId = ttsSessionIdRef.current || sessionId;
    if (!streamId) {
      dashscopeFinishedRef.current = true;
      maybeCompleteReply();
      return;
    }
    dashscopeFinishRequestedRef.current = true;
    dashscopeFinishTimeoutRef.current = window.setTimeout(() => {
      dashscopeFinishTimeoutRef.current = null;
      if (ttsStreamIdRef.current !== streamId || dashscopeFinishedRef.current) return;
      dashscopeFailedRef.current = true;
      dashscopeFinishedRef.current = true;
      setNotice('DashScope TTS 结束超时，已释放本轮语音流');
      void api.ttsStreamCancel(streamSessionId, streamId);
      maybeCompleteReply();
    }, DASHSCOPE_FINISH_TIMEOUT_MS);
    void api.ttsStreamFinish(streamSessionId, streamId, 'dashscope')
      .then((result) => {
        if (ttsStreamIdRef.current !== streamId) return;
        if (!result?.ok || result.empty) {
          if (dashscopeFinishTimeoutRef.current !== null) {
            window.clearTimeout(dashscopeFinishTimeoutRef.current);
            dashscopeFinishTimeoutRef.current = null;
          }
          dashscopeFailedRef.current = !result?.ok;
          dashscopeFinishedRef.current = true;
          if (!result?.ok) setNotice(`DashScope TTS 结束失败：${result?.error || '未知错误'}`);
          maybeCompleteReply();
        }
      })
      .catch((cause: any) => {
        if (ttsStreamIdRef.current !== streamId) return;
        if (dashscopeFinishTimeoutRef.current !== null) {
          window.clearTimeout(dashscopeFinishTimeoutRef.current);
          dashscopeFinishTimeoutRef.current = null;
        }
        dashscopeFailedRef.current = true;
        dashscopeFinishedRef.current = true;
        setNotice(`DashScope TTS 结束失败：${cause?.message || '请求失败'}`);
        maybeCompleteReply();
      });
  };

  const drainPlayback = (): void => {
    if (!activeRef.current || playbackSourceRef.current) return;
    while (decodedBuffersRef.current.has(expectedPlaybackSeqRef.current)) {
      const seq = expectedPlaybackSeqRef.current;
      const buffer = decodedBuffersRef.current.get(seq) ?? null;
      decodedBuffersRef.current.delete(seq);
      expectedPlaybackSeqRef.current += 1;
      pumpTtsRequests();
      if (!buffer) continue;

      const context = playbackContextRef.current;
      if (!context) continue;
      const source = context.createBufferSource();
      const sourceStreamId = ttsStreamIdRef.current;
      source.buffer = buffer;
      source.connect(playbackGainRef.current || context.destination);
      playbackSourceRef.current = source;
      source.onended = () => {
        if (playbackSourceRef.current !== source) return;
        source.disconnect();
        playbackSourceRef.current = null;
        lastPlaybackEndedAtRef.current = Date.now();
        drainPlayback();
      };
      if (firstAudioMsRef.current === null) {
        firstAudioMsRef.current = Math.max(
          0,
          Math.round(performance.now() - replyStartedAtRef.current),
        );
        setFirstAudioMs(firstAudioMsRef.current);
      }
      updatePhase('speaking');
      void context.resume().then(() => {
        if (
          activeRef.current
          && ttsStreamIdRef.current === sourceStreamId
          && playbackSourceRef.current === source
        ) {
          if (!playbackStartedAtRef.current) playbackStartedAtRef.current = Date.now();
          lastPlaybackEndedAtRef.current = 0;
          bargeFramesRef.current = 0;
          source.start();
        }
      }).catch(() => {
        if (
          ttsStreamIdRef.current !== sourceStreamId
          || playbackSourceRef.current !== source
        ) return;
        playbackSourceRef.current = null;
        drainPlayback();
      });
      return;
    }
    if (replyExpectedRef.current && !llmDoneRef.current) {
      updatePhase(activeToolIdsRef.current.size > 0 ? 'working' : 'thinking');
    }
    maybeCompleteReply();
  };

  const scheduleDashscopePcm = (event: TtsStreamAudioEvent): void => {
    const context = playbackContextRef.current;
    if (!context || !event.base64) return;
    const raw = new Uint8Array(base64ToArrayBuffer(event.base64));
    const sampleCount = Math.floor(raw.byteLength / 2);
    if (sampleCount <= 0) return;
    const sampleRate = Math.max(8_000, Math.min(48_000, Number(event.sampleRate) || 24_000));
    const audioBuffer = context.createBuffer(1, sampleCount, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(raw.buffer, raw.byteOffset, sampleCount * 2);
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32_768;
    }

    const source = context.createBufferSource();
    const sourceStreamId = event.streamId;
    source.buffer = audioBuffer;
    source.connect(playbackGainRef.current || context.destination);
    const now = context.currentTime;
    const startAt = Math.max(
      now + (pcmPlaybackSourcesRef.current.size === 0 ? 0.035 : 0.005),
      pcmPlaybackCursorRef.current,
    );
    pcmPlaybackCursorRef.current = startAt + audioBuffer.duration;
    pcmPlaybackSourcesRef.current.add(source);
    source.onended = () => {
      if (!pcmPlaybackSourcesRef.current.delete(source)) return;
      try { source.disconnect(); } catch { /* already disconnected */ }
      if (pcmPlaybackSourcesRef.current.size === 0) {
        pcmPlaybackCursorRef.current = 0;
        lastPlaybackEndedAtRef.current = Date.now();
        if (replyExpectedRef.current && !llmDoneRef.current) {
          updatePhase(activeToolIdsRef.current.size > 0 ? 'working' : 'thinking');
        }
      }
      maybeCompleteReply();
    };
    if (firstAudioMsRef.current === null) {
      firstAudioMsRef.current = Math.max(
        0,
        Math.round(performance.now() - replyStartedAtRef.current),
      );
      setFirstAudioMs(firstAudioMsRef.current);
    }
    updatePhase('speaking');
    void context.resume().then(() => {
      if (
        !activeRef.current
        || ttsStreamIdRef.current !== sourceStreamId
        || !pcmPlaybackSourcesRef.current.has(source)
      ) return;
      if (!playbackStartedAtRef.current) playbackStartedAtRef.current = Date.now();
      lastPlaybackEndedAtRef.current = 0;
      bargeFramesRef.current = 0;
      source.start(startAt);
    }).catch(() => {
      if (!pcmPlaybackSourcesRef.current.delete(source)) return;
      try { source.disconnect(); } catch { /* already disconnected */ }
      if (pcmPlaybackSourcesRef.current.size === 0) pcmPlaybackCursorRef.current = 0;
      setNotice('DashScope PCM 音频播放失败');
      maybeCompleteReply();
    });
  };

  const failTtsSeq = (seq: number, message: string): void => {
    clearTtsTimeout(seq);
    pendingTtsRef.current.delete(seq);
    decodedBuffersRef.current.set(seq, null);
    setNotice(`部分语音未生成：${message}`);
    drainPlayback();
  };

  const ensureBackendStream = (): void => {
    if (!ttsStreamIdRef.current) ttsStreamIdRef.current = createVoiceStreamId();
    if (!ttsSessionIdRef.current) ttsSessionIdRef.current = sessionId;
  };

  const fallbackSystemChunkToEdge = (
    utterance: SpeechSynthesisUtterance,
    chunk: string,
    message: string,
  ): void => {
    if (systemSpeechUtteranceRef.current !== utterance) return;
    systemSpeechUtteranceRef.current = null;
    if (systemSpeechTimeoutRef.current !== null) {
      window.clearTimeout(systemSpeechTimeoutRef.current);
      systemSpeechTimeoutRef.current = null;
    }
    if (systemSpeechAvailable()) window.speechSynthesis.cancel();
    replyTtsEngineRef.current = 'edge';
    setPlaybackEngineLabel('Edge TTS（自动回退）');
    ensureBackendStream();
    speechChunkQueueRef.current.unshift(chunk);
    setNotice(`本机语音不可用，已切换 Edge：${message}`);
    pumpTtsRequests();
  };

  const pumpSystemSpeech = (): void => {
    if (
      replyTtsEngineRef.current !== 'system'
      || systemSpeechUtteranceRef.current
      || !activeRef.current
    ) return;
    const chunk = speechChunkQueueRef.current.shift();
    if (!chunk) {
      if (replyExpectedRef.current && !llmDoneRef.current) {
        updatePhase(activeToolIdsRef.current.size > 0 ? 'working' : 'thinking');
      }
      maybeCompleteReply();
      return;
    }
    if (!systemSpeechAvailable()) {
      replyTtsEngineRef.current = 'edge';
      setPlaybackEngineLabel('Edge TTS（自动回退）');
      ensureBackendStream();
      speechChunkQueueRef.current.unshift(chunk);
      pumpTtsRequests();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = 'zh-CN';
    utterance.rate = systemSpeechRate(speechRateRef.current);
    const selectedVoice = selectSystemSpeechVoice(
      systemVoiceRef.current,
      edgeVoiceRef.current,
    );
    if (selectedVoice) utterance.voice = selectedVoice;
    systemSpeechUtteranceRef.current = utterance;
    utterance.onstart = () => {
      if (systemSpeechUtteranceRef.current !== utterance) return;
      if (systemSpeechTimeoutRef.current !== null) {
        window.clearTimeout(systemSpeechTimeoutRef.current);
        systemSpeechTimeoutRef.current = null;
      }
      if (firstAudioMsRef.current === null) {
        firstAudioMsRef.current = Math.max(0, Math.round(performance.now() - replyStartedAtRef.current));
        setFirstAudioMs(firstAudioMsRef.current);
      }
      if (!playbackStartedAtRef.current) playbackStartedAtRef.current = Date.now();
      lastPlaybackEndedAtRef.current = 0;
      bargeFramesRef.current = 0;
      updatePhase('speaking');
    };
    utterance.onend = () => {
      if (systemSpeechUtteranceRef.current !== utterance) return;
      systemSpeechUtteranceRef.current = null;
      if (systemSpeechTimeoutRef.current !== null) {
        window.clearTimeout(systemSpeechTimeoutRef.current);
        systemSpeechTimeoutRef.current = null;
      }
      lastPlaybackEndedAtRef.current = Date.now();
      pumpTtsRequests();
    };
    utterance.onerror = (event) => {
      fallbackSystemChunkToEdge(utterance, chunk, event.error || '播放失败');
    };
    systemSpeechTimeoutRef.current = window.setTimeout(() => {
      fallbackSystemChunkToEdge(utterance, chunk, '启动超时');
    }, SYSTEM_SPEECH_TIMEOUT_MS);
    try {
      window.speechSynthesis.speak(utterance);
    } catch (cause: any) {
      fallbackSystemChunkToEdge(utterance, chunk, cause?.message || '启动失败');
    }
  };

  const failDashscopeRequest = (seq: number, streamId: string, message: string): void => {
    clearTtsTimeout(seq);
    pendingTtsRef.current.delete(seq);
    if (ttsStreamIdRef.current !== streamId) return;
    dashscopeFailedRef.current = true;
    dashscopeFinishedRef.current = true;
    speechChunkQueueRef.current = [];
    setNotice(`DashScope TTS 已停止：${message}`);
    void api.ttsStreamCancel(ttsSessionIdRef.current || sessionId, streamId);
    maybeCompleteReply();
  };

  const pumpTtsRequests = (): void => {
    if (replyTtsEngineRef.current === 'system') {
      pumpSystemSpeech();
      return;
    }
    const streamId = ttsStreamIdRef.current;
    if (!streamId) return;
    const backendEngine = replyTtsEngineRef.current === 'dashscope' ? 'dashscope' : 'edge';
    if (backendEngine === 'dashscope' && dashscopeFailedRef.current) {
      speechChunkQueueRef.current = [];
      maybeCompleteReply();
      return;
    }
    while (
      speechChunkQueueRef.current.length > 0
      && (
        backendEngine === 'dashscope'
          ? pendingTtsRef.current.size
          : nextTtsSeqRef.current - expectedPlaybackSeqRef.current
      ) < TTS_LOOKAHEAD_CHUNKS
    ) {
      const chunk = speechChunkQueueRef.current.shift();
      if (!chunk) continue;
      const seq = nextTtsSeqRef.current++;
      pendingTtsRef.current.add(seq);
      const timer = window.setTimeout(() => {
        if (ttsStreamIdRef.current === streamId && pendingTtsRef.current.has(seq)) {
          if (backendEngine === 'dashscope') failDashscopeRequest(seq, streamId, '请求超时');
          else failTtsSeq(seq, '合成超时');
        }
      }, TTS_EVENT_TIMEOUT_MS);
      ttsTimeoutsRef.current.set(seq, timer);
      const streamSessionId = ttsSessionIdRef.current || sessionId;
      const selectedVoice = backendEngine === 'dashscope'
        ? dashscopeVoiceRef.current
        : edgeVoiceRef.current;
      const selectedModel = backendEngine === 'dashscope'
        ? dashscopeModelRef.current
        : '';
      void api.ttsStreamSynthesize(
        streamSessionId,
        streamId,
        seq,
        chunk,
        selectedVoice,
        speechRateRef.current,
        backendEngine,
        selectedModel,
      )
        .then((result) => {
          if (ttsStreamIdRef.current !== streamId || !pendingTtsRef.current.has(seq)) return;
          if (backendEngine === 'dashscope') {
            clearTtsTimeout(seq);
            pendingTtsRef.current.delete(seq);
            if (!result?.ok) {
              failDashscopeRequest(seq, streamId, result?.error || '请求失败');
              return;
            }
            dashscopeHadInputRef.current = true;
            pumpTtsRequests();
            maybeFinishDashscopeStream();
            return;
          }
          if (!result?.ok) failTtsSeq(seq, result?.error || '请求失败');
        })
        .catch((cause: any) => {
          if (ttsStreamIdRef.current === streamId && pendingTtsRef.current.has(seq)) {
            if (backendEngine === 'dashscope') {
              failDashscopeRequest(seq, streamId, cause?.message || '请求失败');
            } else {
              failTtsSeq(seq, cause?.message || '请求失败');
            }
          }
        });
    }
    maybeFinishDashscopeStream();
  };

  const scheduleSpeechChunks = (chunks: string[]): void => {
    if (chunks.length === 0) return;
    if (replyTtsEngineRef.current === 'dashscope' && dashscopeFailedRef.current) return;
    if (replyTtsEngineRef.current !== 'system') ensureBackendStream();
    const room = MAX_QUEUED_SPEECH_CHUNKS - speechChunkQueueRef.current.length;
    if (room <= 0) {
      setNotice('回答较长，实时朗读已限制后续缓存');
      return;
    }
    const accepted = chunks.slice(0, room);
    speechChunkQueueRef.current.push(...accepted);
    replySpeechTextRef.current += accepted.join('');
    if (chunks.length > room) setNotice('回答较长，实时朗读已限制后续缓存');
    pumpTtsRequests();
  };

  const scheduleStableSpeechCommit = (): void => {
    if (
      speechCommitTimerRef.current !== null
      || !speechGateRef.current.hasStagedSpeech
    ) return;
    speechCommitTimerRef.current = window.setTimeout(() => {
      speechCommitTimerRef.current = null;
      if (!activeRef.current || !replyExpectedRef.current) return;
      scheduleSpeechChunks(speechGateRef.current.commitStable());
    }, SPEECH_COMMIT_DELAY_MS);
  };

  const handleTtsEvent = async (event: TtsStreamAudioEvent): Promise<void> => {
    if (
      !activeRef.current
      || event.streamId !== ttsStreamIdRef.current
    ) return;

    if (event.engine === 'dashscope' || event.kind) {
      if (event.kind === 'finished' || event.kind === 'error' || !event.ok) {
        if (dashscopeFinishTimeoutRef.current !== null) {
          window.clearTimeout(dashscopeFinishTimeoutRef.current);
          dashscopeFinishTimeoutRef.current = null;
        }
        dashscopeFinishedRef.current = true;
        if (event.kind === 'error' || !event.ok) {
          dashscopeFailedRef.current = true;
          speechChunkQueueRef.current = [];
          setNotice(`DashScope TTS 已结束：${event.error || '任务失败'}`);
        }
        maybeCompleteReply();
        return;
      }
      if (event.kind !== 'audio' || !event.base64) return;
      if (!playbackContextRef.current) {
        dashscopeFailedRef.current = true;
        dashscopeFinishedRef.current = true;
        setNotice('DashScope PCM 播放设备不可用');
        maybeCompleteReply();
        return;
      }
      scheduleDashscopePcm(event);
      return;
    }

    if (!pendingTtsRef.current.has(event.seq)) return;
    clearTtsTimeout(event.seq);
    if (!event.ok || !event.base64) {
      failTtsSeq(event.seq, event.error || '没有返回音频');
      return;
    }
    const context = playbackContextRef.current;
    if (!context) {
      failTtsSeq(event.seq, '播放设备不可用');
      return;
    }
    const streamId = event.streamId;
    try {
      const buffer = await context.decodeAudioData(base64ToArrayBuffer(event.base64));
      if (!activeRef.current || streamId !== ttsStreamIdRef.current) return;
      pendingTtsRef.current.delete(event.seq);
      decodedBuffersRef.current.set(event.seq, buffer);
      drainPlayback();
    } catch (cause: any) {
      if (streamId === ttsStreamIdRef.current) {
        failTtsSeq(event.seq, cause?.message || '音频解码失败');
      }
    }
  };

  const adoptStreamingReply = (): void => {
    if (replyExpectedRef.current) return;
    sttActiveRef.current = false;
    void api.sttStreamStop(sessionId);
    // 非语音入口触发的回复没有隐藏摘要协议，必须按普通正文朗读兜底。
    prepareReplyState('realtime-voice-background');
  };

  const handleStreamDelta = (delta: any): void => {
    if (!activeRef.current || delta?.sessionId !== sessionId) return;
    if (bargeAbortCommittedRef.current || pendingBargeCommandRef.current) return;
    if (ignoredMessageIdRef.current && delta.messageId === ignoredMessageIdRef.current) return;
    if (!replyExpectedRef.current) {
      if (Date.now() < suppressStreamUntilRef.current) return;
      adoptStreamingReply();
    }
    if (!replyMessageIdRef.current) {
      replyMessageIdRef.current = delta.messageId || null;
      if (replyMessageIdRef.current !== ignoredMessageIdRef.current) {
        ignoredMessageIdRef.current = null;
      }
    }
    if (replyMessageIdRef.current && delta.messageId !== replyMessageIdRef.current) return;

    if (isSpeakableAgentDelta(delta.type) && delta.text) {
      // text_delta 始终是 Agent 正文；工具输入、日志和原始输出使用独立
      // tool_* / subagent_* 事件，下面不会投影到 TTS。
      const text = String(delta.text);
      const projected = replyInteractionModeRef.current === 'realtime-voice-foreground'
        ? voiceSummaryProjectorRef.current.pushText(text)
        : [text];
      projected.forEach((item) => {
        scheduleSpeechChunks(speechGateRef.current.pushText(item));
      });
      scheduleStableSpeechCommit();
      return;
    }

    if (delta.type === 'tool_start' || delta.type === 'subagent_start') {
      const tool = delta.toolCall || delta.subagent || {};
      const toolId = String(tool.id || tool.taskId || `${delta.type}-${Date.now()}`);
      const toolName = String(tool.name || tool.description || tool.taskType || 'Agent 工具');
      clearSpeechCommitTimer();
      activeToolIdsRef.current.add(toolId);
      // 工具开始只静默结构化工具载荷；已在播/排队的 Agent 文字不能被切断。
      scheduleSpeechChunks(speechGateRef.current.toolStarted());
      setAgentActivity(toolName);
      if (phaseRef.current !== 'speaking') updatePhase('working');
      setNotice(`正在调用 ${toolName} · 工具内容静默，阶段说明继续朗读`);
      return;
    }

    if (
      delta.type === 'tool_result'
      || delta.type === 'tool_end'
      || delta.type === 'subagent_done'
    ) {
      const tool = delta.toolCall || delta.subagent || {};
      const toolId = String(tool.id || tool.taskId || '');
      if (toolId) activeToolIdsRef.current.delete(toolId);
      else activeToolIdsRef.current.clear();
      if (activeToolIdsRef.current.size === 0) {
        setAgentActivity('');
        if (phaseRef.current !== 'speaking') updatePhase('thinking');
        setNotice('工具已完成，Agent 阶段结果会继续朗读');
      } else {
        setAgentActivity(`${activeToolIdsRef.current.size} 个工具处理中`);
        if (phaseRef.current !== 'speaking') updatePhase('working');
        setNotice(`仍有 ${activeToolIdsRef.current.size} 个工具在运行 · 仅工具内容静默`);
      }
      return;
    }

    if (delta.type === 'subagent_progress') {
      const toolName = String(delta.subagent?.lastToolName || delta.subagent?.description || '子 Agent');
      setAgentActivity(toolName);
      if (phaseRef.current !== 'speaking') updatePhase('working');
      setNotice(`${toolName} 正在处理 · 工具载荷静默，Agent 文字照常朗读`);
      return;
    }

    if (delta.type === 'error') {
      setNotice(delta.error || 'Agent 执行出现异常，正在结束本轮');
      return;
    }

    if (delta.type === 'done') {
      clearSpeechCommitTimer();
      activeToolIdsRef.current.clear();
      setAgentActivity('');
      if (replyInteractionModeRef.current === 'realtime-voice-foreground') {
        voiceSummaryProjectorRef.current.finish().forEach((item) => {
          scheduleSpeechChunks(speechGateRef.current.pushText(item));
        });
      }
      const usedTools = speechGateRef.current.usedTools;
      const finalChunks = speechGateRef.current.finish();
      scheduleSpeechChunks(finalChunks);
      if (usedTools && finalChunks.length === 0 && !replySpeechTextRef.current) {
        setNotice('Agent 已完成；本轮没有可朗读的 Agent 正文');
      }
      llmDoneRef.current = true;
      pumpTtsRequests();
      maybeFinishDashscopeStream();
      maybeCompleteReply();
    }
  };

  const detectInteractionMode = async (): Promise<RealtimeVoiceInteractionMode> => {
    let minimized: boolean | undefined;
    let visible: boolean | undefined;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      [minimized, visible] = await Promise.all([
        currentWindow.isMinimized(),
        currentWindow.isVisible(),
      ]);
    } catch {
      // Browser builds have no Tauri window. visibilityState remains authoritative.
    }
    return resolveRealtimeVoiceInteractionMode({
      documentHidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      minimized,
      visible,
    });
  };

  const beginReply = async (text: string): Promise<void> => {
    const prompt = text.trim();
    if (!prompt || !activeRef.current) {
      void startStt(false);
      return;
    }
    clearContinuousLease();
    const generation = generationRef.current;
    const interactionMode = await detectInteractionMode();
    if (!activeRef.current || generation !== generationRef.current) return;
    bargeAbortCommittedRef.current = false;
    prepareReplyState(interactionMode);
    setTranscript(prompt);
    setNotice(interactionMode === 'realtime-voice-background'
      ? '窗口不可见：采用信息完整的语音主通道回答'
      : '窗口可见：朗读阶段归纳，完整细节保留在界面');
    onSendRef.current(prompt, interactionMode);
  };

  const acknowledgeWake = (): void => {
    if (wakeTransitioningRef.current) return;
    wakeTransitioningRef.current = true;
    clearContinuousLease();
    armedRef.current = true;
    wakeMatchedUtteranceRef.current = true;
    wakeRemainderRef.current = '';
    updateWakeFeedback('acknowledging');
    updatePhase('finalizing');
    setTranscript('');
    setNotice('已收到唤醒，正在切换到问题收听');

    const generation = generationRef.current;
    ignoreSttEndUntilRef.current = Date.now() + 3000;
    void (async () => {
      try {
        if (sttActiveRef.current || sttStartingRef.current) await stopStt();
      } catch {
        // 唤醒声段永远只在本地消费；旧识别流关闭失败也不能提交给模型。
      }
      latestTranscriptRef.current = '';
      resetVad(false);
      setTranscript('');
      if (!activeRef.current || generation !== generationRef.current) {
        wakeTransitioningRef.current = false;
        return;
      }
      playWakeAcknowledgement(() => {
        if (!activeRef.current || generation !== generationRef.current) {
          wakeTransitioningRef.current = false;
          return;
        }
        wakeMatchedUtteranceRef.current = false;
        wakeTransitioningRef.current = false;
        void startStt(false).then(() => {
          if (
            activeRef.current
            && generation === generationRef.current
            && sttActiveRef.current
          ) {
            markWakeReady();
            setNotice('✓ 已唤醒 · 请另起一句说出问题');
          }
        });
      });
    })();
  };

  const processRecognizedText = async (rawText: string): Promise<void> => {
    let text = String(rawText || '').trim();
    const echoReference = echoReferenceRef.current;
    echoReferenceRef.current = '';
    if (echoReference && isLikelyPlaybackEcho(text, echoReference)) {
      setTranscript('');
      setNotice('已过滤扬声器回声，请继续说话');
      await startStt(false);
      return;
    }
    const configuredWake = wakeWordRef.current.trim();
    if (configuredWake) {
      const wakeMatch = matchWakePhrase(text, configuredWake);
      if (!armedRef.current) {
        if (!wakeMatch.matched) {
          setTranscript('');
          setNotice(`未听到唤醒词，请说“${configuredWake}”开始`);
          await startStt(false);
          return;
        }
        acknowledgeWake();
      } else if (wakeMatch.matched && !wakeMatchedUtteranceRef.current) {
        acknowledgeWake();
      }
      text = resolveWakeUtteranceCommand(
        text,
        configuredWake,
        wakeMatchedUtteranceRef.current,
      );
    }

    if (!text) {
      setTranscript('');
      if (wakeTransitioningRef.current) return;
      await startStt(false);
      if (activeRef.current && sttActiveRef.current) {
        setNotice(configuredWake
          ? wakeFeedbackRef.current === 'ready'
            ? '✓ 已唤醒 · 请说出你的问题'
            : '已收到唤醒，听到提示后请说'
          : '没有检测到有效语音，请重试');
      }
      return;
    }
    await beginReply(text);
  };

  const finalizeUtterance = async (): Promise<void> => {
    if (
      !activeRef.current
      || finalizingRef.current
      || wakeTransitioningRef.current
      || !sttActiveRef.current
    ) return;
    finalizingRef.current = true;
    updatePhase('finalizing');
    setNotice('正在确认最后一句，不启用 Flash 二次精转');
    const fallback = latestTranscriptRef.current;
    try {
      const result = await stopStt();
      if (!activeRef.current) return;
      const text = (result.text || fallback || '').trim();
      if (!text) {
        setNotice('没有检测到有效语音，请重试');
        await startStt(false);
        return;
      }
      await processRecognizedText(text);
    } catch (cause: any) {
      if (fallback.trim()) await processRecognizedText(fallback);
      else {
        setNotice(cause?.message || '识别结束失败，正在重新连接');
        await startStt(false);
      }
    } finally {
      finalizingRef.current = false;
    }
  };

  const restoreReplyPhase = (): void => {
    setPlaybackDucked(false);
    if (
      playbackSourceRef.current
      || pcmPlaybackSourcesRef.current.size > 0
      || systemSpeechUtteranceRef.current
    ) {
      updatePhase('speaking');
    } else if (replyExpectedRef.current && !llmDoneRef.current) {
      updatePhase(activeToolIdsRef.current.size > 0 ? 'working' : 'thinking');
    } else {
      maybeCompleteReply();
    }
  };

  const commitWakeDirectedAbort = (match: WakePhraseMatch): void => {
    if (bargeAbortCommittedRef.current) return;
    bargeAbortCommittedRef.current = true;
    bargeProbeMatchRef.current = match;
    clearContinuousLease();
    clearSpeechCommitTimer();
    const oldMessageId = replyMessageIdRef.current;
    ignoredMessageIdRef.current = oldMessageId;
    suppressStreamUntilRef.current = Date.now() + 2500;
    replyExpectedRef.current = false;
    llmDoneRef.current = false;
    armedRef.current = true;
    wakeMatchedUtteranceRef.current = true;
    const command = '';
    wakeRemainderRef.current = '';
    cancelCurrentTts();
    updateWakeFeedback('acknowledging');
    playWakeAcknowledgement();
    if (isStreamingRef.current) onAbortRef.current();
    updatePhase('interrupted');
    setTranscript(command);
    setNotice(command
      ? `已听到“${wakeWordRef.current.trim()}”，正在切换到新指令`
      : `已听到“${wakeWordRef.current.trim()}”，当前回复已停止，请继续说`);
  };

  const dispatchPendingBargeCommand = (): void => {
    const pending = pendingBargeCommandRef.current;
    if (
      !pending
      || !activeRef.current
      || isStreamingRef.current
      || wakeFeedbackRef.current === 'acknowledging'
      || bargeProbeStartingRef.current
      || bargeProbeActiveRef.current
      || bargeProbeFinalizingRef.current
    ) return;
    pendingBargeCommandRef.current = null;
    wakeMatchedUtteranceRef.current = false;
    wakeRemainderRef.current = '';
    if (pending.command.trim()) {
      void beginReply(pending.command);
    } else {
      bargeAbortCommittedRef.current = false;
      void startStt(false).then(() => {
        if (activeRef.current && sttActiveRef.current) {
          setNotice(`已打断，请继续说；再次插话仍需先说“${wakeWordRef.current.trim()}”`);
        }
      });
    }
  };

  const finalizeBargeProbe = async (): Promise<void> => {
    if (
      !activeRef.current
      || bargeProbeFinalizingRef.current
      || (!bargeProbeActiveRef.current && !bargeProbeStartingRef.current)
    ) return;
    bargeProbeFinalizingRef.current = true;
    bargeProbeActiveRef.current = false;
    bargeProbeStartingRef.current = false;
    clearBargeProbeTimer();
    const fallback = bargeProbeTranscriptRef.current.trim();
    ignoreSttEndUntilRef.current = Date.now() + 1200;
    let text = fallback;
    try {
      const result = await api.sttStreamStop(sessionId);
      text = String(result.text || fallback || '').trim();
    } catch {
      // Partial transcript remains usable if the probe stream closed first.
    }
    if (!activeRef.current) return;

    const finalMatch = matchWakeDirectedInterruption(
      text,
      wakeWordRef.current,
      replySpeechTextRef.current,
    );
    const acceptedMatch = finalMatch.matched ? finalMatch : bargeProbeMatchRef.current;
    if (acceptedMatch?.matched) {
      if (!bargeAbortCommittedRef.current) commitWakeDirectedAbort(acceptedMatch);
      const command = '';
      pendingBargeCommandRef.current = { command };
      setTranscript(command);
      setNotice(command
        ? '定向打断已确认，等待上一轮安全停止后发送新指令'
        : `定向打断已确认，请继续说；唤醒词为“${wakeWordRef.current.trim()}”`);
    } else {
      setTranscript('');
      setNotice(`未听到“${wakeWordRef.current.trim()}”，没有打断当前回复`);
    }

    bargeProbeFramesRef.current = [];
    bargeProbeTranscriptRef.current = '';
    bargeProbeStartedAtRef.current = 0;
    bargeProbeSilenceRef.current = 0;
    bargeProbeMatchRef.current = null;
    bargeBusyRef.current = false;
    bargeProbeFinalizingRef.current = false;
    const confirmed = bargeAbortCommittedRef.current;
    if (confirmed) dispatchPendingBargeCommand();
    else restoreReplyPhase();
  };

  const startBargeProbe = async (
    seedFrames: ArrayBuffer[],
    threshold: number,
  ): Promise<void> => {
    if (
      !activeRef.current
      || bargeBusyRef.current
      || bargeProbeStartingRef.current
      || bargeProbeActiveRef.current
      || bargeProbeFinalizingRef.current
      || !wakeWordRef.current.trim()
    ) return;
    bargeBusyRef.current = true;
    bargeProbeStartingRef.current = true;
    bargeProbeFramesRef.current = seedFrames.map((frame) => frame.slice(0));
    bargeProbeTranscriptRef.current = '';
    bargeProbeStartedAtRef.current = Date.now();
    bargeProbeSilenceRef.current = 0;
    bargeProbeThresholdRef.current = threshold;
    bargeProbeMatchRef.current = null;
    bargeAbortCommittedRef.current = false;
    clearContinuousLease();
    // Once a real voice candidate appears, immediately lower WebAudio output
    // (or pause browser system speech). This gives the cloud recognizer a clean
    // continuation even with one microphone beside the speakers.
    setPlaybackDucked(true);
    setNotice(`听到插话候选；只有包含“${wakeWordRef.current.trim()}”才会打断`);
    const generation = generationRef.current;
    try {
      const response = await api.sttStreamStart({ flashRefineEnabled: false }, sessionId);
      if (!activeRef.current || generation !== generationRef.current) {
        if (response.ok) void api.sttStreamStop(sessionId);
        return;
      }
      if (!response.ok) throw new Error(response.error || '插话确认识别启动失败');
      bargeProbeStartingRef.current = false;
      bargeProbeActiveRef.current = true;
      if (response.model) setAsrModel(response.model);
      const buffered = bargeProbeFramesRef.current.splice(0);
      buffered.forEach((frame) => api.sttStreamAudioBinary(frame));
      bargeProbeTimerRef.current = window.setTimeout(() => {
        void finalizeBargeProbe();
      }, BARGE_PROBE_MAX_MS);
    } catch (cause: any) {
      bargeProbeStartingRef.current = false;
      bargeProbeActiveRef.current = false;
      bargeProbeFramesRef.current = [];
      bargeBusyRef.current = false;
      setNotice(cause?.message || '无法确认插话，当前回复保持不变');
      restoreReplyPhase();
    }
  };

  const handlePcmFrame = (frame: ArrayBuffer): void => {
    if (!activeRef.current) return;
    const frameReceivedAt = Date.now();
    const echoQuarantined = frameReceivedAt < startupAudioBlockedUntilRef.current;
    const copy = frame.slice(0);
    preRollRef.current.push(copy);
    if (preRollRef.current.length > MAX_PREROLL_FRAMES) preRollRef.current.shift();
    if (sttStartingRef.current && !echoQuarantined) {
      startupFramesRef.current.push(copy);
      if (startupFramesRef.current.length > MAX_STARTUP_FRAMES) startupFramesRef.current.shift();
    }
    if (bargeProbeStartingRef.current) {
      bargeProbeFramesRef.current.push(copy);
      if (bargeProbeFramesRef.current.length > MAX_STARTUP_FRAMES) {
        bargeProbeFramesRef.current.shift();
      }
    }

    const rms = pcm16Rms(frame);
    const frameMs = Math.max(1, (frame.byteLength / 2 / 16000) * 1000);
    if (bargeProbeActiveRef.current) {
      if (echoQuarantined) return;
      api.sttStreamAudioBinary(frame);
      if (rms >= bargeProbeThresholdRef.current) {
        bargeProbeSilenceRef.current = 0;
      } else {
        bargeProbeSilenceRef.current += frameMs;
      }
      const probeSilenceTarget = Math.max(
        650,
        Math.min(1200, turnEndSilenceMsRef.current * 0.6),
      );
      if (
        bargeProbeSilenceRef.current >= probeSilenceTarget
        && Date.now() - bargeProbeStartedAtRef.current >= 500
      ) {
        void finalizeBargeProbe();
      }
      return;
    }
    if (bargeProbeStartingRef.current || bargeProbeFinalizingRef.current) return;

    if ((phaseRef.current === 'listening' || phaseRef.current === 'standby') && sttActiveRef.current) {
      if (echoQuarantined) return;
      startupAudioBlockedUntilRef.current = 0;
      api.sttStreamAudioBinary(frame);
      if (rms >= vadThresholdRef.current) {
        silenceAccumRef.current = 0;
        if (silenceRemainingRef.current !== null) updateSilenceRemaining(null);
        speechFramesRef.current += 1;
        if (!utteranceStartedAtRef.current && speechFramesRef.current >= 2) {
          utteranceStartedAtRef.current = Date.now();
          clearContinuousLease();
          setHeardSpeech(true);
          setNotice(armedRef.current
            ? '已检测到说话，可自然停顿思考'
            : `正在听，请先说“${wakeWordRef.current.trim()}”`);
        }
      } else if (utteranceStartedAtRef.current) {
        silenceAccumRef.current += frameMs;
      } else {
        speechFramesRef.current = 0;
      }
      const targetSilenceMs = computeTurnEndSilenceMs(
        turnEndSilenceMsRef.current,
        wakeRemainderRef.current || latestTranscriptRef.current,
      );
      if (utteranceStartedAtRef.current && silenceAccumRef.current > 0) {
        const now = Date.now();
        if (now - silenceUiUpdatedAtRef.current >= 100) {
          silenceUiUpdatedAtRef.current = now;
          updateSilenceRemaining(targetSilenceMs - silenceAccumRef.current);
        }
      }
      if (utteranceStartedAtRef.current && (
        silenceAccumRef.current >= targetSilenceMs
        || Date.now() - utteranceStartedAtRef.current >= 60_000
      )) {
        void finalizeUtterance();
      }
      return;
    }

    if (
      bargeInRef.current
      && !!wakeWordRef.current.trim()
      && (
        phaseRef.current === 'thinking'
        || phaseRef.current === 'working'
        || phaseRef.current === 'speaking'
      )
    ) {
      const now = Date.now();
      const speaking = phaseRef.current === 'speaking';
      if (speaking) {
        playbackEchoFloorRef.current = updatePlaybackEchoFloor(
          playbackEchoFloorRef.current,
          rms,
        );
      }
      const playbackAge = playbackStartedAtRef.current
        ? now - playbackStartedAtRef.current
        : 0;
      const sincePlaybackEnded = lastPlaybackEndedAtRef.current
        ? now - lastPlaybackEndedAtRef.current
        : Number.POSITIVE_INFINITY;
      const policy = echoProtectedBargeIn(
        vadThresholdRef.current,
        speaking,
        playbackAge,
        sincePlaybackEnded,
        playbackEchoFloorRef.current,
      );
      if (!policy.enabled) {
        bargeFramesRef.current = 0;
        return;
      }
      if (rms >= policy.threshold) bargeFramesRef.current += 1;
      else bargeFramesRef.current = 0;
      if (bargeFramesRef.current >= policy.requiredFrames) {
        bargeFramesRef.current = 0;
        void startBargeProbe(
          preRollRef.current.map((item) => item.slice(0)),
          policy.threshold,
        );
      }
    }
  };

  const releaseMedia = (): void => {
    if (workletRef.current) {
      workletRef.current.port.onmessage = null;
      workletRef.current.port.close();
      workletRef.current.disconnect();
      workletRef.current = null;
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    void captureContextRef.current?.close().catch(() => {});
    captureContextRef.current = null;
  };

  const stopConversation = (preserveError = false, silent = false): void => {
    generationRef.current += 1;
    activeRef.current = false;
    sttStartingRef.current = false;
    finalizingRef.current = false;
    const hadProbeStream = bargeProbeStartingRef.current
      || bargeProbeActiveRef.current
      || bargeProbeFinalizingRef.current;
    bargeProbeStartingRef.current = false;
    bargeProbeActiveRef.current = false;
    bargeProbeFinalizingRef.current = false;
    bargeBusyRef.current = false;
    clearBargeProbeTimer();
    clearContinuousLease();
    clearWakeReadyTimer();
    bargeProbeFramesRef.current = [];
    bargeProbeTranscriptRef.current = '';
    bargeProbeMatchRef.current = null;
    bargeAbortCommittedRef.current = false;
    pendingBargeCommandRef.current = null;
    replyExpectedRef.current = false;
    resumeScheduledRef.current = false;
    clearSpeechCommitTimer();
    speechGateRef.current.reset();
    activeToolIdsRef.current.clear();
    replySpeechTextRef.current = '';
    echoReferenceRef.current = '';
    startupAudioBlockedUntilRef.current = 0;
    if (sttActiveRef.current || hadProbeStream) {
      sttActiveRef.current = false;
      void api.sttStreamStop(sessionId);
    }
    cancelCurrentTts();
    releaseMedia();
    try { playbackGainRef.current?.disconnect(); } catch { /* already disconnected */ }
    playbackGainRef.current = null;
    playbackDuckedRef.current = false;
    void playbackContextRef.current?.close().catch(() => {});
    playbackContextRef.current = null;
    preRollRef.current = [];
    startupFramesRef.current = [];
    latestTranscriptRef.current = '';
    armedRef.current = false;
    wakeMatchedUtteranceRef.current = false;
    wakeTransitioningRef.current = false;
    wakeRemainderRef.current = '';
    updateWakeFeedback('locked');
    voiceSummaryProjectorRef.current.reset();
    if (!silent) {
      setActive(false);
      updatePhase(preserveError ? 'error' : 'idle');
      setTranscript('');
      setHeardSpeech(false);
      setAgentActivity('');
      updateSilenceRemaining(null);
      if (!preserveError) {
        setError('');
        setNotice('');
      }
      onActiveChangeRef.current?.(false);
    }
  };

  const startConversation = async (): Promise<void> => {
    if (activeRef.current || isStreamingRef.current) return;
    setError('');
    setNotice('正在初始化麦克风与低延时音频队列');
    armedRef.current = !wakeWordRef.current.trim();
    updateWakeFeedback(armedRef.current ? 'ready' : 'locked');
    pendingBargeCommandRef.current = null;
    bargeAbortCommittedRef.current = false;
    wakeMatchedUtteranceRef.current = false;
    wakeTransitioningRef.current = false;
    wakeRemainderRef.current = '';
    const preferredEngine = ttsEngineRef.current === 'system'
      ? (systemSpeechAvailable() ? 'system' : 'edge')
      : ttsEngineRef.current;
    setPlaybackEngineLabel(
      preferredEngine === 'system'
        ? '本机系统语音'
        : preferredEngine === 'dashscope'
          ? 'DashScope 流式 TTS'
          : 'Edge TTS',
    );
    window.dispatchEvent(new CustomEvent('awu:voice-owner-active', {
      detail: { ownerId: voiceOwnerId },
    }));
    setActive(true);
    activeRef.current = true;
    generationRef.current += 1;
    const generation = generationRef.current;
    updatePhase('starting');
    onActiveChangeRef.current?.(true);
    try {
      const AudioContextCtor = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('当前环境不支持实时麦克风或 Web Audio');
      }

      // 先占住一个由用户点击激活的播放上下文，后续异步 TTS 不再受 autoplay 限制。
      const playback = new AudioContextCtor();
      playbackContextRef.current = playback;
      const playbackGain = playback.createGain();
      playbackGain.gain.value = 1;
      playbackGain.connect(playback.destination);
      playbackGainRef.current = playbackGain;
      playbackDuckedRef.current = false;
      await playback.resume();
      const wakeEngine = ttsEngineRef.current === 'system' && !systemSpeechAvailable()
        ? 'edge'
        : ttsEngineRef.current;
      if (wakeEngine !== 'system') {
        // Waiting for the wake word is useful idle time: warm the fixed first
        // acknowledgement so the selected cloud voice can answer immediately.
        void loadBackendWakeAcknowledgement('我在', wakeEngine).catch(() => {});
      }

      const sttConfig = await api.getSttConfig(sessionId);
      if (sttConfig?.mode !== 'dashscope' || !sttConfig?.apiKey) {
        throw new Error('请先在设置 → Voice-to-Text 选择 DashScope 并配置 API Key');
      }

      // 与单次听写互斥；即便两者同时发出 stop，请求在同一 WS 上仍会有序完成。
      await api.sttStreamStop(sessionId).catch(() => {});
      const deviceId = sttConfig?.deviceId || '';
      let stream: MediaStream;
      try {
        const enhancedAudioConstraints = {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          // Boolean constraints make Chromium/WebView2 actually enable its
          // acoustic echo canceller; an `ideal` hint was sometimes ignored by
          // USB microphones and led the recognizer to hear the TTS itself.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // WebView2/Chromium 支持时进一步隔离扬声器回放；不支持会被忽略。
          voiceIsolation: { ideal: true },
        } as MediaTrackConstraints;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: enhancedAudioConstraints,
        });
      } catch (cause) {
        if (!deviceId) throw cause;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (!activeRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = stream;

      const capture = new AudioContextCtor({ sampleRate: 16000 });
      captureContextRef.current = capture;
      await capture.resume();
      await capture.audioWorklet.addModule('./pcm-worklet.js');
      const source = capture.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(capture, 'pcm-processor');
      workletRef.current = worklet;
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer | { type?: string }>) => {
        if (event.data instanceof ArrayBuffer) handlePcmFrame(event.data);
      };
      source.connect(worklet);
      const silentSink = capture.createGain();
      silentSink.gain.value = 0;
      worklet.connect(silentSink);
      silentSink.connect(capture.destination);
      await startStt(false);
      if (phaseRef.current === 'error') throw new Error('Fun-ASR Realtime 连接失败');
    } catch (cause: any) {
      setError(cause?.message || '实时语音对话启动失败');
      updatePhase('error');
      stopConversation(true);
    }
  };

  // Push-event subscriptions stay stable; handlers above read current refs.
  const ttsHandlerRef = useRef(handleTtsEvent);
  const streamHandlerRef = useRef(handleStreamDelta);
  ttsHandlerRef.current = handleTtsEvent;
  streamHandlerRef.current = handleStreamDelta;
  useEffect(() => {
    const offTts = api.onTtsStreamAudio((event) => { void ttsHandlerRef.current(event); });
    const offStream = subscribeToReply
      ? subscribeToReply((delta) => streamHandlerRef.current(delta))
      : api.onStreamDelta((delta) => streamHandlerRef.current(delta));
    const offText = api.onSttStreamText((data) => {
      if (!activeRef.current) return;
      const rawText = data.text || '';
      if (bargeProbeActiveRef.current || bargeProbeStartingRef.current) {
        bargeProbeTranscriptRef.current = rawText;
        const wakeMatch = matchWakeDirectedInterruption(
          rawText,
          wakeWordRef.current,
          replySpeechTextRef.current,
        );
        if (wakeMatch.matched && (!wakeMatch.finalOnly || data.isFinal)) {
          bargeProbeMatchRef.current = wakeMatch;
          commitWakeDirectedAbort(wakeMatch);
          setTranscript(wakeMatch.remainder);
          void finalizeBargeProbe();
          return;
        }
        if (data.isFinal) void finalizeBargeProbe();
        return;
      }
      if (!sttActiveRef.current) return;
      // A final empty event must not erase the last useful partial. Short wake
      // words are especially prone to this Fun-ASR event sequence.
      if (rawText.trim()) latestTranscriptRef.current = rawText;
      if (!armedRef.current && wakeWordRef.current.trim()) {
        const wakeMatch = matchWakePhrase(rawText, wakeWordRef.current);
        if (wakeMatch.matched && (!wakeMatch.finalOnly || data.isFinal)) {
          acknowledgeWake();
        }
        else setTranscript(rawText);
      } else if (wakeWordRef.current.trim()) {
        const wakeMatch = matchWakePhrase(rawText, wakeWordRef.current);
        if (
          wakeMatch.matched
          && (!wakeMatch.finalOnly || data.isFinal)
          && !wakeMatchedUtteranceRef.current
        ) {
          acknowledgeWake();
        } else if (wakeMatchedUtteranceRef.current) {
          setTranscript('');
        } else {
          setTranscript(rawText);
        }
      } else {
        setTranscript(rawText);
      }
    });
    const offEnd = api.onSttStreamEnd(() => {
      if (!activeRef.current || Date.now() < ignoreSttEndUntilRef.current) return;
      if (bargeProbeFinalizingRef.current) return;
      if (bargeProbeActiveRef.current || bargeProbeStartingRef.current) {
        void finalizeBargeProbe();
        return;
      }
      if (
        phaseRef.current !== 'listening' && phaseRef.current !== 'standby'
      ) return;
      sttActiveRef.current = false;
      const partial = latestTranscriptRef.current.trim();
      if (partial && utteranceStartedAtRef.current) void processRecognizedText(partial);
      else {
        setNotice('识别连接中断，正在恢复');
        void startStt(false);
      }
    });
    return () => { offTts(); offStream(); offText(); offEnd(); };
  }, [sessionId, subscribeToReply]);

  const stopRef = useRef(stopConversation);
  stopRef.current = stopConversation;
  const previousSessionRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionRef.current !== sessionId) {
      previousSessionRef.current = sessionId;
      stopRef.current();
    }
  }, [sessionId]);
  useEffect(() => {
    const handleVoiceOwner = (event: Event) => {
      const nextOwner = (event as CustomEvent<{ ownerId?: string }>).detail?.ownerId;
      if (nextOwner && nextOwner !== voiceOwnerId && activeRef.current) stopRef.current();
    };
    window.addEventListener('awu:voice-owner-active', handleVoiceOwner);
    return () => window.removeEventListener('awu:voice-owner-active', handleVoiceOwner);
  }, [voiceOwnerId]);
  useEffect(() => () => {
    stopRef.current(false, true);
    onActiveChangeRef.current?.(false);
  }, []);
  useEffect(() => {
    if (!isFocused && activeRef.current) stopConversation();
  }, [isFocused]);

  const previousStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const previous = previousStreamingRef.current;
    previousStreamingRef.current = isStreaming;
    if (!activeRef.current) return;
    if (!isStreaming && pendingBargeCommandRef.current) {
      dispatchPendingBargeCommand();
      return;
    }
    if (!previous && isStreaming && !replyExpectedRef.current) adoptStreamingReply();
    if (previous && !isStreaming && replyExpectedRef.current && !llmDoneRef.current) {
      // 没收到 done 的下降沿通常来自人工 Abort / 断线恢复；不朗读残缺尾巴。
      clearSpeechCommitTimer();
      cancelCurrentTts();
      llmDoneRef.current = true;
      scheduleListeningAfterReply();
    }
  }, [isStreaming]);

  const statusColor = phase === 'error'
    ? 'var(--theme-error, #f85149)'
    : phase === 'listening'
      ? '#32b67a'
      : phase === 'speaking'
        ? 'var(--theme-accent, #4096ff)'
        : '#d29922';
  const pauseDetail = silenceRemainingMs !== null && phase === 'listening'
    ? `停顿中，继续说话即可取消 · ${(silenceRemainingMs / 1000).toFixed(1)}s`
    : '';
  const detail = error
    || pauseDetail
    || notice
    || (active
      ? PHASE_LABELS[phase]
      : `Fun-ASR → 当前 Backend → ${
        ttsEngine === 'system'
          ? '本机系统语音'
          : ttsEngine === 'dashscope'
            ? 'DashScope 流式 TTS'
            : 'Edge TTS'
      }`);

  const toggleTitle = !active && isStreaming
    ? '当前回答结束后可开启实时语音对话'
    : active
      ? `退出实时语音对话\n${detail}`
      : `开启实时语音对话（实验）\n${detail}`;
  const compactStatus = phase === 'standby' || wakeFeedback === 'locked'
    ? `说 ${wakeWord.trim() || '唤醒词'}`
    : phase === 'listening' && heardSpeech
      ? '● 正在听'
      : wakeFeedback === 'acknowledging'
        ? '已收到…'
        : phase === 'listening' && wakeFeedback === 'ready'
          ? '✓ 已唤醒 · 请说'
          : PHASE_LABELS[phase];

  if (compact) {
    return (
      <div style={compactWrapStyle}>
        <button
          type="button"
          onClick={() => activeRef.current ? stopConversation() : void startConversation()}
          disabled={!active && isStreaming}
          aria-label={active ? `退出实时语音对话，当前${PHASE_LABELS[phase]}` : '开启实时语音对话'}
          aria-pressed={active}
          style={{
            ...compactToggleStyle,
            borderColor: active
              ? statusColor
              : phase === 'error' ? 'var(--theme-error, #f85149)' : 'var(--theme-border)',
            background: active
              ? 'var(--theme-accent-bg, rgba(64,150,255,0.1))'
              : 'var(--theme-bg-secondary)',
            color: active
              ? statusColor
              : phase === 'error' ? 'var(--theme-error, #f85149)' : 'var(--theme-text-muted)',
            opacity: !active && isStreaming ? 0.42 : 1,
            cursor: !active && isStreaming ? 'not-allowed' : 'pointer',
          }}
          title={toggleTitle}
        >
          <span aria-hidden="true" style={{ fontSize: 13 }}>{phase === 'error' ? '!' : active ? '■' : '◉'}</span>
          {active && <span aria-hidden="true" style={{ ...compactStatusDotStyle, background: statusColor }} />}
        </button>
        {active && (
          <span
            style={{
              ...compactWakeStatusStyle,
              color: wakeFeedback === 'ready' && phase === 'listening'
                ? 'var(--theme-success, #32b67a)'
                : 'var(--theme-text-muted)',
              borderColor: wakeFeedback === 'ready' && phase === 'listening'
                ? 'var(--theme-success-border, rgba(50,182,122,0.25))'
                : 'var(--theme-border)',
            }}
            title={detail}
            aria-live="polite"
          >
            {compactStatus}
          </span>
        )}
        {active && phase === 'listening' && heardSpeech && !finalizingRef.current && (
          <button
            type="button"
            onClick={() => void finalizeUtterance()}
            style={compactSendStyle}
            title="不再等待静音，立即提交当前语音"
            aria-label="立即提交当前语音"
          >
            ↗
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={barStyle}>
      <button
        type="button"
        onClick={() => activeRef.current ? stopConversation() : void startConversation()}
        disabled={!active && isStreaming}
        style={{
          ...toggleStyle,
          borderColor: active ? 'var(--theme-accent, #4096ff)' : 'var(--theme-border)',
          color: active ? 'var(--theme-accent, #4096ff)' : 'var(--theme-text)',
          opacity: !active && isStreaming ? 0.45 : 1,
        }}
        title={toggleTitle}
      >
        <span style={{ fontSize: 13 }}>{active ? '■' : '◉'}</span>
        <span>{active ? '退出实时' : '实时对话'}</span>
        {!active && <span style={experimentTag}>实验</span>}
      </button>

      <span style={{ ...statusDot, background: active ? statusColor : 'var(--theme-text-muted)' }} />
      <span style={detailStyle} title={detail}>{detail}</span>

      {active && (
        <>
          {phase === 'standby' && wakeWord.trim() && (
            <span style={wakePromptStyle}>请说“{wakeWord.trim()}”开始</span>
          )}
          {phase === 'listening' && heardSpeech && !finalizingRef.current && (
            <button
              type="button"
              onClick={() => void finalizeUtterance()}
              style={sendNowStyle}
              title="不再等待静音，立即提交当前语音"
            >
              立即发送
            </button>
          )}
          {agentActivity && (
            <span style={agentActivityStyle} title={`Agent 正在处理：${agentActivity}；仅工具输入、日志和原始输出不朗读`}>
              ⚙ {agentActivity} · 工具静默
            </span>
          )}
          <span style={routeStyle} title={`${asrModel} → ${backendLabel} → ${playbackEngineLabel}`}>
            {heardSpeech ? '声段已锁定' : asrModel} · {backendLabel || '当前 Backend'} · {playbackEngineLabel}
          </span>
          {firstAudioMs !== null && (
            <span style={metricStyle} title="从发送转写到首段音频开始播放">首音 {firstAudioMs}ms</span>
          )}
          {transcript && (
            <span style={transcriptStyle} title={transcript}>“{transcript}”</span>
          )}
        </>
      )}
    </div>
  );
};

const barStyle: React.CSSProperties = {
  flexShrink: 0,
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '3px 10px 0',
  padding: '4px 7px',
  border: '1px solid var(--theme-border, rgba(148,163,184,0.16))',
  borderRadius: 5,
  background: 'var(--theme-bg-secondary, rgba(16,23,32,0.92))',
  color: 'var(--theme-text)',
  minWidth: 0,
  overflow: 'hidden',
};

const compactWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  flexShrink: 0,
};

const compactToggleStyle: React.CSSProperties = {
  position: 'relative',
  minWidth: 33,
  height: 27,
  padding: '0 9px',
  border: '1px solid var(--theme-border)',
  borderRadius: 5,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s',
};

const compactStatusDotStyle: React.CSSProperties = {
  position: 'absolute',
  top: 3,
  right: 3,
  width: 4,
  height: 4,
  borderRadius: '50%',
  boxShadow: '0 0 0 2px var(--theme-bg-secondary)',
};

const compactWakeStatusStyle: React.CSSProperties = {
  height: 27,
  maxWidth: 126,
  padding: '0 7px',
  border: '1px solid var(--theme-border)',
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  background: 'var(--theme-bg-secondary)',
  fontSize: 10.5,
  fontWeight: 600,
};

const compactSendStyle: React.CSSProperties = {
  width: 27,
  height: 27,
  padding: 0,
  border: '1px solid var(--theme-success-border, rgba(50,182,122,0.25))',
  borderRadius: 5,
  background: 'var(--theme-success-bg, rgba(50,182,122,0.1))',
  color: 'var(--theme-success, #32b67a)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 700,
};

const toggleStyle: React.CSSProperties = {
  height: 25,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '0 8px',
  border: '1px solid var(--theme-border)',
  borderRadius: 4,
  background: 'var(--theme-bg-tertiary)',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const experimentTag: React.CSSProperties = {
  padding: '1px 4px',
  borderRadius: 3,
  background: 'var(--theme-accent-bg)',
  color: 'var(--theme-accent)',
  fontSize: 9,
  fontWeight: 700,
};

const statusDot: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  flexShrink: 0,
};

const detailStyle: React.CSSProperties = {
  flex: '1 1 120px',
  minWidth: 36,
  maxWidth: 260,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--theme-text-muted)',
  fontSize: 10,
};

const routeStyle: React.CSSProperties = {
  maxWidth: 190,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--theme-text-muted)',
  fontSize: 9,
  opacity: 0.82,
  whiteSpace: 'nowrap',
};

const metricStyle: React.CSSProperties = {
  padding: '2px 5px',
  border: '1px solid var(--theme-success-border, rgba(50,182,122,0.25))',
  borderRadius: 3,
  background: 'var(--theme-success-bg, rgba(50,182,122,0.1))',
  color: 'var(--theme-success, #32b67a)',
  fontSize: 9,
  whiteSpace: 'nowrap',
};

const wakePromptStyle: React.CSSProperties = {
  padding: '2px 6px',
  border: '1px solid var(--theme-accent, #4096ff)',
  borderRadius: 3,
  color: 'var(--theme-accent, #4096ff)',
  background: 'var(--theme-accent-bg, rgba(64,150,255,0.1))',
  fontSize: 10,
  fontWeight: 650,
  whiteSpace: 'nowrap',
};

const sendNowStyle: React.CSSProperties = {
  height: 23,
  padding: '0 7px',
  border: '1px solid var(--theme-success-border, rgba(50,182,122,0.25))',
  borderRadius: 3,
  background: 'var(--theme-success-bg, rgba(50,182,122,0.1))',
  color: 'var(--theme-success, #32b67a)',
  cursor: 'pointer',
  fontSize: 10,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const agentActivityStyle: React.CSSProperties = {
  maxWidth: 170,
  padding: '2px 6px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  border: '1px solid rgba(210,153,34,0.32)',
  borderRadius: 3,
  background: 'rgba(210,153,34,0.08)',
  color: '#d6a33a',
  fontSize: 9,
};

const transcriptStyle: React.CSSProperties = {
  marginLeft: 'auto',
  maxWidth: '34%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--theme-text-muted)',
  fontSize: 10,
};
