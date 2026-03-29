import React, { useState } from 'react';
import type { ImageAttachment } from '../hooks/useClipboardImage';

interface Props {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}

export const ImagePreview: React.FC<Props> = ({ images, onRemove }) => {
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Esc 键关闭预览
  React.useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && previewImage) {
        setPreviewImage(null);
      }
    };
    if (previewImage) {
      window.addEventListener('keydown', handleEsc);
    }
    return () => {
      window.removeEventListener('keydown', handleEsc);
    };
  }, [previewImage]);

  if (images.length === 0) return null;
  return (
    <>
      <div style={{ display: 'flex', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
        {images.map((img) => {
          const src = `data:${img.mime_type};base64,${img.base64}`;
          return (
            <div
              key={img.id}
              style={{
                ...thumbStyle,
                cursor: 'zoom-in',
                transition: 'transform 0.15s',
              }}
              onClick={() => setPreviewImage(src)}
              title="点击放大"
            >
              <img
                src={src}
                alt="Pasted"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(img.id);
                }}
                style={removeBtnStyle}
                title="Remove"
              >
                ×
              </button>
              <span style={labelStyle}>
                {img.width && img.height ? `${img.width}×${img.height}` : `${(img.size / 1024).toFixed(0)}KB`}
              </span>
            </div>
          );
        })}
      </div>

      {/* 放大预览 */}
      {previewImage && (
        <div
          style={previewOverlayStyle}
          onClick={() => setPreviewImage(null)}
        >
          <div
            style={previewContentStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewImage}
              alt="Preview"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          </div>
          <button
            onClick={() => setPreviewImage(null)}
            style={previewCloseBtnStyle}
            title="关闭 (Esc)"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

const thumbStyle: React.CSSProperties = {
  position: 'relative', width: 80, height: 80, borderRadius: 8,
  overflow: 'hidden', border: '1px solid rgba(255,255,255,0.15)', flexShrink: 0,
};
const removeBtnStyle: React.CSSProperties = {
  position: 'absolute', top: 2, right: 2, width: 20, height: 20,
  borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.6)',
  color: '#fff', fontSize: 14, cursor: 'pointer', display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 0,
  zIndex: 1,
};
const labelStyle: React.CSSProperties = {
  position: 'absolute', bottom: 2, left: 2, fontSize: 10, color: '#fff',
  background: 'rgba(0,0,0,0.5)', padding: '1px 4px', borderRadius: 4,
  zIndex: 1,
};

const previewOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.85)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  cursor: 'zoom-out',
};

const previewContentStyle: React.CSSProperties = {
  padding: 20,
  maxWidth: '95vw',
  maxHeight: '95vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const previewCloseBtnStyle: React.CSSProperties = {
  position: 'absolute',
  top: 20,
  right: 20,
  width: 40,
  height: 40,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(255,255,255,0.2)',
  color: '#fff',
  fontSize: 24,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 0.15s',
};
