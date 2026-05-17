/**
 * uuid — 生成 UUID v4。
 *
 * crypto.randomUUID 只在「安全上下文」（HTTPS 或 localhost）可用。
 * 局域网 IP 上跑纯 HTTP（如 http://192.168.x.x）时它是 undefined，
 * 直接调用会抛 "crypto.randomUUID is not a function"。
 * 这里在不可用时回退到 crypto.getRandomValues（任何上下文都可用）。
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 按 RFC 4122 设置版本号(4)与变体位
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}
