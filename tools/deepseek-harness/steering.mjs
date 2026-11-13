import { createHash } from 'node:crypto'

// 不调用 session/prompt（它是 followup），也不创建或唤醒空闲 Agent。
export function createSteering(config, createUserMessage) {
  let agent, turn, signal
  const receipts = new Map()
  const identity = { sessionId: config.sessionId, generation: config.generation,
    configFingerprint: config.configFingerprint }
  return {
    get supported() { return typeof createUserMessage === 'function' },
    mount(value) { if (String(value.session.id) === config.sessionId) agent = value },
    step(value) {
      if (String(value.agent.session.id) === config.sessionId && value.turn === turn) signal = value.signal
    },
    observe(sessionId, event) {
      if (sessionId !== config.sessionId) return
      if (event.type === 'turn/start') { turn = event.data.turn; signal = undefined }
      if (event.type === 'turn/end') { turn = undefined; signal = undefined }
    },
    request(method, params) {
      if (!Object.keys(identity).every(key => params[key] === identity[key])
          || typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 200) {
        throw new Error('Invalid AWU steer identity')
      }
      const reply = (status, extra = {}) => ({ ...identity, requestId: params.requestId, status, ...extra })
      if (method === 'awu/steerStatus') return receipts.get(params.requestId)?.reply ?? reply('not_found')
      if (typeof params.content !== 'string' || !params.content.trim()
          || Buffer.byteLength(params.content, 'utf8') > 1024 * 1024 || params.images !== undefined
          || !Number.isSafeInteger(params.expectedTurn)) return reply('rejected')
      const hash = createHash('sha256').update(JSON.stringify([params.expectedTurn, params.content])).digest('hex')
      const prior = receipts.get(params.requestId)
      if (prior) return prior.hash === hash ? prior.reply : reply('conflict')
      if (receipts.size >= 256) return reply('limit')
      if (!createUserMessage) return reply('unsupported')
      if (!agent || agent.status !== 'running' || turn !== params.expectedTurn || !signal || signal.aborted) return reply('turn_finished')
      const message = createUserMessage({ content: [{ type: 'text', text: params.content }], source: { kind: 'user' } })
      // 同一事件循环内检查 + 入箱；保留写前 unknown，异常不得谎称未接收。
      const item = { hash, reply: reply('unknown', { turn, messageId: message.id }) }
      receipts.set(params.requestId, item)
      try {
        agent.steer(message)
        item.reply = reply('accepted', { turn, messageId: message.id })
      } catch { /* 原生入箱可能已发生，只允许查询原回执。 */ }
      return item.reply
    },
  }
}
