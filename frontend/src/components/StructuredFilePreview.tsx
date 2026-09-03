import React, { useMemo, useState } from 'react';
import ExcelPreview, { type ExcelCellStyle, type ExcelSheet } from './ExcelPreview';

export interface StructuredPreviewPayload {
  status: 'ok' | 'error' | 'unsupported';
  kind?: 'word' | 'excel' | 'powerpoint' | 'drawio' | 'legacy-office';
  message?: string;
  truncated?: boolean;
  blocks?: Array<{ type: 'paragraph' | 'table'; text?: string; style?: string; rows?: string[][] }>;
  images?: Array<{ name: string; dataUrl: string }>;
  sheets?: ExcelSheet[];
  styles?: ExcelCellStyle[];
  calculation?: { mode?: string; date1904?: boolean };
  slides?: Array<{
    number: number; title: string; texts: string[];
    images: Array<{ name: string; dataUrl: string }>;
  }>;
  pages?: Array<{ name: string; svg: string }>;
}

interface Props {
  preview: StructuredPreviewPayload;
  onReveal?: () => void;
}

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 13 }}>{text}</div>
);

export const StructuredFilePreview: React.FC<Props> = ({ preview, onReveal }) => {
  const [active, setActive] = useState(0);
  const pages = preview.kind === 'drawio' ? preview.pages : undefined;
  const safeActive = Math.min(active, Math.max(0, (pages?.length || 1) - 1));
  const drawioUrl = useMemo(() => {
    const svg = preview.kind === 'drawio' ? preview.pages?.[safeActive]?.svg : '';
    return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : '';
  }, [preview, safeActive]);

  if (preview.status !== 'ok') {
    return (
      <div style={{ padding: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 30 }}>{preview.kind === 'legacy-office' ? '📦' : '⚠️'}</div>
        <div style={{ maxWidth: 620, textAlign: 'center', color: 'var(--theme-text-muted)', lineHeight: 1.7, fontSize: 13 }}>
          {preview.message || '无法预览此文件'}
        </div>
        {onReveal && <button style={actionStyle} onClick={onReveal}>📂 在文件夹中显示</button>}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {pages && pages.length > 1 && (
        <div style={tabBarStyle}>
          {pages.map((page, index) => (
            <button key={`${page.name}-${index}`} style={{ ...tabStyle, ...(safeActive === index ? activeTabStyle : {}) }} onClick={() => setActive(index)}>
              {page.name}
            </button>
          ))}
        </div>
      )}

      <div style={{
        flex: 1, minHeight: 0,
        overflow: preview.kind === 'excel' ? 'hidden' : 'auto',
        padding: preview.kind === 'excel' ? 0 : preview.kind === 'drawio' ? 10 : 18,
      }}>
        {preview.kind === 'word' && (
          <div style={paperStyle}>
            {(preview.blocks || []).map((block, index) => block.type === 'table' ? (
              <div key={index} style={{ overflowX: 'auto', margin: '12px 0' }}>
                <table style={tableStyle}><tbody>
                  {(block.rows || []).map((row, rowIndex) => (
                    <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={cellStyle}>{cell}</td>)}</tr>
                  ))}
                </tbody></table>
              </div>
            ) : (
              <div key={index} style={wordParagraphStyle(block.style || '')}>{block.text}</div>
            ))}
            {(preview.blocks || []).length === 0 && <Empty text="文档没有可提取的正文" />}
            {(preview.images || []).length > 0 && (
              <div style={mediaGridStyle}>{preview.images!.map((image) => (
                <img key={image.name} src={image.dataUrl} alt={image.name} title={image.name} style={mediaImageStyle} />
              ))}</div>
            )}
          </div>
        )}

        {preview.kind === 'excel' && (
          (preview.sheets || []).length
            ? <ExcelPreview sheets={preview.sheets!} styles={preview.styles} calculation={preview.calculation} />
            : <Empty text="工作簿没有可显示的数据" />
        )}

        {preview.kind === 'powerpoint' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 18 }}>
            {(preview.slides || []).map((slide) => (
              <section key={slide.number} style={slideStyle}>
                <span style={slideNumberStyle}>{slide.number}</span>
                <h3 style={{ margin: '0 0 12px', fontSize: 18, color: 'var(--theme-text)' }}>{slide.title}</h3>
                {slide.texts.slice(1).map((text, index) => <p key={index} style={{ margin: '5px 0', lineHeight: 1.55 }}>{text}</p>)}
                {slide.images.length > 0 && <div style={mediaGridStyle}>{slide.images.map((image) => (
                  <img key={image.name} src={image.dataUrl} alt={image.name} style={mediaImageStyle} />
                ))}</div>}
              </section>
            ))}
            {(preview.slides || []).length === 0 && <Empty text="演示文稿没有可提取的幻灯片" />}
          </div>
        )}

        {preview.kind === 'drawio' && (drawioUrl ? (
          <div style={{ minWidth: '100%', minHeight: '100%', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', background: '#e5e7eb', borderRadius: 8 }}>
            <img src={drawioUrl} alt={preview.pages?.[safeActive]?.name || 'Draw.io'} style={{ maxWidth: 'none', padding: 18 }} />
          </div>
        ) : <Empty text="图表中没有可渲染的页面" />)}
      </div>

      {preview.truncated && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid var(--theme-border)', color: '#d29922', fontSize: 11 }}>
          为保证响应速度，超大文档仅展示部分内容；原文件没有被修改。
        </div>
      )}
    </div>
  );
};

function wordParagraphStyle(style: string): React.CSSProperties {
  const heading = /heading\s*([1-6])/i.exec(style);
  if (heading) return { fontSize: 26 - Number(heading[1]) * 2, fontWeight: 700, margin: '18px 0 8px', lineHeight: 1.3 };
  return { margin: '8px 0', lineHeight: 1.75, whiteSpace: 'pre-wrap' };
}

const actionStyle: React.CSSProperties = { border: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)', borderRadius: 7, padding: '7px 12px', cursor: 'pointer' };
const tabBarStyle: React.CSSProperties = { display: 'flex', gap: 3, overflowX: 'auto', padding: '7px 10px', borderBottom: '1px solid var(--theme-border)', flexShrink: 0 };
const tabStyle: React.CSSProperties = { border: 'none', borderRadius: 5, padding: '5px 10px', whiteSpace: 'nowrap', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 11 };
const activeTabStyle: React.CSSProperties = { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', fontWeight: 700 };
const paperStyle: React.CSSProperties = { maxWidth: 850, minHeight: 600, margin: '0 auto', padding: '38px 48px', color: '#202124', background: '#fff', boxShadow: '0 3px 18px rgba(0,0,0,.22)', fontFamily: 'system-ui, sans-serif' };
const tableStyle: React.CSSProperties = { borderCollapse: 'collapse', fontSize: 12 };
const cellStyle: React.CSSProperties = { border: '1px solid #cbd5e1', padding: '6px 8px', verticalAlign: 'top', whiteSpace: 'pre-wrap' };
const mediaGridStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 };
const mediaImageStyle: React.CSSProperties = { maxWidth: 280, maxHeight: 190, objectFit: 'contain', border: '1px solid rgba(0,0,0,.16)', borderRadius: 4, background: '#fff' };
const slideStyle: React.CSSProperties = { position: 'relative', aspectRatio: '16 / 9', overflow: 'auto', padding: '28px 34px', background: '#fff', color: '#1f2937', borderRadius: 7, boxShadow: '0 3px 14px rgba(0,0,0,.24)' };
const slideNumberStyle: React.CSSProperties = { position: 'absolute', right: 10, bottom: 7, color: '#94a3b8', fontSize: 10 };

export default StructuredFilePreview;
