// 仅显式测试挂载，不是产品能力放行参数。不导入或修改上游实现。
import { appendFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ImageEgressError, installImageEgressGuard } from '../../tools/deepseek-harness/image-egress.mjs'
import { createNativeImageConnection } from '../../tools/deepseek-harness/image-identity.mjs'
import { createImageCatalog } from '../../tools/deepseek-harness/image-catalog.mjs'

export const name = 'awu-image-contract-fixture'
export const inject = ['llm', 'agents']

export function apply(ctx, config) {
  const origin = new URL(config.origin)
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw new Error('Nonlocal fixture origin')
  const record = event => appendFileSync(config.output, JSON.stringify(event) + '\n')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== origin.origin) {
      record({ type: 'blocked-network', host: 'non-fixture' })
      throw new Error('Native fixture forbids external network')
    }
    return originalFetch(input, { ...init, redirect: 'error' })
  }
  const egress = ['guarded', 'revoked'].includes(config.egress)
    ? installImageEgressGuard({ endpoint: `${origin.origin}/v1`, identity: config.identity }) : undefined
  let catalogGuard
  if (config.egress === 'revoked') egress.revoke()
  ctx.effect(() => () => {
    if (egress) egress.revoke()
    else if (catalogGuard) catalogGuard.revoke()
    else if (Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.configurable) globalThis.fetch = originalFetch
  })
  const dispatchContext = new AsyncLocalStorage()
  const connectionResolver = createNativeImageConnection(ctx)
  ctx.on('agent/created', ({ agent }) => {
    if (config.egress) {
      agent.ctx.on('llm/stream', async function* (options, next) {
        if (!egress) throw new ImageEgressError('guard_unavailable')
        const scope = { ...config.identity, provider: options.provider, model: options.model }
        const preparedEntry = dispatchContext.getStore()
        if (preparedEntry?.options === options && !preparedEntry.entered) {
          egress.assertActive(scope)
          yield* next()
          return
        }
        try { yield* egress.stream(scope, () => next(), options.signal) }
        finally { record({ type: 'egress', ...egress.snapshot() }) }
      })
    }
    if (config.mode === 'route-change') {
      agent.ctx.on('agent/request', async (_request, next) => ({ ...await next(), model: 'unlisted-model' }))
    }
    if (config.mode === 'invalidate-route') {
      agent.ctx.on('agent/request', async (_request, next) => {
        const request = await next()
        ctx.emit('llm/adapters-updated') // 仅隔离夹具触发真实桥的修订撤销监听。
        return request
      })
    }
    agent.ctx.on('llm/stream', async function* (options, next) {
      const nested = dispatchContext.getStore()
      if (nested?.options === options && !nested.entered) {
        nested.entered = true
        record({ type: 'prepared-reentry' })
        yield* next()
        return
      }
      record({ type: 'stream', provider: options.provider, model: options.model,
        images: options.messages.flatMap(message => message.content).filter(block => block.type === 'image').length })
      if (config.mode === 'catalog') {
        const { imageCatalogProtocol } = await import('../../build/deepseek-harness/bridge/lib/index.mjs')
        const connection = await connectionResolver.resolve(options.provider, options.model)
        catalogGuard = installImageEgressGuard({ endpoint: connection.endpoint, identity: config.identity, headers: connection.headers })
        const catalog = createImageCatalog(agent.ctx, imageCatalogProtocol, {
          readCatalog: (action, signal) => catalogGuard.readCatalog(config.identity, action, signal),
        })
        try {
          const [first, second] = await Promise.all([catalog.check(connection, options), catalog.check(connection, options)])
          record({ type: 'catalog', ...first, coalesced: first === second })
        } finally { catalog.close(); catalogGuard.revoke() }
        // 这里只验目录契约，不将 fixture 观察当作发送授权，也不做识图探针。
        throw new Error('Fixture stopped after catalog contract')
      }
      if (config.mode === 'identity') {
        try {
          const connection = await connectionResolver.resolve(options.provider, options.model)
          record({ type: 'identity', endpointMatches: connection.endpoint === `${origin.origin}/v1`,
            listingMatches: connection.listingURL === `${origin.origin}/models`, source: connection.endpointSource,
            stable: connection.revision === (await connectionResolver.resolve(options.provider, options.model)).revision })
        } catch (error) {
          record({ type: 'identity-error', code: error.code, entries: [...ctx.get('loader').entries()]
            .filter(entry => entry.options.id === 'llm' || entry.options.id === 'llm-deepseek')
            .map(entry => ({ id: entry.options.id, disabled: entry.disabled, state: entry.fiber?.state,
              runtime: entry.fiber?.runtime?.name, module: entry.moduleNamespace?.name,
              keyValidator: typeof entry.moduleNamespace?.assertUsableApiKey,
              resolver: typeof entry.moduleNamespace?.resolveAdapterOptions,
              launchEnvironment: typeof entry.fiber?.ctx.get('launchEnvironment')?.get,
              sameApply: entry.moduleNamespace?.apply === entry.fiber?.runtime?.callback })) })
          throw error
        }
      }
      const info = await agent.ctx.llm.resolveModelInfo(options.provider, options.model)
      record({ type: 'metadata', model: options.model, modalities: info.inputModalities })
      if (['observe', 'route-change', 'invalidate-route'].includes(config.mode)) {
        yield* next()
        return
      }
      const { provider, model, reasoningEffort, maxTokens } = options
      const prepared = await agent.ctx.llm.prepareCall({ provider, model, reasoningEffort, maxTokens }, options.signal)
      record({ type: 'prepared', model: prepared.config.model, modalities: prepared.inputModalities,
        frozen: Object.isFrozen(prepared) && Object.isFrozen(prepared.config) })
      const hasImages = options.messages.some(message => message.content.some(block => block.type === 'image'))
      if (hasImages && !prepared.inputModalities?.includes('image')) {
        record({ type: 'rejected-text-route' })
        throw new Error('Fixture final guard rejects text-only route')
      }
      const token = { options, entered: false }
      const stream = dispatchContext.run(token, () => prepared.stream(options))
      const iterator = stream[Symbol.asyncIterator]()
      try {
        while (true) {
          const item = await dispatchContext.run(token, () => iterator.next())
          if (item.done) break
          yield item.value
        }
      } finally {
        if (iterator.return) await dispatchContext.run(token, () => iterator.return())
      }
      // 已消耗 handle 的二次 dispatch 必须在 provider I/O 前拒绝。
      try {
        prepared.stream(options)
        throw new Error('Fixture prepared handle was reusable')
      } catch (error) {
        if (error.code !== 'INVALID_PREPARED_CALL') throw error
        record({ type: 'reuse-rejected', code: error.code })
      }
    })
    // 位于图片守卫之后的中间件必须被走到，且只走一次。
    agent.ctx.on('llm/stream', async function* (_options, next) {
      record({ type: 'middleware' })
      yield* next()
    })
  })
}
