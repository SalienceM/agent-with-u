// 与 Python 完整解码后的摘要一致。原始字节 hash 同时绑定尺寸、格式头和全部像素编码；
// 不在桥里再次转码，也不把 EXIF 旋转后的原生尺寸误作原文件尺寸。
import { createHash } from 'node:crypto'
import { IMAGE_LIMITS, IMAGE_FORMATS } from './image-limits.mjs'
import { ImageAdmissionError } from './image-identity.mjs'

export function promptImageDigest(blocks) {
  const fail = code => { throw new ImageAdmissionError(code) }
  if (!Array.isArray(blocks)) fail('image_payload_invalid')
  const images = blocks.filter(block => block?.type === 'image')
  if (!images.length || images.length > IMAGE_LIMITS.maxImages) fail('image_payload_invalid')
  let total = 0
  const metadata = images.map(block => {
    if (Object.keys(block).some(key => !['type', 'data', 'mimeType'].includes(key))
        || !IMAGE_FORMATS.includes(block.mimeType)
        || typeof block.data !== 'string' || !block.data.length
        || block.data.length > 4 * Math.ceil(IMAGE_LIMITS.maxImageBytes / 3)) fail('image_payload_invalid')
    // Buffer.from 对坏字符宽容，必须通过 round-trip 核对严格 canonical Base64。
    const raw = Buffer.from(block.data, 'base64')
    if (!raw.length || raw.toString('base64') !== block.data) fail('image_payload_invalid')
    total += raw.length
    if (raw.length > IMAGE_LIMITS.maxImageBytes || total > IMAGE_LIMITS.maxTotalImageBytes) fail('image_payload_invalid')
    return [block.mimeType, raw.length, createHash('sha256').update(raw).digest('hex')]
  })
  return createHash('sha256').update(JSON.stringify(metadata)).digest('hex')
}
