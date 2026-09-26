import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppModalPortal, AppModalVisibilityContext } from './AppModalPortal';
import { constrainImageView, fitImageScale, imageScaleLimits, wheelImageScale, zoomImageAt,
  type ImagePoint, type ImageSize, type ImageView } from '../utils/imageViewport';

interface Props { src: string; onClose: () => void }
const emptySize: ImageSize = { width: 0, height: 0 };
const initialView: ImageView = { scale: 1, x: 0, y: 0 };

function visibleViewport() {
  const viewport = window.visualViewport;
  return { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0,
    width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight };
}

/** Portal 脱离消息动画/输入栏裁剪；保活但隐藏的 Session 不得留下全局弹窗或键盘监听。 */
export const ImageLightbox: React.FC<Props> = (props) => {
  const visible = useContext(AppModalVisibilityContext);
  return visible ? <AppModalPortal><ImageViewer key={props.src} {...props} /></AppModalPortal> : null;
};

const ImageViewer: React.FC<Props> = ({ src, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef(emptySize);
  const viewportRef = useRef(emptySize);
  const viewRef = useRef(initialView);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const autoFitRef = useRef(true);
  const pointers = useRef(new Map<number, ImagePoint>());
  const gesture = useRef({ moved: false, dismiss: false, start: { x: 0, y: 0 } });
  const [bounds, setBounds] = useState(visibleViewport);
  const [size, setSize] = useState(emptySize);
  const [view, setView] = useState(initialView);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [dragging, setDragging] = useState(false);

  const updateView = useCallback((next: ImageView) => {
    viewRef.current = next;
    setView(next);
  }, []);
  const fit = useCallback(() => {
    autoFitRef.current = true;
    updateView({ scale: fitImageScale(imageRef.current, viewportRef.current), x: 0, y: 0 });
  }, [updateView]);
  const zoom = useCallback((scale: number, anchor?: ImagePoint, nextAnchor?: ImagePoint) => {
    if (!imageRef.current.width) return;
    autoFitRef.current = false;
    updateView(zoomImageAt(viewRef.current, imageRef.current, viewportRef.current, scale, anchor, nextAnchor));
  }, [updateView]);
  const actualSize = useCallback(() => {
    autoFitRef.current = false;
    updateView({ scale: 1, x: 0, y: 0 });
  }, [updateView]);
  const pan = useCallback((x: number, y: number) => {
    autoFitRef.current = false;
    updateView(constrainImageView({ ...viewRef.current, x, y }, imageRef.current, viewportRef.current));
  }, [updateView]);
  const pointAt = useCallback((clientX: number, clientY: number): ImagePoint => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  useLayoutEffect(() => {
    const update = () => setBounds(visibleViewport());
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    const measure = () => {
      const rect = stageRef.current!.getBoundingClientRect();
      viewportRef.current = { width: rect.width, height: rect.height };
      pointers.current.clear();
      setDragging(false);
      if (autoFitRef.current) fit();
      else updateView(constrainImageView(viewRef.current, imageRef.current, viewportRef.current));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stageRef.current!);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [fit, updateView]);

  useEffect(() => {
    const overlay = overlayRef.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    overlay.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (!overlay.contains(document.activeElement)) return;
      if (event.key === 'Tab') {
        const buttons = [...overlay.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[index < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!['Escape', '+', '=', '-', '0', '1', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') onCloseRef.current();
      else if (!imageRef.current.width) return;
      else if (event.key === '0') fit();
      else if (event.key === '1') actualSize();
      else if (event.key === '+' || event.key === '=') zoom(viewRef.current.scale * 1.2);
      else if (event.key === '-') zoom(viewRef.current.scale / 1.2);
      else pan(viewRef.current.x + (event.key === 'ArrowLeft' ? 80 : event.key === 'ArrowRight' ? -80 : 0),
        viewRef.current.y + (event.key === 'ArrowUp' ? 80 : event.key === 'ArrowDown' ? -80 : 0));
    };
    // 原生非 passive 监听拦截页面滚动/浏览器 Ctrl+滚轮缩放，只变换这张图。
    const onWheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (!stageRef.current?.contains(event.target as Node)) return;
      zoom(wheelImageScale(viewRef.current.scale, event.deltaY, event.deltaMode, viewportRef.current.height), pointAt(event.clientX, event.clientY));
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.removeEventListener('wheel', onWheel);
      if (previousFocus?.isConnected && (overlay.contains(document.activeElement) || document.activeElement === document.body)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [actualSize, fit, pan, pointAt, zoom]);

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = pointAt(event.clientX, event.clientY);
    if (!pointers.current.size) gesture.current = { moved: false, dismiss: event.target === event.currentTarget, start: point };
    else gesture.current.moved = true;
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const before = [...pointers.current.values()];
    const point = pointAt(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    if (Math.hypot(point.x - gesture.current.start.x, point.y - gesture.current.start.y) > 3) gesture.current.moved = true;
    if (before.length >= 2) {
      const after = [...pointers.current.values()];
      const center = (points: ImagePoint[]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
      const distance = (points: ImagePoint[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (distance(before) > 1) zoom(viewRef.current.scale * distance(after) / distance(before), center(before), center(after));
    } else if (gesture.current.moved && imageRef.current.width) {
      pan(viewRef.current.x + point.x - previous.x, viewRef.current.y + point.y - previous.y);
    }
  };
  const pointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!pointers.current.size) {
      setDragging(false);
      if (event.type === 'pointerup' && gesture.current.dismiss && !gesture.current.moved) onCloseRef.current();
    }
  };
  const limits = imageScaleLimits(size, viewportRef.current);

  return (
    <div ref={overlayRef} role="dialog" aria-modal="true" aria-label="图片预览" tabIndex={-1}
      style={{ position: 'fixed', ...bounds, zIndex: 50000, background: 'rgba(8,12,18,.94)',
        color: '#fff', outline: 'none', overflow: 'hidden', touchAction: 'none', overscrollBehavior: 'contain' }}>
      <div ref={stageRef} data-testid="image-preview-stage"
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}
        onDoubleClick={() => { if (size.width) { if (autoFitRef.current) actualSize(); else fit(); } }}
        style={{ position: 'absolute', inset: '64px 12px', overflow: 'hidden', touchAction: 'none',
          userSelect: 'none', cursor: dragging ? 'grabbing' : size.width ? 'grab' : 'default' }}>
        <img key={retry} src={src} alt="预览原图" draggable={false} onDragStart={event => event.preventDefault()}
          onLoad={event => {
            const image = event.currentTarget;
            imageRef.current = { width: image.naturalWidth, height: image.naturalHeight };
            setSize(imageRef.current); setError(false); fit();
          }}
          onError={() => { imageRef.current = emptySize; setSize(emptySize); setError(true); }}
          style={{ position: 'absolute', left: '50%', top: '50%', width: size.width, height: size.height,
            maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, border: 0, borderRadius: 0,
            visibility: size.width && !error ? 'visible' : 'hidden', pointerEvents: 'auto',
            transformOrigin: 'center', transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
        {!size.width && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          {error ? <div role="alert" style={{ textAlign: 'center', pointerEvents: 'auto' }}>图片加载失败
            <button type="button" style={{ ...buttonStyle, marginLeft: 10 }} onPointerDown={event => event.stopPropagation()}
              onClick={() => { overlayRef.current?.focus({ preventScroll: true }); setError(false); setRetry(value => value + 1); }}>重试</button>
          </div> : <span role="status">正在加载图片…</span>}
        </div>}
      </div>
      <div role="toolbar" aria-label="图片缩放工具" style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 4, padding: 6, maxWidth: 'calc(100% - 16px)', boxSizing: 'border-box',
        border: '1px solid rgba(255,255,255,.2)', borderRadius: 10, background: '#18202b' }}>
        <button type="button" aria-label="缩小图片" title="缩小（−）" style={buttonStyle}
          disabled={!size.width || view.scale <= limits.min} onClick={() => zoom(viewRef.current.scale / 1.2)}>−</button>
        <output aria-label="图片缩放比例" style={{ width: 56, textAlign: 'center', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {size.width ? `${Number((view.scale * 100).toFixed(1))}%` : '—'}
        </output>
        <button type="button" aria-label="放大图片" title="放大（+）" style={buttonStyle}
          disabled={!size.width || view.scale >= limits.max} onClick={() => zoom(viewRef.current.scale * 1.2)}>＋</button>
        <button type="button" aria-label="适应窗口" title="完整显示并居中（0 / 双击）" style={buttonStyle} disabled={!size.width} onClick={fit}>适应</button>
        <button type="button" aria-label="原始尺寸" title="原始尺寸（1）" style={buttonStyle} disabled={!size.width} onClick={actualSize}>1:1</button>
        <button type="button" aria-label="关闭图片预览" title="关闭（Esc）" style={buttonStyle} onClick={onClose}>×</button>
      </div>
      <div style={{ position: 'absolute', bottom: 14, left: 12, right: 12, textAlign: 'center', fontSize: 12, lineHeight: 1.6, color: '#c1cad5', pointerEvents: 'none' }}>
        {size.width > 0 && <span>{size.width} × {size.height} · </span>}滚轮 / 双指缩放 · 拖动查看 · 双击切换适应 / 原图
      </div>
    </div>
  );
};

const buttonStyle: React.CSSProperties = {
  minWidth: 32, height: 32, padding: '0 7px', flexShrink: 0, borderRadius: 5,
  border: '1px solid rgba(255,255,255,.24)', background: '#263241', color: '#fff',
  font: 'inherit', fontSize: 13, cursor: 'pointer',
};
