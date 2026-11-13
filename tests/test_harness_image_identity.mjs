import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNativeImageConnection } from '../tools/deepseek-harness/image-identity.mjs'
import { createImageAdmission, IMAGE_LIMITS } from '../tools/deepseek-harness/image-admission.mjs'
import { installBridge, RUNTIME_VERSION, SOURCE_COMMIT } from '../tools/deepseek-harness/bridge.mjs'
import { promptImageDigest } from '../tools/deepseek-harness/image-digest.mjs'

const runtime = { runtimeVersion: RUNTIME_VERSION, sourceCommit: SOURCE_COMMIT }
const identity = { ownerId: 'owner', executorId: 'executor', awuSessionId: 'awu-session', backendId: 'backend',
  sessionId: 'native', generation: 'generation', configFingerprint: 'fingerprint', provider: 'deepseek-official', model: 'deepseek-flash' }
const config = { ...identity, imageIdentity: { ...identity } }
const request = () => ({ ...identity, ...runtime, version: 1, bridgeVersion: 1, limits: { ...IMAGE_LIMITS }, imageDigest: 'a'.repeat(64) })

function fixture() {
  let credential = { value: 'fixture-secret', source: 'env' }
  const environment = { get(ref) { return ref === 'DEEPSEEK_BASE_URL'
    ? { value: 'http://127.0.0.1:43210', source: 'process' } : { value: 'ambient-key', source: 'project-env' } } }
  const credentials = { async resolve() { return credential } }
  const settings = { baseURL: undefined, apiKeyEnv: 'DEEPSEEK_API_KEY' }
  const module = { name: 'llm-deepseek-api-key', apply() {}, plainOptions: value => ({ ...value }),
    resolveAdapterOptions: (value, env) => ({ baseURL: value.baseURL ?? env.get('DEEPSEEK_BASE_URL').value, apiKeyEnv: value.apiKeyEnv }) }
  class LlmRuntime {}
  class LlmError extends Error {}
  const entries = [
    { options: { id: 'llm-deepseek' }, disabled: false, moduleNamespace: module,
      fiber: { state: 2, uid: 'adapter', runtime: { name: module.name, callback: module.apply }, config: settings,
        ctx: { get(name) { return name === 'credentials' ? credentials : environment } } } },
    { disabled: false, options: { id: 'llm' }, moduleNamespace: { LlmRuntime, LlmError, assertUsableApiKey(value) {
      if (!/^[!-~]+$/u.test(value.trim())) throw Error('private error text')
      return value.trim()
    } }, fiber: { state: 2, uid: 'llm', runtime: { name: 'LlmRuntime', callback: LlmRuntime } } },
  ]
  const listeners = new Map()
  const ctx = { get(name) { if (name === 'loader') return { entries: () => entries, async await() {} } },
    llm: { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }] },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  return { ctx, settings, entries, listeners, credentials, environment, setCredential(value) { credential = value } }
}

test('连接使用当前原生配置与凭据接缝，地址/key/source变化都使内部修订变化', async () => {
  const f = fixture(), resolver = createNativeImageConnection(f.ctx)
  const read = () => resolver.resolve(identity.provider, identity.model)
  const first = await read()
  assert.equal(first.endpoint, 'http://127.0.0.1:43210/v1')
  assert.equal(first.headers['x-api-key'], 'fixture-secret')
  assert.equal(first.revision, (await read()).revision)
  f.settings.baseURL = 'http://127.0.0.1:54321/anthropic/v1/'
  const changed = await read()
  assert.equal(changed.endpoint, 'http://127.0.0.1:54321/anthropic/v1')
  assert.equal(changed.listingURL, 'http://127.0.0.1:54321/models')
  assert.equal(changed.endpointSource, 'native-config')
  assert.notEqual(changed.revision, first.revision)
  f.setCredential({ value: 'different-key', source: 'env' })
  const keyChanged = await read()
  assert.notEqual(keyChanged.revision, changed.revision)
  f.setCredential({ value: 'different-key', source: 'file' })
  assert.notEqual((await read()).revision, keyChanged.revision)
  assert.notEqual((await createNativeImageConnection(f.ctx).resolve(identity.provider, identity.model)).revision, (await read()).revision)
})

test('存在凭据服务但无命中不回退环境；无服务才使用启动快照；原始错误不向外传播', async () => {
  const f = fixture(), resolver = createNativeImageConnection(f.ctx)
  const read = () => resolver.resolve(identity.provider, identity.model)
  f.setCredential(undefined)
  await assert.rejects(read(), { code: 'credential_unavailable' })
  f.credentials.resolve = async () => { throw Error('private-key-and-http-body') }
  await assert.rejects(read(), error => error.code === 'connection_unavailable' && !error.message.includes('private'))
  f.entries[0].fiber.ctx.get = name => name === 'launchEnvironment' ? f.environment : undefined
  assert.equal((await read()).headers['x-api-key'], 'ambient-key')
  f.entries[0].fiber.ctx.get = () => undefined
  await assert.rejects(read(), { code: 'connection_unavailable' })
})

test('缺失/重复/停用 provider 与不相符的模块不能作为原生连接证据', async () => {
  for (const mutate of [f => { f.entries[0].disabled = true }, f => f.entries.push(f.entries[0]),
    f => { f.entries[0].fiber.state = 4 }, f => { f.entries[0].moduleNamespace = {} },
    f => { f.ctx.llm.listConfigurableProviders = () => [] }]) {
    const f = fixture(); mutate(f)
    await assert.rejects(createNativeImageConnection(f.ctx).resolve(identity.provider, identity.model), { code: 'connection_unavailable' })
  }
})

test('扩展冻结完整身份、版本和限额；尚无能力证据绝不允许图片', async () => {
  const f = fixture(), admission = createImageAdmission(f.ctx, config, runtime, IMAGE_LIMITS)
  admission.initialize(identity)
  const first = await admission.admit(request())
  assert.equal(first.reason, 'native_catalog_unavailable')
  assert.equal(first.admitted, false)
  assert.equal(first.capability, 'unknown')
  const serialized = JSON.stringify(first)
  for (const secret of ['fixture-secret', 'DEEPSEEK_API_KEY', '127.0.0.1', 'credentialSource', 'headers']) {
    assert.ok(!serialized.includes(secret))
  }
  assert.equal(first.route, undefined, 'Missing native extension must not expose a usable route token')
  for (const key of Object.keys(identity)) assert.equal((await admission.admit({ ...request(), [key]: 'other' })).reason, 'identity_mismatch')
  for (const key of ['version', 'bridgeVersion', 'runtimeVersion', 'sourceCommit']) {
    assert.equal((await admission.admit({ ...request(), [key]: 'other' })).reason, 'extension_mismatch')
  }
  for (const key of Object.keys(IMAGE_LIMITS)) {
    const value = request(); value.limits[key] += 1
    assert.equal((await admission.admit(value)).reason, 'limits_mismatch')
  }
  assert.equal((await admission.admit({ ...request(), supported: true })).reason, 'request_invalid')
  assert.equal((await admission.admit({ ...request(), imageDigest: 'data:image/png;base64,private' })).reason, 'digest_invalid')
  f.setCredential({ value: 'new-key', source: 'env' })
  assert.equal((await admission.admit(request())).reason, 'connection_changed')
  admission.close()
  assert.equal((await admission.admit(request())).reason, 'admission_closed')
})

test('解析中拓扑变化/关闭使迟到结果失效；未冻结身份或实际路线不符拒绝', async () => {
  for (const close of [false, true]) {
    const f = fixture(), admission = createImageAdmission(f.ctx, config, runtime, IMAGE_LIMITS)
    admission.initialize(identity)
    let release
    f.credentials.resolve = () => new Promise(resolve => { release = resolve })
    const pending = admission.admit(request())
    if (close) admission.close()
    else f.listeners.get('llm/adapters-updated')()
    release({ value: 'fixture-key', source: 'env' })
    assert.equal((await pending).reason, 'connection_changed')
  }
  for (const cfg of [{ ...config, imageIdentity: undefined }, { ...config, imageIdentity: { ...identity, model: 'other' } }]) {
    const admission = createImageAdmission(fixture().ctx, cfg, runtime, IMAGE_LIMITS)
    admission.initialize(identity)
    assert.equal((await admission.admit(request())).reason, 'identity_unavailable')
    admission.close()
  }
})

test('桥新扩展缺失/旧限额不影响文字握手；图片在原生 handler 前拒绝', async () => {
  const f = fixture(), calls = [], sent = []
  f.ctx.systemPrompt = { section() { return () => {} } }
  let handler
  const transport = { onRequest(fn) { handler = fn }, notify(...args) { sent.push(args) }, close() {} }
  const dispose = installBridge(f.ctx, transport,
    { async handleRequest(method) { calls.push(method); return {} }, async shutdown() {} },
    { sessionId: 'native', generation: 'generation', configFingerprint: 'fingerprint' },
    { stdout: { writableLength: 0 }, stdin: { destroy() {} } })
  await handler('initialize', identity)
  const cap = await handler('awu/capabilities')
  assert.equal(cap.protocolVersion, 1)
  assert.equal(cap.imageAdmission.version, 1)
  assert.equal(cap.imageAdmission.limits.maxFrameBytes, IMAGE_LIMITS.maxFrameBytes)
  await handler('awu/configure', { ...identity, constraints: '' })
  assert.equal((await handler('awu/imageAdmission', request())).reason, 'identity_unavailable')
  const result = await handler('session/prompt', { sessionId: 'native', contentBlocks: [{ type: 'image' }] })
  assert.equal(result.status, 'rejected')
  assert.equal(result.boundary, 'before-native-handler')
  assert.ok(!calls.includes('session/prompt'))
  await handler('session/prompt', { sessionId: 'native', contentBlocks: [{ type: 'text', text: 'safe' }] })
  assert.equal(calls.filter(method => method === 'session/prompt').length, 1)
  await dispose()
})

test('准入仅消费一次，真实连接修订变化拒绝 prompt，防护不可安装时不能放行', async () => {
  const f = fixture()
  f.ctx.llm.prepareCall = () => {}
  f.ctx.llm.resolveModelInfo = async () => ({ provider: identity.provider, id: identity.model, inputModalities: ['image'] })
  const protocol = { clientVersion: '0.2.1-rc.3',
    parseModelListing: () => ({ entries: [{ id: identity.model, capabilities: { usable: true }, requirement: { kind: 'none' } }] }),
    resolveListedCatalog: () => ({ problems: [], refusals: new Map() }) }
  let gets = 0
  globalThis.fetch = async () => {
    gets += 1
    return Response.json({ data: [{ id: identity.model, input_modalities: ['image'], api_capabilities: { anthropic_messages: {} } }] })
  }
  const admission = createImageAdmission(f.ctx, config, runtime, IMAGE_LIMITS, protocol)
  admission.initialize(identity)
  const blocks = [{ type: 'image', mimeType: 'image/png', data: Buffer.from('unit digest bytes').toString('base64') }]
  const valid = { ...request(), imageDigest: promptImageDigest(blocks) }
  assert.equal((await admission.admit({ ...valid, capability: 'supported' })).reason, 'request_invalid')
  assert.equal(gets, 0)
  const accepted = await admission.admit(valid)
  assert.equal(accepted.admitted, true)
  assert.equal((await admission.admit(valid)).reason, 'admission_used')
  f.setCredential({ value: 'replacement-credential', source: 'env' })
  const prompt = { sessionId: identity.sessionId, contentBlocks: blocks, awuImageAdmission: { admissionId: accepted.admissionId } }
  const refused = await admission.beforePrompt(prompt)
  assert.equal(refused.reason, 'connection_changed')
  assert.equal(refused.boundary, 'before-native-handler')
  assert.equal((await admission.beforePrompt(prompt)).reason, 'admission_required')
  assert.equal((await admission.admit(valid)).reason, 'admission_used')
  const another = createImageAdmission(f.ctx, config, runtime, IMAGE_LIMITS, protocol)
  another.initialize(identity)
  assert.equal((await another.admit(valid)).reason, 'safety_guard_unavailable')
  admission.close(); another.close()
})
