import type { TextAttachment } from '../types/attachments';
import { uuid } from './uuid';

export interface RedoImageAttachment {
  id: string;
  base64: string;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
}

export interface RedoSourceMessage {
  role: string;
  content?: string;
  images?: RedoImageAttachment[];
  textAttachments?: TextAttachment[];
}

export interface MessageRedoPayload {
  content: string;
  images?: RedoImageAttachment[];
  textAttachments?: TextAttachment[];
}

/**
 * 把一条历史用户消息复制成可重新发送的新载荷。
 *
 * 附件内容保持不变，但 ID 必须更新：同一内容再次发送是新消息，复用旧 ID 会让
 * 历史加载时的本地/已落盘消息去重把两轮误判成同一轮。
 */
export function buildMessageRedoPayload(
  message: RedoSourceMessage,
  createId: () => string = uuid,
): MessageRedoPayload | null {
  if (message.role !== 'user') return null;
  const content = String(message.content || '');
  const images = message.images?.length
    ? message.images.map((image) => ({ ...image, id: createId() }))
    : undefined;
  const textAttachments = message.textAttachments?.length
    ? message.textAttachments.map((attachment) => ({ ...attachment, id: createId() }))
    : undefined;
  if (!content.trim() && !images?.length && !textAttachments?.length) return null;
  return { content, images, textAttachments };
}
