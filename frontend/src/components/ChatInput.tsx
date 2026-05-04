import React, { useRef, useCallback, useEffect, memo, useState, useMemo } from 'react';
import { ImagePreview } from './ImagePreview';
import { useClipboardImage } from '../hooks/useClipboardImage';
import type { ImageAttachment } from '../hooks/useClipboardImage';
import { SLASH_COMMANDS } from '../hooks/useChat';
import type { SlashCommand } from '../hooks/useChat';
import { api } from '../api';

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
  sandboxEnabled?: boolean;
  onSandboxChange?: (enabled: boolean) => void;
  onCompact?: () => void;
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
}

const ToolbarBtn: React.FC<ToolbarBtnProps> = ({ icon, title, active, onClick, loading }) => {
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
        gap: 4,
        padding: '4px 8px',
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
      <span style={{ fontSize: 12 }}>{icon}</span>
      <span>{title}</span>
    </button>
  );
};

const ChatInputInner: React.FC<Props> = ({
  onSend, onAbort, isStreaming, backends, activeBackendId, sessionId, workingDir,
  skipPermissions = true, onSkipPermissionsChange,
  sandboxEnabled = true, onSandboxChange,
  onCompact,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage();

  // ── 稳定 refs ──
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const clearImagesRef = useRef(clearImages);
  clearImagesRef.current = clearImages;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const composingRef = useRef(false);

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

  const float32ToB64 = useCallback((floats: Float32Array): string => {
    const pcm = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
    }
    return btoa(binary);
  }, []);

  const micStop = useCallback(async () => {
    if (micStoppedRef.current) return;
    micStoppedRef.current = true;
    micUnsubRef.current?.();
    micUnsubRef.current = null;
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
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (micStoppedRef.current) return;
        api.sttStreamAudio(float32ToB64(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      processor.connect(gain);
      gain.connect(audioCtx.destination);

      setMicActive(true);
    } catch (e: any) {
      console.error('[mic]', e);
      setMicActive(false);
    }
  }, [float32ToB64]);

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

  // ── 发送 ──
  const handleSend = useCallback(() => {
    let text = ref.current?.value.trim() || '';
    const imgs = imagesRef.current;
    if (!text && imgs.length === 0) return;
    // ★ 图像 backend：自动注入 --size 参数
    if (isImageBackendRef.current && imageSizeRef.current && imageSizeRef.current !== '1:1' && text) {
      text = `${text} --size ${imageSizeRef.current}`;
    }
    onSendRef.current(text, imgs.length > 0 ? imgs : undefined);
    if (ref.current) {
      ref.current.value = '';
      ref.current.style.height = 'auto';
    }
    clearImagesRef.current();
    setShowCommands(false);
  }, []);

  // ── 键盘事件 ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229)
        return;

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

    // 没有 @ 触发时，关闭文件选择器
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
          onClick={() => onSkipPermissionsChange?.(!skipPermissions)}
        />
        <ToolbarBtn
          icon="🔒"
          title={sandboxEnabled ? "沙盒模式（已启用）— 文件操作限制在工作目录内" : "沙盒模式（已关闭）— 无路径限制"}
          active={sandboxEnabled}
          onClick={() => onSandboxChange?.(!sandboxEnabled)}
        />
        <ToolbarBtn
          icon="✨"
          title="新会话（清空上下文，同目录）"
          onClick={handleCompact}
        />
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

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={ref}
          className="chat-textarea"
          placeholder={isStreaming ? '输入并按 Enter 可中断当前响应并续发…' : '输入消息… 输入 / 查看命令 · @ 引用文件 · Ctrl+V 粘贴图片'}
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
          <button onClick={handleSend} style={sendBtnStyle} title="Send (Enter)">🚀</button>
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