import type { TextAttachment } from '../types/attachments';
import { HARNESS_IMAGE_CONTRACT } from '../types/harnessImages';

export interface ImageData { id: string; base64: string; mime_type: string; size: number; width?: number; height?: number }
export interface ImageInput { content: string; images?: ImageData[]; textAttachments?: TextAttachment[] }
export interface ImageScope { key: string; owner: string; executor: string; session: string }
export interface ImageDraftContext { scopeKey: string; draftRevision: number; originalContent?: string }
export type ImageState = 'preparing' | 'not_submitted' | 'platform_accepted' | 'queued' | 'submitting'
  | 'native_received' | 'succeeded' | 'rejected' | 'failed' | 'cancelled' | 'unknown';
export interface ImageReceipt {
  version: 1; requestId: string; sessionId: string; state: ImageState; nativeReceived: boolean;
  revision: number; reason: string; queueId?: string;
}
export interface ImageSendResult { kind: 'harness-image'; receipt: ImageReceipt }
export type ChatSendResult = ImageSendResult | import('./composerSubmissions').ComposerSendResult | void;
export interface ImageSnapshot extends ImageInput {
  content: string; images: ImageData[]; textAttachments: TextAttachment[]; draftRevision: number;
}
export interface ImageAttempt {
  requestId: string; userMessageId: string; messageId: string; snapshot: ImageSnapshot;
  receipt: ImageReceipt; autoRead: boolean; cleared: boolean;
}
interface Slot { scope: ImageScope; current?: ImageAttempt; recovery?: ImageAttempt }
export interface ImageSubmissionIO {
  current(scope: ImageScope): boolean;
  capabilities(scope: ImageScope): Promise<unknown>;
  write(scope: ImageScope, queue: boolean, payload: Record<string, unknown>): Promise<unknown>;
  read(scope: ImageScope, requestId: string): Promise<unknown>;
  id(): string;
}
const unresolved = (a?: ImageAttempt) => !!a && ['preparing', 'platform_accepted', 'submitting', 'unknown'].includes(a.receipt.state);
const knownStates = new Set(['platform_accepted', 'queued', 'submitting', 'native_received', 'succeeded', 'rejected', 'failed', 'cancelled', 'unknown']);
const reasons = new Set(['', 'preflight_rejected', 'runtime_failed', 'cancelled', 'receipt_unknown', 'restarted',
  'storage_failed', 'request_conflict', 'route_changed', 'queue_revised',
  'invalid_container', 'too_many_images', 'invalid_base64', 'image_bytes', 'total_bytes', 'unsupported_format', 'animated_image',
  'image_dimensions', 'total_pixels', 'corrupt_image', 'mime_mismatch', 'request_bytes', 'extension_missing', 'extension_mismatch',
  'limits_mismatch', 'identity_mismatch', 'text_only', 'capability_unknown', 'endpoint_text_only', 'runtime_text_only',
  'safety_guard_unavailable', 'connection_changed', 'admission_invalid', 'admission_required', 'digest_mismatch']);

/** 白名单拷贝：授权、工具令牌及所有独立开关从不进入恢复槽。 */
export function imageSnapshot(input: ImageInput, draftRevision: number): ImageSnapshot {
  return Object.freeze({ content: input.content, draftRevision,
    images: Object.freeze((input.images || []).map(i => Object.freeze({ id: i.id, base64: i.base64,
      mime_type: i.mime_type, size: i.size, ...(i.width !== undefined ? { width: i.width } : {}),
      ...(i.height !== undefined ? { height: i.height } : {}) }))) as unknown as ImageData[],
    textAttachments: Object.freeze((input.textAttachments || []).map(a => Object.freeze({ id: a.id, name: a.name,
      content: a.content, size: a.size, source: a.source }))) as unknown as TextAttachment[],
  });
}

export function imageQuickCheck(input: ImageInput): string {
  const { limits, formats } = HARNESS_IMAGE_CONTRACT;
  if (!input.images?.length || input.images.length > limits.maxImages) return 'image_count';
  let total = 0;
  for (const image of input.images) {
    if (!formats.includes(image.mime_type)) return 'image_format';
    // 仅快速预算；实际解码、格式、像素和最终模型请求由执行器校验。
    const bytes = Math.floor(image.base64.length * 3 / 4) - (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0);
    if (!image.base64 || bytes > limits.maxImageBytes) return 'image_bytes';
    total += bytes;
  }
  if (total > limits.maxTotalImageBytes) return 'image_total';
  if (new TextEncoder().encode(JSON.stringify(input)).length > limits.maxRequestBytes) return 'request_bytes';
  return '';
}

/** 每个身份最多一个当前快照和一个恢复槽；卸载只取消订阅，不会重放写请求。 */
export class HarnessImageSubmissions {
  private slots = new Map<string, Slot>();
  private listeners = new Set<() => void>();
  private flights = new Map<string, Promise<ImageSendResult>>();
  private reads = new Map<string, Promise<void>>();
  constructor(private io: ImageSubmissionIO, private maxScopes = 16) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { this.listeners.forEach(listener => listener()); }
  get(scope: ImageScope): Readonly<Slot> | undefined { return this.slots.get(scope.key); }
  clear() { this.slots.clear(); this.flights.clear(); this.reads.clear(); this.emit(); }
  private live(scope: ImageScope, slot: Slot) { return this.slots.get(scope.key) === slot && this.io.current(scope); }
  private local(a: ImageAttempt, state: ImageState, reason: string) {
    if (a.receipt.revision > 0 && !(state === 'unknown' && unresolved(a))) return; // 真实事件可能比 RPC 返回更早。
    a.receipt = { ...a.receipt, state, reason };
    this.emit();
  }
  private accept(scope: ImageScope, slot: Slot, a: ImageAttempt, value: unknown): boolean {
    if (!this.live(scope, slot) || !value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    if (r.version !== 1 || r.requestId !== a.requestId || r.sessionId !== scope.session || !knownStates.has(String(r.state))) return false;
    if (r.ownerId !== undefined && r.ownerId !== scope.owner) return false;
    // 缺失历史记录只能维持 unknown，不能覆盖已经观察到的原生接收／终态。
    if (r.revision === undefined && r.state === 'unknown') return true;
    if (!Number.isSafeInteger(r.revision) || Number(r.revision) <= a.receipt.revision
        || typeof r.nativeReceived !== 'boolean') return false;
    if (['native_received', 'succeeded', 'failed'].includes(String(r.state)) && !r.nativeReceived) return false;
    if (a.receipt.nativeReceived && !r.nativeReceived) return false;
    a.receipt = { version: 1, requestId: a.requestId, sessionId: scope.session, state: r.state as ImageState,
      revision: Number(r.revision), nativeReceived: r.nativeReceived, reason: reasons.has(String(r.reason)) ? String(r.reason) : 'receipt_unknown',
      ...(typeof r.queueId === 'string' ? { queueId: r.queueId } : {}) };
    this.emit();
    if (a.receipt.state === 'unknown') this.reconcile(scope, slot, a);
    return true;
  }
  observe(scope: ImageScope, value: unknown) {
    const slot = this.slots.get(scope.key);
    if (!slot) return;
    for (const a of [slot.current, slot.recovery]) if (a) this.accept(scope, slot, a, value);
  }
  private reconcile(scope: ImageScope, slot: Slot, a: ImageAttempt) {
    if (a.autoRead || !this.live(scope, slot)) return;
    a.autoRead = true;
    void this.refresh(scope, a.requestId);
  }
  async refresh(scope: ImageScope, requestId: string): Promise<void> {
    const key = JSON.stringify([scope.key, requestId]), existing = this.reads.get(key);
    if (existing) return existing;
    const slot = this.slots.get(scope.key), a = [slot?.current, slot?.recovery].find(a => a?.requestId === requestId);
    if (!slot || !a || !this.live(scope, slot)) return;
    const work = (async () => {
      try { this.accept(scope, slot, a, await this.io.read(scope, requestId)); }
      catch { /* 只读失败保持原状态；不按错误正文推断未发送，不循环重试。 */ }
    })();
    this.reads.set(key, work);
    try { await work; } finally { if (this.reads.get(key) === work) this.reads.delete(key); }
  }
  /** 调用者仍须核对当前身份；一次清理不能因重新挂载而清空后来编辑的草稿。 */
  shouldClear(a: ImageAttempt, draftRevision: number): boolean {
    return !a.cleared && a.snapshot.draftRevision === draftRevision && draftRevision > 0
      && (a.receipt.state === 'queued' || a.receipt.nativeReceived);
  }
  didClear(a: ImageAttempt) { a.cleared = true; }
  restore(a: ImageAttempt, nonempty: boolean, replace: boolean, acknowledgeDuplicate: boolean): ImageSnapshot | undefined {
    if (nonempty && !replace) return;
    if (!['not_submitted', 'rejected'].includes(a.receipt.state) && !acknowledgeDuplicate) return;
    return imageSnapshot(a.snapshot, a.snapshot.draftRevision);
  }
  submit(scope: ImageScope, payload: ImageInput & Record<string, unknown>, queue: boolean, draft?: ImageDraftContext): Promise<ImageSendResult> {
    const inFlight = this.flights.get(scope.key);
    if (inFlight) return inFlight;
    let slot = this.slots.get(scope.key);
    const pending = [slot?.current, slot?.recovery].find(unresolved);
    if (pending) return Promise.resolve({ kind: 'harness-image', receipt: pending.receipt });
    const sameDraft = draft && draft.scopeKey === scope.key && [slot?.current, slot?.recovery].find(a => a
      && a.snapshot.draftRevision === draft.draftRevision && !['not_submitted', 'rejected'].includes(a.receipt.state));
    if (sameDraft) return Promise.resolve({ kind: 'harness-image', receipt: sameDraft.receipt });
    const requestId = this.io.id();
    const a: ImageAttempt = { requestId, userMessageId: this.io.id(), messageId: this.io.id(),
      snapshot: imageSnapshot({ ...payload, content: draft?.originalContent ?? payload.content }, draft?.draftRevision || 0), autoRead: false, cleared: false,
      receipt: { version: 1, requestId, sessionId: scope.session, state: 'preparing', nativeReceived: false, revision: 0, reason: '' } };
    if (!slot && this.slots.size >= this.maxScopes) {
      const evict = [...this.slots].find(([, s]) => !unresolved(s.current) && !unresolved(s.recovery)
        && [s.current, s.recovery].every(row => !row || ['succeeded', 'cancelled'].includes(row.receipt.state)));
      if (evict) this.slots.delete(evict[0]);
      else return Promise.resolve({ kind: 'harness-image', receipt: { ...a.receipt, state: 'not_submitted', reason: 'memory_limit' } });
    }
    if (!slot) { slot = { scope }; this.slots.set(scope.key, slot); }
    slot.recovery = slot.current;
    slot.current = a;
    const currentSlot = slot;
    const work = (async (): Promise<ImageSendResult> => {
      // 先让 single-flight 安装，再通知组件；能力查询只由这个明确发送动作启动。
      await Promise.resolve();
      this.emit();
      try {
        if (!this.live(scope, currentSlot) || !scope.executor || draft && draft.scopeKey !== scope.key) {
          this.local(a, 'not_submitted', 'identity_changed');
        } else {
          const quick = imageQuickCheck(a.snapshot);
          if (quick) this.local(a, 'not_submitted', quick);
          else {
            const cap = await this.io.capabilities(scope) as Record<string, unknown>;
            if (!this.live(scope, currentSlot)) return { kind: 'harness-image', receipt: a.receipt };
            if (!cap || cap.version !== 1 || cap.status !== true || cap[queue ? 'queue' : 'submit'] !== true) {
              this.local(a, 'not_submitted', 'protocol_unavailable');
            } else {
              try {
                const result = await this.io.write(scope, queue, { ...payload, ...a.snapshot, version: 1, sessionId: scope.session,
                  content: payload.content, requestId, userMessageId: a.userMessageId, messageId: a.messageId });
                if (!this.accept(scope, currentSlot, a, result) && a.receipt.revision === 0) this.local(a, 'unknown', 'receipt_unknown');
              } catch { this.local(a, 'unknown', 'receipt_unknown'); }
              if (a.receipt.state === 'unknown') this.reconcile(scope, currentSlot, a);
            }
          }
        }
      } catch (error) {
        this.local(a, 'not_submitted', (error as { serverRejected?: boolean })?.serverRejected ? 'protocol_unavailable' : 'offline');
      }
      return { kind: 'harness-image', receipt: a.receipt };
    })();
    this.flights.set(scope.key, work);
    void work.finally(() => { if (this.flights.get(scope.key) === work) this.flights.delete(scope.key); });
    return work;
  }
}

export function imageReceiptLabel(receipt: ImageReceipt): string {
  const states: Record<ImageState, string> = { preparing: '正在核对执行端协议（尚未提交）', not_submitted: '图片未提交',
    platform_accepted: '平台已接单，尚无原生接收回执', queued: '已排队，尚未提交给模型', submitting: '正在提交，尚无原生接收回执',
    native_received: '原生已接收，正在等待运行结果', succeeded: '本轮已完成', rejected: '原生接收前拒绝',
    failed: '原生接收后执行失败', cancelled: '已取消（不代表从未提交）', unknown: '结果未知，请只读核对，勿重复发送' };
  const messages: Record<string, string> = { offline: '执行端离线或连接未完成，草稿已保留', protocol_unavailable: '目标节点不支持新版图片回执协议，请更新后再试',
    identity_changed: '账号或执行节点已变化，未改用其他节点', image_count: '请保留 1–4 张图片', image_format: '仅支持静态 PNG、JPEG、WebP',
    image_bytes: '请替换空图片或超过 4 MiB 的图片', image_total: '图片文件总计不能超过 8 MiB', request_bytes: '含编码与正文的请求不能超过 12 MiB',
    memory_limit: '恢复槽已满，请先处理其他 Session 的待决图片', preflight_rejected: '请查看本轮具体错误，调整图片或模型路线后再发送',
    route_changed: '派发路线已变化，请核对 Backend 与原附件', storage_failed: '执行端回执保存失败，请核对原请求', restarted: '执行端重启，在途请求未重放',
    invalid_container: '图片字段无效，请重新添加图片', too_many_images: '模型输入最多 4 张图片（含模型专用图片）',
    invalid_base64: '图片编码无效，请重新添加', total_bytes: '图片总计不能超过 8 MiB', unsupported_format: '仅支持静态 PNG、JPEG、WebP',
    animated_image: '请替换动画／多帧图片', image_dimensions: '边长最多 8192，单图最多 1600 万像素', total_pixels: '总计最多 3200 万像素',
    corrupt_image: '图片数据损坏，请重新添加', mime_mismatch: '图片声明格式与实际内容不符，请重新添加',
    extension_missing: '原生桥缺少图片扩展，请核对执行端配套资源', extension_mismatch: '图片扩展版本不匹配，请核对配套资源',
    limits_mismatch: '图片限额版本不匹配，请核对配套资源', identity_mismatch: '调用身份与路线不一致，请核对当前节点与 Backend',
    text_only: '此次调用限定纯文本，不能携带图片', capability_unknown: '当前路由图片能力未确认，请核对该端点模型目录声明',
    endpoint_text_only: '当前端点声明该模型只支持文本，请选择明确支持图片的路线', runtime_text_only: '当前原生通道不支持该模型的图片输入',
    safety_guard_unavailable: '远端文件删除防护未能确认，不能提交图片；请核对执行端配套资源',
    connection_changed: '调用配置或路线变化，请核对原请求', admission_invalid: '准入回执不匹配，请核对执行端配套资源',
    admission_required: '一次性准入已失效，原生输入未接收', digest_mismatch: '图片与准入内容不一致，原生输入未接收' };
  return `${states[receipt.state]}${messages[receipt.reason] ? `；${messages[receipt.reason]}` : ''}`;
}
