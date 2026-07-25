import { api } from '../api';

export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'error';

export interface SpeechState {
  messageId: string | null;
  status: SpeechStatus;
  error?: string;
}

export const TTS_STATE_EVENT = 'awu-tts-state';

let activeAudio: HTMLAudioElement | null = null;
let activeUrl: string | null = null;
let activeMessageId: string | null = null;
let requestVersion = 0;

function emit(state: SpeechState): void {
  window.dispatchEvent(new CustomEvent<SpeechState>(TTS_STATE_EVENT, { detail: state }));
}

function releaseAudio(): void {
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  }
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

export function stopSpeech(messageId?: string): void {
  if (messageId && activeMessageId !== messageId) return;
  requestVersion += 1;
  const stoppedId = activeMessageId;
  releaseAudio();
  activeMessageId = null;
  emit({ messageId: stoppedId, status: 'idle' });
}

export async function toggleSpeech(
  messageId: string,
  text: string,
  voice: string,
  rate: number,
): Promise<void> {
  if (activeMessageId === messageId) {
    stopSpeech(messageId);
    return;
  }

  stopSpeech();
  const version = ++requestVersion;
  activeMessageId = messageId;
  emit({ messageId, status: 'loading' });

  try {
    const result = await api.ttsSynthesize(text, voice, rate);
    if (version !== requestVersion || activeMessageId !== messageId) return;
    if (!result.ok || !result.base64) {
      throw new Error(result.error || '语音生成失败');
    }

    const blob = new Blob([decodeBase64(result.base64)], {
      type: result.mime || 'audio/mpeg',
    });
    activeUrl = URL.createObjectURL(blob);
    activeAudio = new Audio(activeUrl);
    activeAudio.onended = () => {
      if (activeMessageId === messageId) stopSpeech(messageId);
    };
    activeAudio.onerror = () => {
      if (activeMessageId !== messageId) return;
      const error = '音频播放失败';
      releaseAudio();
      activeMessageId = null;
      emit({ messageId, status: 'error', error });
    };
    await activeAudio.play();
    if (version === requestVersion && activeMessageId === messageId) {
      emit({ messageId, status: 'playing' });
    }
  } catch (error: any) {
    if (version !== requestVersion) return;
    releaseAudio();
    activeMessageId = null;
    emit({
      messageId,
      status: 'error',
      error: error?.message || String(error),
    });
  }
}
