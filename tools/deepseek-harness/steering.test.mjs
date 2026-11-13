import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSteering } from './steering.mjs'

function setup() {
  const identity = { sessionId: 'root', generation: 'run', configFingerprint: 'config' }
  const sent = []
  const agent = { session: { id: 'root' }, status: 'running', steer(message) { sent.push(message) } }
  const bridge = createSteering(identity, input => ({ ...input, id: 'native-1' }))
  bridge.mount(agent)
  bridge.observe('root', { type: 'turn/start', data: { turn: 1 } })
  const controller = new AbortController()
  bridge.step({ agent, turn: 1, signal: controller.signal })
  const params = { ...identity, requestId: 'input-1', expectedTurn: 1, content: '改查旧金山' }
  return { bridge, agent, params, sent, controller }
}

test('原生 steer、相同请求幂等，查询不入箱', () => {
  const { bridge, params, sent } = setup()
  const receipt = bridge.request('awu/steer', params)
  assert.equal(receipt.status, 'accepted')
  assert.equal(receipt.messageId, 'native-1')
  assert.deepEqual(bridge.request('awu/steer', params), receipt)
  assert.deepEqual(bridge.request('awu/steerStatus', params), receipt)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].content, [{ type: 'text', text: '改查旧金山' }])
  assert.equal(bridge.request('awu/steer', { ...params, content: 'changed' }).status, 'conflict')
})

test('旧身份、子会话、图片、旧轮次和结束后的插话不能唤醒新轮', () => {
  const { bridge, params, agent, sent } = setup()
  for (const override of [{ generation: 'old' }, { sessionId: 'child' }, { configFingerprint: 'old' }])
    assert.throws(() => bridge.request('awu/steer', { ...params, ...override }), /identity/)
  assert.equal(bridge.request('awu/steer', { ...params, images: [] }).status, 'rejected')
  assert.equal(bridge.request('awu/steer', { ...params, expectedTurn: 2 }).status, 'turn_finished')
  agent.status = 'idle'
  assert.equal(bridge.request('awu/steer', params).status, 'turn_finished')
  agent.status = 'running'
  bridge.observe('root', { type: 'turn/end', data: { turn: 1 } })
  assert.equal(bridge.request('awu/steer', params).status, 'turn_finished')
  assert.equal(sent.length, 0)
})

test('原生异常保留 unknown，不重新执行', () => {
  const { bridge, params, agent, sent } = setup()
  agent.steer = value => { sent.push(value); throw new Error('after insertion') }
  assert.equal(bridge.request('awu/steer', params).status, 'unknown')
  assert.equal(bridge.request('awu/steer', params).status, 'unknown')
  assert.equal(bridge.request('awu/steerStatus', params).status, 'unknown')
  assert.equal(sent.length, 1)
})

test('取消后的运行状态不能将插话变成 next-turn', () => {
  const { bridge, params, sent, controller } = setup()
  controller.abort()
  assert.equal(bridge.request('awu/steer', params).status, 'turn_finished')
  assert.equal(sent.length, 0)
})
