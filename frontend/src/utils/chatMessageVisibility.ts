interface TextLikeBlock {
  type?: unknown;
  text?: unknown;
}

interface ThinkingLikeBlock {
  content?: unknown;
}

/**
 * 判断一条消息是否真的带有用户可见载荷。
 *
 * 耗时、token、时间戳和空的 contentBlocks 都只是元数据，不能单独撑起一条
 * Assistant 气泡；正文、思考、工具、附件或显式文本块则都属于有效内容。
 */
export function hasVisibleMessagePayload(message: {
  content?: unknown;
  thinking?: unknown;
  thinkingBlocks?: ThinkingLikeBlock[] | null;
  toolCalls?: unknown[] | null;
  images?: unknown[] | null;
  textAttachments?: unknown[] | null;
  contentBlocks?: TextLikeBlock[] | null;
}): boolean {
  const hasText = (value: unknown): boolean => (
    typeof value === 'string' && value.trim().length > 0
  );

  if (hasText(message.content) || hasText(message.thinking)) return true;
  if (message.thinkingBlocks?.some((block) => hasText(block?.content))) return true;
  if ((message.toolCalls?.length || 0) > 0) return true;
  if ((message.images?.length || 0) > 0) return true;
  if ((message.textAttachments?.length || 0) > 0) return true;
  return !!message.contentBlocks?.some(
    (block) => block?.type === 'text' && hasText(block.text),
  );
}

/** 运行中的占位可以显示；已经定稿的空 Assistant 必须丢弃。 */
export function shouldKeepChatMessage(message: {
  role?: unknown;
  streaming?: unknown;
  content?: unknown;
  thinking?: unknown;
  thinkingBlocks?: ThinkingLikeBlock[] | null;
  toolCalls?: unknown[] | null;
  images?: unknown[] | null;
  textAttachments?: unknown[] | null;
  contentBlocks?: TextLikeBlock[] | null;
}): boolean {
  return message.role !== 'assistant'
    || message.streaming === true
    || hasVisibleMessagePayload(message);
}
