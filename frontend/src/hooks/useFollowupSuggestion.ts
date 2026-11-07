import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onCurrentUserChanged } from '../api';
import { composerDrafts } from '../utils/composerDrafts';
import { defaultFollowupConfig, FollowupDraftGuard, type FollowupConfig } from '../utils/followupSuggestions';
import { interactionIndex } from '../utils/userInteractions';

export function useFollowupSuggestion(session: string, executor: string, draftKey: string, blocked: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [config, setConfig] = useState(defaultFollowupConfig);
  const [configSupported, setConfigSupported] = useState(false);
  const busy = useRef(false), settingsRead = useRef(0);
  const [, refresh] = useState(0);
  const guard = useRef(new FollowupDraftGuard());
  const identity = useRef(draftKey); identity.current = draftKey;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const eligible = useCallback(() => {
    const row = composerDrafts.get(draftKey);
    return enabledRef.current && !blockedRef.current && !row?.text && !row?.images.length && !row?.textAttachments.length
      && !row?.references.length && !row?.review.roles.length && !interactionIndex.count(executor, session);
  }, [draftKey, executor, session]);
  const dismiss = useCallback(() => {
    const id = guard.current.invalidate(); refresh(v => v + 1);
    if (id) void api.followupSuggestionDismiss(session, executor, id).catch(() => {});
  }, [session, executor]);
  useEffect(() => {
    let alive = true;
    guard.current = new FollowupDraftGuard(); setEnabled(false); enabledRef.current = false; setNotice(''); setSaving(false); busy.current = false;
    setConfig(defaultFollowupConfig()); setConfigSupported(false);
    const read = ++settingsRead.current;
    void api.followupSuggestionSettings(session, executor).then(row => {
      if (alive && read === settingsRead.current) {
        enabledRef.current = row.enabled; setEnabled(row.enabled); setConfig(row.config || defaultFollowupConfig()); setConfigSupported(row.version === 2);
      }
    }).catch(() => { if (alive) setNotice('执行节点暂不支持影子建议'); });
    const off = api.onFollowupSuggestion((row, source) => {
      if (!alive || row.sessionId !== session || source !== executor) return;
      const ok = guard.current.receive(row, composerDrafts.get(draftKey)?.revision || 0, eligible());
      if (ok) refresh(v => v + 1);
      if (row.state === 'generating' && !eligible()) void api.followupSuggestionDismiss(session, executor, row.requestId).catch(() => {});
    });
    const check = () => {
      const id = guard.current.check(composerDrafts.get(draftKey)?.revision || 0, eligible());
      if (id) { refresh(v => v + 1); void api.followupSuggestionDismiss(session, executor, id).catch(() => {}); }
    };
    const offDraft = composerDrafts.subscribe(check), offInteraction = interactionIndex.subscribe(check);
    const offIdentity = onCurrentUserChanged((_profile, changed) => { if (changed) {
      ++settingsRead.current; guard.current.invalidate(); enabledRef.current = false; setEnabled(false);
      setConfig(defaultFollowupConfig()); setConfigSupported(false); refresh(v => v + 1);
    } });
    return () => { alive = false; off(); offDraft(); offInteraction(); offIdentity(); dismiss(); };
  }, [session, executor, draftKey, eligible, dismiss]);
  useEffect(() => { if (blocked || !enabled) dismiss(); }, [blocked, enabled, dismiss]);
  const save = useCallback(async (next?: boolean, settings?: FollowupConfig) => {
    if (busy.current) return false;
    const captured = identity.current; ++settingsRead.current;
    busy.current = true; setSaving(true); dismiss();
    try {
      const row = await api.followupSuggestionSettings(session, executor, next, settings);
      if (identity.current !== captured) return false;
      enabledRef.current = row.enabled; setEnabled(row.enabled); setConfig(row.config || defaultFollowupConfig()); setConfigSupported(row.version === 2); setNotice('');
      return true;
    } catch (error) {
      if (identity.current === captured) setNotice(`设置未确认：${String(error)}。请重新打开会话核对；未重试，编辑内容保留。`);
      return false;
    } finally { if (identity.current === captured) { busy.current = false; setSaving(false); } }
  }, [session, executor, dismiss]);
  const toggle = useCallback(() => save(!enabledRef.current), [save]);
  const saveConfig = useCallback((settings: FollowupConfig) => save(undefined, settings), [save]);
  return { enabled, saving, notice, toggle, config, configSupported, saveConfig, dismiss, suggestion: eligible() ? guard.current.current : undefined };
}
