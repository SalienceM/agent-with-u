/** Pure helpers for the experimental low-latency voice conversation path. */

export interface SpeechChunkerOptions {
  firstMinChars?: number;
  firstMaxChars?: number;
  nextMinChars?: number;
  nextMaxChars?: number;
}

export interface WakePhraseMatch {
  matched: boolean;
  remainder: string;
  matchedText?: string;
  /** Ambiguous ASR homophones are accepted only after the utterance is final. */
  finalOnly?: boolean;
}

export const WAKE_ACKNOWLEDGEMENTS = [
  '我在',
  '在呢',
  '嗯，我在',
  "I'm here",
  'Listening',
] as const;

/** Pick a short acknowledgement while avoiding an immediate repeat. */
export function pickWakeAcknowledgement(
  previous = '',
  random: () => number = Math.random,
): string {
  const candidates = WAKE_ACKNOWLEDGEMENTS.filter((item) => item !== previous);
  const pool = candidates.length > 0 ? candidates : [...WAKE_ACKNOWLEDGEMENTS];
  const sample = Number(random());
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999, sample)) : 0;
  return pool[Math.floor(normalized * pool.length)] || WAKE_ACKNOWLEDGEMENTS[0];
}

export type RealtimeVoiceInteractionMode =
  | 'realtime-voice-foreground'
  | 'realtime-voice-background';

export interface VoiceSurfaceState {
  documentHidden?: boolean;
  minimized?: boolean;
  visible?: boolean;
}

const VOICE_SUMMARY_START = '<!--AWU-VOICE-->';
const VOICE_SUMMARY_END = '<!--/AWU-VOICE-->';

/** Only a genuinely hidden/minimized surface uses the audio-first response contract. */
export function resolveRealtimeVoiceInteractionMode(
  state: VoiceSurfaceState,
): RealtimeVoiceInteractionMode {
  return state.documentHidden || state.minimized || state.visible === false
    ? 'realtime-voice-background'
    : 'realtime-voice-foreground';
}

export function normalizeContinuousVoiceWindowMs(value: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(10_000, Math.min(120_000, Math.round(parsed)))
    : 30_000;
}

/** Pure lease decision used by the realtime controller and regression tests. */
export function shouldRelockContinuousVoice(
  wakeWord: string,
  idleForMs: number,
  continuousWindowMs: number,
  busy = false,
): boolean {
  if (!String(wakeWord || '').trim() || busy) return false;
  return Math.max(0, Number(idleForMs) || 0)
    >= normalizeContinuousVoiceWindowMs(continuousWindowMs);
}

function markerSuffixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (marker.startsWith(value.slice(-size))) return size;
  }
  return 0;
}

/**
 * Projects hidden <!--AWU-VOICE--> summaries out of a foreground response.
 * Markers may be split across arbitrary stream deltas and may occur repeatedly.
 * If a backend ignores the protocol entirely, finish() returns the original prose
 * so the user never receives a completely silent reply.
 */
export class VoiceSummaryProjector {
  private pending = '';
  private inside = false;
  private sawMarker = false;
  private plainText = false;

  reset(): void {
    this.pending = '';
    this.inside = false;
    this.sawMarker = false;
    this.plainText = false;
  }

  pushText(delta: string): string[] {
    if (!delta) return [];
    if (this.plainText) return [delta];
    this.pending += delta;

    // The summary protocol always starts with the marker (apart from harmless
    // whitespace). As soon as the first real character proves this is ordinary
    // prose, pass it through incrementally instead of holding the whole answer
    // until `done`. This keeps normal/legacy backends genuinely low latency.
    if (!this.sawMarker) {
      const firstContent = this.pending.search(/\S/);
      if (firstContent < 0) return [];
      const candidate = this.pending.slice(firstContent);
      if (VOICE_SUMMARY_START.startsWith(candidate)) return [];
      if (!candidate.startsWith(VOICE_SUMMARY_START)) {
        const prose = this.pending;
        this.pending = '';
        this.plainText = true;
        return [prose];
      }
      this.pending = candidate;
    }
    return this.consume(false);
  }

  finish(): string[] {
    if (this.plainText) {
      this.reset();
      return [];
    }
    if (!this.sawMarker) {
      const fallback = this.pending;
      this.reset();
      return fallback ? [fallback] : [];
    }
    const projected = this.consume(true);
    this.reset();
    return projected;
  }

  private consume(final: boolean): string[] {
    const output: string[] = [];
    while (this.pending) {
      const marker = this.inside ? VOICE_SUMMARY_END : VOICE_SUMMARY_START;
      const index = this.pending.indexOf(marker);
      if (index >= 0) {
        if (this.inside && index > 0) output.push(this.pending.slice(0, index));
        this.pending = this.pending.slice(index + marker.length);
        this.inside = !this.inside;
        if (!this.sawMarker) {
          this.sawMarker = true;
        }
        continue;
      }

      const retained = final ? 0 : markerSuffixLength(this.pending, marker);
      const safeLength = this.pending.length - retained;
      if (safeLength > 0 && this.inside) output.push(this.pending.slice(0, safeLength));
      this.pending = this.pending.slice(safeLength);
      break;
    }
    return output;
  }
}

/** Only Agent-authored visible prose is eligible for TTS projection. */
export function isSpeakableAgentDelta(deltaType: string): boolean {
  return deltaType === 'text_delta';
}

const STRONG_BOUNDARY = /[。！？!?；;：:\n]/;
const WEAK_BOUNDARY = /[，、,]/;

/** Remove visual-only syntax immediately before a chunk is sent to TTS. */
export function cleanSpeechText(value: string): string {
  let text = String(value || '').replace(/\r\n/g, '\n');
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/<https?:\/\/[^>]+>/gi, '');
  text = text.replace(/https?:\/\/\S+/gi, '');
  text = text.replace(/(^|\n)\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s*/g, '$1');
  text = text.replace(/[`*_~]/g, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\s*\n\s*/g, '。');
  text = text.replace(/。{2,}/g, '。');
  text = text.replace(/^[。！？!?；;：:，、,\s]+/, '');
  return text.trim();
}

/**
 * Append-only Markdown-aware speech chunker.
 *
 * LLM deltas may split a ``` marker between frames, so the last two raw
 * characters are retained until another delta arrives. Fenced code is omitted;
 * prose is emitted at punctuation boundaries, with a smaller first chunk for a
 * low time-to-first-audio and larger later chunks for natural prosody.
 */
export class IncrementalSpeechChunker {
  private rawTail = '';
  private pendingSpeech = '';
  private inCodeFence = false;
  private firstChunk = true;
  private readonly options: Required<SpeechChunkerOptions>;

  constructor(options: SpeechChunkerOptions = {}) {
    this.options = {
      // 第一段刻意更短：先把首音送出去，后续再用较长片段保持韵律。
      firstMinChars: options.firstMinChars ?? 5,
      firstMaxChars: options.firstMaxChars ?? 12,
      nextMinChars: options.nextMinChars ?? 14,
      nextMaxChars: options.nextMaxChars ?? 32,
    };
  }

  reset(): void {
    this.rawTail = '';
    this.pendingSpeech = '';
    this.inCodeFence = false;
    this.firstChunk = true;
  }

  pushDelta(delta: string, final = false): string[] {
    if (delta) this.rawTail += delta;
    this.consumeRaw(final);
    return this.takeReady(final);
  }

  finish(): string[] {
    return this.pushDelta('', true);
  }

  private consumeRaw(final: boolean): void {
    const source = this.rawTail;
    // 只有末尾恰好是 ``` 的未完整前缀时才等待下一 delta；普通句末标点
    // 不应被无条件压住两个字符，否则会白白增加首音延迟。
    const retained = final ? 0 : source.endsWith('``') ? 2 : source.endsWith('`') ? 1 : 0;
    const safeLimit = source.length - retained;
    let index = 0;
    while (index < safeLimit) {
      if (source.startsWith('```', index)) {
        this.inCodeFence = !this.inCodeFence;
        index += 3;
        continue;
      }
      if (!this.inCodeFence) this.pendingSpeech += source[index];
      index += 1;
    }
    this.rawTail = source.slice(index);
  }

  private takeReady(final: boolean): string[] {
    const chunks: string[] = [];
    while (this.pendingSpeech) {
      const minChars = this.firstChunk
        ? this.options.firstMinChars
        : this.options.nextMinChars;
      const maxChars = this.firstChunk
        ? this.options.firstMaxChars
        : this.options.nextMaxChars;

      let strongBoundary = -1;
      let weakBoundary = -1;
      let maxBoundary = -1;
      for (let index = 0; index < this.pendingSpeech.length; index += 1) {
        const candidate = this.pendingSpeech.slice(0, index + 1);
        const cleanLength = cleanSpeechText(candidate).length;
        if (cleanLength >= minChars) {
          const char = this.pendingSpeech[index];
          if (STRONG_BOUNDARY.test(char)) {
            strongBoundary = index + 1;
            break;
          }
          if (WEAK_BOUNDARY.test(char)) weakBoundary = index + 1;
        }
        if (cleanLength >= maxChars) {
          maxBoundary = index + 1;
          break;
        }
      }

      let boundary = strongBoundary;
      if (boundary < 0 && maxBoundary > 0) boundary = weakBoundary > 0 ? weakBoundary : maxBoundary;
      if (boundary < 0 && final) boundary = this.pendingSpeech.length;
      if (boundary <= 0) break;

      const raw = this.pendingSpeech.slice(0, boundary);
      this.pendingSpeech = this.pendingSpeech.slice(boundary).replace(/^\s+/, '');
      const clean = cleanSpeechText(raw);
      if (!clean) continue;
      chunks.push(clean);
      this.firstChunk = false;
    }
    return chunks;
  }
}

/**
 * Holds the first short phrase briefly so a raw tool payload cannot accidentally
 * become speech. Structured tool events are filtered by the caller; every
 * text_delta is therefore Agent-authored prose and remains speakable across tool
 * boundaries, including useful stage summaries.
 */
export class ToolAwareSpeechGate {
  private readonly chunker: IncrementalSpeechChunker;
  private stagedChunks: string[] = [];
  private committed = false;
  private toolSeen = false;

  constructor(options: SpeechChunkerOptions = {}) {
    this.chunker = new IncrementalSpeechChunker(options);
  }

  reset(): void {
    this.chunker.reset();
    this.stagedChunks = [];
    this.committed = false;
    this.toolSeen = false;
  }

  pushText(text: string, _toolActive = false): string[] {
    if (!text) return [];
    const chunks = this.chunker.pushDelta(text);
    if (this.committed) return chunks;
    this.stagedChunks.push(...chunks);
    return [];
  }

  get hasStagedSpeech(): boolean {
    return this.stagedChunks.length > 0;
  }

  get usedTools(): boolean {
    return this.toolSeen;
  }

  /** Release early prose only after a short no-tool stability window. */
  commitStable(): string[] {
    if (this.committed) return [];
    this.committed = true;
    return this.stagedChunks.splice(0);
  }

  /**
   * A tool boundary confirms that preceding text is intentional Agent prose.
   * Flush it immediately and keep the same chunker/voice queue alive, so entering
   * a tool never cuts off a sentence that is already being spoken.
   */
  toolStarted(): string[] {
    this.toolSeen = true;
    const chunks = this.committed ? [] : this.stagedChunks.splice(0);
    this.committed = true;
    chunks.push(...this.chunker.finish());
    return chunks;
  }

  /** Release any remaining Agent prose at the end of the turn. */
  finish(): string[] {
    const chunks = this.committed ? [] : this.stagedChunks.splice(0);
    this.committed = true;
    chunks.push(...this.chunker.finish());
    return chunks;
  }
}

export interface BargeInPolicy {
  enabled: boolean;
  threshold: number;
  requiredFrames: number;
}

/**
 * Playback audio is the dominant false-barge source. Ignore the first part of
 * each spoken reply, require a louder sustained utterance while audio is
 * playing, and quarantine the short acoustic tail after playback ends.
 */
export function echoProtectedBargeIn(
  baseThreshold: number,
  speaking: boolean,
  playbackAgeMs: number,
  sincePlaybackEndedMs: number,
  playbackEchoFloor = 0,
): BargeInPolicy {
  const base = Math.max(0.004, Math.min(0.12, Number(baseThreshold) || 0.018));
  if (!speaking && sincePlaybackEndedMs < 160) {
    return { enabled: false, threshold: base, requiredFrames: 3 };
  }
  if (speaking) {
    const echoFloor = Math.max(0, Math.min(0.12, Number(playbackEchoFloor) || 0));
    const adaptiveThreshold = Math.max(
      0.01,
      base * 0.9,
      echoFloor > 0 ? echoFloor * 1.45 + 0.0025 : base,
    );
    // Never make the beginning of playback a blind zone. A slightly stricter
    // three-frame gate is enough there; after 180 ms two 100 ms PCM frames can
    // open a probe. The cloud transcript still has to contain the wake word,
    // so lower acoustic latency does not turn ambient speech into an abort.
    if (playbackAgeMs < 180) {
      return {
        enabled: true,
        threshold: Math.max(adaptiveThreshold, base * 1.2),
        requiredFrames: 3,
      };
    }
    return { enabled: true, threshold: adaptiveThreshold, requiredFrames: 2 };
  }
  return { enabled: true, threshold: base, requiredFrames: 3 };
}

/**
 * Track the residual loudspeaker level after browser AEC without letting a
 * short human utterance immediately raise the baseline and hide itself.
 */
export function updatePlaybackEchoFloor(currentFloor: number, rms: number): number {
  const current = Math.max(0, Math.min(0.12, Number(currentFloor) || 0));
  const sample = Math.max(0, Math.min(0.12, Number(rms) || 0));
  if (current <= 0) return sample;
  const weight = sample <= current ? 0.18 : 0.012;
  return current + (sample - current) * weight;
}

/** Reject an ASR fragment that is simply a contiguous phrase from recent TTS. */
export function isLikelyPlaybackEcho(transcript: string, spokenText: string): boolean {
  const normalize = (value: string): string => cleanSpeechText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const heard = normalize(transcript);
  const spoken = normalize(spokenText);
  return heard.length >= 4 && spoken.length >= heard.length && spoken.includes(heard);
}

const WAKE_IGNORED = /[\s，。！？!?、,.;；:：'"“”‘’·\-_]/;
function compactWakeText(value: string): { text: string; sourceIndexes: number[] } {
  let text = '';
  const sourceIndexes: number[] = [];
  let sourceIndex = 0;
  for (const char of String(value || '')) {
    const currentSourceIndex = sourceIndex;
    sourceIndex += char.length;
    if (WAKE_IGNORED.test(char)) continue;
    text += char.toLocaleLowerCase();
    sourceIndexes.push(currentSourceIndex);
  }
  return { text, sourceIndexes };
}

function isAllowedWakePrefix(prefix: string): boolean {
  return /^(?:(?:嗯|呃|啊|哦|嘿|喂|你好|请问|hey|hi|hello|ok|okay))*$/i.test(prefix);
}

/**
 * Detect a wake phrase near the beginning of an ASR transcript.
 *
 * Fun-ASR may render an English name phonetically. Yuki therefore accepts a
 * small, deliberately bounded alias set near the beginning of the utterance.
 * Source indexes are retained while normalising, which lets callers strip the
 * wake phrase without damaging the original command text.
 */
export function matchWakePhrase(transcript: string, wakeWord: string): WakePhraseMatch {
  const source = String(transcript || '');
  const configured = compactWakeText(wakeWord).text;
  if (!configured) return { matched: true, remainder: source.trim() };

  const compact = compactWakeText(source);
  const aliases = new Set([configured]);
  const finalOnlyAliases = new Set<string>();
  if (['小u', '小优', '小悠', '小友', '小佑', '小玉', '小雨'].includes(configured)) {
    ['小u', '小优', '小悠', '小友', '小佑', '小玉', '小雨'].forEach((item) => aliases.add(item));
  }
  if ([
    'yuki', 'yuuki', 'youki', 'youkey', 'youkee', 'yookie', 'uki', 'ukey', 'ukee',
    '优纪', '由纪', '悠纪', '优希', '由希', '尤琪', '优琪', '悠琪', '由琪', '尤基',
  ].includes(configured)) {
    [
      'yuki', 'yuuki', 'youki', 'youkey', 'youkee', 'yookie', 'uki', 'ukey', 'ukee',
      '优纪', '由纪', '悠纪', '优希', '由希', '尤琪', '优琪', '悠琪', '由琪', '尤基',
      '玉琪', '雨琪', '玉纪',
    ]
      .forEach((item) => aliases.add(item));

    // Fun-ASR also frequently writes the isolated pronunciation "You-key" as
    // an ordinary Chinese word. These forms are useful for a wake-only
    // utterance, but accepting them at the front of a longer sentence would
    // make phrases such as "尤其重要" or "有机食品" false-trigger Yuki.
    [
      '有机', '游记', '邮寄', '尤其', '语气', '预期', '油漆', '玉器',
    ].forEach((item) => {
      aliases.add(item);
      finalOnlyAliases.add(item);
    });
  }

  for (const candidate of aliases) {
    const start = compact.text.indexOf(candidate);
    if (start < 0 || !isAllowedWakePrefix(compact.text.slice(0, start))) continue;
    const lastCompactIndex = start + candidate.length - 1;
    if (finalOnlyAliases.has(candidate) && lastCompactIndex !== compact.text.length - 1) continue;
    const sourceEnd = compact.sourceIndexes[lastCompactIndex];
    if (sourceEnd === undefined) continue;
    const sourceStart = compact.sourceIndexes[start] ?? 0;
    return {
      matched: true,
      matchedText: source.slice(sourceStart, sourceEnd + 1),
      ...(finalOnlyAliases.has(candidate) ? { finalOnly: true } : {}),
      remainder: source
        .slice(sourceEnd + 1)
        .replace(/^[\s，。！？!?、,.;；:：'"“”‘’·\-_]+/, '')
        .trim(),
    };
  }
  return { matched: false, remainder: '' };
}

/**
 * Enforce the two-utterance wake protocol. Any sound segment that contains the
 * wake phrase is controller-only, regardless of words that follow it. A final
 * ASR rewrite may drop the short wake token, so callers also pass the partial
 * match latch. Only a later, separate sound segment may become a model command.
 */
export function resolveWakeUtteranceCommand(
  transcript: string,
  wakeWord: string,
  wakeMatchedEarlier = false,
): string {
  const source = String(transcript || '').trim();
  const configured = String(wakeWord || '').trim();
  if (!configured) return source;
  if (wakeMatchedEarlier || matchWakePhrase(source, configured).matched) return '';
  return source;
}

/**
 * Keep a wake match latched when Fun-ASR rewrites its last partial at final.
 * A short rewritten token is still the wake phrase, not a user command.
 */
export function resolveLatchedWakeText(
  transcript: string,
  wakeWord: string,
  preservedRemainder = '',
): string {
  const source = String(transcript || '').trim();
  const match = matchWakePhrase(source, wakeWord);
  if (match.matched) return match.remainder;
  const preserved = String(preservedRemainder || '').trim();
  if (preserved) return preserved;

  const compactSource = compactWakeText(source).text;
  const compactWake = compactWakeText(wakeWord).text;
  const wakeOnlyLimit = Math.max(4, compactWake.length + 2);
  return compactSource.length <= wakeOnlyLimit ? '' : source;
}

/**
 * Barge-in is stricter than ordinary wake-up: an empty wake phrase never grants
 * interruption, and a fragment copied from current playback is rejected.
 */
export function matchWakeDirectedInterruption(
  transcript: string,
  wakeWord: string,
  spokenText = '',
): WakePhraseMatch {
  const configured = String(wakeWord || '').trim();
  if (!configured) return { matched: false, remainder: '' };
  const match = matchWakePhrase(transcript, configured);
  if (!match.matched) return match;
  if (spokenText && isLikelyPlaybackEcho(transcript, spokenText)) {
    return { matched: false, remainder: '' };
  }

  // 唤醒词本身可能很短，通用回声过滤器会有意跳过。若当前播音里恰好
  // 包含同一短句，必须优先防误杀；带新指令的“Yuki，停一下”仍可通过。
  if (!match.remainder && spokenText) {
    const heard = cleanSpeechText(transcript).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const spoken = cleanSpeechText(spokenText).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (heard.length >= 2 && spoken.includes(heard)) {
      return { matched: false, remainder: '' };
    }
  }
  // A directed wake may stop playback, but never doubles as a replacement
  // prompt. The user speaks the actual instruction after acknowledgement.
  return { ...match, remainder: '' };
}

/**
 * Calculate an adaptive end-of-turn pause. A complete sentence uses the user's
 * base value; an unfinished/filler ending receives extra thinking time.
 */
export function computeTurnEndSilenceMs(baseMs: number, transcript: string): number {
  const base = Math.max(900, Math.min(3000, Math.round(Number(baseMs) || 1500)));
  const text = String(transcript || '').trim();
  let extension = 0;
  if (!/[。！？!?…]$/.test(text)) extension += 400;

  const continuationEnding = /(?:然后|因为|所以|但是|不过|而且|如果|比如|就是|这个|那个|还有|以及|首先|其次|最后|我想|我觉得|可能|应该|嗯|呃|啊|额|哦)$/;
  if (/[，,、：:；;—-]$/.test(text) || continuationEnding.test(text)) {
    extension += 900;
  }
  return Math.max(900, Math.min(4000, base + extension));
}

/** Map the existing Edge percentage slider to the Web Speech rate scale. */
export function systemSpeechRate(ratePercent: number): number {
  return Math.max(0.6, Math.min(1.5, 1 + (Number(ratePercent) || 0) / 100));
}

export function pcm16Rms(buffer: ArrayBuffer): number {
  const samples = new Int16Array(buffer);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function createVoiceStreamId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `rv_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `rv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output.buffer;
}
