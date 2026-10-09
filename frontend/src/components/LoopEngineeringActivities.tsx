import React, { useEffect, useRef, useState } from 'react';
import { api, getCurrentUserProfile, loopControlTarget } from '../api';
import { useWindowWriteBlocked } from '../hooks/useWindowWriteBlocked';
import type { ControlTarget, EngineeringActivity } from '../utils/loopControl';
import { sameWorkspace } from '../utils/workspaceDocuments';

export const LoopEngineeringActivities: React.FC<{ target: ControlTarget; activities: EngineeringActivity[]; refresh: () => Promise<void> }> = ({ target, activities, refresh }) => {
  const [pending, setPending] = useState(''), [message, setMessage] = useState('');
  const identity = JSON.stringify(target), current = useRef(identity); current.current = identity;
  const blocked = useWindowWriteBlocked(target.executor, target.session);
  useEffect(() => { setPending(''); setMessage(''); }, [identity]);
  const stop = async (activity: EngineeringActivity) => {
    if (pending || blocked || activity.kind === 'document-save') return;
    if (!window.confirm(`停止此 ${activity.kind === 'terminal' ? '终端及所属子进程' : '语言服务及所属子进程'}？\n${activity.workspace.workingDir}\n${activity.resourceId}\n只有确认退出后才解除 LOOP 保护。`)) return;
    const valid = () => current.current === identity && JSON.stringify(loopControlTarget(target.session, target.executor)) === identity;
    setPending(activity.activityId); setMessage('正在停止；取消等待不会释放活动。');
    try {
      let stopped: { exitConfirmed: boolean };
      if (activity.kind === 'terminal') {
        const client = await api.workspaceTerminals(target.session, target.executor, activity.workspace.workingDir, valid);
        const row = (await client.list()).terminals.find(r => r.resourceId === activity.resourceId && r.generation === activity.generation && r.activityId === activity.activityId);
        if (!row || !sameWorkspace(row.workspace, activity.workspace)) throw Error('原终端身份已变化，请核对活动');
        stopped = await client.stop(row);
      } else {
        const client = await api.workspaceLanguages(target.session, target.executor, activity.workspace.workingDir, valid);
        const row = (await client.list()).services.find(r => r.resourceId === activity.resourceId && r.generation === activity.generation && r.activityId === activity.activityId);
        if (!row || !sameWorkspace(row.workspace, activity.workspace)) throw Error('原语言实例身份已变化，请核对活动');
        stopped = await client.stop(row);
      }
      if (valid()) setMessage(stopped.exitConfirmed ? '已确认所属进程退出。请单独选择交还。' : '退出未确认，活动保护仍保留。');
    } catch (reason) { if (valid()) setMessage(`${String(reason)}；不假定已退出，不自动重试停止。`); }
    finally { if (valid()) { setPending(''); await refresh(); } }
  };
  return <div aria-label="LOOP 工程阻塞活动" style={{ flexBasis: '100%', fontSize: 12 }}>
    {activities.map(activity => <div key={activity.activityId} style={{ padding: 4, borderTop: '1px solid var(--theme-border)' }}>
      <strong>{activity.kind === 'terminal' ? '交互终端（空闲 Shell 仍占用）' : activity.kind === 'language-write' ? '可能写工作区的语言服务' : '文件保存 / 回执待核对'}</strong>
      {' · '}{activity.status}{' · '}{activity.relativePath || activity.resourceId || activity.activityId}
      <div>{target.executor} · {activity.workspace.workingDir}</div>
      <button disabled={blocked} onClick={() => window.dispatchEvent(new CustomEvent('awu:locate-engineering', {
        detail: { user: getCurrentUserProfile().userId, executor: target.executor, session: target.session, activity },
      }))}>定位工程活动</button>
      {activity.kind !== 'document-save' && activity.resourceId && <button disabled={blocked || !!pending} onClick={() => void stop(activity)}>
        {pending === activity.activityId ? '停止中…' : '停止此活动及所属进程'}</button>}
      {activity.kind === 'document-save' && <span>保存提交不可盲目取消；请在文件工作区核对原保存回执。</span>}
    </div>)}
    {message && <div role="status">{message}</div>}
  </div>;
};
