/** 有界流恢复闸门。只转发既有事件，绝不发送模型或审批请求。 */
export interface StreamPosition { epoch: string; sequence: number; complete: boolean }
export interface StreamTransfer<T = unknown> { position: StreamPosition; state: T }
type Delta = { sessionId: string; streamEpoch?: string; streamSequence?: number; streamMessageStart?: boolean; [key: string]: any };
type Held = { events: Delta[]; characters: number; failed: boolean };
const limit = 4 * 1024 * 1024;
const validPosition = (epoch: unknown, sequence: unknown) => typeof epoch === 'string' && /^[\w-]{1,128}$/.test(epoch)
  && Number.isSafeInteger(sequence) && Number(sequence) > 0;

export class WorkbenchStreamGate {
  private positions = new Map<string, StreamPosition>();
  private held = new Map<string, Held>();
  constructor(private deliver: (delta: Delta, key: string) => void) {}
  clear() { this.positions.clear(); this.held.clear(); }
  position(key: string): StreamPosition { return { ...(this.positions.get(key) || { epoch: '', sequence: 0, complete: true }) }; }
  push(key: string, delta: Delta): void {
    const held = this.held.get(key);
    if (held) {
      const characters = JSON.stringify(delta).length;
      if (held.failed || held.characters + characters > limit || held.events.length >= 4096) {
        held.failed = true; held.events = []; held.characters = 0;
      } else { held.events.push(structuredClone(delta)); held.characters += characters; }
      return;
    }
    this.accept(key, delta);
  }
  private accept(key: string, delta: Delta): void {
    if (!validPosition(delta.streamEpoch, delta.streamSequence)) {
      // 旧端仍正常显示，但不能把无位置的中间输出当作可完整交接快照。
      this.positions.set(key, { epoch: '', sequence: 0, complete: false }); this.deliver(delta, key); return;
    }
    const old = this.positions.get(key), epoch = delta.streamEpoch!, sequence = delta.streamSequence!;
    if (old?.epoch === epoch && sequence <= old.sequence) return;
    const continuous = old?.epoch === epoch && sequence === old.sequence + 1;
    this.positions.set(key, { epoch, sequence, complete: delta.streamMessageStart === true || sequence === 1 || !!(continuous && old.complete) });
    this.deliver(delta, key);
  }
  capture<T>(key: string, state: T): StreamTransfer<T> {
    const position = this.position(key);
    if (!position.complete || this.held.has(key)) throw new Error('流式输出存在缺口或正在恢复，不能确认完整交接');
    const serialized = JSON.stringify(state);
    if (serialized.length > limit) throw new Error('当前流快照超出有界交接容量，请等待本轮结束后再移动');
    return { position, state: JSON.parse(serialized) };
  }
  async restore<T>(key: string, session: string, transfer: StreamTransfer<T>,
    read: (epoch: string, after: number) => Promise<any>, install: (state: T) => void, current: () => boolean): Promise<void> {
    if (this.held.has(key)) throw new Error('流恢复已在进行');
    if (!transfer || !transfer.position?.complete || typeof transfer.position.epoch !== 'string'
      || !(transfer.position.epoch === '' && transfer.position.sequence === 0 || validPosition(transfer.position.epoch, transfer.position.sequence))
      || JSON.stringify(transfer).length > limit + 1024) throw new Error('无效或不完整的流恢复快照');
    const held: Held = { events: [], characters: 0, failed: false };
    this.held.set(key, held);
    try {
      const { epoch, sequence } = transfer.position;
      const result = await read(epoch, sequence);
      if (!current()) throw new Error('流恢复身份已变化');
      if (held.failed) throw new Error('恢复期间输出超过缓存预算，请保留源窗口并重新核对');
      const empty = result?.status === 'unavailable' && !epoch && !sequence && !held.events.length;
      if (!empty && (result?.status !== 'ok' || result.gap || result.sessionId !== session
        || epoch && result.streamEpoch !== epoch || !Array.isArray(result.events)
        || result.events.length > 4096 || JSON.stringify(result.events).length > limit
        || !Number.isSafeInteger(result.lastSequence) || result.lastSequence < sequence)) throw new Error('执行端流恢复出现缺口或实例变化，未确认交接');
      const events: Delta[] = empty ? [] : result.events;
      let next = sequence;
      for (const delta of events) {
        if (delta.sessionId !== session || delta.streamEpoch !== result.streamEpoch || delta.streamSequence !== ++next) throw new Error('流恢复事件位置不连续');
      }
      if (!empty && next !== result.lastSequence) throw new Error('流恢复末尾缺失');
      // 单次同步提交快照+回放；UI 不会看到旧快照覆盖已经追加的新事件。
      const merged = [...events, ...held.events].filter(delta => (delta.streamSequence || 0) > sequence)
        .sort((a, b) => a.streamSequence! - b.streamSequence!);
      const expectedEpoch = epoch || result.streamEpoch;
      next = sequence;
      for (const delta of merged) {
        if (delta.streamEpoch !== expectedEpoch || delta.sessionId !== session || !validPosition(delta.streamEpoch, delta.streamSequence)) throw new Error('恢复期间流实例变化');
        if (delta.streamSequence! <= next) continue;
        if (delta.streamSequence !== next + 1) throw new Error('恢复期间流事件缺失');
        next++;
      }
      install(structuredClone(transfer.state));
      this.positions.set(key, { epoch: expectedEpoch || '', sequence, complete: true });
      this.held.delete(key);
      for (const delta of merged) this.accept(key, delta);
    } catch (error) {
      this.held.delete(key);
      // 保留目标原先可见输出，但失败绝不 ACK。源仍为权威恢复依据。
      if (current()) {
        for (const delta of held.events) this.accept(key, delta);
        if (held.failed) this.positions.set(key, { ...this.position(key), complete: false });
      }
      throw error;
    }
  }
}
