import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callConfig, preparedOptions, modelCallError } from '../tools/deepseek-harness/model-call.mjs'

test('压缩请求使用准备后的默认值，保留请求内容和取消信号，不改原对象', () => {
  const signal = new AbortController().signal
  const options = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash',
    messages: Object.freeze([{ role: 'user', content: [] }]), tools: [], maxTokens: 1024,
    purpose: 'compaction', sessionId: 'fixture', signal })
  const config = Object.freeze({ ...callConfig(options), reasoningEffort: 'high' })
  const resolved = preparedOptions(options, config)
  assert.deepEqual(callConfig(resolved), config)
  for (const key of ['messages', 'tools', 'purpose', 'sessionId', 'signal']) assert.equal(resolved[key], options[key])
  assert.equal(options.reasoningEffort, undefined)
  assert.ok(Object.isFrozen(resolved))
  assert.equal(preparedOptions(resolved, config), resolved)
})

test('温度/停止词参与准备；已有的冻结 Agent 请求保留原生对象身份', () => {
  const options = Object.freeze({ provider: 'p', model: 'm', reasoningEffort: 'off', maxTokens: 400,
    temperature: 0.4, stop: Object.freeze(['END']), messages: [], purpose: 'conversation' })
  const config = callConfig(options)
  assert.deepEqual(config, { provider: 'p', model: 'm', reasoningEffort: 'off', maxTokens: 400,
    temperature: 0.4, stop: ['END'] })
  assert.equal(preparedOptions(options, { ...config, stop: Object.freeze(['END']) }), options)
})

class NativeLlmError extends Error {
  constructor(message, code, facts) { super(message); this.code = code; this.failure = { message, code, ...facts } }
}

test('失败使用调用方原生异常类，保留安全分类/HTTP，丢弃正文/ID/原因/重试和删图指令', () => {
  for (const code of ['AUTH', 'RATE_LIMIT', 'QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'TRANSPORT',
    'TIMEOUT', 'MALFORMED_RESPONSE', 'EMPTY_RESPONSE', 'INVALID_PREPARED_CALL', 'SERVER']) {
    const error = modelCallError(NativeLlmError, { code, status: 429, message: 'PRIVATE_SECRET',
      requestId: 'PRIVATE_ID', providerRetryAfterMs: 1, offloadImages: 10, cause: new Error('PRIVATE') })
    assert.ok(error instanceof NativeLlmError)
    assert.deepEqual(error.failure, { message: `AWU model call failed: ${code}`, code, status: 429 })
    assert.ok(!JSON.stringify(error).includes('PRIVATE'))
  }
  for (const failure of [null, undefined, 'PRIVATE', { code: 'PRIVATE', status: '401' },
    { code: [], status: true }, { status: 9999 }, { message: 'HTTP 401 context exceeded PRIVATE' }]) {
    assert.deepEqual(modelCallError(NativeLlmError, failure).failure,
      { message: 'AWU model call failed: UNKNOWN', code: 'UNKNOWN' })
  }
})
