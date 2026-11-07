import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createImageCatalog, CATALOG_TIMEOUT_MS, MAX_CATALOG_BYTES } from '../tools/deepseek-harness/image-catalog.mjs'

const route = { provider: 'deepseek-official', model: 'deepseek-flash' }
const connection = { revision: 'one', endpoint: 'http://127.0.0.1:41234/v1', listingURL: 'http://127.0.0.1:41234/models',
  headers: { 'x-api-key': 'fixture-secret' }, models: [{ id: route.model }], maxTokens: 1000 }
const row = () => ({ id: route.model, input_modalities: ['text', 'image'], api_capabilities: { anthropic_messages: {} } })
const response = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
// 网络/边界单元测试用最小契约；真实 parser/版本准入另由锁定运行时测试验证。
const protocol = { clientVersion: '0.2.1-rc.3', parseModelListing: body => ({ entries: body.data.map(row => ({
  id: row.id, requirement: { kind: 'none' }, capabilities: { usable: true },
})) }), resolveListedCatalog: () => ({ refusals: new Map(), problems: [] }) }
const context = () => ({ llm: { async resolveModelInfo() { return { provider: route.provider, id: route.model, inputModalities: ['text', 'image'] } } } })
const catalogFixture = ctx => createImageCatalog(ctx, protocol, { readCatalog: action => action() })

test('当前同源认证 GET，不允许重定向；相同在途合并但不缓存成功/跨 generation', async t => {
  let requests = 0, release
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests += 1
    assert.equal(url, connection.listingURL)
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.deepEqual(init.headers, connection.headers)
    await new Promise(resolve => { release = resolve })
    return response([row()])
  })
  const catalog = catalogFixture(context())
  const first = catalog.check(connection, route), second = catalog.check(connection, route)
  assert.equal(first, second)
  assert.equal((await catalog.check({ ...connection, revision: 'other' }, route)).reason, 'catalog_route_changed')
  release()
  assert.equal((await first).capability, 'supported')
  assert.equal(requests, 1)
  const next = catalog.check(connection, route); release(); await next
  assert.equal(requests, 2)
  const other = catalogFixture(context())
  const fresh = other.check(connection, route); release(); await fresh
  assert.equal(requests, 3)
  catalog.close(); other.close()
})

test('三态取目录与精确 adapter 交集；缺字段/重复/未列出不能沿用默认 image', async t => {
  let current = [row()]
  t.mock.method(globalThis, 'fetch', async () => response(current))
  const ctx = context(), catalog = catalogFixture(ctx)
  for (const [rows, capability, reason] of [
    [[row()], 'supported', 'route_declares_image'],
    [[{ ...row(), input_modalities: ['text'] }], 'unsupported', 'endpoint_text_only'],
    [[{ ...row(), input_modalities: undefined }], 'unknown', 'catalog_incomplete'],
    [[{ ...row(), api_capabilities: { anthropic_messages: true } }], 'unknown', 'catalog_incomplete'],
    [[{ ...row(), id: 'other' }], 'unknown', 'model_unlisted'],
    [[row(), row()], 'unknown', 'catalog_ambiguous'],
    [[{ ...row(), input_modalities: null }], 'unknown', 'catalog_incomplete'],
  ]) {
    current = rows
    assert.deepEqual(await catalog.check(connection, route), { capability, reason,
      source: capability === 'supported' ? 'endpoint-and-native' : capability === 'unsupported' ? 'endpoint-declaration' : 'none' })
  }
  current = [row()]
  ctx.llm.resolveModelInfo = async () => ({ provider: route.provider, id: route.model, inputModalities: ['text'] })
  assert.equal((await catalog.check(connection, route)).reason, 'runtime_text_only')
  ctx.llm.resolveModelInfo = async () => ({ provider: 'other', id: route.model, inputModalities: ['image'] })
  assert.equal((await catalog.check(connection, route)).reason, 'native_metadata_invalid')
  catalog.close()
})

test('完整读取最多 1 MiB，含无长度/伪造较小长度、坏 UTF-8、错误回显和重定向', async t => {
  let next
  t.mock.method(globalThis, 'fetch', async () => next())
  const catalog = catalogFixture(context())
  const checks = [
    [() => new Response('x', { headers: { 'content-length': MAX_CATALOG_BYTES + 1 } }), 'catalog_too_large'],
    [() => new Response('x'.repeat(MAX_CATALOG_BYTES + 1)), 'catalog_too_large'],
    [() => new Response('x'.repeat(MAX_CATALOG_BYTES + 1), { headers: { 'content-length': '1' } }), 'catalog_too_large'],
    [() => new Response(new Uint8Array([255])), 'catalog_unavailable'],
    [() => new Response('private-base64-and-api-key', { status: 403 }), 'catalog_unavailable'],
    [() => { const res = response([row()]); Object.defineProperty(res, 'redirected', { value: true }); return res }, 'catalog_redirect'],
    [() => { throw Error('private-token-url') }, 'catalog_unavailable'],
  ]
  for (const [create, expected] of checks) {
    next = create
    assert.equal((await catalog.check(connection, route)).reason, expected)
  }
  const text = JSON.stringify({ data: [row()] })
  next = () => new Response(text + ' '.repeat(MAX_CATALOG_BYTES - Buffer.byteLength(text)))
  assert.equal((await catalog.check(connection, route)).capability, 'supported')
  catalog.close()
})

test('5 秒涵盖响应正文和原生能力查询；关闭终止读取，不等待无响应网络', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  t.mock.method(globalThis, 'fetch', (_url, init) => { signal = init.signal; return new Promise(() => {}) })
  const catalog = catalogFixture(context())
  const first = catalog.check(connection, route)
  t.mock.timers.tick(CATALOG_TIMEOUT_MS)
  assert.equal((await first).reason, 'catalog_timeout')
  assert.equal(signal.aborted, true)
  const next = catalog.check(connection, route)
  catalog.close()
  assert.equal((await next).reason, 'catalog_closed')
  assert.equal(signal.aborted, true)
  assert.equal((await catalog.check(connection, route)).reason, 'catalog_closed')
  for (const stage of ['body', 'native']) {
    let entered
    const started = new Promise(resolve => { entered = resolve })
    const ctx = context()
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      signal = init.signal
      if (stage === 'body') return new Response(new ReadableStream({ pull() { entered(); return new Promise(() => {}) } }))
      return response([row()])
    })
    if (stage === 'native') ctx.llm.resolveModelInfo = () => { entered(); return new Promise(() => {}) }
    const check = catalogFixture(ctx)
    const result = check.check(connection, route)
    await started
    t.mock.timers.tick(CATALOG_TIMEOUT_MS)
    assert.equal((await result).reason, 'catalog_timeout')
    assert.equal(signal.aborted, true)
    check.close()
  }
})

test('同名异端点独立证据，坏目录目标不能发送凭据', async t => {
  const urls = []
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return url === connection.listingURL
    ? response([row()]) : response([{ ...row(), input_modalities: ['text'] }]) })
  const one = catalogFixture(context()), two = catalogFixture(context())
  assert.equal((await one.check(connection, route)).capability, 'supported')
  assert.equal((await two.check({ ...connection, revision: 'two', endpoint: 'http://127.0.0.1:41235/v1',
    listingURL: 'http://127.0.0.1:41235/models' }, route)).capability, 'unsupported')
  assert.equal((await one.check({ ...connection, listingURL: 'http://127.0.0.1:49999/models' }, route)).reason, 'catalog_route_invalid')
  assert.equal(urls.length, 2)
  one.close(); two.close()
})
