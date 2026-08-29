import React, {
  useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import { api } from '../api';
import {
  detectPromptReference,
  replacePromptReference,
  type PromptReferenceTrigger,
} from '../utils/promptReferences';
import { AppModalPortal } from './AppModalPortal';

type FileEntry = { name: string; path: string; isDir: boolean };
type PickerMode = 'file' | 'session' | null;

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
  const activeTriggerRef = useRef<PromptReferenceTrigger | null>(null);
  const pickerRef = useRef<PickerMode>(null);
  const fileRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const listboxId = useId();

  const [picker, setPickerState] = useState<PickerMode>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [fileQuery, setFileQuery] = useState('');
  const [currentDir, setCurrentDir] = useState('.');
  const [fileLoading, setFileLoading] = useState(false);
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
    setPicker(null);
    setSelectedIndex(0);
  }, [setPicker]);

  const restoreCaret = useCallback((cursor: number) => {
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(cursor, cursor);
    });
  }, [inputRef]);

  const replaceActive = useCallback((replacement: string, close = true) => {
    const input = inputRef.current;
    const trigger = activeTriggerRef.current
      || detectPromptReference(value, input?.selectionStart ?? value.length);
    if (!trigger) return;
    const next = replacePromptReference(value, trigger, replacement);
    onValueChange(next.value);
    if (close) closePicker();
    restoreCaret(next.cursor);
  }, [closePicker, inputRef, onValueChange, restoreCaret, value]);

  const loadDirectory = useCallback(async (dir: string) => {
    const version = ++fileRequestRef.current;
    setFileLoading(true);
    const entries = await api.listDirectory(
      dir || '.', workingDir || '.', execKey, false,
    ).catch(() => [] as FileEntry[]);
    if (version !== fileRequestRef.current) return;
    setFileEntries(Array.isArray(entries) ? entries : []);
    setFileLoading(false);
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

  const inspectValue = useCallback((nextValue: string, cursor: number) => {
    const trigger = detectPromptReference(nextValue, cursor);
    activeTriggerRef.current = trigger;
    if (!trigger) {
      closePicker();
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
    setFileQuery(trigger.query);
    setSelectedIndex(0);
    if (pickerRef.current !== 'file') {
      setCurrentDir('.');
      setFileEntries([]);
      setPicker('file');
      void loadDirectory('.');
    }
  }, [closePicker, loadDirectory, loadSessions, onValueChange, restoreCaret, setPicker]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
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
      const next = replacePromptReference(value, trigger, '@');
      onValueChange(next.value);
      activeTriggerRef.current = {
        kind: 'file', start: trigger.start, cursor: next.cursor,
        query: '', expandSessionPrefix: false,
      };
      restoreCaret(next.cursor);
    }
    setCurrentDir(path || '.');
    setFileQuery('');
    setSelectedIndex(0);
    void loadDirectory(path || '.');
  }, [inputRef, loadDirectory, onValueChange, restoreCaret, value]);

  const chooseFileOption = useCallback((index: number) => {
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
    if (entry.isDir) navigateToDirectory(entry.path);
    else replaceActive(`@${entry.path.replace(/\\/g, '/')} `);
  }, [
    enterSessionPicker, fileEntryOffset, filteredFiles, navigateToDirectory,
    parentDir, replaceActive, showParentOption, showSessionShortcut,
  ]);

  const handlePickerKey = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!pickerRef.current) return false;
    const count = pickerRef.current === 'session' ? sessionRefs.length : fileOptionCount;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -1 : 1;
      setSelectedIndex((previous) => Math.max(0, Math.min(Math.max(0, count - 1), previous + delta)));
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      if (pickerRef.current === 'session') {
        const entry = sessionRefs[selectedIndex];
        if (entry?.id) replaceActive(`@SESSION:${entry.id} `);
      } else {
        chooseFileOption(selectedIndex);
      }
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
      return true;
    }
    return false;
  }, [chooseFileOption, closePicker, fileOptionCount, replaceActive, selectedIndex, sessionRefs]);

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
  }, [picker, selectedIndex, sessionRefs, filteredFiles]);

  useEffect(() => () => {
    fileRequestRef.current += 1;
    sessionRequestRef.current += 1;
  }, []);

  const popup = picker && popupPosition ? (
    <AppModalPortal>
      <div
        ref={popupRef}
        id={listboxId}
        role="listbox"
        aria-label={picker === 'session' ? '引用会话' : '引用工作区文件'}
        onMouseDown={(event) => event.preventDefault()}
        style={{
          position: 'fixed', zIndex: 10040,
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
            {picker === 'session'
              ? `引用会话${sessionQuery ? ` · ${sessionQuery}` : ''}`
              : currentDir === '.' ? '引用工作区文件或会话' : currentDir}
          </span>
          {(picker === 'session' ? sessionLoading : fileLoading) && <span>…</span>}
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {picker === 'session' ? (
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
                    hint={entry.isDir ? '进入' : entry.path}
                    onChoose={() => entry.isDir
                      ? navigateToDirectory(entry.path)
                      : replaceActive(`@${entry.path.replace(/\\/g, '/')} `)}
                    onHover={setSelectedIndex}
                  />
                );
              })}
              {!fileLoading && fileOptionCount === 0 && <EmptyPicker text="无匹配文件" />}
            </>
          )}
        </div>
        <div style={popupFooterStyle}>↑↓ 导航 · Enter/Tab 选择 · Esc 关闭</div>
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
  onChoose: () => void; onHover: (index: number) => void;
}> = ({ index, selected, icon, label, hint, onChoose, onHover }) => (
  <button
    type="button"
    tabIndex={-1}
    role="option"
    aria-selected={selected}
    data-ref-index={index}
    onMouseEnter={() => onHover(index)}
    onClick={onChoose}
    style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 34,
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
);

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
