import React, { useRef, useCallback, useEffect, memo, useState, useMemo } from 'react';
import { ImagePreview } from './ImagePreview';
import { useClipboardImage } from '../hooks/useClipboardImage';
import type { ImageAttachment } from '../hooks/useClipboardImage';
import { SLASH_COMMANDS } from '../hooks/useChat';
import type { SlashCommand } from '../hooks/useChat';
import { api, isTauri } from '../api';

// ── 注入全局样式（focus glow）────────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('chat-input-css')) {
  const s = document.createElement('style');
  s.id = 'chat-input-css';
  s.textContent = `
    .chat-textarea {
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .chat-textarea:focus {
      border-color: var(--theme-accent, #0969da) !important;
      box-shadow: 0 0 0 3px var(--theme-accent-bg, rgba(9,105,218,0.15)) !important;
    }
    @keyframes chat-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.4; }
    }
    @keyframes dialogSlideIn {
      from { opacity: 0; transform: perspective(900px) rotateX(-14deg) scale(0.96) translateY(-8px); }
      to   { opacity: 1; transform: perspective(900px) rotateX(0deg)   scale(1)    translateY(0); }
    }
    @keyframes mic-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(248,81,73,0.5); }
      50% { box-shadow: 0 0 0 10px rgba(248,81,73,0); }
    }
  `;
  document.head.appendChild(s);
}

type FileEntry = { name: string; path: string; isDir: boolean };

interface Props {
  onSend: (content: string, images?: ImageAttachment[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  backends: any[];
  activeBackendId: string;
  sessionId?: string;
  workingDir?: string;
  skipPermissions?: boolean;
  onSkipPermissionsChange?: (enabled: boolean) => void;
  isMobile?: boolean;
  // ── 序列任务：输入框「序列模式」——激活后回车不直接发送,而是排入队列 ──
  seqMode?: boolean;
  onToggleSeqMode?: () => void;
  onQueueTask?: (content: string, images?: ImageAttachment[]) => void;
  seqCount?: number;
  onCompact?: () => void;
  fontSize?: number;                         // 当前对话字号(用于 A−/A+ 显示)
  onAdjustFontSize?: (delta: number) => void; // 步进对话字号
  // 多 pane 场景:用来决定全局快捷键(截图等)归哪个输入框处理。
  // 单 pane / 浏览器单实例下不传也行,默认 true。
  isFocused?: boolean;
  // ── Git 集成（execKey/execMode 用于 FileTreePanel 侧 Git 操作）──
  execKey?: string;
  execMode?: 'local' | 'relay';
  // ── ★ 自动 AI commit ──
  autoCommit?: boolean;
  autoCommitPush?: boolean;
  autoCommitBackendId?: string;
  onAutoCommitChange?: (enabled: boolean, push?: boolean, backendId?: string) => void;
}

// ═══════════════════════════════════════
//  ★ 工具栏按钮组件
// ═══════════════════════════════════════
interface ToolbarBtnProps {
  icon: string;
  title: string;
  active?: boolean;
  onClick?: () => void;
  loading?: boolean;
  compact?: boolean;   // 移动端:只显示图标,隐藏文字标签(整排不再撑成好几行)
}

const ToolbarBtn: React.FC<ToolbarBtnProps> = ({ icon, title, active, onClick, loading, compact }) => {
  const [isHover, setIsHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      disabled={loading}
      title={title}
      onMouseEnter={() => setIsHover(true)}
      onMouseLeave={() => setIsHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 4,
        padding: compact ? '5px 9px' : '4px 8px',
        fontSize: 11,
        borderRadius: 6,
        border: active ? '1px solid var(--theme-accent, #0969da)' : '1px solid var(--theme-border, rgba(0,0,0,0.12))',
        background: active ? 'var(--theme-accent-bg, rgba(9,105,218,0.1))' : isHover ? 'var(--theme-bg-tertiary, #eaeef2)' : 'var(--theme-bg-secondary, #f6f8fa)',
        color: active ? 'var(--theme-accent, #0969da)' : isHover ? 'var(--theme-text, #1f2328)' : 'var(--theme-text-muted, #656d76)',
        cursor: loading ? 'wait' : 'pointer',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
        opacity: loading ? 0.6 : 1,
      }}
    >
      <span style={{ fontSize: compact ? 14 : 12 }}>{icon}</span>
      {!compact && <span>{title}</span>}
    </button>
  );
};

const ChatInputInner: React.FC<Props> = ({
  onSend, onAbort, isStreaming, backends, activeBackendId, sessionId, workingDir,
  skipPermissions = true, onSkipPermissionsChange,
  isMobile = false,
  seqMode = false, onToggleSeqMode, onQueueTask, seqCount = 0,
  onCompact,
  fontSize, onAdjustFontSize,
  isFocused = true,
  autoCommit = false, autoCommitPush = false, autoCommitBackendId = '', onAutoCommitChange,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 把 textarea ref 传给 useClipboardImage,这样多 pane 场景下只有聚焦
  // 的输入框对应的 hook 会处理粘贴,避免一张图被所有 pane 同时吃下。
  const { images, removeImage, clearImages, addImage } = useClipboardImage(ref);

  // 截图按钮状态:正在等待用户选区域 / 已超时
  const [screenshotBusy, setScreenshotBusy] = useState(false);

  // 调起系统截图工具 → 等图片落进剪贴板 → 走既有粘贴流程加入附件。
  // 桌面端独占——浏览器无法触发系统截图工具。
  const handleScreenshot = useCallback(async () => {
    if (!isTauri()) return;
    if (screenshotBusy) return;
    let invoke: ((cmd: string) => Promise<unknown>) | null = null;
    try {
      const mod = await import('@tauri-apps/api/core');
      invoke = mod.invoke;
    } catch {
      return;
    }
    // 记一下点击前剪贴板里现成的那张图(如果有),用 base64 前缀做去重
    // key,避免后面把「旧图」误认成新截图加入附件。
    let beforeKey = '';
    try {
      const before = await api.readClipboardImage();
      if (before?.base64) beforeKey = before.base64.slice(0, 200);
    } catch { /* 没装 PIL 或失败:无所谓,beforeKey 留空 */ }
    setScreenshotBusy(true);
    try {
      await invoke('open_screenshot_tool');
    } catch (e) {
      console.error('[screenshot] open tool failed:', e);
      setScreenshotBusy(false);
      return;
    }
    // 轮询剪贴板,最长 60 秒
    const start = Date.now();
    const POLL_INTERVAL = 500;
    const TIMEOUT = 60_000;
    while (Date.now() - start < TIMEOUT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      try {
        const img = await api.readClipboardImage();
        if (img && img.base64 && img.base64.slice(0, 200) !== beforeKey) {
          addImage(img);
          break;
        }
      } catch { /* 单次失败继续轮询 */ }
    }
    setScreenshotBusy(false);
  }, [addImage, screenshotBusy]);

  // 全局快捷键(App.tsx 注册 Ctrl+Shift+A)触发时,每个 pane 的 ChatInput
  // 都会收到事件,只有焦点 pane 那一个真正去截图——其它静默。用 ref 拿最新
  // 的 isFocused / handleScreenshot,避免闭包问题。
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  const screenshotFnRef = useRef(handleScreenshot);
  screenshotFnRef.current = handleScreenshot;
  useEffect(() => {
    if (!isTauri()) return;
    const onHotkey = () => {
      if (focusedRef.current) screenshotFnRef.current();
    };
    window.addEventListener('awu:screenshot-hotkey', onHotkey);
    return () => window.removeEventListener('awu:screenshot-hotkey', onHotkey);
  }, []);

  // ── 稳定 refs ──
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const seqModeRef = useRef(seqMode);
  seqModeRef.current = seqMode;
  const onQueueTaskRef = useRef(onQueueTask);
  onQueueTaskRef.current = onQueueTask;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const clearImagesRef = useRef(clearImages);
  clearImagesRef.current = clearImages;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const composingRef = useRef(false);

  // ═══════════════════════════════════════
  //  ★ 输入历史（Linux 风格 ↑↓ 浏览，最多 10 条）
  // ══════════════════════════════════════
  // 历史条目 & 当前浏览位置（-1 = 未进入浏览模式）
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  // 进入浏览模式时，暂存用户当时正在输入的草稿，退出时恢复
  const draftRef = useRef('');

  // 每会话独立：sessionId 变化时自动重置
  useEffect(() => {
    setHistory([]);
    setHistIdx(-1);
    draftRef.current = '';
  }, [sessionId]);

  // 稳定 refs，供 keydown 里同步读取
  const historyRef = useRef<string[]>([]);
  historyRef.current = history;
  const histIdxRef = useRef(-1);
  histIdxRef.current = histIdx;

  // 追加一条到历史（去重 + 最多 10 条，最新的在末尾）
  const pushHistory = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setHistory(prev => {
      // 与最近一条重复则不追加（避免连续发送相同内容撑爆历史）
      if (prev.length > 0 && prev[prev.length - 1] === t) return prev;
      const next = [...prev, t];
      return next.length > 10 ? next.slice(next.length - 10) : next;
    });
    setHistIdx(-1); // 发送后退出浏览模式
  }, []);

  // ═══════════════════════════════════════
  //  ★ 斜杠命令自动补全状态
  // ═══════════════════════════════════════
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);

  // 稳定 refs for keyboard handler
  const showCommandsRef = useRef(false);
  showCommandsRef.current = showCommands;
  const filteredCommandsRef = useRef<SlashCommand[]>([]);
  filteredCommandsRef.current = filteredCommands;
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;

  // ═══════════════════════════════════════
  //  ★ @ 文件选择器状态
  // ═══════════════════════════════════════
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
  const [currentDir, setCurrentDir] = useState('');
  const [fileQuery, setFileQuery] = useState('');
  const filePopupRef = useRef<HTMLDivElement>(null);

  const showFilePickerRef = useRef(false);
  showFilePickerRef.current = showFilePicker;
  const fileEntriesRef = useRef<FileEntry[]>([]);
  fileEntriesRef.current = fileEntries;
  const fileSelectedIndexRef = useRef(0);
  fileSelectedIndexRef.current = fileSelectedIndex;
  const fileQueryRef = useRef('');
  fileQueryRef.current = fileQuery;
  const currentDirRef = useRef('');
  currentDirRef.current = currentDir;

  // ★ @SESSION: 会话引用选择器状态
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionRefs, setSessionRefs] = useState<any[]>([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionSelectedIndex, setSessionSelectedIndex] = useState(0);
  const showSessionPickerRef = useRef(false);
  showSessionPickerRef.current = showSessionPicker;
  const sessionRefsRef = useRef<any[]>([]);
  sessionRefsRef.current = sessionRefs;
  const sessionSelectedIndexRef = useRef(0);
  sessionSelectedIndexRef.current = sessionSelectedIndex;

  const workingDirRef = useRef(workingDir);
  workingDirRef.current = workingDir;

  // ── 清理上下文 ──
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  // ── 语音流式转写 ──
  const [micActive, setMicActive] = useState(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micUnsubRef = useRef<(() => void) | null>(null);
  const micPrefixRef = useRef<string | null>(null);
  const micStoppedRef = useRef(false);

  const micWorkletRef = useRef<AudioWorkletNode | null>(null);

  const micStop = useCallback(async () => {
    if (micStoppedRef.current) return;
    micStoppedRef.current = true;
    micUnsubRef.current?.();
    micUnsubRef.current = null;
    if (micWorkletRef.current) {
      micWorkletRef.current.port.close();
      micWorkletRef.current.disconnect();
      micWorkletRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    micAudioCtxRef.current?.close().catch(() => {});
    micAudioCtxRef.current = null;
    try {
      const res = await api.sttStreamStop();
      if (res.ok && res.text && ref.current) {
        const prefix = micPrefixRef.current ?? '';
        ref.current.value = prefix ? prefix + '\n' + res.text : res.text;
        ref.current.style.height = 'auto';
        ref.current.style.height = ref.current.scrollHeight + 'px';
      }
    } catch {}
    micPrefixRef.current = null;
    setMicActive(false);
    ref.current?.focus();
  }, []);

  const micStart = useCallback(async () => {
    micStoppedRef.current = false;
    try {
      const cfg = await api.getSttConfig();
      const deviceId = cfg?.deviceId || '';

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
      } catch (devErr) {
        if (deviceId) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw devErr;
        }
      }
      micStreamRef.current = stream;

      const res = await api.sttStreamStart();
      if (!res.ok) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error(res.error || 'STT stream start failed');
      }

      micPrefixRef.current = ref.current?.value ?? '';

      const unsub = api.onSttStreamText((data) => {
        if (!ref.current) return;
        const prefix = micPrefixRef.current ?? '';
        ref.current.value = prefix ? prefix + '\n' + data.text : data.text;
        ref.current.style.height = 'auto';
        ref.current.style.height = ref.current.scrollHeight + 'px';
      });
      micUnsubRef.current = unsub;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      micAudioCtxRef.current = audioCtx;
      await audioCtx.audioWorklet.addModule('./pcm-worklet.js');
      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor');
      micWorkletRef.current = worklet;
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (micStoppedRef.current) return;
        api.sttStreamAudioBinary(e.data);
      };
      source.connect(worklet);

      setMicActive(true);
    } catch (e: any) {
      console.error('[mic]', e);
      setMicActive(false);
    }
  }, []);

  const toggleMic = useCallback(() => {
    if (micActive) {
      micStop();
    } else {
      micStart();
    }
  }, [micActive, micStart, micStop]);

  const micReconnect = useCallback(async () => {
    if (micStoppedRef.current) return;
    micUnsubRef.current?.();
    micUnsubRef.current = null;
    // 保存当前文本作为新前缀，避免重连后丢失已转写内容
    if (ref.current) micPrefixRef.current = ref.current.value;
    try {
      const res = await api.sttStreamStart();
      if (!res.ok) throw new Error(res.error);
      const unsub = api.onSttStreamText((data) => {
        if (!ref.current) return;
        const prefix = micPrefixRef.current ?? '';
        ref.current.value = prefix ? prefix + '\n' + data.text : data.text;
        ref.current.style.height = 'auto';
        ref.current.style.height = ref.current.scrollHeight + 'px';
      });
      micUnsubRef.current = unsub;
    } catch {
      micStoppedRef.current = true;
      if (micWorkletRef.current) {
        micWorkletRef.current.port.close();
        micWorkletRef.current.disconnect();
        micWorkletRef.current = null;
      }
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      micAudioCtxRef.current?.close().catch(() => {});
      micAudioCtxRef.current = null;
      micPrefixRef.current = null;
      setMicActive(false);
    }
  }, []);

  useEffect(() => {
    const unsub = api.onSttStreamEnd(() => {
      if (!micStoppedRef.current) {
        micReconnect();
      }
    });
    return () => {
      unsub();
      if (micStreamRef.current) {
        micStoppedRef.current = true;
        micUnsubRef.current?.();
        if (micWorkletRef.current) {
          micWorkletRef.current.port.close();
          micWorkletRef.current.disconnect();
          micWorkletRef.current = null;
        }
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micAudioCtxRef.current?.close().catch(() => {});
      }
    };
  }, [micReconnect]);

  const handleCompact = useCallback(() => {
    // ★ 二次确认：新会话会清空上下文，误触代价很大
    setShowNewSessionConfirm(true);
  }, []);
  const confirmNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    onCompact?.();
  }, [onCompact]);

  // ═══════════════════════════════════════
  //  ★ 图像尺寸选择器（DashScope 图像 backend）
  // ═══════════════════════════════════════
  const activeBackend = useMemo(() => backends.find(b => b.id === activeBackendId), [backends, activeBackendId]);
  const isImageBackend = activeBackend?.type === 'dashscope-image';
  const isImageBackendRef = useRef(false);
  isImageBackendRef.current = isImageBackend;
  const [imageSize, setImageSize] = useState('1:1');
  const [showSizePicker, setShowSizePicker] = useState(false);
  const imageSizeRef = useRef('1:1');
  imageSizeRef.current = imageSize;
  const sizePickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSizePicker) return;
    const handler = (e: MouseEvent) => {
      if (sizePickerRef.current && !sizePickerRef.current.contains(e.target as Node)) {
        setShowSizePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSizePicker]);

  // 分辨率档位 → 比例 → 具体尺寸的映射
  const SIZE_PRESETS: Record<string, { label: string; icon: string }> = {
    '1:1': { label: '1:1', icon: '□' },
    '16:9': { label: '16:9', icon: '▭' },
    '9:16': { label: '9:16', icon: '▯' },
    '4:3': { label: '4:3', icon: '▭' },
    '3:4': { label: '3:4', icon: '▯' },
    '3:2': { label: '3:2', icon: '▭' },
    '2:3': { label: '2:3', icon: '▯' },
  };

  // ═══════════════════════════════════════
  //  ★ @ 文件选择器 helpers
  // ═══════════════════════════════════════

  // 计算父目录（不允许超过 workingDir，全部使用相对路径）
  const getParentDir = (dirPath: string): string | null => {
    const normalized = dirPath.replace(/\\/g, '/').replace(/\/$/, '');
    if (!normalized || normalized === '.') return null; // 已在根目录
    const lastSep = normalized.lastIndexOf('/');
    if (lastSep < 0) return '.'; // 单层子目录 → 回到根
    return normalized.substring(0, lastSep) || '.';
  };

  // 进入子目录
  const navigateToDir = useCallback((dirPath: string) => {
    setCurrentDir(dirPath);
    setFileQuery('');
    setFileSelectedIndex(0);
    // 清除光标前 @ 后面的查询词
    const el = ref.current;
    if (el) {
      const cursor = el.selectionStart ?? el.value.length;
      const before = el.value.substring(0, cursor);
      const lastAt = before.lastIndexOf('@');
      if (lastAt >= 0) {
        const newVal = el.value.substring(0, lastAt + 1) + el.value.substring(cursor);
        el.value = newVal;
        el.selectionStart = lastAt + 1;
        el.selectionEnd = lastAt + 1;
      }
    }
    api.listDirectory(dirPath, workingDirRef.current).then((entries) => {
      if (Array.isArray(entries)) setFileEntries(entries);
    });
  }, []);

  const navigateToDirRef = useRef(navigateToDir);
  navigateToDirRef.current = navigateToDir;

  // 选中文件：在光标处替换 @query → @path
  const insertFileRef = useCallback((filePath: string) => {
    const el = ref.current;
    if (!el) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = el.value.substring(0, cursor);
    const lastAt = before.lastIndexOf('@');
    if (lastAt < 0) { setShowFilePicker(false); return; }
    const normalized = filePath.replace(/\\/g, '/');
    const newVal = el.value.substring(0, lastAt) + '@' + normalized + ' ' + el.value.substring(cursor);
    el.value = newVal;
    const newCursor = lastAt + 1 + normalized.length + 1;
    el.selectionStart = newCursor;
    el.selectionEnd = newCursor;
    el.focus();
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    setShowFilePicker(false);
    setFileQuery('');
  }, []);

  const insertFileRefRef = useRef(insertFileRef);
  insertFileRefRef.current = insertFileRef;

  const insertSessionRef = useCallback((session: any) => {
    const el = ref.current;
    if (!el || !session?.id) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = el.value.substring(0, cursor);
    const marker = '@SESSION:';
    const last = before.lastIndexOf(marker);
    if (last < 0) { setShowSessionPicker(false); return; }
    const label = String(session.id);
    const newVal = el.value.substring(0, last) + `${marker}${label} ` + el.value.substring(cursor);
    el.value = newVal;
    const newCursor = last + marker.length + label.length + 1;
    el.selectionStart = newCursor;
    el.selectionEnd = newCursor;
    el.focus();
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    setShowSessionPicker(false);
    setSessionQuery('');
  }, []);
  const insertSessionRefRef = useRef(insertSessionRef);
  insertSessionRefRef.current = insertSessionRef;

  // ── 发送 ──
  const handleSend = useCallback(() => {
    let text = ref.current?.value.trim() || '';
    const imgs = imagesRef.current;
    if (!text && imgs.length === 0) return;
    // ★ 图像 backend：自动注入 --size 参数
    if (isImageBackendRef.current && imageSizeRef.current && imageSizeRef.current !== '1:1' && text) {
      text = `${text} --size ${imageSizeRef.current}`;
    }
    // ★ 保存到输入历史（Linux 风格 ↑ 追溯）
    pushHistory(text);
    // 序列模式:回车/发送 → 排入队列(不进对话);否则正常发送。
    if (seqModeRef.current && onQueueTaskRef.current) {
      onQueueTaskRef.current(text, imgs.length > 0 ? imgs : undefined);
    } else {
      onSendRef.current(text, imgs.length > 0 ? imgs : undefined);
    }
    if (ref.current) {
      ref.current.value = '';
      ref.current.style.height = 'auto';
      if (seqModeRef.current) ref.current.focus();   // 连续排入,保持焦点
    }
    clearImagesRef.current();
    setShowCommands(false);
  }, []);

  // ── 键盘事件 ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229)
        return;

      // ★ @SESSION: 会话引用选择器键盘导航（优先于文件选择器）
      if (showSessionPickerRef.current) {
        const filtered = sessionRefsRef.current;
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSessionSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSessionSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          const entry = filtered[sessionSelectedIndexRef.current];
          if (entry) insertSessionRefRef.current(entry);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowSessionPicker(false);
          return;
        }
      }

      // ★ @ 文件选择器键盘导航（优先于斜杠命令）
      if (showFilePickerRef.current) {
        const q = fileQueryRef.current.toLowerCase();
        const filtered = fileEntriesRef.current.filter(
          (en) => !q || en.name.toLowerCase().includes(q)
        );
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFileSelectedIndex((prev) => {
            const next = Math.max(0, prev - 1);
            fileSelectedIndexRef.current = next;
            return next;
          });
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFileSelectedIndex((prev) => {
            const next = Math.min(filtered.length - 1, prev + 1);
            fileSelectedIndexRef.current = next;
            return next;
          });
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const entry = filtered[fileSelectedIndexRef.current];
          if (entry) {
            if (entry.isDir) navigateToDirRef.current(entry.path);
            else insertFileRefRef.current(entry.path);
          }
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const entry = filtered[fileSelectedIndexRef.current];
          if (entry) {
            if (entry.isDir) navigateToDirRef.current(entry.path);
            else insertFileRefRef.current(entry.path);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowFilePicker(false);
          return;
        }
      }

      // ★ 命令弹窗打开时的键盘导航
      if (showCommandsRef.current && filteredCommandsRef.current.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = Math.max(0, prev - 1);
            selectedIndexRef.current = next;  // ★ 立即同步 ref，避免后续 Tab/Enter 读到旧值
            return next;
          });
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = Math.min(filteredCommandsRef.current.length - 1, prev + 1);
            selectedIndexRef.current = next;  // ★ 立即同步 ref
            return next;
          });
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          // Tab: 只自动补全，不执行
          const cmd = filteredCommandsRef.current[selectedIndexRef.current];
          if (cmd && ref.current) {
            ref.current.value = cmd.name + ' ';
            setShowCommands(false);
            // 触发 auto-resize
            ref.current.style.height = 'auto';
            ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + 'px';
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowCommands(false);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          // Enter: 补全并执行
          const cmd = filteredCommandsRef.current[selectedIndexRef.current];
          if (cmd && ref.current) {
            ref.current.value = cmd.name;
          }
          setShowCommands(false);
          handleSend();
          return;
        }
      }

      // ★ 输入历史浏览（Linux 风格 ↑↓）
      // 仅在输入框非空且光标在首行（或无多行）时触发，避免干扰多行文本编辑。
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const el = ref.current;
        const cursorPos = el ? (el.selectionStart ?? el.value.length) : 0;
        const text = el?.value ?? '';
        // 只有光标在第一行（之前没有换行符）时才触发历史浏览
        const firstLineEnd = text.indexOf('\n');
        const onFirstLine = firstLineEnd < 0 || cursorPos <= firstLineEnd;

        if (!onFirstLine) {
          // 光标不在第一行，让浏览器默认行为处理光标移动
          return;
        }

        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const hist = historyRef.current;
          if (hist.length === 0) return;
          const curIdx = histIdxRef.current;
          // 第一次按 ↑：保存当前草稿，跳到最新一条
          if (curIdx === -1) {
            draftRef.current = text;
            const newIdx = hist.length - 1;
            setHistIdx(newIdx);
            if (el) { el.value = hist[newIdx]; el.selectionStart = el.selectionEnd = hist[newIdx].length; }
          } else if (curIdx > 0) {
            // 继续往上翻
            const newIdx = curIdx - 1;
            setHistIdx(newIdx);
            if (el) { el.value = hist[newIdx]; el.selectionStart = el.selectionEnd = hist[newIdx].length; }
          }
          // 已在最旧的一条，不再上翻
          return;
        }

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const curIdx = histIdxRef.current;
          if (curIdx === -1) return; // 未在浏览历史，不处理
          const hist = historyRef.current;
          if (curIdx < hist.length - 1) {
            // 往下翻
            const newIdx = curIdx + 1;
            setHistIdx(newIdx);
            if (el) { el.value = hist[newIdx]; el.selectionStart = el.selectionEnd = hist[newIdx].length; }
          } else {
            // 回到草稿 / 清空
            setHistIdx(-1);
            if (el) { el.value = draftRef.current; el.selectionStart = el.selectionEnd = draftRef.current.length; }
          }
          return;
        }
      }

      // ★ Escape 退出历史浏览模式
      if (e.key === 'Escape' && histIdxRef.current !== -1) {
        e.preventDefault();
        setHistIdx(-1);
        const el = ref.current;
        if (el) { el.value = draftRef.current; el.selectionStart = el.selectionEnd = draftRef.current.length; }
        return;
      }

      // 普通 Enter 发送（流式进行中也允许，sendMessage 内部处理中断续发）
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  // ── 输入变化：auto-resize + 斜杠命令检测 + @ 文件选择检测 ──
  const handleInput = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // ★ 用户手动输入时退出历史浏览模式（草稿自动成为新的"当前文本"）
    if (histIdxRef.current !== -1) {
      setHistIdx(-1);
    }

    // auto-resize
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';

    const text = el.value;
    const cursor = el.selectionStart ?? text.length;
    const beforeCursor = text.substring(0, cursor);
    const lastAt = beforeCursor.lastIndexOf('@');

    // ★ @ 文件选择器检测（优先于斜杠命令）
    if (lastAt >= 0) {
      const afterAt = beforeCursor.substring(lastAt + 1);
      if (afterAt.toUpperCase().startsWith('SESSION:') && !afterAt.includes('\n')) {
        const query = afterAt.slice('SESSION:'.length);
        if (!query.includes(' ')) {
          setSessionQuery(query);
          setSessionSelectedIndex(0);
          api.listSessionRefs(query).then((items) => {
            setSessionRefs((items || []).filter((s: any) => s.id !== sessionId));
            setShowSessionPicker(true);
          });
          setShowFilePicker(false);
          setShowCommands(false);
          return;
        }
      }
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        const query = afterAt;
        setFileQuery(query);
        setFileSelectedIndex(0);
        if (!showFilePickerRef.current) {
          // 首次打开：加载工作目录
          setCurrentDir('.');
          const wd = workingDirRef.current || '.';
          api.listDirectory(wd, wd).then((entries) => {
            if (Array.isArray(entries)) {
              setFileEntries(entries);
              setShowFilePicker(true);
            }
          });
        }
        setShowCommands(false);
        return;
      }
    }

    // 没有 @ 触发时，关闭选择器
    if (showSessionPickerRef.current) {
      setShowSessionPicker(false);
      setSessionQuery('');
    }
    if (showFilePickerRef.current) {
      setShowFilePicker(false);
      setFileQuery('');
    }

    // ★ 斜杠命令检测（仅在行首 / 时触发）
    if (text.startsWith('/') && !text.includes(' ') && text.length > 0) {
      const query = text.toLowerCase();
      const matched = SLASH_COMMANDS.filter((cmd) =>
        cmd.name.startsWith(query)
      );
      setFilteredCommands(matched);
      setShowCommands(matched.length > 0);
      setSelectedIndex(0);
    } else {
      setShowCommands(false);
    }
  }, []);

  // ── 点击选择命令 ──
  const handleSelectCommand = useCallback((cmd: SlashCommand) => {
    if (ref.current) {
      ref.current.value = cmd.name;
      ref.current.focus();
    }
    setShowCommands(false);
    handleSend();
  }, [handleSend]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // 滚动选中项到可见区域（斜杠命令）
  useEffect(() => {
    if (showCommands && popupRef.current) {
      const items = popupRef.current.children;
      if (items[selectedIndex]) {
        (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showCommands]);

  // 滚动选中项到可见区域（文件选择器）
  useEffect(() => {
    if (showFilePicker && filePopupRef.current) {
      const items = filePopupRef.current.querySelectorAll<HTMLElement>('[data-file-item]');
      if (items[fileSelectedIndex]) {
        items[fileSelectedIndex].scrollIntoView({ block: 'nearest' });
      }
    }
  }, [fileSelectedIndex, showFilePicker]);

  // ── 文件选择器：过滤当前目录条目 ──
  const filteredEntries = useMemo(() => {
    const q = fileQuery.toLowerCase();
    return fileEntries.filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [fileEntries, fileQuery]);

  // 是否可以返回上级目录
  const parentDir = showFilePicker ? getParentDir(currentDir) : null;

  return (
    <div style={{ padding: '8px 16px 12px', borderTop: isStreaming ? '1px solid rgba(34,197,94,0.4)' : '1px solid var(--theme-border, rgba(0,0,0,0.12))', background: 'var(--theme-bg, #ffffff)', position: 'relative', transition: 'border-top-color 0.2s ease' }}>
      {/* ★ 工具栏：统一的图标按钮 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <ToolbarBtn
          icon="⚡"
          title="跳过确认"
          active={skipPermissions}
          compact={isMobile}
          onClick={() => onSkipPermissionsChange?.(!skipPermissions)}
        />
        <ToolbarBtn
          icon="🧹"
          title="新会话（清空上下文，同目录）"
          compact={isMobile}
          onClick={handleCompact}
        />
        {onToggleSeqMode && (
          <ToolbarBtn
            icon={seqCount > 0 ? `🧬${seqCount}` : '🧬'}
            title={seqMode
              ? '序列模式：开 — 回车把内容排入队列（不直接发送）。再点关闭'
              : '序列模式：开启后回车排入序列队列，可一条条确认或自动连发'}
            active={seqMode}
            compact={isMobile}
            onClick={onToggleSeqMode}
          />
        )}
        {onAdjustFontSize && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 2 }}
            title={`对话字号${fontSize ? ` ${fontSize}px` : ''}（A− / A+ 调整，全局生效）`}>
            <ToolbarBtn icon="A−" title="缩小对话字号" compact={isMobile} onClick={() => onAdjustFontSize(-1)} />
            <ToolbarBtn icon="A+" title="放大对话字号" compact={isMobile} onClick={() => onAdjustFontSize(1)} />
          </div>
        )}
        {/* 截图按钮:桌面端独有,浏览器无法调起系统截图工具 */}
        {isTauri() && (
          <ToolbarBtn
            icon="📷"
            title={screenshotBusy ? "等待截图…(选完区域自动加入附件)" : "截图(系统截图工具)"}
            active={screenshotBusy}
            compact={isMobile}
            onClick={handleScreenshot}
            loading={screenshotBusy}
          />
        )}
        {/* ★ 自动 AI commit 开关（点击循环：关→提交→提交+推送→关） */}
        {onAutoCommitChange && (
          <ToolbarBtn
            icon={`🤖${autoCommit ? (autoCommitPush ? '⇧' : '✓') : ''}`}
            title={autoCommit
              ? `自动提交${autoCommitPush ? '+推送' : ''}：开（点击${autoCommitPush ? '关闭' : '切换到+推送'}）`
              : '自动提交：关（点击开启）'}
            active={autoCommit}
            compact={isMobile}
            onClick={() => {
              if (!autoCommit) {
                onAutoCommitChange(true, false);
              } else if (!autoCommitPush) {
                onAutoCommitChange(true, true);
              } else {
                onAutoCommitChange(false);
              }
            }}
          />
        )}
        {/* ★ 自动 commit 模型选择（多后端时显示） */}
        {autoCommit && onAutoCommitChange && backends.length > 1 && (
          <ToolbarBtn
            icon="⚙️"
            title={`AI 提交模型：${autoCommitBackendId ? (backends.find(b => b.id === autoCommitBackendId)?.label || autoCommitBackendId) : '跟随会话'}（点击切换）`}
            compact={isMobile}
            onClick={() => {
              // 循环：会话主模型 → backend[0] → backend[1] → ... → 会话主模型
              const currentIdx = autoCommitBackendId ? backends.findIndex(b => b.id === autoCommitBackendId) : -1;
              const nextIdx = (currentIdx + 1) % (backends.length + 1);
              const bid = nextIdx < backends.length ? backends[nextIdx].id : '';
              onAutoCommitChange(autoCommit, autoCommitPush, bid);
            }}
          />
        )}
        {/* ★ 流式进度指示器 */}
        {isStreaming && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            fontSize: 11,
            borderRadius: 6,
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.2)',
          }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#22c55e',
              animation: 'chat-pulse 1.5s ease-in-out infinite',
            }} />
            <span style={{ color: '#22c55e', fontWeight: 500 }}>生成中...</span>
          </div>
        )}
        {/* ★ 图像尺寸选择器（仅 DashScope 图像 backend 显示） */}
        {isImageBackend && (
          <div ref={sizePickerRef} style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              onClick={() => setShowSizePicker(v => !v)}
              title="图片尺寸"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', fontSize: 11, borderRadius: 6,
                border: '1px solid var(--theme-border)', cursor: 'pointer',
                background: 'var(--theme-bg-secondary)', color: 'var(--theme-text-muted)',
                transition: 'all 0.15s', whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: 12 }}>{SIZE_PRESETS[imageSize]?.icon || '□'}</span>
              <span>{imageSize}</span>
            </button>
            {showSizePicker && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
                padding: 8, borderRadius: 10,
                background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.2)', zIndex: 200,
                display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200,
              }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', fontWeight: 600, padding: '0 4px' }}>
                  画面比例
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {Object.entries(SIZE_PRESETS).map(([key, { label, icon }]) => (
                    <button
                      key={key}
                      onClick={() => { setImageSize(key); setShowSizePicker(false); }}
                      style={{
                        padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                        border: key === imageSize
                          ? '1px solid var(--theme-accent)'
                          : '1px solid var(--theme-border)',
                        background: key === imageSize
                          ? 'var(--theme-accent-bg)'
                          : 'var(--theme-bg)',
                        color: key === imageSize
                          ? 'var(--theme-accent)'
                          : 'var(--theme-text)',
                        display: 'flex', alignItems: 'center', gap: 4,
                        transition: 'all 0.12s',
                      }}
                    >
                      <span style={{ fontSize: 10, opacity: 0.7 }}>{icon}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <ImagePreview images={images} onRemove={removeImage} />


      {/* ★ @SESSION: 会话引用选择器弹窗 */}
      {showSessionPicker && (
        <div style={filePickerPopupStyle}>
          <div style={filePickerHeaderStyle}>
            <span style={{ opacity: 0.6, fontSize: 10 }}>💬</span>
            <span style={{ flex: 1 }}>引用会话 {sessionQuery ? `· ${sessionQuery}` : ''}</span>
          </div>
          {sessionRefs.length === 0 && (
            <div style={{ padding: '8px 12px', color: 'var(--theme-text-muted)', fontSize: 12 }}>无匹配会话</div>
          )}
          {sessionRefs.map((s: any, i: number) => (
            <div
              key={s.id}
              style={{
                ...fileItemStyle,
                background: i === sessionSelectedIndex ? 'var(--theme-bg-tertiary, #eaeef2)' : 'transparent',
              }}
              onClick={() => insertSessionRefRef.current(s)}
              onMouseEnter={() => setSessionSelectedIndex(i)}
            >
              <span>{s.sessionType === 'loop' ? '🔁' : '💬'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title || s.id}</span>
              <span style={{ fontSize: 10, opacity: 0.55 }}>{String(s.id || '').slice(0, 8)}</span>
            </div>
          ))}
          <div style={filePickerFooterStyle}>
            ↑↓ 导航 · Enter/Tab 引用 · Esc 关闭
          </div>
        </div>
      )}

      {/* ★ @ 文件选择器弹窗 */}
      {showFilePicker && (
        <div ref={filePopupRef} style={filePickerPopupStyle}>
          {/* 当前目录路径 */}
          <div style={filePickerHeaderStyle}>
            <span style={{ opacity: 0.6, fontSize: 10 }}>📁</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
              {currentDir === '.' ? (workingDir || '.').replace(/\\/g, '/').split('/').pop() || '.' : currentDir}
            </span>
          </div>
          {/* 上级目录 */}
          {parentDir && (
            <div
              data-file-item
              style={{ ...fileItemStyle, color: 'var(--theme-text-muted, #656d76)' }}
              onClick={() => navigateToDirRef.current(parentDir)}
              onMouseEnter={() => setFileSelectedIndex(-1)}
            >
              <span>↩</span>
              <span>..</span>
            </div>
          )}
          {filteredEntries.length === 0 && (
            <div style={{ padding: '8px 12px', color: 'var(--theme-text-muted)', fontSize: 12 }}>无匹配文件</div>
          )}
          {filteredEntries.map((entry, i) => (
            <div
              key={entry.path}
              data-file-item
              style={{
                ...fileItemStyle,
                background: i === fileSelectedIndex ? 'var(--theme-bg-tertiary, #eaeef2)' : 'transparent',
              }}
              onClick={() => entry.isDir ? navigateToDirRef.current(entry.path) : insertFileRefRef.current(entry.path)}
              onMouseEnter={() => setFileSelectedIndex(i)}
            >
              <span>{entry.isDir ? '📁' : '📄'}</span>
              <span style={{ flex: 1 }}>{entry.name}</span>
              {entry.isDir && <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>}
            </div>
          ))}
          <div style={filePickerFooterStyle}>
            ↑↓ 导航 · Enter/Tab 进入/选择 · Esc 关闭
          </div>
        </div>
      )}

      {/* ★ 斜杠命令弹窗 */}
      {showCommands && filteredCommands.length > 0 && (
        <div ref={popupRef} style={commandPopupStyle}>
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.name}
              style={{
                ...commandItemStyle,
                background: i === selectedIndex ? 'var(--theme-bg-tertiary, #eaeef2)' : 'transparent',
              }}
              onClick={() => handleSelectCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--theme-accent, #0969da)', minWidth: 120, display: 'inline-block' }}>
                {cmd.name}
              </span>
              <span style={{ color: 'var(--theme-text-muted, #656d76)', fontSize: 12 }}>
                {cmd.description}
              </span>
            </div>
          ))}
          <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--theme-text-muted, #656d76)', borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.08))' }}>
            ↑↓ 导航 · Tab 补全 · Enter 执行 · Esc 关闭
          </div>
        </div>
      )}

      <style>{`
        @keyframes seqGlow {
          0%,100% { box-shadow: 0 0 0 1.5px #7aa2f7, 0 0 8px 1px rgba(122,162,247,0.45); }
          50%     { box-shadow: 0 0 0 1.5px #22d3ee, 0 0 16px 3px rgba(34,211,238,0.75); }
        }
        .seq-neon { border-radius: 12px; animation: seqGlow 1.8s ease-in-out infinite; }
      `}</style>
      <div
        className={seqMode ? 'seq-neon' : undefined}
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', ...(seqMode ? { padding: 6 } : {}) }}
      >
        <textarea
          ref={ref}
          className="chat-textarea"
          placeholder={seqMode
            ? `🧬 序列模式：回车排入队列（不直接发送）${seqCount ? ` · 已 ${seqCount} 条` : ''}`
            : isStreaming ? '输入并按 Enter 可中断当前响应并续发…' : '输入消息… 输入 / 查看命令 · @ 引用文件 · Ctrl+V 粘贴图片'}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleInput}
          style={{ ...textareaStyle, ...(isStreaming ? { opacity: 0.75 } : {}) }}
          rows={1}
        />
        {isStreaming ? (
          <button onClick={onAbort} style={abortBtnStyle} title="Stop">■</button>
        ) : (
          <button onClick={handleSend} style={sendBtnStyle} title={seqMode ? '排入序列队列' : 'Send (Enter)'}>{seqMode ? '＋' : '🚀'}</button>
        )}
        <button
          onClick={toggleMic}
          style={micActive ? micRecordingStyle : micBtnStyle}
          title={micActive ? '停止语音输入' : '语音输入'}
        >
          🎙️
        </button>
      </div>

      {/* 新会话确认对话框（风格与 Sidebar 删除会话保持一致） */}
      {showNewSessionConfirm && (
        <div style={confirmOverlayStyle} onClick={() => setShowNewSessionConfirm(false)}>
          <div
            style={{ ...confirmPanelStyle, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>
              开启新会话
            </h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              当前会话的上下文将被清空，Claude 不再记得之前的对话内容。
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0' }}>
              历史消息仍保留在侧边栏，可随时回看。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmNewSession} style={confirmBtnStyle}>
                开始
              </button>
              <button onClick={() => setShowNewSessionConfirm(false)} style={cancelBtnStyle}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export const ChatInput = memo(ChatInputInner);

// ═══════════════════════════════════════
//  样式
// ═══════════════════════════════════════

const textareaStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 10,
  color: 'var(--theme-text, #1f2328)',
  padding: '10px 14px',
  fontSize: 14,
  lineHeight: 1.5,
  resize: 'none',
  outline: 'none',
  fontFamily: 'inherit',
  maxHeight: 200,
  overflow: 'auto',
};

const btnBase: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: '50%',
  border: 'none',
  color: '#fff',
  fontSize: 18,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const sendBtnStyle: React.CSSProperties = { ...btnBase, background: 'var(--theme-accent, #0969da)' };
const abortBtnStyle: React.CSSProperties = { ...btnBase, background: 'var(--theme-error, #cf222e)', fontSize: 14 };
const micBtnStyle: React.CSSProperties = {
  ...btnBase,
  background: 'var(--theme-bg-tertiary, #eaeef2)',
  fontSize: 16,
  padding: '0 8px',
};

const micRecordingStyle: React.CSSProperties = {
  ...btnBase,
  background: '#f85149',
  color: '#fff',
  fontSize: 16,
  padding: '0 8px',
  animation: 'mic-pulse 1.5s ease-in-out infinite',
};

const commandPopupStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 16,
  right: 16,
  marginBottom: 4,
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 10,
  maxHeight: 280,
  overflowY: 'auto',
  zIndex: 100,
  boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
  backdropFilter: 'blur(12px)',
};

const commandItemStyle: React.CSSProperties = {
  padding: '8px 12px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  transition: 'background 0.1s',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
};

const filePickerPopupStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 16,
  right: 16,
  marginBottom: 4,
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 10,
  overflow: 'hidden',
  maxHeight: 300,
  overflowY: 'auto',
  zIndex: 100,
  boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
  backdropFilter: 'blur(12px)',
};

const filePickerHeaderStyle: React.CSSProperties = {
  padding: '6px 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: 'var(--theme-text-muted, #656d76)',
  background: 'var(--theme-bg-tertiary, #eaeef2)',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
  userSelect: 'none' as const,
};

const fileItemStyle: React.CSSProperties = {
  padding: '7px 12px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  transition: 'background 0.1s',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.05))',
  color: 'var(--theme-text, #1f2328)',
};

const filePickerFooterStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 10,
  color: 'var(--theme-text-muted, #656d76)',
  borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
  userSelect: 'none' as const,
};

// ── 确认对话框样式（与 Sidebar 删除会话保持一致）────────────────────────────
const confirmOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const confirmPanelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 12,
  padding: 24, width: '90%', maxWidth: 400,
  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
};

const confirmBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'var(--theme-accent, #0969da)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'var(--theme-bg-secondary, #f6f8fa)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)', fontSize: 14, cursor: 'pointer',
};