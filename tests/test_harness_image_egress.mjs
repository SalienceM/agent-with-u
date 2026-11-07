import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncResource } from 'node:async_hooks'
import { installImageEgressGuard } from '../tools/deepseek-harness/image-egress.mjs'

const identity = Object.freeze({ sessionId: 'fixture', generation: 'generation-one',
  configFingerprint: 'fixture-only', provider: 'deepseek-official', model: 'deepseek-flash' })
const endpoint = 'http://127.0.0.1:13131/v1'
function fixture() {
  const sent = []
  const host = { fetch: async (input, init) => { sent.push({ input, init }); return new Response('{}') } }
  const guard = installImageEgressGuard({ endpoint, identity }, host)
  return { host, guard, sent }
}
const code = value => error => error.code === value

test('native metadata reads are bounded even when the native caller uses response.text()', async () => {
  let bytes = 1024 * 1024
  const host = { fetch: async () => new Response('x'.repeat(bytes), { headers: { 'content-length': '1' } }) }
  const headers = { 'x-api-key': 'fixture-key' }
  const guard = installImageEgressGuard({ endpoint, identity, headers }, host)
  const read = () => guard.readCatalog(identity, async () => (await host.fetch('http://127.0.0.1:13131/models', { headers })).text())
  assert.equal((await read()).length, bytes)
  bytes += 1
  await assert.rejects(read(), code('catalog_too_large'))
  await assert.rejects(guard.readCatalog(identity, () => host.fetch(`${endpoint}/files`, { method: 'POST', headers })), code('method_forbidden'))
  await assert.rejects(guard.readCatalog(identity, () => host.fetch('http://127.0.0.1:13131/models?key=private', { headers })), code('method_forbidden'))
  guard.revoke()
})

test('actual credentials cannot change inside Files, Messages or directory requests', async () => {
  const sent = []
  const headers = { 'x-api-key': 'fixture-key' }
  const host = { fetch: async (...args) => { sent.push(args); return new Response('{}') } }
  const guard = installImageEgressGuard({ endpoint, identity, headers }, host)
  for (const path of [`${endpoint}/files`, `${endpoint}/messages`, 'http://127.0.0.1:13131/models']) {
    for (const bad of [undefined, { 'x-api-key': 'other' }, { ...headers, authorization: 'Bearer other' }]) {
      await assert.rejects(guard.run(identity, () => host.fetch(path, { method: 'POST', headers: bad })), code('credential_mismatch'))
    }
  }
  const req = new Request(`${endpoint}/messages`, { method: 'POST', headers })
  await guard.run(identity, () => host.fetch(req))
  await assert.rejects(guard.run(identity, () => host.fetch(req, { headers: {} })), code('credential_mismatch'))
  assert.equal(sent.length, 1)
})

test('native directory body shares five-second cancellation and cannot live beyond its scope', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reading, cancelled = false
  const started = new Promise(resolve => { reading = resolve })
  const host = { fetch: async () => new Response(new ReadableStream({
    pull() { reading(); return new Promise(() => {}) }, cancel() { cancelled = true },
  })) }
  const guard = installImageEgressGuard({ endpoint, identity }, host)
  const pending = guard.readCatalog(identity, async () => (await host.fetch('http://127.0.0.1:13131/models')).text())
  await started
  t.mock.timers.tick(5000)
  await assert.rejects(pending, code('catalog_timeout'))
  assert.equal(cancelled, true)
  assert.equal(guard.snapshot().activeCalls, 0)
})

test('native request bytes and credentials stay on the same transport; redirects are refused', async () => {
  const { host, guard, sent } = fixture()
  const init = { method: 'POST', body: 'fixture-body', headers: { 'x-api-key': 'fixture-only' }, redirect: 'follow' }
  await guard.run(identity, () => host.fetch(`${endpoint}/files`, init))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].input, `${endpoint}/files`)
  assert.equal(sent[0].init.body, init.body)
  assert.equal(sent[0].init.headers, init.headers)
  assert.equal(sent[0].init.redirect, 'error')
})

test('all file deletes, including own/foreign/encoded IDs and Request overrides, are blocked before I/O', async () => {
  const { host, guard, sent } = fixture()
  for (const id of ['own', 'other-session', 'user-file', 'encoded%2Ffile']) {
    await assert.rejects(guard.run(identity, () => host.fetch(`${endpoint}/files/${id}`, { method: 'DELETE' })),
      code('remote_delete_forbidden'))
  }
  const request = new Request(`${endpoint}/files/own`, { method: 'GET' })
  await assert.rejects(guard.run(identity, () => host.fetch(request, { method: 'delete' })), code('remote_delete_forbidden'))
  await assert.rejects(guard.run(identity, () => host.fetch(new Request(`${endpoint}/files/own`, { method: 'DELETE' }))),
    code('remote_delete_forbidden'))
  assert.equal(guard.snapshot().blockedDeletes, 6)
  assert.equal(sent.length, 0)
})

test('missing/stale scope and changed route cannot reach native endpoints', async () => {
  const { host, guard, sent } = fixture()
  await assert.rejects(host.fetch(`${endpoint}/files`, { method: 'POST' }), code('scope_missing'))
  for (const key of Object.keys(identity)) {
    await assert.rejects(guard.run({ ...identity, [key]: 'changed' }, () => host.fetch(`${endpoint}/messages`, { method: 'POST' })),
      code('scope_mismatch'))
  }
  for (const url of ['http://127.0.0.1:13132/v1/files', `${endpoint}/../other/files`, `${endpoint}/messages/other`]) {
    await assert.rejects(guard.run(identity, () => host.fetch(url, { method: 'POST' })), code('route_mismatch'))
  }
  await assert.rejects(guard.run(identity, () => host.fetch(`${endpoint}/files/own`, { method: 'POST' })), code('method_forbidden'))
  assert.equal(sent.length, 0)
})

test('guard is immutable and revoke never restores unguarded transport', async () => {
  const { host, guard, sent } = fixture()
  assert.throws(() => { host.fetch = () => {} }, TypeError)
  assert.throws(() => Object.defineProperty(host, 'fetch', { value: () => {} }), TypeError)
  await guard.run(identity, () => host.fetch(`${endpoint}/files`, { method: 'POST' }))
  assert.equal(sent[0].init.signal.aborted, false)
  guard.revoke()
  assert.equal(sent[0].init.signal.aborted, true)
  await assert.rejects(guard.run(identity, () => host.fetch(`${endpoint}/messages`, { method: 'POST' })), code('guard_unavailable'))
  await assert.rejects(host.fetch(`${endpoint}/files/own`, { method: 'DELETE' }), code('scope_missing'))
  assert.equal(sent.length, 1)
})

test('asynchronous generator preserves context; cleanup and escaped work lose permission', async () => {
  const { host, guard, sent } = fixture()
  let escaped
  let cleanupCode
  const stream = guard.stream(identity, async function* () {
    escaped = AsyncResource.bind(() => host.fetch(`${endpoint}/files`, { method: 'POST' }))
    try {
      await host.fetch(`${endpoint}/files`, { method: 'POST' })
      yield 'uploaded'
      await host.fetch(`${endpoint}/messages`, { method: 'POST' })
    } finally {
      try { await host.fetch(`${endpoint}/files/own`, { method: 'DELETE' }) }
      catch (error) { cleanupCode = error.code }
    }
  })
  assert.deepEqual(await stream.next(), { value: 'uploaded', done: false })
  await stream.return()
  assert.equal(cleanupCode, 'scope_inactive')
  await assert.rejects(escaped(), code('scope_inactive'))
  assert.equal(sent.length, 1)
  assert.equal(guard.snapshot().activeCalls, 0)
})

test('concurrent streams have independent cancellation and nested contexts are refused', async () => {
  const { host, guard, sent } = fixture()
  const stopped = new AbortController()
  const first = guard.stream(identity, async function* () {
    await host.fetch(`${endpoint}/files`, { method: 'POST' })
    yield 1
  }, stopped.signal)
  await first.next()
  stopped.abort()
  await assert.rejects(first.next(), code('scope_inactive'))
  await guard.run(identity, () => host.fetch(`${endpoint}/messages`, { method: 'POST' }))
  await assert.rejects(guard.run(identity, () => guard.run(identity, () => {})), code('nested_scope'))
  assert.equal(sent.length, 2)
  assert.equal(sent[0].init.signal.aborted, true)
  assert.equal(sent[1].init.signal.aborted, false)
  assert.equal(guard.snapshot().activeCalls, 0)
})

test('unavailable hook rejects installation, unrelated traffic is not a new model channel', async () => {
  const host = {}
  Object.defineProperty(host, 'fetch', { value: () => {} })
  assert.throws(() => installImageEgressGuard({ endpoint, identity }, host), code('guard_unavailable'))
  const fixtureState = fixture()
  await fixtureState.host.fetch('http://127.0.0.1:13131/unrelated', { method: 'GET' })
  assert.equal(fixtureState.sent.length, 1)
})

