import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { uuid } from '../utils/uuid';

/** 窗口级回执先存后发；连接中断只自动读一次，绝不生成新 ID 重放。 */
export function useSessionRenewal(user: string, session: string, executor: string, active: boolean,
  onCreated: (next: any) => void) {
  const key = `awu:session-renew:v1:${JSON.stringify([user, executor, session])}`;
  const current = useRef({ key, active, onCreated }); current.current = { key, active, onCreated };
  const mounted = useRef(true), inFlight = useRef(false);
  const [state, setState] = useState({ key, busy: false, unknown: false, retryable: false, message: '' });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let pending = false;
    try { pending = !!sessionStorage.getItem(key); } catch { /* 提交时会报告不可持久化 */ }
    setState({ key, busy: false, unknown: pending, retryable: false,
      message: pending ? '上次开启新会话的结果尚未确认，请核对。旧会话仍保留。' : '' });
  }, [key]);

  const start = useCallback(async (retry = false) => {
    if (!session || !executor || !active || inFlight.current) return;
    inFlight.current = true;
    const live = () => mounted.current && current.current.key === key;
    const update = (patch: Partial<typeof state>) => { if (live()) setState(previous => ({ ...previous, key, ...patch })); };
    update({ busy: true, message: '' });
    let request = '', submitted = false;
    try {
      const pending = sessionStorage.getItem(key);
      request = pending || uuid();
      sessionStorage.setItem(key, request);
      submitted = true;
      let result;
      try {
        result = pending && !retry ? await api.sessionRenewStatus(session, request, executor)
          : await api.sessionRenew(session, request, executor);
      } catch (error: any) {
        if (!live()) return;
        if (error?.notSubmitted && !pending) { sessionStorage.removeItem(key); submitted = false; throw error; }
        if (pending && !retry) throw error;
        result = await api.sessionRenewStatus(session, request, executor);
      }
      if (result.status === 'succeeded' && result.session?.id) {
        sessionStorage.removeItem(key);
        update({ unknown: false, retryable: false });
        // 元数据已由 API 归属到原执行器；迟到回执不能抢走另一会话的焦点。
        window.dispatchEvent(new CustomEvent('session-created', { detail: result.session }));
        if (live() && current.current.active) current.current.onCreated(result.session);
      } else if (result.status === 'error') {
        sessionStorage.removeItem(key);
        update({ unknown: false, retryable: false, message: result.message || '未能开启新会话，旧会话保持不变。' });
      } else {
        update({ unknown: true, retryable: ['not_found', 'incomplete'].includes(result.status),
          message: '新会话结果尚未确认，旧记录仍保留。可稍后核对或在会话历史中查看。' });
      }
    } catch (error: any) {
      update({ unknown: submitted, retryable: false, message: submitted
        ? '连接中断，创建结果尚未确认。请核对结果，旧记录仍保留。'
        : error?.message || '无法保存新会话请求，请检查浏览器存储。' });
    } finally { inFlight.current = false; update({ busy: false }); }
  }, [active, executor, key, session]);
  return { ...(state.key === key ? state : { busy: false, unknown: false, retryable: false, message: '' }), start };
}
