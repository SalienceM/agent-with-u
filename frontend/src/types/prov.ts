export type ProvReviewState =
  | 'draft'
  | 'changes_requested'
  | 'conditionally_approved'
  | 'approved'
  | 'rejected';

export type ProvAnnotationStatus = 'open' | 'addressed' | 'verified' | 'dismissed';
export type ProvAnnotationKind = 'change_request' | 'comment' | 'question' | 'approval';
export type ProvSeverity = 'minor' | 'normal' | 'major' | 'critical';
export type ProvImageShape = 'rectangle' | 'ellipse' | 'arrow' | 'polygon' | 'point';
export type ProvTool = 'select' | ProvImageShape;

export interface ProvPoint { x: number; y: number }

export type ProvSelector =
  | { type: 'document' }
  | {
      type: 'image-region';
      shape: ProvImageShape;
      geometry: {
        unit: 'normalized';
        x?: number; y?: number; width?: number; height?: number;
        x1?: number; y1?: number; x2?: number; y2?: number;
        points?: ProvPoint[];
      };
    }
  | {
      type: 'text-block' | 'text-range';
      headingPath: string[];
      blockFingerprint: string;
      exactQuote: string;
      prefix?: string;
      suffix?: string;
      startOffset: number;
      endOffset: number;
      blockIndex?: number;
    };

export interface ProvAnnotation {
  id: string;
  ref: string;
  title: string;
  parentId: string | null;
  order: number;
  target: { selector: ProvSelector };
  body: {
    kind: ProvAnnotationKind;
    comment: string;
    expected: string;
    severity: ProvSeverity;
    blocking: boolean;
  };
  status: ProvAnnotationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProvSource {
  path: string;
  mediaType: string;
  kind: 'image' | 'markdown' | 'text';
  sha256: string;
  size: number;
  width?: number;
  height?: number;
}

export interface ProvDocument {
  format: 'agentwithu.prov';
  schemaVersion: 1;
  source: ProvSource;
  review: {
    id: string;
    revision: number;
    state: ProvReviewState;
    createdAt: string;
    updatedAt: string;
  };
  counters: Record<string, number>;
  annotations: ProvAnnotation[];
}

export type ProvSourcePreview =
  | { kind: 'image'; mimeType: string; dataBase64: string; width: number; height: number }
  | { kind: 'markdown' | 'text'; text: string; truncated?: boolean };

export interface ProvOpenResult {
  status: string;
  message?: string;
  document: ProvDocument;
  provPath: string;
  existing: boolean;
  sourceStatus: 'ok' | 'changed' | 'missing';
  currentSource: ProvSource | null;
  sourcePreview: ProvSourcePreview | null;
}

export interface ProvSaveResult {
  status: 'ok' | 'error' | 'conflict' | 'source_changed';
  message?: string;
  document?: ProvDocument;
  provPath?: string;
  sourceStatus?: 'ok';
  currentSource?: ProvSource;
  currentRevision?: number;
}

export interface ProvResolveResult {
  status: string;
  message?: string;
  resolved?: string[];
  workOrder?: string;
  errors?: string[];
  attachments?: Array<{
    id?: string; mimeType?: string; size?: number; width?: number; height?: number;
  }>;
}

