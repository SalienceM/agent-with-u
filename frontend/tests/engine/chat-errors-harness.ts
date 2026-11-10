export { default as React } from 'react';
export { createRoot } from 'react-dom/client';
export { MessageBubble } from '../../src/components/MessageBubble';
export { processStreamDelta, buildStreamingMessage, clearAllStreamStates,
  configureStreamIdentity, getStreamState, initStreamMessage, restoreStreamState } from '../../src/hooks/useStreamState';
