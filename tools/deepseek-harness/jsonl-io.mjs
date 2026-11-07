// 原生 transport 之前/之后的唯一流包装；不另读 stdin，也不截断协议帧。
import { Transform, Writable } from 'node:stream'
import { IMAGE_LIMITS } from './image-limits.mjs'

const { maxFrameBytes: MAX_FRAME, maxPendingBytes: MAX_PENDING, maxRequestBytes: MAX_REQUEST } = IMAGE_LIMITS
const error = reason => new Error(`AWU JSONL transport refused: ${reason}`)
class Frames {
  constructor(input = false) { this.input = input; this.parts = []; this.bytes = 0 }
  accept(chunk) {
    const frames = []
    let offset = 0
    while (offset < chunk.length) {
      const lf = chunk.indexOf(10, offset)
      const end = lf < 0 ? chunk.length : lf + 1
      const part = chunk.subarray(offset, end)
      if (this.bytes + part.length > MAX_FRAME) throw error('frame_limit')
      this.parts.push(lf < 0 ? Buffer.from(part) : part)
      this.bytes += part.length
      offset = end
      if (lf < 0) continue
      const frame = Buffer.concat(this.parts, this.bytes)
      this.parts = []; this.bytes = 0
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(frame) }
      catch { throw error('invalid_utf8') }
      if (this.input) {
        let message
        try { message = JSON.parse(text) } catch { throw error('invalid_json') }
        if (message?.method === 'session/prompt' && frame.length > MAX_REQUEST) throw error('request_limit')
      }
      frames.push(frame)
      if (frames.length > 256) throw error('frame_count')
    }
    return frames
  }
  end() { if (this.bytes) throw error('truncated_frame') }
  clear() { this.parts = []; this.bytes = 0 }
}

class BoundedInput extends Transform {
  constructor() { super(); this.frames = new Frames(true) }
  _transform(chunk, _encoding, callback) {
    try {
      if (chunk.length + this.frames.bytes + this.readableLength > MAX_PENDING) throw error('input_backlog')
      for (const frame of this.frames.accept(chunk)) this.push(frame)
      callback()
    } catch (cause) { callback(cause) }
  }
  _flush(callback) { try { this.frames.end(); callback() } catch (cause) { callback(cause) } }
  _destroy(cause, callback) { this.frames.clear(); callback(cause) }
}

class BoundedOutput extends Writable {
  constructor(destination) { super(); this.destination = destination; this.frames = new Frames() }
  write(chunk, encoding, callback) {
    // 原生 writer 不等待 drain；必须在进入 Writable 的无界排队之前核对累计字节。
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk.byteLength
    if (this.writableLength + this.frames.bytes + bytes > MAX_PENDING) {
      const failure = error('output_backlog')
      this.destroy(failure)
      const cb = typeof encoding === 'function' ? encoding : callback
      if (cb) queueMicrotask(() => cb(failure))
      return false
    }
    return super.write(chunk, encoding, callback)
  }
  _write(chunk, _encoding, callback) {
    let frames
    try { frames = this.frames.accept(chunk) } catch (cause) { callback(cause); return }
    if (!frames.length) { callback(); return } // 包括原生 flush 的零字节 barrier。
    let remaining = frames.length
    let finished = false
    const done = cause => {
      if (finished) return
      if (cause || --remaining === 0) { finished = true; callback(cause) }
    }
    try { for (const frame of frames) this.destination.write(frame, done) }
    catch { done(error('output_failed')) }
  }
  _final(callback) { try { this.frames.end(); callback() } catch (cause) { callback(cause) } }
  _destroy(cause, callback) { this.frames.clear(); callback(cause) }
}

export function createBoundedJsonlIO(source, destination, onFailure) {
  const input = new BoundedInput(), output = new BoundedOutput(destination)
  let failed = false, started = false, closed = false
  const fail = () => {
    if (failed || closed) return
    failed = true
    source.unpipe(input)
    input.destroy()
    output.destroy()
    onFailure()
  }
  input.on('error', fail)
  output.on('error', fail)
  source.on('error', fail)
  destination.on('error', fail)
  return Object.freeze({ input, output,
    start() { if (!started && !closed) { started = true; source.pipe(input) } },
    close() {
      if (closed) return
      closed = true
      source.unpipe(input)
      source.off('error', fail); destination.off('error', fail)
      input.destroy(); output.destroy()
    },
  })
}
