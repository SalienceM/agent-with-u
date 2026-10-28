import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installBridge } from './bridge.mjs'

function setup(overrides = {}) {
  const listeners = new Map()
  let handler
  const sent = []
  const config = { sessionId: 'root', generation: 'run', configFingerprint: 'config' }
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) },
    get() {}, systemPrompt: { section() { return () => {} } }, root: { fiber: { async dispose() {} } } }
  const transport = { onRequest(fn) { handler = fn }, notify(method, params) { sent.push({ method, params }) }, close() {} }
  const server = { async handleRequest() { return {} }, async shutdown() {} }
  const io = { stdout: { writableLength: 0 }, stdin: { destroy() {} }, ...overrides }
  const dispose = installBridge(ctx, transport, server, config, io)
  const session = { id: 'root' }
  return { listeners, sent, config, dispose, session, io, transport, request: (method, params) => handler(method, params) }
}

test('能力握手与根身份检查，不启动另一协议读取者', async () => {
  const bridge = setup()
  await assert.rejects(bridge.request('session/prompt', { sessionId: 'root' }), /handshake/)
  await bridge.request('initialize')
  assert.equal((await bridge.request('awu/capabilities')).protocolVersion, 1)
  await assert.rejects(bridge.request('awu/configure', { ...bridge.config, generation: 'old', constraints: '' }), /configuration/)
  await bridge.request('awu/configure', { ...bridge.config, constraints: '{{literal}} !!js data only' })
  await assert.rejects(bridge.request('awu/configure', { ...bridge.config, constraints: '' }), /configuration/)
  await bridge.request('session/prompt', { sessionId: 'root' })
  await assert.rejects(bridge.request('session/prompt', { sessionId: 'foreign' }), /identity/)
  await bridge.dispose()
})

test('实时帧保留原生 attempt/index，其他会话不投递', async () => {
  const bridge = setup()
  const frame = { type: 'chunk', attemptId: 'attempt', revision: 1, index: 0, chunk: { type: 'text-delta', text: 'hello' } }
  bridge.listeners.get('agent/assistant-stream')({ agent: { session: bridge.session }, frame })
  bridge.listeners.get('agent/assistant-stream')({ agent: { session: { id: 'foreign' } }, frame })
  assert.equal(bridge.sent.length, 1)
  assert.deepEqual(bridge.sent[0].params.frame, frame)
  await bridge.dispose()
})

test('授权绑定真实参数，旧身份/重复应答不能放行', async () => {
  const bridge = setup()
  const ask = bridge.listeners.get('approval/request')
  assert.equal(await ask({ agent: { session: bridge.session }, toolName: 'write', callId: 'missing' }), 'unavailable')
  bridge.listeners.get('session/event')(bridge.session,
    { type: 'tool/call', data: { callId: 'call', name: 'write', arguments: '{"file":"test"}' } })
  const outcome = ask({ agent: { session: bridge.session }, toolName: 'write', callId: 'call' })
  const message = bridge.sent.at(-1).params
  assert.equal(message.arguments, '{"file":"test"}')
  const params = { ...message, allowed: true }
  await assert.rejects(bridge.request('awu/approvalRespond', { ...params, generation: 'old' }), /Stale/)
  await bridge.request('awu/approvalRespond', params)
  assert.equal(await outcome, 'allowed-once')
  await assert.rejects(bridge.request('awu/approvalRespond', params), /Stale/)
  await bridge.dispose()
})

test('取消与销毁关闭所有待答授权', async () => {
  const bridge = setup()
  bridge.listeners.get('session/event')(bridge.session,
    { type: 'tool/call', data: { callId: 'call', name: 'write', arguments: '{}' } })
  const controller = new AbortController()
  const outcome = bridge.listeners.get('approval/request')({ agent: { session: bridge.session }, toolName: 'write',
    callId: 'call', signal: controller.signal })
  controller.abort()
  assert.equal(await outcome, 'cancelled')
  const second = bridge.listeners.get('approval/request')({ agent: { session: bridge.session }, toolName: 'write', callId: 'call' })
  await bridge.dispose()
  assert.equal(await second, 'cancelled')
})

test('已完成的工具调用不再具有可授权参数', async () => {
  const bridge = setup()
  const event = bridge.listeners.get('session/event')
  event(bridge.session, { type: 'tool/call', data: { callId: 'done', name: 'write', arguments: '{}' } })
  event(bridge.session, { type: 'tool/result', data: { message: { toolCallId: 'done' } } })
  const outcome = await bridge.listeners.get('approval/request')({ agent: { session: bridge.session }, toolName: 'write', callId: 'done' })
  assert.equal(outcome, 'unavailable')
  await bridge.dispose()
})

test('所有通知共用帧/背压上限；溢出关闭 pending 授权而非静默丢帧', async () => {
  for (const backpressure of [false, true]) {
    let destroyed = false
    const bridge = setup({ stdin: { destroy() { destroyed = true } } })
    bridge.listeners.get('session/event')(bridge.session,
      { type: 'tool/call', data: { callId: 'call', name: 'write', arguments: '{}' } })
    const pending = bridge.listeners.get('approval/request')({ agent: { session: bridge.session }, toolName: 'write', callId: 'call' })
    if (backpressure) bridge.io.stdout.writableLength = 1024 * 1024 + 1
    assert.throws(() => bridge.transport.notify('session.event', { data: backpressure ? '' : 'x'.repeat(1024 * 1024) }), /limit exceeded/)
    assert.equal(await pending, 'cancelled')
    assert.equal(destroyed, true)
    await assert.rejects(bridge.request('session/prompt', { sessionId: 'root' }), /closed/)
    await bridge.dispose()
  }
})

test('恢复前重新冻结访问策略，text-only 同时禁用目录和实际执行', async () => {
  const bridge = setup()
  await bridge.request('initialize')
  await bridge.request('awu/capabilities')
  await bridge.request('awu/configure', { ...bridge.config, constraints: '', textOnly: true })
  const changes = [], restrictions = []
  let guard, assemble
  const agent = { session: { id: 'root', append(type, data) { changes.push({ type, data }) } },
    ctx: { tools: { restrict(value) { restrictions.push(value) }, guard(fn) { guard = fn } },
      on(_type, fn) { assemble = fn } } }
  bridge.listeners.get('agent/created')({ agent, source: 'resume' })
  assert.deepEqual(changes, [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } }])
  assert.deepEqual(restrictions, [{ allow: [] }])
  assert.match(guard(), /disables every tool/)
  assert.deepEqual((await assemble({}, {}, async () => ({ tools: [{ name: 'write' }] }))).tools, [])
  await bridge.dispose()
})

test('授权超时后旧允许回执无效', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bridge = setup()
  bridge.listeners.get('session/event')(bridge.session,
    { type: 'tool/call', data: { callId: 'call', name: 'write', arguments: '{}' } })
  const pending = bridge.listeners.get('approval/request')({ agent: { session: bridge.session }, toolName: 'write', callId: 'call' })
  const request = bridge.sent.at(-1).params
  t.mock.timers.tick(300_001)
  assert.equal(await pending, 'unavailable')
  await assert.rejects(bridge.request('awu/approvalRespond', { ...request, allowed: true }), /Stale/)
  await bridge.dispose()
})

test('子代理关联来自真实工具执行异步上下文，不按时间猜测 callId', async () => {
  const bridge = setup()
  await bridge.listeners.get('tools/execute')({ agent: { session: bridge.session }, callId: 'real-parent-call' }, async () => {
    await Promise.resolve()
    bridge.listeners.get('session/created')({ id: 'child', header: { parentSession: 'root' } })
  })
  assert.equal(bridge.sent.at(-1).method, 'awu/subagentLink')
  assert.equal(bridge.sent.at(-1).params.callId, 'real-parent-call')
  assert.equal(bridge.sent.at(-1).params.parentSessionId, 'root')
  assert.equal(bridge.sent.at(-1).params.sessionId, 'child')
  await bridge.dispose()
})
