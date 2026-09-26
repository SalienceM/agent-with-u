import React, {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { api, onCurrentUserChanged } from '../api';
import {
  detectPromptReference,
  fileReferenceLocation,
  formatFileReference,
  replacePromptReference,
  type PromptReferenceTrigger,
} from '../utils/promptReferences';
import { AppModalPortal } from './AppModalPortal';
import { skillReferenceText, type SkillManualSummary } from '../utils/skillManual';

type FileEntry = { name: string; path: string; isDir: boolean };
type PickerMode = 'file' | 'session' | 'skill' | null;

export interface AdvancedPromptTextareaProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> {
  value: string;
  onValueChange: (value: string) => void;
  sessionId?: string;
  workingDir?: string;
  execKey?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  containerStyle?: React.CSSProperties;
  enableSkillReferences?: boolean;
  onSkillManualsLoaded?: (entries: SkillManualSummary[]) => void;
}

interface PopupPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/**
 * LOOP / BTW 等入口共用的高级提示词输入框。
 * 支持与主聊天一致的 @文件、@SE → @SESSION:、键盘导航和远端执行节点路由。
 */
export const AdvancedPromptTextarea: React.FC<AdvancedPromptTextareaProps> = ({
  value,
  onValueChange,
  sessionId,
  workingDir,
  execKey,
  textareaRef,
  containerStyle,
  enableSkillReferences = false,
  onSkillManualsLoaded,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onBlur,
  onFocus,
  style,
  disabled,
  ...textareaProps
}) => {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef || fallbackRef;
  const popupRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const activeTriggerRef = useRef<PromptReferenceTrigger | null>(null);
  const pickerRef = useRef<PickerMode>(null);
  const fileRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const skillRequestRef = useRef(0);
  const [skillRefs, setSkillRefs] = useState<SkillManualSummary[]>([]);
  const [showSkillChildren, setShowSkillChildren] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillError, setSkillError] = useState('');
  const skillMatches = useMemo(() => skillRefs.flatMap(entry => [entry, ...(showSkillChildren ? entry.children || [] : [])])
    .filter(entry => `${entry.name} ${entry.displayName || ''} ${entry.repository || ''} ${(entry.children || []).map(child => child.name).join(' ')}`.toLowerCase().includes(skillQuery.toLowerCase())), [skillRefs, showSkillChildren, skillQuery]);
  const listboxId = useId();

  const [picker, setPickerState] = useState<PickerMode>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [fileQuery, setFileQuery] = useState('');
  const [currentDir, setCurrentDir] = useState('.');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [sessionRefs, setSessionRefs] = useState<any[]>([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionLoading, setSessionLoading] = useState(false);
  const [popupPosition, setPopupPosition] = useState<PopupPosition | null>(null);

  const setPicker = useCallback((next: PickerMode) => {
    pickerRef.current = next;
    setPickerState(next);
  }, []);

  const closePicker = useCallback(() => {
    activeTriggerRef.current = null;
    fileRequestRef.current += 1;
    sessionRequestRef.current += 1;
    skillRequestRef.current += 1;
    setPicker(null);
    setSelectedIndex(0);
  }, [setPicker]);

  const restoreCaret = useCallback((cursor: number) => {
    pendingCaretRef.current = cursor;
  }, []);
  // 跟随受控 value 的同次提交恢复，避免延迟 RAF 抢走用户下一次编辑的选区。
  useLayoutEffect(() => {
    const cursor = pendingCaretRef.current;
    if (cursor === null) return;
    pendingCaretRef.current = null;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(cursor, cursor);
  });

  const replaceActive = useCallback((replacement: string, close = true) => {
    const input = inputRef.current;
    const trigger = activeTriggerRef.current
      || detectPromptReference(value, input?.selectionStart ?? value.length, enableSkillReferences);
    if (!trigger) return;
    const next = replacePromptReference(value, trigger, replacement);
    onValueChange(next.value);
    if (close) closePicker();
    restoreCaret(next.cursor);
  }, [closePicker, inputRef, onValueChange, restoreCaret, value, enableSkillReferences]);

  const loadDirectory = useCallback(async (dir: string) => {
    const version = ++fileRequestRef.current;
    setFileLoading(true);
    setFileEntries([]);
    setFileError('');
    try {
      const entries = await api.listDirectory(dir || '.', workingDir || '.', execKey, false);
      if (version === fileRequestRef.current) setFileEntries(entries);
    } catch (error) {
      if (version === fileRequestRef.current) setFileError(String(error));
    } finally {
      if (version === fileRequestRef.current) setFileLoading(false);
    }
  }, [execKey, workingDir]);

  const loadSessions = useCallback(async (query: string) => {
    const version = ++sessionRequestRef.current;
    setSessionLoading(true);
    const entries = await api.listSessionRefs(query, execKey).catch(() => []);
    if (version !== sessionRequestRef.current) return;
    setSessionRefs((entries || []).filter((entry: any) => entry?.id && entry.id !== sessionId));
    setSessionLoading(false);
  }, [execKey, sessionId]);

  const enterSessionPicker = useCallback((trigger?: PromptReferenceTrigger) => {
    const input = inputRef.current;
    const active = trigger || activeTriggerRef.current
      || detectPromptReference(value, input?.selectionStart ?? value.length);
    if (!active) return;
    const next = replacePromptReference(value, active, '@SESSION:');
    const sessionTrigger: PromptReferenceTrigger = {
      kind: 'session', start: active.start, cursor: next.cursor,
      query: '', expandSessionPrefix: false,
    };
    activeTriggerRef.current = sessionTrigger;
    onValueChange(next.value);
    setSessionQuery('');
    setSessionRefs([]);
    setSelectedIndex(0);
    setPicker('session');
    void loadSessions('');
    restoreCaret(next.cursor);
  }, [inputRef, loadSessions, onValueChange, restoreCaret, setPicker, value]);

  const loadSkills = useCallback(async () => {
    const version = ++skillRequestRef.current;
    setSkillLoading(true); setSkillError('');
    try {
      if (!execKey) throw new Error('尚未确认 Session 执行节点，请稍后重试');
      const entries = await api.listSkillManuals(execKey);
      if (version === skillRequestRef.current) {
        setSkillRefs(entries);
        onSkillManualsLoaded?.(entries);
      }
    } catch (reason) { if (version === skillRequestRef.current) { setSkillRefs([]); setSkillError(String(reason)); } }
    finally { if (version === skillRequestRef.current) setSkillLoading(false); }
  }, [execKey, onSkillManualsLoaded]);

  const inspectValue = useCallback((nextValue: string, cursor: number) => {
    const trigger = detectPromptReference(nextValue, cursor, enableSkillReferences);
    activeTriggerRef.current = trigger;
    if (!trigger) {
      closePicker();
      return;
    }
    if (trigger.kind === 'skill') {
      fileRequestRef.current += 1; sessionRequestRef.current += 1;
      setSkillQuery(trigger.query); setSelectedIndex(0);
      if (pickerRef.current !== 'skill') { setSkillRefs([]); setPicker('skill'); void loadSkills(); }
      return;
    }
    if (trigger.kind === 'session') {
      if (trigger.expandSessionPrefix) {
        // 受控输入需要用本次 onChange 的 nextValue，而不是上一轮 props.value。
        const expanded = replacePromptReference(nextValue, trigger, '@SESSION:');
        const expandedTrigger: PromptReferenceTrigger = {
          kind: 'session', start: trigger.start, cursor: expanded.cursor,
          query: '', expandSessionPrefix: false,
        };
        activeTriggerRef.current = expandedTrigger;
        onValueChange(expanded.value);
        restoreCaret(expanded.cursor);
        setSessionQuery('');
        setSelectedIndex(0);
        setPicker('session');
        void loadSessions('');
        return;
      }
      fileRequestRef.current += 1;
      setSessionQuery(trigger.query);
      setSelectedIndex(0);
      setPicker('session');
      void loadSessions(trigger.query);
      return;
    }

    sessionRequestRef.current += 1;
    const location = fileReferenceLocation(trigger.query);
    setFileQuery(location.query);
    setSelectedIndex(0);
    if (pickerRef.current !== 'file' || currentDir !== location.directory) {
      setCurrentDir(location.directory);
      setPicker('file');
      void loadDirectory(location.directory);
    }
  }, [closePicker, currentDir, loadDirectory, loadSessions, loadSkills, enableSkillReferences, onValueChange, restoreCaret, setPicker]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    pendingCaretRef.current = null;
    const nextValue = event.currentTarget.value;
    const cursor = event.currentTarget.selectionStart ?? nextValue.length;
    onValueChange(nextValue);
    if (!composingRef.current) inspectValue(nextValue, cursor);
  }, [inspectValue, onValueChange]);

  const filteredFiles = useMemo(() => {
    const query = fileQuery.toLocaleLowerCase();
    return fileEntries.filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query));
  }, [fileEntries, fileQuery]);

  const parentDir = currentDir === '.'
    ? null
    : (currentDir.includes('/') ? currentDir.slice(0, currentDir.lastIndexOf('/')) || '.' : '.');
  const showParentOption = !!parentDir && !fileQuery;
  const showSessionShortcut = currentDir === '.' && (
    !fileQuery || 'session'.startsWith(fileQuery.toLocaleLowerCase())
  );
  const fileEntryOffset = (showParentOption ? 1 : 0) + (showSessionShortcut ? 1 : 0);
  const fileOptionCount = filteredFiles.length + fileEntryOffset;

  const navigateToDirectory = useCallback((path: string) => {
    const input = inputRef.current;
    const trigger = activeTriggerRef.current
      || detectPromptReference(value, input?.selectionStart ?? value.length);
    if (trigger) {
      const token = formatFileReference(path || '.', true);
      const next = replacePromptReference(value, trigger, token);
      onValueChange(next.value);
      activeTriggerRef.current = {
        kind: 'file', start: trigger.start, cursor: next.cursor,
        query: token.slice(1), expandSessionPrefix: false,
      };
      restoreCaret(next.cursor);
    }
    setCurrentDir(path || '.');
    setFileQuery('');
    setSelectedIndex(0);
    void loadDirectory(path || '.');
  }, [inputRef, loadDirectory, onValueChange, restoreCaret, value]);

  const chooseFileOption = useCallback((index: number, browse = false) => {
    if (showParentOption && index === 0 && parentDir) {
      navigateToDirectory(parentDir);
      return;
    }
    const sessionIndex = showParentOption ? 1 : 0;
    if (showSessionShortcut && index === sessionIndex) {
      enterSessionPicker();
      return;
    }
    const entry = filteredFiles[index - fileEntryOffset];
    if (!entry) return;
    if (entry.isDir && browse) navigateToDirectory(entry.path);
    else replaceActive(`${formatFileReference(entry.path, entry.isDir)} `);
  }, [
    enterSessionPicker, fileEntryOffset, filteredFiles, navigateToDirectory,
    parentDir, replaceActive, showParentOption, showSessionShortcut,
  ]);

  const handlePickerKey = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!pickerRef.current) return false;
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return true;
    if (pickerRef.current === 'file') {
      if (event.key === 'Enter' && !event.shiftKey && (event.ctrlKey || event.metaKey || fileOptionCount === 0 && !fileQuery)) {
        event.preventDefault();
        if (!fileLoading && !fileError) replaceActive(`${formatFileReference(currentDir, true)} `);
        return true;
      }
      if (event.key === 'ArrowLeft' && !event.shiftKey && !event.ctrlKey && !event.metaKey && parentDir) {
        event.preventDefault(); navigateToDirectory(parentDir); return true;
      }
      if (event.key === 'ArrowRight' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const entry = filteredFiles[selectedIndex - fileEntryOffset];
        if (!fileLoading && entry?.isDir) navigateToDirectory(entry.path);
        return true;
      }
    }
    const matches = skillMatches;
    const count = pickerRef.current === 'skill' ? matches.length : pickerRef.current === 'session' ? sessionRefs.length : fileOptionCount;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -1 : 1;
      setSelectedIndex((previous) => Math.max(0, Math.min(Math.max(0, count - 1), previous + delta)));
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      if (pickerRef.current === 'skill') {
        const entry = matches[selectedIndex];
        if (entry) replaceActive(skillReferenceText(entry));
      } else if (pickerRef.current === 'session') {
        const entry = sessionRefs[selectedIndex];
        if (entry?.id) replaceActive(`@SESSION:${entry.id} `);
      } else {
        if (!fileLoading && !fileError) chooseFileOption(selectedIndex, event.key === 'Tab');
      }
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
      return true;
    }
    return false;
  }, [chooseFileOption, closePicker, currentDir, fileEntryOffset, fileError, fileLoading, fileOptionCount, fileQuery,
    filteredFiles, navigateToDirectory, parentDir, replaceActive, selectedIndex, sessionRefs, skillMatches]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handlePickerKey(event)) return;
    onKeyDown?.(event);
  }, [handlePickerKey, onKeyDown]);

  const updatePopupPosition = useCallback(() => {
    const input = inputRef.current;
    if (!input || !pickerRef.current) return;
    const rect = input.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(240, Math.min(rect.width, viewportWidth - 16));
    const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
    const above = Math.max(0, rect.top - 8);
    const below = Math.max(0, viewportHeight - rect.bottom - 8);
    const placeAbove = above >= 180 || above > below;
    const available = Math.max(120, (placeAbove ? above : below) - 6);
    setPopupPosition({
      left, width, maxHeight: Math.min(300, available),
      ...(placeAbove
        ? { bottom: viewportHeight - rect.top + 5 }
        : { top: rect.bottom + 5 }),
    });
  }, [inputRef]);

  useEffect(() => {
    if (!picker) {
      setPopupPosition(null);
      return;
    }
    updatePopupPosition();
    const update = () => updatePopupPosition();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (inputRef.current?.contains(node) || popupRef.current?.contains(node)) return;
      closePicker();
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [closePicker, inputRef, picker, updatePopupPosition]);

  useEffect(() => {
    if (!picker || !popupRef.current) return;
    popupRef.current.querySelector<HTMLElement>(`[data-ref-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [picker, selectedIndex, sessionRefs, filteredFiles, skillRefs]);

  useEffect(() => () => {
    fileRequestRef.current += 1;
    sessionRequestRef.current += 1;
    skillRequestRef.current += 1;
  }, []);
  useEffect(() => { closePicker(); setSkillRefs([]); }, [sessionId, execKey, workingDir, closePicker]);
  useEffect(() => onCurrentUserChanged(() => { closePicker(); setSkillRefs([]); }), [closePicker]);

  const popup = picker && popupPosition ? (
    <AppModalPortal>
      <div
        ref={popupRef}
        id={listboxId}
        role="listbox"
        aria-label={picker === 'skill' ? '引用 Skill 手册' : picker === 'session' ? '引用会话' : '引用工作区文件或目录'}
        onMouseDown={(event) => event.preventDefault()}
        style={{
          position: 'fixed', zIndex: 40040,
          left: popupPosition.left, width: popupPosition.width,
          top: popupPosition.top, bottom: popupPosition.bottom,
          maxHeight: popupPosition.maxHeight,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          border: '1px solid var(--theme-border, rgba(0,0,0,.18))', borderRadius: 9,
          background: 'var(--theme-bg-secondary, #fff)', color: 'var(--theme-text, #1f2328)',
          boxShadow: '0 10px 30px rgba(0,0,0,.28)',
        }}
      >
        <div style={popupHeaderStyle}>
          <span>{picker === 'session' ? '💬' : '📁'}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {picker === 'skill' ? '📖 引用 Skill 使用知识（不执行）' : picker === 'session'
              ? `引用会话${sessionQuery ? ` · ${sessionQuery}` : ''}`
              : currentDir === '.' ? '引用工作区文件、目录或会话' : currentDir}
          </span>
          {(picker === 'session' ? sessionLoading : fileLoading) && <span>…</span>}
          {picker === 'file' && <button type="button" tabIndex={-1} style={directoryActionStyle}
            disabled={fileLoading || !!fileError} title="Ctrl/⌘+Enter 引用当前目录，只填入不发送"
            onClick={() => replaceActive(`${formatFileReference(currentDir, true)} `)}>引用当前目录</button>}
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {picker === 'skill' ? <>
            {skillError && <div role="alert" style={{ padding: 10 }}>{skillError}<button type="button" onClick={() => void loadSkills()}>重试</button></div>}
            {skillRefs.some(entry => entry.kind === 'parent') && <button type="button" onClick={() => { setShowSkillChildren(value => !value); setSelectedIndex(0); }} style={{ margin: 6 }}>{showSkillChildren ? '仅显示父级' : '展开子 Skill（单独引用）'}</button>}
            {skillMatches.map((entry, index) => <ReferenceOption key={entry.name} index={index} selected={index === selectedIndex}
              icon={entry.kind === 'parent' ? '📦' : '📖'} label={entry.displayName || entry.name} hint={entry.kind === 'parent' ? `全部 ${entry.children?.length || 0} 个子 Skill` : entry.hasManual ? '维护手册' : '原始资料'} onChoose={() => replaceActive(skillReferenceText(entry))} onHover={setSelectedIndex} />)}
            {skillLoading ? <EmptyPicker text="读取本节点已安装的 Skill…" /> : !skillError && !skillMatches.length && <EmptyPicker text="无匹配 Skill；可在本节点市场安装后重试" />}
          </> : picker === 'session' ? (
            sessionRefs.length ? sessionRefs.map((entry: any, index) => (
              <ReferenceOption
                key={entry.id}
                index={index}
                selected={index === selectedIndex}
                icon={entry.sessionType === 'loop' ? '🔁' : '💬'}
                label={entry.title || entry.id}
                hint={String(entry.id || '').slice(0, 8)}
                onChoose={() => replaceActive(`@SESSION:${entry.id} `)}
                onHover={setSelectedIndex}
              />
            )) : <EmptyPicker text={sessionLoading ? '正在查询会话…' : '无匹配会话'} />
          ) : (
            <>
              {fileError && <div role="alert" style={{ padding: 10 }}>{fileError}
                <button type="button" onClick={() => void loadDirectory(currentDir)}>重试</button>
              </div>}
              {showParentOption && parentDir && (
                <ReferenceOption
                  index={0}
                  selected={selectedIndex === 0}
                  icon="↩"
                  label=".."
                  hint="上级目录"
                  onChoose={() => navigateToDirectory(parentDir)}
                  onHover={setSelectedIndex}
                />
              )}
              {showSessionShortcut && (
                <ReferenceOption
                  index={showParentOption ? 1 : 0}
                  selected={selectedIndex === (showParentOption ? 1 : 0)}
                  icon="💬"
                  label="SESSION · 引用其他会话"
                  hint="@SESSION:"
                  onChoose={() => enterSessionPicker()}
                  onHover={setSelectedIndex}
                />
              )}
              {filteredFiles.map((entry, rawIndex) => {
                const index = rawIndex + fileEntryOffset;
                return (
                  <ReferenceOption
                    key={entry.path}
                    index={index}
                    selected={index === selectedIndex}
                    icon={entry.isDir ? '📁' : '📄'}
                    label={entry.name}
                    hint={entry.isDir ? '引用目录' : entry.path}
                    onChoose={() => replaceActive(`${formatFileReference(entry.path, entry.isDir)} `)}
                    onBrowse={entry.isDir ? () => navigateToDirectory(entry.path) : undefined}
                    onHover={setSelectedIndex}
                  />
                );
              })}
              {fileLoading && <EmptyPicker text="正在读取目录…" />}
              {!fileLoading && !fileError && !filteredFiles.length && <EmptyPicker text={fileQuery ? '无匹配文件或目录' : '空目录，可直接引用当前目录'} />}
            </>
          )}
        </div>
        <div style={popupFooterStyle}>{picker === 'file'
          ? '↑↓ 选择 · Enter 引用 · Tab/→ 进入 · Ctrl+Enter 当前目录 · Esc 关闭'
          : '↑↓ 导航 · Enter/Tab 选择 · Esc 关闭'}</div>
      </div>
    </AppModalPortal>
  ) : null;

  return (
    <div style={{ position: 'relative', minWidth: 0, ...containerStyle }}>
      <textarea
        {...textareaProps}
        ref={inputRef}
        value={value}
        disabled={disabled}
        aria-autocomplete="list"
        aria-expanded={!!picker}
        aria-controls={picker ? listboxId : undefined}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={(event) => {
          composingRef.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          onCompositionEnd?.(event);
          inspectValue(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length);
        }}
        onFocus={(event) => { onFocus?.(event); }}
        onBlur={(event) => { onBlur?.(event); }}
        style={style}
      />
      {popup}
    </div>
  );
};

const ReferenceOption: React.FC<{
  index: number; selected: boolean; icon: string; label: string; hint?: string;
  onChoose: () => void; onHover: (index: number) => void; onBrowse?: () => void;
}> = ({ index, selected, icon, label, hint, onChoose, onHover, onBrowse }) => (
  <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
  <button
    type="button"
    tabIndex={-1}
    role="option"
    aria-selected={selected}
    data-ref-index={index}
    onMouseEnter={() => onHover(index)}
    onClick={onChoose}
    style={{
      display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, width: '100%', minHeight: 34,
      padding: '6px 10px', border: 0, textAlign: 'left', cursor: 'pointer',
      color: 'var(--theme-text)',
      background: selected ? 'var(--theme-accent-bg, rgba(9,105,218,.12))' : 'transparent',
      font: 'inherit', fontSize: 12,
    }}
  >
    <span aria-hidden="true">{icon}</span>
    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    {hint && <span style={{ maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--theme-text-muted)', fontSize: 10 }}>{hint}</span>}
  </button>
  {onBrowse && <button type="button" tabIndex={-1} aria-label={`进入目录 ${label}`}
    title="进入目录（Tab / →）" style={directoryActionStyle} onClick={onBrowse}>进入 ›</button>}
  </div>
);

const directoryActionStyle: React.CSSProperties = {
  flexShrink: 0, minHeight: 32, padding: '5px 8px', marginRight: 4, borderRadius: 4,
  border: '1px solid var(--theme-border)', color: 'var(--theme-text)',
  background: 'var(--theme-bg-secondary)', font: 'inherit', fontSize: 11, cursor: 'pointer',
};

const EmptyPicker: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ padding: '10px 12px', color: 'var(--theme-text-muted)', fontSize: 12 }}>{text}</div>
);

const popupHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
  padding: '7px 10px', borderBottom: '1px solid var(--theme-border)',
  color: 'var(--theme-text-muted)', fontSize: 11,
};

const popupFooterStyle: React.CSSProperties = {
  flexShrink: 0, padding: '5px 10px', borderTop: '1px solid var(--theme-border)',
  color: 'var(--theme-text-muted)', fontSize: 9.5,
};
