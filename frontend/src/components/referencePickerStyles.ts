import type { CSSProperties } from 'react';

// 不透明选中色避免壁纸透出；鼠标悬停和键盘导航共用同一状态。
export const referenceSelectedStyle: CSSProperties = {
  background: '#1d4ed8',
  color: '#fff',
  boxShadow: 'inset 3px 0 0 #93c5fd',
};

export const referenceSelectedActionStyle: CSSProperties = {
  background: 'rgba(255,255,255,.12)',
  color: 'inherit',
  borderColor: 'rgba(255,255,255,.45)',
};
