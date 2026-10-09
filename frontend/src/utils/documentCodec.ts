import { IncrementalSha256 } from './sha256';
import { DocumentProtocolError } from './workspaceDocuments';

export const MAX_EDIT_BYTES = 8 * 1024 * 1024;
export const PREVIEW_BYTES = 256 * 1024;
export interface TextFormat { encoding: string; bom: string; eol: string; text?: string; lineEndings?: string[]; }
export const byteHash = (bytes: Uint8Array): string => new IncrementalSha256().update(bytes).digestHex();
const markers: [number[], string, string][] = [
  [[0xef, 0xbb, 0xbf], 'utf-8', 'utf8'], [[0xff, 0xfe], 'utf-16le', 'utf16le'], [[0xfe, 0xff], 'utf-16be', 'utf16be'],
];
const starts = (bytes: Uint8Array, marker: number[]) => marker.every((n, index) => bytes[index] === n);

export function decodeDocumentBytes(bytes: Uint8Array, complete: boolean): TextFormat & { text: string; reasonCode: string } {
  let encoding = 'utf-8', bom = '', body = bytes;
  const failed = (reasonCode: string) => ({ encoding, bom, eol: 'none', text: '', reasonCode });
  if (starts(bytes, [0xff, 0xfe, 0, 0]) || starts(bytes, [0, 0, 0xfe, 0xff])) return failed('unsupported_encoding');
  for (const [marker, codec, name] of markers) if (starts(bytes, marker)) {
    encoding = codec; bom = name; body = bytes.subarray(marker.length); break;
  }
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body, { stream: !complete }); }
  catch { return failed('invalid_encoding'); }
  const endings = new Set(text.match(/\r\n|\r|\n/g) || []);
  const eol = endings.size > 1 ? 'mixed' : endings.has('\r\n') ? 'crlf' : endings.has('\r') ? 'cr' : endings.has('\n') ? 'lf' : 'none';
  const reasonCode = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? 'binary'
    : text.includes('\ufffd') ? 'replacement_character' : '';
  return { encoding: encoding.replace('utf-16', 'utf-16-'), bom, eol,
    text: reasonCode === 'binary' ? '' : text.replace(/\r\n|\r/g, '\n'), reasonCode,
    ...(eol === 'mixed' ? { lineEndings: text.match(/\r\n|\r|\n/g) || [] } : {}) };
}

/** 有界行锚点映射：原行沿用自己的换行符；新增行继承邻近行，不规范化整份文件。 */
function mixedText(value: string, format: TextFormat): string {
  if (typeof format.text !== 'string' || !format.lineEndings) throw new DocumentProtocolError('mixed_eol_baseline_required');
  const old = format.text.split('\n'), next = value.split('\n'), endings = format.lineEndings;
  if (endings.length !== old.length - 1 || endings.some(e => !['\n', '\r', '\r\n'].includes(e))) throw new DocumentProtocolError('invalid_encoding');
  const mapped: (number | undefined)[] = new Array(next.length);
  let prefix = 0, oldEnd = old.length - 1, newEnd = next.length - 1;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) { mapped[prefix] = prefix; prefix++; }
  while (oldEnd >= prefix && newEnd >= prefix && old[oldEnd] === next[newEnd]) { mapped[newEnd--] = oldEnd--; }
  // 唯一行作为稳定锚点；重复行只在相邻一一对应的区间按原次序保留，避免贪婪跨块误配。
  const positions = new Map<string, number>();
  for (let i = prefix; i <= oldEnd; i++) positions.set(old[i], positions.has(old[i]) ? -1 : i);
  let previousOld = prefix - 1, previousNew = prefix - 1;
  const fillGap = (oi: number, ni: number) => {
    const count = Math.min(oi - previousOld - 1, ni - previousNew - 1);
    for (let i = 1; i <= count; i++) mapped[previousNew + i] = previousOld + i;
    previousOld = oi; previousNew = ni;
  };
  for (let i = prefix; i <= newEnd; i++) {
    const at = positions.get(next[i]);
    if (at !== undefined && at > previousOld) { fillGap(at, i); mapped[i] = at; }
  }
  fillGap(oldEnd + 1, newEnd + 1);
  let last = endings[0] || '\n';
  return next.map((line, i) => {
    if (i === next.length - 1) return line;
    const at = mapped[i];
    if (at !== undefined && endings[at]) last = endings[at];
    return line + last;
  }).join('');
}

export function encodeDocumentText(value: string, format: TextFormat): Uint8Array {
  if (value.length > MAX_EDIT_BYTES) throw new DocumentProtocolError('too_large');
  const newline = { lf: '\n', crlf: '\r\n', cr: '\r', none: '\n' }[format.eol];
  const normalized = value.replace(/\r\n|\r/g, '\n');
  if (newline === undefined && format.eol !== 'mixed') throw new DocumentProtocolError('invalid_encoding');
  const text = format.eol === 'mixed' ? mixedText(normalized, format) : normalized.replace(/\n/g, newline!);
  let body: Uint8Array;
  if (format.encoding === 'utf-8') body = new TextEncoder().encode(text);
  else if (format.encoding === 'utf-16-le' || format.encoding === 'utf-16-be') {
    body = new Uint8Array(text.length * 2);
    const view = new DataView(body.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), format.encoding === 'utf-16-le');
  } else throw new DocumentProtocolError('unsupported_encoding');
  const marker = format.bom ? markers.find(row => row[2] === format.bom)?.[0] : [];
  if (!marker) throw new DocumentProtocolError('unsupported_encoding');
  const bytes = new Uint8Array(marker.length + body.length);
  if (bytes.length > MAX_EDIT_BYTES) throw new DocumentProtocolError('too_large');
  bytes.set(marker); bytes.set(body, marker.length);
  const verified = decodeDocumentBytes(bytes, true);
  if (verified.reasonCode || verified.text !== value.replace(/\r\n|\r/g, '\n')) throw new DocumentProtocolError(verified.reasonCode || 'invalid_encoding');
  return bytes;
}

export function specializedDocument(path: string): boolean {
  return /\.(pdf|docx?|xlsx?|xlsm|pptx?|png|jpe?g|gif|webp|ico|bmp|avif|zip|gz|tar|7z|exe|dll|pyd|so|mp4|mp3|wav|woff2?)$/i.test(path);
}
