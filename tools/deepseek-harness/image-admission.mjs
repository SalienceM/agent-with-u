// 图片扩展与核心文字协议独立协商；旧核心握手不构成图片准入。
import { createNativeImageConnection, ImageAdmissionError } from './image-identity.mjs'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createImageCatalog } from './image-catalog.mjs'
import { installImageEgressGuard, ImageEgressError } from './image-egress.mjs'
import { promptImageDigest } from './image-digest.mjs'
import { IMAGE_ADMISSION_VERSION, IMAGE_BRIDGE_VERSION, IMAGE_LIMITS } from './image-limits.mjs'
export { IMAGE_ADMISSION_VERSION, IMAGE_BRIDGE_VERSION, IMAGE_LIMITS } from './image-limits.mjs'

export const IMAGE_IDENTITY_KEYS = Object.freeze(['ownerId', 'executorId', 'awuSessionId', 'backendId',
  'sessionId', 'generation', 'configFingerprint', 'provider', 'model'])
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !/[\x00-\x1f\x7f]/u.test(value)
const fail = code => { throw new ImageAdmissionError(code) }

export function createImageAdmission(ctx, config, runtime, transportLimits, catalogProtocol) {
  const resolver = createNativeImageConnection(ctx)
  let catalog
  let egress
  const binding = config.imageIdentity && Object.freeze(Object.fromEntries(IMAGE_IDENTITY_KEYS
    .map(key => [key, ['sessionId', 'generation', 'configFingerprint'].includes(key) ? config[key] : config.imageIdentity[key]])))
  const validBinding = binding && IMAGE_IDENTITY_KEYS.every(key => textId(binding[key]))
  const descriptor = Object.freeze({ version: IMAGE_ADMISSION_VERSION, bridgeVersion: IMAGE_BRIDGE_VERSION,
    limits: Object.freeze({ ...IMAGE_LIMITS, ...transportLimits }) })
  let initialRoute
  let connection
  let connectionTopology
  const routeId = randomUUID()
  let closed = false
  let revision = 0
  let grant
  let admitting = false
  let consumed = false
  let evidence
  const dispatchContext = new AsyncLocalStorage()
  // 只有当前 generation 的状态；卸载/替换 adapter 后，迟到的解析不再有效。
  const changed = () => { revision += 1; grant = undefined; egress?.revoke() }
  const disposeTopology = ctx.on('llm/adapters-updated', changed)
  const disposeConfig = ctx.on('loader/volatile-update', changed)
  const rejected = reason => ({ version: IMAGE_ADMISSION_VERSION, admitted: false,
    capability: 'unknown', reason, source: 'none', limits: descriptor.limits })
  const validate = params => {
    if (closed) fail('admission_closed')
    if (!validBinding || !initialRoute || !['provider', 'model'].every(key => binding[key] === initialRoute[key])) {
      fail('identity_unavailable')
    }
    if (!IMAGE_IDENTITY_KEYS.every(key => params?.[key] === binding[key])) fail('identity_mismatch')
    if (params.version !== IMAGE_ADMISSION_VERSION || params.bridgeVersion !== IMAGE_BRIDGE_VERSION
        || params.runtimeVersion !== runtime.runtimeVersion || params.sourceCommit !== runtime.sourceCommit) {
      fail('extension_mismatch')
    }
    if (!params.limits || Object.keys(params.limits).length !== Object.keys(IMAGE_LIMITS).length
        || !Object.entries(IMAGE_LIMITS).every(([key, value]) => params.limits[key] === value
          && descriptor.limits[key] === value)) fail('limits_mismatch')
    if (typeof params.imageDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(params.imageDigest)) fail('digest_invalid')
    // 客户端不能提交任意 URL、密钥、路径或能力声明来改变实际原生连接。
    const keys = [...IMAGE_IDENTITY_KEYS, 'version', 'bridgeVersion', 'runtimeVersion', 'sourceCommit', 'limits', 'imageDigest']
    if (Object.keys(params).some(key => !keys.includes(key))) fail('request_invalid')
  }
  const assertIdentity = () => {
    if (closed) fail('admission_closed')
    if (!validBinding || !initialRoute || !['provider', 'model'].every(key => binding[key] === initialRoute[key])) {
      fail('identity_unavailable')
    }
  }
  const currentConnection = async () => {
    assertIdentity()
    const at = revision
    if (connection && connectionTopology !== at) fail('connection_changed')
    const current = await resolver.resolve(binding.provider, binding.model)
    if (closed || at !== revision || (connection && current.revision !== connection.revision)) fail('connection_changed')
    return current
  }
  const ensureEvidence = async () => {
    const next = await currentConnection()
    connection ??= next
    connectionTopology ??= revision
    if (!catalogProtocol || typeof ctx.llm.prepareCall !== 'function') fail('native_catalog_unavailable')
    if (!egress) {
      egress = installImageEgressGuard({ endpoint: connection.endpoint, identity: binding, headers: connection.headers })
      catalog = createImageCatalog(ctx, catalogProtocol, {
        readCatalog: (action, signal) => egress.readCatalog(binding, action, signal),
      })
    }
    egress.assertReady(binding)
    evidence ??= await catalog.check(connection, binding)
    await currentConnection()
    return evidence
  }
  const safeReason = error => error instanceof ImageAdmissionError ? error.code
    : error instanceof ImageEgressError ? 'safety_guard_unavailable' : 'connection_unavailable'
  return Object.freeze({
    descriptor,
    initialize(params) { initialRoute = Object.freeze({ provider: params.provider, model: params.model }) },
    async admit(params) {
      if (admitting || consumed || grant) return rejected('admission_used')
      admitting = true
      try {
        validate(params)
        const observation = await ensureEvidence()
        if (observation.capability === 'supported') {
          grant = Object.freeze({ admissionId: randomUUID(), imageDigest: params.imageDigest, revision })
        }
        return { ...rejected(observation.reason), ...observation, admitted: Boolean(grant),
          ...(grant ? { admissionId: grant.admissionId } : {}),
          route: { ...binding, ...runtime, bridgeVersion: IMAGE_BRIDGE_VERSION, routeId },
          endpointSource: connection.endpointSource }
      } catch (error) {
        return rejected(safeReason(error))
      } finally { admitting = false }
    },
    async beforePrompt(params) {
      const hasImages = Array.isArray(params.contentBlocks) && params.contentBlocks.some(block => block?.type === 'image')
      if (!hasImages && !params.awuImageAdmission) return
      const ticket = grant
      grant = undefined // 核对开始即消费；并发 prompt 不能共享同一准入。
      consumed = true
      try {
        assertIdentity()
        const supplied = params.awuImageAdmission
        if (!ticket || !supplied || Object.keys(supplied).length !== 1
            || supplied.admissionId !== ticket.admissionId || params.sessionId !== binding.sessionId) fail('admission_required')
        if (ticket.revision !== revision) fail('connection_changed')
        if (promptImageDigest(params.contentBlocks) !== ticket.imageDigest) fail('digest_mismatch')
        await currentConnection()
        egress.assertReady(binding)
      } catch (error) {
        return { ...rejected(safeReason(error)), status: 'rejected', boundary: 'before-native-handler' }
      }
    },
    mount(agent) {
      // 在实际会话的原生 waterfall 中冻结并分派同一 handle；不创建第二模型通道。
      return agent.ctx.on('llm/stream', async function* (options, next) {
        const nested = dispatchContext.getStore()
        if (nested) {
          if (nested.options !== options || nested.entered) fail('dispatch_reentry')
          nested.entered = true
          await currentConnection()
          egress.assertActive(binding)
          yield* next()
          return
        }
        const hasImages = options.messages.some(message => message.content.some(block => block.type === 'image'))
        if (!hasImages && !egress) { yield* next(); return }
        assertIdentity()
        if (options.provider !== binding.provider || options.model !== binding.model) fail('route_changed')
        const observation = await ensureEvidence()
        if (observation.capability !== 'supported') fail(observation.reason)
        yield* egress.stream(binding, async function* () {
          const { provider, model, reasoningEffort, maxTokens } = options
          let prepared
          try { prepared = await agent.ctx.llm.prepareCall({ provider, model, reasoningEffort, maxTokens }, options.signal) }
          catch { fail('native_prepare_failed') }
          await currentConnection()
          if (!prepared.inputModalities?.includes('image') || prepared.config.provider !== provider
              || prepared.config.model !== model) fail('runtime_text_only')
          const token = { options, entered: false }
          const iterator = dispatchContext.run(token, () => prepared.stream(options)[Symbol.asyncIterator]())
          try {
            while (true) {
              const item = await dispatchContext.run(token, () => iterator.next())
              if (item.done) return
              // 不让原生上层按 IMAGE_OFFLOAD_REQUIRED 删图重试；不转发服务端原始错误。
              if (item.value.type === 'finish' && item.value.reason?.kind === 'error') {
                fail(item.value.reason.failure?.code === 'IMAGE_OFFLOAD_REQUIRED' ? 'image_offload_forbidden' : 'image_model_failed')
              }
              yield item.value
            }
          } finally { if (iterator.return) await dispatchContext.run(token, () => iterator.return()) }
        }, options.signal)
      }, { prepend: true })
    },
    close() { if (closed) return; closed = true; grant = undefined; catalog?.close(); egress?.revoke(); connection = undefined; disposeTopology(); disposeConfig() },
  })
}
