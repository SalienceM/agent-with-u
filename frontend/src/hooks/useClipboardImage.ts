import { useState, useCallback, useEffect } from 'react';
import { api } from '../api';

export interface ImageAttachment {
  id: string;
  base64: string;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
}

export function useClipboardImage() {
  const [images, setImages] = useState<ImageAttachment[]>([]);

  const readFromClipboard = useCallback(async () => {
    const img = await api.readClipboardImage();
    if (img) {
      setImages((prev) => [...prev, img]);
      return img;
    }
    return null;
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const clearImages = useCallback(() => setImages([]), []);

  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      // File paste (drag-drop)
      if (e.clipboardData?.files?.length) {
        const file = e.clipboardData.files[0];
        if (file.type.startsWith('image/')) {
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = () => {
            const b64 = (reader.result as string).split(',')[1];
            setImages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                base64: b64,
                mime_type: file.type,
                size: file.size,
              },
            ]);
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
  }, [readFromClipboard]);

  return { images, removeImage, clearImages, readFromClipboard };
}
