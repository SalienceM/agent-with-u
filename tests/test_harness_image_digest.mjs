import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { promptImageDigest } from '../tools/deepseek-harness/image-digest.mjs'

const image = (data = 'fixture') => ({ type: 'image', mimeType: 'image/png', data: Buffer.from(data).toString('base64') })
test('摘要绑定有序 MIME、实际字节数及原文件 hash，不使用可伪造尺寸', () => {
  const blocks = [image(), image('other')]
  const metadata = blocks.map(block => {
    const raw = Buffer.from(block.data, 'base64')
    return [block.mimeType, raw.length, createHash('sha256').update(raw).digest('hex')]
  })
  assert.equal(promptImageDigest(blocks), createHash('sha256').update(JSON.stringify(metadata)).digest('hex'))
  assert.notEqual(promptImageDigest(blocks), promptImageDigest([...blocks].reverse()))
  assert.equal(promptImageDigest(blocks), promptImageDigest([{ type: 'text', text: 'not an image' }, ...blocks]))
})
test('坏 Base64、额外字段、未知 MIME、空/超量图片拒绝整笔摘要', () => {
  for (const blocks of [[], [image(), { ...image(), data: 'bad base64' }], [{ ...image(), width: 32 }],
    [{ ...image(), mimeType: 'image/gif' }], [image('')], Array(5).fill(image()),
    [{ ...image(), data: 'x'.repeat(6 * 1024 * 1024) }]]) {
    assert.throws(() => promptImageDigest(blocks), { code: 'image_payload_invalid' })
  }
})
