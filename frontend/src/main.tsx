import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const style = document.createElement('style');
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { overflow: hidden; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
  @keyframes blink { 50% { opacity: 0; } }
  .code-block {
    background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px 14px;
    margin: 8px 0; overflow-x: auto;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 13px; line-height: 1.5; color: #d4d4d4;
  }
  .inline-code {
    background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 0.9em;
  }
  a { color: #818cf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
