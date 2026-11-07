import { useLayoutEffect, useState } from 'react';

/** 观察实际宿主，不把桌面窗口宽度当成窄分栏宽度。 */
export function usePreviewSize<T extends HTMLElement>() {
  const [element, ref] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setSize(old => old.width === next.width && old.height === next.height ? old : next);
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, ...size };
}

export function usePreviewViewport(active: boolean) {
  const read = () => {
    const v = window.visualViewport;
    return { width: v?.width ?? window.innerWidth, height: v?.height ?? window.innerHeight,
      left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, narrow: window.innerWidth <= 640 };
  };
  const [viewport, setViewport] = useState(read);
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => setViewport(read());
    update(); window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => { window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update); };
  }, [active]);
  return viewport;
}
