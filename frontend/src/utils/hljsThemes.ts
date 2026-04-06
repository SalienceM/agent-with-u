/**
 * highlight.js 主题 CSS 字符串
 * 直接内嵌避免 Vite/Rollup 跨平台 CSS ?inline 兼容问题
 * Source: highlight.js v11 - github / github-dark-dimmed themes
 * Modified for better contrast in classic/light themes
 */

export const hljsLightCss = `
pre code.hljs { display: block; overflow-x: auto; padding: 1em }
code.hljs { padding: 3px 5px }
.hljs { color: #24292e; background: transparent }
.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,
.hljs-template-variable,.hljs-type,.hljs-variable.language_ { color: #d73a49; font-weight: 600 }
.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_ { color: #6f42c1; font-weight: 600 }
.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,
.hljs-variable,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id { color: #005cc5; font-weight: 500 }
.hljs-regexp,.hljs-string,.hljs-meta .hljs-string { color: #d73a49 }
.hljs-built_in,.hljs-symbol { color: #e36209; font-weight: 600 }
.hljs-comment,.hljs-code,.hljs-formula { color: #6a737d }
.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo { color: #22863a; font-weight: 500 }
.hljs-subst { color: #24292e }
.hljs-section { color: #005cc5; font-weight: 700 }
.hljs-bullet { color: #735c0f; font-weight: 500 }
.hljs-emphasis { color: #24292e; font-style: italic }
.hljs-strong { color: #24292e; font-weight: 700 }
.hljs-addition { color: #22863a; background-color: #f0fff4 }
.hljs-deletion { color: #b31d28; background-color: #ffeef0 }
`;

export const hljsDarkCss = `
pre code.hljs { display: block; overflow-x: auto; padding: 1em }
code.hljs { padding: 3px 5px }
.hljs { color: #adbac7; background: #22272e }
.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,
.hljs-template-variable,.hljs-type,.hljs-variable.language_ { color: #f47067 }
.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_ { color: #dcbdfb }
.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,
.hljs-variable,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id { color: #6cb6ff }
.hljs-regexp,.hljs-string,.hljs-meta .hljs-string { color: #96d0ff }
.hljs-built_in,.hljs-symbol { color: #f69d50 }
.hljs-comment,.hljs-code,.hljs-formula { color: #768390 }
.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo { color: #8ddb8c }
.hljs-subst { color: #adbac7 }
.hljs-section { color: #316dca; font-weight: bold }
.hljs-bullet { color: #eac55f }
.hljs-emphasis { color: #adbac7; font-style: italic }
.hljs-strong { color: #adbac7; font-weight: bold }
.hljs-addition { color: #b4f1b4; background-color: #1b4721 }
.hljs-deletion { color: #ffd8d3; background-color: #78191b }
`;
