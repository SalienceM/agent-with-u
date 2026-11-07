import React from 'react';
import { markdownHighlightStyles, markdownStyles } from '../utils/markdownStyles';

/** 主窗口和独立窗口共用；不把样式注入副作用放进纯解析函数。 */
export const MarkdownStyles: React.FC = () => <style data-awu-markdown-styles>{markdownHighlightStyles + markdownStyles}</style>;
