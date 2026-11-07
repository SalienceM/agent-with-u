export interface InteractionQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ id: string; label: string; description: string }>;
  multiple: boolean;
  allowOther: boolean;
  secret: boolean;
  required: boolean;
}
export interface UserInteraction {
  id: string;
  sessionId: string;
  messageId: string;
  revision: number;
  kind: 'question' | 'approval';
  status: 'pending' | 'responding' | 'answered' | 'auto_handled' | 'cancelled' | 'expired' | 'failed' | 'unknown' | 'interrupted';
  title: string;
  detail: string;
  questions: InteractionQuestion[];
  canSkip: boolean;
  notice?: string;
  deadline: number;
  receiptLevel?: string;
  disposition?: string;
  answers?: Record<string, string[]>;
  approved?: boolean | null;
}
export type InteractionResponse = { kind: 'answers'; answers: Record<string, string[]> }
  | { kind: 'approved'; approved: boolean } | { kind: 'skipped' | 'cancelled' };
