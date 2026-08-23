export type TextAttachmentSource = 'paste' | 'input' | 'voice' | 'file';

export interface TextAttachment {
  id: string;
  name: string;
  content: string;
  size: number;
  source?: TextAttachmentSource;
}
