/**
 * 轻量 Markdown → HTML，适配深色主题聊天界面。
 * 支持：代码块、行内代码、粗体、斜体、标题、列表、链接、分割线。
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function markdownToHtml(src: string): string {
  const codeBlocks: string[] = [];
  let idx = 0;

  // 1) 提取 fenced code blocks
  let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const ph = `\u0000CB${idx}\u0000`;
    const langTag = lang
      ? `<div style="font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:4px;font-family:sans-serif">${esc(lang)}</div>`
      : '';
    codeBlocks[idx] =
      `<pre style="background:#0d0d1a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px 16px;overflow-x:auto;font-size:13px;line-height:1.6;margin:8px 0">` +
      `${langTag}<code>${esc(code.trim())}</code></pre>`;
    idx++;
    return ph;
  });

  // 2) 逐段处理非代码部分
  const parts = text.split(/(\u0000CB\d+\u0000)/);
  text = parts
    .map((p) => {
      if (/^\u0000CB\d+\u0000$/.test(p)) return p;

      let t = esc(p);

      // 行内代码
      t = t.replace(
        /`([^`\n]+)`/g,
        '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-size:0.88em">$1</code>',
      );
      // 粗斜体
      t = t.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      // 粗体
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // 斜体
      t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
      // 链接
      t = t.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener" style="color:#8b9cf7;text-decoration:underline">$1</a>',
      );
      // 标题
      t = t.replace(/^#### (.+)$/gm, '<h4 style="font-size:1em;font-weight:600;margin:14px 0 2px;color:#e8e8e8">$1</h4>');
      t = t.replace(/^### (.+)$/gm, '<h3 style="font-size:1.05em;font-weight:600;margin:14px 0 2px;color:#e8e8e8">$1</h3>');
      t = t.replace(/^## (.+)$/gm, '<h2 style="font-size:1.12em;font-weight:600;margin:16px 0 2px;color:#f0f0f0">$1</h2>');
      t = t.replace(/^# (.+)$/gm, '<h1 style="font-size:1.2em;font-weight:700;margin:16px 0 2px;color:#fff">$1</h1>');
      // 无序列表
      t = t.replace(/^[\-\*] (.+)$/gm, '<li style="margin-left:20px;list-style-type:disc;margin-bottom:2px">$1</li>');
      // 有序列表
      t = t.replace(/^\d+\. (.+)$/gm, '<li style="margin-left:20px;list-style-type:decimal;margin-bottom:2px">$1</li>');
      // 分割线
      t = t.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:12px 0">');
      // 双换行 → 段落
      t = t.replace(/\n\n+/g, '</p><p style="margin:6px 0">');
      // 单换行 → <br>
      t = t.replace(/\n/g, '<br>');

      return t;
    })
    .join('');

  // 3) 还原代码块
  for (let j = 0; j < codeBlocks.length; j++) {
    text = text.replace(`\u0000CB${j}\u0000`, codeBlocks[j]);
  }

  return `<div style="line-height:1.6">${text}</div>`;
}

export function messagesToMarkdown(
  messages: Array<{ role: string; content: string; timestamp?: number }>,
): string {
  return messages
    .map((msg) => {
      const role = msg.role === 'user' ? '## 🧑 User' : '## 🤖 Assistant';
      const time = msg.timestamp ? `\n*${new Date(msg.timestamp).toLocaleString()}*\n` : '';
      return `${role}${time}\n\n${msg.content}`;
    })
    .join('\n\n---\n\n');
}

export function messagesToJson(
  messages: Array<{ role: string; content: string; timestamp?: number }>,
): string {
  return JSON.stringify(messages, null, 2);
}