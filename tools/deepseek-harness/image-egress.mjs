// 锁定原生 fetch 接缝：目录/Files/Messages 同一路线，目录有界、远端 DELETE 永不放行。
import { AsyncLocalStorage } from 'node:async_hooks'

const IDENTITY_KEYS = ['sessionId', 'generation', 'configFingerprint', 'provider', 'model']

export class ImageEgressError extends Error {
  constructor(code) {
    super(`AWU image transport refused: ${code}`)
    this.name = 'ImageEgressError'
    this.code = code
  }
}

/** endpoint 必须由受信调用方提供原生 Messages API root，而非用户附件 URL。 */
export function installImageEgressGuard({ endpoint, identity, headers }, host = globalThis) {
  const root = new URL(endpoint)
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash
      || !IDENTITY_KEYS.every(key => typeof identity?.[key] === 'string' && identity[key].length > 0
        && identity[key].length <= 200)) throw new ImageEgressError('invalid_scope')
  const expected = Object.freeze(Object.fromEntries(IDENTITY_KEYS.map(key => [key, identity[key]])))
  const prefix = root.pathname.replace(/\/+$/, '')
  const files = `${prefix}/files`
  const messages = `${prefix}/messages`
  const expectedHeaders = headers && new Headers(headers)
  const original = host.fetch
  const descriptor = Object.getOwnPropertyDescriptor(host, 'fetch')
  if (typeof original !== 'function' || descriptor?.configurable !== true) {
    throw new ImageEgressError('guard_unavailable')
  }
  const calls = new AsyncLocalStorage()
  const shutdown = new AbortController()
  let revoked = false
  let blockedDeletes = 0
  let rejectedCalls = 0
  let activeCalls = 0
  const refuse = code => {
    rejectedCalls = Math.min(rejectedCalls + 1, Number.MAX_SAFE_INTEGER)
    if (code === 'remote_delete_forbidden') blockedDeletes = Math.min(blockedDeletes + 1, Number.MAX_SAFE_INTEGER)
    throw new ImageEgressError(code)
  }
  const assertReady = scope => {
    if (revoked || host.fetch !== guardedFetch) refuse('guard_unavailable')
    if (!IDENTITY_KEYS.every(key => scope?.[key] === expected[key])) refuse('scope_mismatch')
  }
  async function guardedFetch(input, init) {
    let url
    let method
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      method = String(init?.method ?? (typeof input === 'object' ? input.method : undefined) ?? 'GET').toUpperCase()
    } catch { return refuse('invalid_request') }
    const token = calls.getStore()
    const filePath = url.pathname === files || url.pathname.startsWith(`${files}/`)
    const catalogPath = url.pathname === '/models'
    const protectedRoute = url.origin === root.origin && (filePath || url.pathname === messages || catalogPath)
    // 同一个 owned worker 的原生端点不能通过漏传异步上下文绕开防护。
    if (!token && protectedRoute) return refuse('scope_missing')
    if (!token) return Reflect.apply(original, host, [input, init])
    assertReady(token.identity)
    if (!token.active || token.signal?.aborted) return refuse('scope_inactive')
    if (url.username || url.password || !protectedRoute || url.hash) return refuse('route_mismatch')
    if (method === 'DELETE') return refuse('remote_delete_forbidden')
    if (token.kind === 'catalog' && !catalogPath) return refuse('method_forbidden')
    if (expectedHeaders) {
      const actual = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined))
      if (actual.get('x-api-key') !== expectedHeaders.get('x-api-key') || actual.has('authorization')) return refuse('credential_mismatch')
    }
    if (catalogPath) {
      if (method !== 'GET' || url.search) return refuse('method_forbidden')
      return boundedCatalogFetch(input, init, token)
    }
    if (!(filePath ? (method === 'GET' || (url.pathname === files && method === 'POST'))
      : method === 'POST')) return refuse('method_forbidden')
    const signals = [shutdown.signal]
    if (token.signal) signals.push(token.signal)
    const requestSignal = init?.signal ?? (typeof input === 'object' ? input.signal : undefined)
    if (requestSignal) signals.push(requestSignal)
    // 不复制/解析正文，不更换凭据、目标或原生序列化；禁止重定向并传播停止。
    return Reflect.apply(original, host, [input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) }])
  }
  async function boundedCatalogFetch(input, init, token) {
    const deadline = new AbortController()
    const signals = [shutdown.signal, deadline.signal]
    if (token.signal) signals.push(token.signal)
    const ownSignal = init?.signal ?? (typeof input === 'object' ? input.signal : undefined)
    if (ownSignal) signals.push(ownSignal)
    const signal = AbortSignal.any(signals)
    const timer = setTimeout(() => deadline.abort(new ImageEgressError('catalog_timeout')), 5000)
    let reader
    let cancel
    let transferred = false
    const finish = () => {
      clearTimeout(timer)
      if (cancel) signal.removeEventListener('abort', cancel)
    }
    try {
      const response = await Reflect.apply(original, host, [input, { ...init, redirect: 'error', signal }])
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 1024 * 1024)) {
        await response.body?.cancel()
        refuse('catalog_too_large')
      }
      if (!response.body) return response
      reader = response.body.getReader()
      cancel = () => { void reader.cancel().catch(() => {}) }
      signal.addEventListener('abort', cancel, { once: true })
      let bytes = 0
      const body = new ReadableStream({
        async pull(controller) {
          try {
            signal.throwIfAborted()
            if (!token.active) refuse('scope_inactive')
            const item = await reader.read()
            signal.throwIfAborted()
            if (item.done) { finish(); reader.releaseLock(); controller.close(); return }
            bytes += item.value.byteLength
            if (bytes > 1024 * 1024) refuse('catalog_too_large')
            controller.enqueue(item.value)
          } catch (error) {
            finish()
            try { await reader.cancel() } catch { /* 原错误只保留受控分类 */ }
            controller.error(error instanceof ImageEgressError ? error : new ImageEgressError('catalog_cancelled'))
          }
        },
        async cancel() { finish(); try { await reader.cancel() } finally { reader.releaseLock() } },
      })
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected } })
      transferred = true
      return wrapped
    } finally { if (!transferred) finish() }
  }
  // 每个 owned worker 生命周期仅安装一次。停止只收紧权限，绝不恢复未防护 fetch。
  Object.defineProperty(host, 'fetch', { value: guardedFetch, writable: false, configurable: false,
    enumerable: descriptor.enumerable })
  const newToken = (scope, signal, kind = 'model') => {
    assertReady(scope)
    if (signal?.aborted) refuse('scope_inactive')
    if (calls.getStore()) refuse('nested_scope')
    activeCalls += 1
    return { identity: expected, active: true, signal, kind }
  }
  const finish = token => { token.active = false; activeCalls -= 1 }
  return Object.freeze({
    assertReady,
    assertActive(scope) {
      assertReady(scope)
      const token = calls.getStore()
      if (!token?.active || token.signal?.aborted) refuse('scope_inactive')
    },
    revoke() { revoked = true; shutdown.abort(new ImageEgressError('guard_unavailable')) },
    snapshot() { return { revoked, blockedDeletes, rejectedCalls, activeCalls } },
    async run(scope, action, signal) {
      const token = newToken(scope, signal)
      try { return await calls.run(token, action) }
      finally { finish(token) }
    },
    async readCatalog(scope, action, signal) {
      const token = newToken(scope, signal, 'catalog')
      try { return await calls.run(token, action) }
      finally { finish(token) }
    },
    async *stream(scope, open, signal) {
      const token = newToken(scope, signal)
      let iterator
      try {
        iterator = calls.run(token, () => open()[Symbol.asyncIterator]())
        while (true) {
          assertReady(scope)
          if (signal?.aborted) refuse('scope_inactive')
          const item = await calls.run(token, () => iterator.next())
          if (item.done) return
          yield item.value
        }
      } finally {
        // 关闭过程和遗留异步回调都不能继续 Files/模型副作用。
        finish(token)
        if (iterator?.return) await calls.run(token, () => iterator.return())
      }
    },
  })
}
