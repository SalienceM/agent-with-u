// 单次发送的目录读取：唯一同源地址、只读 GET、有界时间/正文、不跨 worker 缓存。
export const CATALOG_TIMEOUT_MS = 5000
export const MAX_CATALOG_BYTES = 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const verdict = (capability, reason, source = 'none') => Object.freeze({ capability, reason, source })

export function createImageCatalog(ctx, protocol, transport) {
  const shutdown = new AbortController()
  let inFlight
  let closed = false
  async function load(connection, route, signal) {
    let reader
    let cancelReader
    try {
      if (!protocol || typeof protocol.parseModelListing !== 'function' || typeof protocol.resolveListedCatalog !== 'function') {
        return verdict('unknown', 'native_catalog_unavailable')
      }
      const target = new URL(connection.listingURL)
      if (target.origin !== new URL(connection.endpoint).origin || target.pathname !== '/models'
          || target.username || target.password || target.search || target.hash) {
        return verdict('unknown', 'catalog_route_invalid')
      }
      const response = await globalThis.fetch(target.href, { method: 'GET', headers: connection.headers,
        redirect: 'error', signal })
      if (response.redirected || (response.url && response.url !== target.href)) return verdict('unknown', 'catalog_redirect')
      if (!response.ok) { await response.body?.cancel(); return verdict('unknown', 'catalog_unavailable') }
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_CATALOG_BYTES)) {
        await response.body?.cancel()
        return verdict('unknown', 'catalog_too_large')
      }
      reader = response.body?.getReader()
      if (!reader) return verdict('unknown', 'catalog_invalid')
      cancelReader = () => { void reader.cancel().catch(() => {}) }
      signal.addEventListener('abort', cancelReader, { once: true })
      const chunks = []
      let bytes = 0
      while (true) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_CATALOG_BYTES) { await reader.cancel(); return verdict('unknown', 'catalog_too_large') }
        chunks.push(value)
      }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)))
      if (!object(body) || !Array.isArray(body.data)) return verdict('unknown', 'catalog_invalid')
      const rows = body.data.filter(row => object(row) && row.id === route.model)
      if (rows.length !== 1) return verdict('unknown', rows.length ? 'catalog_ambiguous' : 'model_unlisted')
      const row = rows[0]
      // 原生解析器会补 text 默认值；准入必须先检查服务端明确字段，不能把默认当证据。
      if (!Array.isArray(row.input_modalities) || !row.input_modalities.length
          || !row.input_modalities.every(value => typeof value === 'string' && value.length > 0)
          || !object(row.api_capabilities) || !object(row.api_capabilities.anthropic_messages)) {
        return verdict('unknown', 'catalog_incomplete')
      }
      const listing = protocol.parseModelListing({ data: [row] })
      const entry = listing.entries.find(item => item.id === route.model)
      if (!entry?.capabilities.usable || entry.requirement.kind === 'invalid') return verdict('unknown', 'catalog_invalid')
      const resolved = protocol.resolveListedCatalog({ listing: listing.entries, supported: connection.models,
        routeMaxTokens: connection.maxTokens, overrides: {}, clientVersion: protocol.clientVersion })
      if (resolved.problems.length) return verdict('unknown', 'catalog_invalid')
      const refusal = resolved.refusals.get(route.model)
      if (refusal) return verdict('unsupported', refusal.kind === 'upgrade-required' ? 'runtime_version_required' : 'runtime_model_unsupported', 'native-admission')
      if (!row.input_modalities.includes('image')) return verdict('unsupported', 'endpoint_text_only', 'endpoint-declaration')
      // 精确 adapter 结果不是端点声明的替代品；两份证据必须同时成立。
      signal.throwIfAborted()
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      signal.throwIfAborted()
      if (info?.provider !== route.provider || info?.id !== route.model || !Array.isArray(info.inputModalities)) {
        return verdict('unknown', 'native_metadata_invalid')
      }
      if (!info.inputModalities.includes('image')) return verdict('unsupported', 'runtime_text_only', 'native-adapter')
      return verdict('supported', 'route_declares_image', 'endpoint-and-native')
    } catch {
      return verdict('unknown', signal.aborted ? 'catalog_cancelled' : 'catalog_unavailable')
    } finally {
      if (cancelReader) signal.removeEventListener('abort', cancelReader)
      if (reader) {
        try { await reader.cancel() } catch { /* 已关闭/取消不泄露底层错误 */ }
        reader.releaseLock()
      }
    }
  }
  return Object.freeze({
    check(connection, route) {
      if (closed) return Promise.resolve(verdict('unknown', 'catalog_closed'))
      if (typeof transport?.readCatalog !== 'function') return Promise.resolve(verdict('unknown', 'catalog_guard_unavailable'))
      const key = JSON.stringify([connection.revision, route.provider, route.model])
      if (inFlight) return inFlight.key === key ? inFlight.promise : Promise.resolve(verdict('unknown', 'catalog_route_changed'))
      const deadline = new AbortController()
      const signal = AbortSignal.any([shutdown.signal, deadline.signal])
      let timer
      let abortHandler
      const aborted = new Promise(resolve => {
        abortHandler = () => resolve(verdict('unknown', closed ? 'catalog_closed' : 'catalog_timeout'))
        signal.addEventListener('abort', abortHandler, { once: true })
        timer = setTimeout(() => deadline.abort(), CATALOG_TIMEOUT_MS)
      })
      let reading
      try { reading = transport.readCatalog(() => load(connection, route, signal), signal) }
      catch { reading = Promise.resolve(verdict('unknown', 'catalog_guard_unavailable')) }
      reading = Promise.resolve(reading).catch(() => verdict('unknown', 'catalog_guard_unavailable'))
      const promise = Promise.race([reading, aborted]).finally(() => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abortHandler)
        if (inFlight?.promise === promise) inFlight = undefined
      })
      inFlight = { key, promise }
      return promise
    },
    close() { closed = true; shutdown.abort() },
  })
}
