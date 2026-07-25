export type TextAttachmentSource = 'paste' | 'input' | 'voice';

export interface TextAttachment {
  id: string;
  name: string;
  content: string;
  size: number;
  source?: TextAttachmentSource;
}
