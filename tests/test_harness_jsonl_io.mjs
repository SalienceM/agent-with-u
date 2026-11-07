import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough, Writable } from 'node:stream'
import { once } from 'node:events'
import { createBoundedJsonlIO } from '../tools/deepseek-harness/jsonl-io.mjs'
import { IMAGE_LIMITS } from '../tools/deepseek-harness/image-limits.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const bytes = value => Buffer.from(JSON.stringify(value) + '\n')
function sized(size, message = { jsonrpc: '2.0', id: 1, result: { value: '' } }) {
  const text = JSON.stringify(message) + '\n'
  return Buffer.from(text.replace('"value":""', '"value":"' + 'x'.repeat(size - Buffer.byteLength(text)) + '"'))
}
function fixture(destination = new Writable({ write(_chunk, _enc, done) { done() } })) {
  const source = new PassThrough(), frames = []
  let failures = 0
  const io = createBoundedJsonlIO(source, destination, () => { failures += 1 })
  io.input.on('data', frame => frames.push(frame))
  io.start()
  return { io, source, frames, get failures() { return failures } }
}

test('输入只有一个管道 reader，UTF-8 跨 chunk、完整 16 MiB 与 EOF 均按字节处理', async () => {
  const f = fixture()
  assert.equal(f.source.listenerCount('data'), 1)
  const unicode = bytes({ method: 'fixture', params: { value: '图片😀' } })
  const at = unicode.indexOf(Buffer.from('图')) + 1
  f.source.write(unicode.subarray(0, at)); f.source.write(unicode.subarray(at))
  f.source.end(sized(IMAGE_LIMITS.maxFrameBytes))
  await once(f.io.input, 'end')
  assert.equal(f.failures, 0)
  assert.deepEqual(f.frames[0], unicode)
  assert.equal(f.frames[1].length, IMAGE_LIMITS.maxFrameBytes)
  f.io.close()
})

test('无换行超长、完整超长、截断、坏 UTF-8 和 12 MiB prompt 都在原生读取前失败', async () => {
  const prompt = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { value: '' } }
  const samples = [Buffer.alloc(IMAGE_LIMITS.maxFrameBytes + 1, 120), sized(IMAGE_LIMITS.maxFrameBytes + 1),
    Buffer.from('{"id":1}'), Buffer.from([0xff, 10]), sized(IMAGE_LIMITS.maxRequestBytes + 1, prompt)]
  for (const sample of samples) {
    const f = fixture()
    f.source.end(sample)
    await tick()
    assert.equal(f.failures, 1)
    assert.equal(f.frames.length, 0)
    f.io.close()
  }
  const f = fixture()
  f.source.end(sized(IMAGE_LIMITS.maxRequestBytes, prompt))
  await once(f.io.input, 'end')
  assert.equal(f.frames[0].length, IMAGE_LIMITS.maxRequestBytes)
  f.io.close()
})

test('输出覆盖 response/error/notification 完整 envelope，越界不发部分帧', async () => {
  for (const message of [{ id: 1, result: { value: '' } }, { id: 1, error: { code: -1, value: '' } },
    { method: 'fixture', params: { value: '' } }]) {
    const output = []
    const f = fixture(new Writable({ write(chunk, _enc, done) { output.push(chunk); done() } }))
    const exact = sized(IMAGE_LIMITS.maxFrameBytes, message)
    await new Promise((resolve, reject) => f.io.output.write(exact, cause => cause ? reject(cause) : resolve()))
    assert.deepEqual(Buffer.concat(output), exact)
    f.io.output.write(sized(IMAGE_LIMITS.maxFrameBytes + 1, message))
    await tick()
    assert.equal(f.failures, 1)
    assert.equal(output.length, 1)
    f.io.close()
  }
})

test('原生 flush 空 barrier 等待实际输出 callback，不额外写字节', async () => {
  let release
  const sent = []
  const f = fixture(new Writable({ write(chunk, _enc, done) { sent.push(chunk); release = done } }))
  f.io.output.write(bytes({ id: 1, result: {} }))
  let flushed = false
  const flush = new Promise((resolve, reject) => f.io.output.write('', cause => {
    flushed = true
    if (cause) reject(cause); else resolve()
  }))
  await tick()
  assert.equal(flushed, false)
  release()
  await flush
  assert.equal(sent.length, 1)
  f.io.close()
})

test('忽略 drain 的原生 writer 也不能超过 32 MiB 累计输出；溢出明确关闭', async () => {
  let release
  const f = fixture(new Writable({ write(_chunk, _enc, done) { release = done } }))
  const frame = sized(IMAGE_LIMITS.maxFrameBytes)
  f.io.output.write(frame)
  f.io.output.write(frame)
  assert.equal(f.io.output.writableLength, IMAGE_LIMITS.maxPendingBytes)
  f.io.output.write('\n')
  await tick()
  assert.equal(f.failures, 1)
  assert.equal(f.io.output.destroyed, true)
  release()
  f.io.close()
})

test('输出截断与底层错误失败；正常 close 不伪造失败或关闭别的流', async () => {
  const truncated = fixture()
  truncated.io.output.end('{"id":1}')
  await tick()
  assert.equal(truncated.failures, 1)
  truncated.io.close()
  const destination = new Writable({ write(_chunk, _enc, done) { done(new Error('fixture raw details')) } })
  const failed = fixture(destination)
  failed.io.output.write(bytes({ id: 1, result: {} }))
  await tick()
  assert.equal(failed.failures, 1)
  failed.io.close()
  const normal = fixture()
  normal.io.close(); normal.io.close()
  assert.equal(normal.failures, 0)
  assert.equal(normal.source.destroyed, false)
})
