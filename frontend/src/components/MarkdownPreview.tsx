import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  markdownHtmlWithOutline,
  markdownToHtml,
  type MarkdownOutlineItem,
} from '../utils/markdown';

type ReaderTheme = 'light' | 'dark';

interface Props {
  source: string;
  title?: string;
  initialDark?: boolean;
}

const THEME_KEY = 'agentwithu.markdownPreview.theme';
const TOC_KEY = 'agentwithu.markdownPreview.tocOpen';

function storedTheme(initialDark: boolean): ReaderTheme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch { /* localStorage may be unavailable in hardened WebViews */ }
  return initialDark ? 'dark' : 'light';
}

function storedTocOpen(): boolean {
  try {
    return localStorage.getItem(TOC_KEY) !== '0';
  } catch { return true; }
}

function outlineIndent(item: MarkdownOutlineItem, minimumLevel: number): number {
  return Math.min(4, Math.max(0, item.level - minimumLevel)) * 13;
}

export const MarkdownPreview: React.FC<Props> = ({ source, title = 'Markdown 文档', initialDark = true }) => {
  const [theme, setTheme] = useState<ReaderTheme>(() => storedTheme(initialDark));
  const [tocOpen, setTocOpen] = useState(storedTocOpen);
  const [activeId, setActiveId] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rendered = useMemo(
    () => markdownHtmlWithOutline(markdownToHtml(source || '')),
    [source],
  );
  const minimumLevel = useMemo(
    () => rendered.outline.reduce((minimum, item) => Math.min(minimum, item.level), 6),
    [rendered.outline],
  );

  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem(TOC_KEY, tocOpen ? '1' : '0'); } catch { /* ignore */ }
  }, [tocOpen]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    scroller.scrollTop = 0;
    setActiveId(rendered.outline[0]?.id || '');

    let frame = 0;
    const updateActive = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = scroller.getBoundingClientRect().top + 88;
        let current = rendered.outline[0]?.id || '';
        for (const item of rendered.outline) {
          const heading = scroller.querySelector<HTMLElement>(`#${item.id}`);
          if (heading && heading.getBoundingClientRect().top <= top) current = item.id;
          else if (heading) break;
        }
        setActiveId(current);
      });
    };
    scroller.addEventListener('scroll', updateActive, { passive: true });
    updateActive();
    return () => {
      scroller.removeEventListener('scroll', updateActive);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rendered]);

  const navigateTo = useCallback((id: string) => {
    const scroller = scrollRef.current;
    const heading = scroller?.querySelector<HTMLElement>(`#${id}`);
    if (!heading) return;
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
    if (window.matchMedia('(max-width: 760px)').matches) setTocOpen(false);
  }, []);

  const toggleToc = useCallback(() => setTocOpen((open) => !open), []);
  const toggleTheme = useCallback(
    () => setTheme((value) => value === 'dark' ? 'light' : 'dark'),
    [],
  );

  return (
    <div
      className={`awu-md-reader ${tocOpen ? 'awu-md-toc-open' : 'awu-md-toc-closed'}`}
      data-reader-theme={theme}
    >
      <style>{readerCss}</style>
      <div className="awu-md-reader-toolbar">
        <button
          type="button"
          className="awu-md-reader-button"
          onClick={toggleToc}
          aria-expanded={tocOpen}
          title={tocOpen ? '收起文档目录' : '展开文档目录'}
        >
          <span aria-hidden="true">{tocOpen ? '◀' : '☰'}</span>
          <span>{tocOpen ? '收起目录' : '展开目录'}</span>
        </button>
        <div className="awu-md-reader-title" title={title}>
          <span aria-hidden="true">▤</span>
          <span>{title}</span>
          {rendered.outline.length > 0 && (
            <span className="awu-md-heading-count">{rendered.outline.length} 个标题</span>
          )}
        </div>
        <button
          type="button"
          className="awu-md-reader-button awu-md-theme-button"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到白天阅读' : '切换到夜间阅读'}
        >
          <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          <span>{theme === 'dark' ? '白天' : '夜间'}</span>
        </button>
      </div>

      <div className="awu-md-reader-layout">
        <button
          type="button"
          className="awu-md-toc-backdrop"
          aria-label="关闭目录"
          onClick={() => setTocOpen(false)}
        />
        <aside className="awu-md-toc" aria-label="文档目录">
          <div className="awu-md-toc-heading">
            <span>目录</span>
            <span>{rendered.outline.length || '—'}</span>
          </div>
          <nav className="awu-md-toc-list">
            {rendered.outline.length === 0 ? (
              <div className="awu-md-toc-empty">这份文档没有可导航的标题</div>
            ) : rendered.outline.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`awu-md-toc-item ${activeId === item.id ? 'is-active' : ''}`}
                style={{ paddingLeft: 14 + outlineIndent(item, minimumLevel) }}
                onClick={() => navigateTo(item.id)}
                title={item.title}
              >
                <span className="awu-md-toc-marker" />
                <span>{item.title}</span>
              </button>
            ))}
          </nav>
        </aside>

        <div ref={scrollRef} className="awu-md-document-scroll">
          <article
            className="awu-md-document"
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        </div>
      </div>
    </div>
  );
};

const readerCss = `
  .awu-md-reader {
    --md-bg: #f3f6fa;
    --md-panel: #ffffff;
    --md-toolbar: rgba(255,255,255,.93);
    --md-text: #202733;
    --md-muted: #667085;
    --md-border: #dce2ea;
    --md-soft: #f6f8fb;
    --md-code: #f4f6f9;
    --md-accent: #2563eb;
    --md-accent-soft: rgba(37,99,235,.09);
    --theme-text: var(--md-text);
    --theme-text-muted: var(--md-muted);
    --theme-border: var(--md-border);
    --theme-bg-secondary: var(--md-soft);
    --theme-code-bg: var(--md-code);
    --theme-accent: var(--md-accent);
    width: 100%; height: 100%; min-width: 0; min-height: 0;
    display: flex; flex-direction: column; overflow: hidden;
    color: var(--md-text); background: var(--md-bg);
  }
  .awu-md-reader[data-reader-theme="dark"] {
    --md-bg: #0d1117;
    --md-panel: #151b23;
    --md-toolbar: rgba(21,27,35,.94);
    --md-text: #e6edf3;
    --md-muted: #9da7b3;
    --md-border: #303844;
    --md-soft: #1c232d;
    --md-code: #0d1117;
    --md-accent: #67a9ff;
    --md-accent-soft: rgba(88,166,255,.12);
  }
  .awu-md-reader-toolbar {
    height: 46px; padding: 0 12px; flex: 0 0 auto; z-index: 8;
    display: flex; align-items: center; gap: 10px;
    color: var(--md-text); background: var(--md-toolbar);
    border-bottom: 1px solid var(--md-border); backdrop-filter: blur(14px);
  }
  .awu-md-reader-button {
    min-height: 30px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--md-border); border-radius: 8px;
    color: var(--md-text); background: var(--md-panel); cursor: pointer;
    font: 600 11.5px/1.2 inherit; white-space: nowrap;
  }
  .awu-md-reader-button:hover { color: var(--md-accent); border-color: var(--md-accent); }
  .awu-md-reader-title {
    min-width: 0; flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px;
    font-size: 12px; font-weight: 650; color: var(--md-text);
  }
  .awu-md-reader-title > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .awu-md-heading-count {
    flex: 0 0 auto; padding: 2px 7px; border-radius: 999px;
    color: var(--md-muted); background: var(--md-soft); font-size: 10px; font-weight: 500;
  }
  .awu-md-reader-layout {
    position: relative; min-width: 0; min-height: 0; flex: 1;
    display: grid; grid-template-columns: 260px minmax(0, 1fr);
    transition: grid-template-columns .2s ease;
  }
  .awu-md-toc {
    z-index: 5; min-width: 0; min-height: 0; overflow: hidden;
    color: var(--md-text); background: var(--md-panel); border-right: 1px solid var(--md-border);
    transition: opacity .18s ease, transform .2s ease;
  }
  .awu-md-toc-heading {
    height: 43px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between;
    color: var(--md-muted); border-bottom: 1px solid var(--md-border);
    font-size: 10.5px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase;
  }
  .awu-md-toc-list { height: calc(100% - 43px); padding: 8px 7px 22px; overflow: auto; }
  .awu-md-toc-item {
    position: relative; width: 100%; min-height: 31px; padding: 6px 9px 6px 14px;
    display: flex; align-items: flex-start; gap: 8px;
    border: 0; border-radius: 7px; text-align: left;
    color: var(--md-muted); background: transparent; cursor: pointer;
    font: 500 11.5px/1.45 inherit;
  }
  .awu-md-toc-item > span:last-child {
    min-width: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 2; overflow-wrap: anywhere;
  }
  .awu-md-toc-item:hover { color: var(--md-text); background: var(--md-soft); }
  .awu-md-toc-item.is-active { color: var(--md-accent); background: var(--md-accent-soft); font-weight: 700; }
  .awu-md-toc-marker {
    width: 4px; height: 4px; margin-top: 6px; flex: 0 0 auto; border-radius: 50%;
    background: currentColor; opacity: .55;
  }
  .awu-md-toc-item.is-active .awu-md-toc-marker { height: 14px; margin-top: 1px; border-radius: 3px; opacity: 1; }
  .awu-md-toc-empty { padding: 16px 12px; color: var(--md-muted); font-size: 11px; line-height: 1.6; }
  .awu-md-document-scroll { min-width: 0; min-height: 0; overflow: auto; background: var(--md-bg); }
  .awu-md-document {
    width: min(900px, calc(100% - 48px)); min-height: calc(100% - 40px); margin: 20px auto;
    padding: clamp(28px, 5vw, 58px); box-sizing: border-box;
    color: var(--md-text); background: var(--md-panel); border: 1px solid var(--md-border);
    border-radius: 12px; box-shadow: 0 12px 34px rgba(15,23,42,.08);
    overflow-wrap: anywhere;
  }
  .awu-md-reader[data-reader-theme="dark"] .awu-md-document { box-shadow: 0 18px 44px rgba(0,0,0,.28); }
  .awu-md-document .md-content { color: var(--md-text); font-size: 15px; line-height: 1.78; }
  .awu-md-document .md-content p { margin: .8em 0; }
  .awu-md-document .md-content h1,
  .awu-md-document .md-content h2,
  .awu-md-document .md-content h3,
  .awu-md-document .md-content h4,
  .awu-md-document .md-content h5,
  .awu-md-document .md-content h6 {
    color: var(--md-text); line-height: 1.3; font-weight: 720;
    scroll-margin-top: 26px; outline: none;
  }
  .awu-md-document .md-content h1 { margin: 0 0 .8em; padding-bottom: .42em; font-size: 2em; border-bottom: 1px solid var(--md-border); }
  .awu-md-document .md-content h2 { margin: 1.9em 0 .65em; padding-bottom: .35em; font-size: 1.48em; border-bottom: 1px solid var(--md-border); }
  .awu-md-document .md-content h3 { margin: 1.6em 0 .5em; font-size: 1.2em; }
  .awu-md-document .md-content h4 { margin: 1.4em 0 .45em; font-size: 1.06em; }
  .awu-md-document .md-content h5,
  .awu-md-document .md-content h6 { margin: 1.3em 0 .4em; font-size: 1em; }
  .awu-md-document .md-content a { color: var(--md-accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  .awu-md-document .md-content hr { margin: 2em 0; border-color: var(--md-border); }
  .awu-md-document .md-content blockquote.md-blockquote {
    margin: 1.1em 0; padding: .55em 1em; border-left: 4px solid var(--md-accent);
    border-radius: 0 7px 7px 0; color: var(--md-muted); background: var(--md-soft);
  }
  .awu-md-document .md-content code.md-code-inline {
    padding: .15em .4em; color: var(--md-text); background: var(--md-code);
    border: 1px solid var(--md-border); border-radius: 5px;
  }
  .awu-md-document .md-content pre.md-pre {
    margin: 1em 0; padding: 15px 17px; color: var(--md-text); background: var(--md-code);
    border: 1px solid var(--md-border); border-radius: 9px;
  }
  .awu-md-document .md-table-wrap { margin: 1.2em 0; border: 1px solid var(--md-border); border-radius: 8px; overflow: auto; }
  .awu-md-document .md-table { width: 100%; margin: 0; border: 0; border-collapse: collapse; }
  .awu-md-document .md-table th,
  .awu-md-document .md-table td { padding: .62em .8em; color: var(--md-text); border-color: var(--md-border); }
  .awu-md-document .md-table th { background: var(--md-soft); font-weight: 700; }
  .awu-md-document .md-content img { display: block; max-width: 100%; height: auto; margin: 1.3em auto; border-radius: 7px; }
  .awu-md-toc-closed .awu-md-reader-layout { grid-template-columns: 0 minmax(0, 1fr); }
  .awu-md-toc-closed .awu-md-toc { opacity: 0; pointer-events: none; transform: translateX(-12px); }
  .awu-md-toc-backdrop { display: none; }
  @media (max-width: 760px) {
    .awu-md-reader-toolbar { padding: 0 8px; gap: 6px; }
    .awu-md-reader-button { padding: 5px 8px; }
    .awu-md-heading-count { display: none; }
    .awu-md-reader-layout,
    .awu-md-toc-closed .awu-md-reader-layout { display: block; }
    .awu-md-toc {
      position: absolute; inset: 0 auto 0 0; width: min(82vw, 300px);
      box-shadow: 16px 0 40px rgba(0,0,0,.3); transform: translateX(0);
    }
    .awu-md-toc-closed .awu-md-toc { transform: translateX(-100%); }
    .awu-md-toc-open .awu-md-toc-backdrop {
      display: block; position: absolute; inset: 0; z-index: 4; border: 0;
      background: rgba(0,0,0,.42); cursor: default;
    }
    .awu-md-document-scroll { height: 100%; }
    .awu-md-document { width: 100%; min-height: 100%; margin: 0; padding: 24px 18px 44px; border: 0; border-radius: 0; box-shadow: none; }
    .awu-md-document .md-content { font-size: 14px; }
  }
`;

export default MarkdownPreview;
