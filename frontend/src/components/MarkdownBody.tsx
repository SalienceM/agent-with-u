import React, { useMemo } from 'react';
import { markdownToHtml } from '../utils/markdown';

interface Props {
  text: string;
  style?: React.CSSProperties;
  trailing?: React.ReactNode;
}

/** LOOP/俺寻思等只读正文共用；消息气泡保留其分块、链接与图片增强。 */
export const MarkdownBody: React.FC<Props> = ({ text, style, trailing }) => {
  const html = useMemo(() => markdownToHtml(text), [text]);
  return <div style={{ minWidth: 0, maxWidth: '100%', ...style }}>
    <div dangerouslySetInnerHTML={{ __html: html }} />
    {trailing}
  </div>;
};
