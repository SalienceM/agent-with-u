export interface SmoothGhostState {
  sessionId: string;
  sessionTitle: string;
  backendLabel: string;
  question: string;
  answer: string;
  isStreaming: boolean;
  updatedAt: number;
}

export const SMOOTH_GHOST_STATE_EVENT = 'smooth-ghost-state';
export const SMOOTH_GHOST_READY_EVENT = 'smooth-ghost-ready';

