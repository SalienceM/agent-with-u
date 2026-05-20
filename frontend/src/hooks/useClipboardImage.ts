import { useState, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { api } from '../api';
import { uuid } from '../utils/uuid';

export interface ImageAttachment {
  id: string;
  base64: string;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
}

/**
 * 监听 document 粘贴事件,把图片塞进待发送列表。
 *
 * @param scopeRef  可选:把生效范围限制在这个元素(及其子元素)拥有焦点时。
 *                  多 pane 场景下每个 ChatInput 把自己 textarea 的 ref 传进来,
 *                  这样只有当前聚焦 pane 的 useClipboardImage 会处理粘贴,
 *                  否则所有 pane 都会同时吃到这张图。
 */
export function useClipboardImage(scopeRef?: RefObject<HTMLElement | null>) {
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // 新增一张图片：既加入待发送列表，又异步存入素材中转池。
  // 入池失败不影响聊天发送。
  const addImage = useCallback((img: ImageAttachment) => {
    setImages((prev) => [...prev, img]);
    api.assetPush({
      base64: img.base64,
      mime: img.mime_type,
      source: 'clipboard',
    }).catch(() => {});
  }, []);

  const readFromClipboard = useCallback(async () => {
    const img = await api.readClipboardImage();
    if (img) {
      addImage(img);
      return img;
    }
    return null;
  }, [addImage]);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const clearImages = useCallback(() => setImages([]), []);

  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      // ★ 多 pane 场景下用 scopeRef 限制生效范围:只有当前聚焦的 textarea
      //    对应的 hook 处理粘贴,其它 pane 一律放行。否则一次粘贴会让所有
      //    pane 都拿到同一张图。
      if (scopeRef) {
        const el = scopeRef.current;
        const active = document.activeElement;
        if (!el || !active || !(el === active || el.contains(active))) {
          return;
        }
      }
      // ★ HTML paste with embedded base64 images（e.g. from ScratchPad copy-all）
      const html = e.clipboardData?.getData('text/html');
      if (html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const b64Imgs = Array.from(doc.querySelectorAll('img')).filter(
          (img) => img.src.startsWith('data:image'),
        );
        if (b64Imgs.length > 0) {
          e.preventDefault();
          // 提取纯文本注入到当前聚焦的 textarea
          const text = doc.body.textContent?.replace(/\s+/g, ' ').trim() || '';
          const activeEl = document.activeElement as HTMLTextAreaElement | null;
          if (text && activeEl?.tagName === 'TEXTAREA') {
            const start = activeEl.selectionStart ?? activeEl.value.length;
            const end   = activeEl.selectionEnd   ?? activeEl.value.length;
            const next  = activeEl.value.slice(0, start) + text + activeEl.value.slice(end);
            // 触发 React 受控组件的 onChange
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value',
            )?.set;
            setter?.call(activeEl, next);
            activeEl.dispatchEvent(new Event('input', { bubbles: true }));
            activeEl.setSelectionRange(start + text.length, start + text.length);
          }
          // 逐一提取图片
          for (const img of b64Imgs) {
            const m = img.src.match(/^data:(image\/[\w+]+);base64,(.+)/);
            if (m) {
              addImage({
                id: uuid(),
                base64: m[2],
                mime_type: m[1],
                size: Math.ceil(m[2].length * 0.75),
              });
            }
          }
          return;
        }
      }

      // File paste (drag-drop)
      if (e.clipboardData?.files?.length) {
        const file = e.clipboardData.files[0];
        if (file.type.startsWith('image/')) {
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = () => {
            const b64 = (reader.result as string).split(',')[1];
            addImage({
              id: uuid(),
              base64: b64,
              mime_type: file.type,
              size: file.size,
            });
          };
          reader.readAsDataURL(file);
          return;
        }
      }
      // Snipaste-style clipboard image (no text)
      if (!e.clipboardData?.getData('text/plain')) {
        e.preventDefault();
        await readFromClipboard();
      }
    };
    document.addEventListener('paste', handler);
    return () => document.removeEventListener('paste', handler);
  }, [readFromClipboard, addImage, scopeRef]);

  return { images, removeImage, clearImages, readFromClipboard };
}
