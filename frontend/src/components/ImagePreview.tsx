import React from 'react';
import type { ImageAttachment } from '../hooks/useClipboardImage';

interface Props {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}

export const ImagePreview: React.FC<Props> = ({ images, onRemove }) => {
  if (images.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
      {images.map((img) => (
        <div key={img.id} style={thumbStyle}>
          <img
            src={`data:${img.mime_type};base64,${img.base64}`}
            alt="Pasted"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <button onClick={() => onRemove(img.id)} style={removeBtnStyle} title="Remove">×</button>
          <span style={labelStyle}>
            {img.width && img.height ? `${img.width}×${img.height}` : `${(img.size / 1024).toFixed(0)}KB`}
          </span>
        </div>
      ))}
    </div>
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
};
const labelStyle: React.CSSProperties = {
  position: 'absolute', bottom: 2, left: 2, fontSize: 10, color: '#fff',
  background: 'rgba(0,0,0,0.5)', padding: '1px 4px', borderRadius: 4,
};
