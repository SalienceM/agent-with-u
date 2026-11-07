import React, { useState, useSyncExternalStore } from 'react';
import { composerSubmissions } from '../api';
import type { ImageScope } from '../utils/harnessImageSubmission';

export const ComposerSubmissionStatus: React.FC<{ scope: ImageScope }> = ({ scope }) => {
  useSyncExternalStore(composerSubmissions.subscribe, composerSubmissions.snapshot);
  const [notice, setNotice] = useState('');
  const rows = composerSubmissions.list(scope).filter(item => !item.cleared).slice(-8);
  if (!rows.length) return null;
  return <div style={{ fontSize: 11, maxHeight: 140, overflow: 'auto' }} aria-label="输入接收回执">
    {rows.map(item => <details key={item.receipt.requestId}>
      <summary>{({ preparing: '正在确认接收', accepted: '原输入已接收 · 新草稿保留', queued: '原输入已入队 · 新草稿保留', rejected: '未接收 · 原稿保留', unknown: '接收结果未知 · 未重发' })[item.receipt.state]}</summary>
      <div>{item.receipt.reason}</div>
      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto' }}>{item.snapshot.content.slice(0, 6000)}</pre>
      <span>{item.snapshot.textAttachments.length} 个文本块 / {item.snapshot.images.length} 张图片</span>
      {['preparing', 'unknown'].includes(item.receipt.state) && <button onClick={() => {
        void composerSubmissions.reconcile(scope, item.receipt.requestId).then(() => setNotice('已核对原请求')).catch(() => setNotice('核对失败，未重发原输入'));
      }}>核对原提交</button>}
    </details>)}
    {notice && <span role="status">{notice}</span>}
  </div>;
};
