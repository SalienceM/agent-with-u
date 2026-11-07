// 只读当前已挂载原生插件的公开配置接缝；不复制配置优先级或读取用户文件。
import { createHmac, randomBytes } from 'node:crypto'

export class ImageAdmissionError extends Error {
  constructor(code) {
    super(`AWU image admission refused: ${code}`)
    this.name = 'ImageAdmissionError'
    this.code = code
  }
}

const fail = code => { throw new ImageAdmissionError(code) }
const active = entry => entry?.disabled === false && entry.fiber?.state === 2 && entry.fiber.uid != null

/** 密钥与地址仅存在于 owned worker 内部；对外只返回随机盐隔离的路线标识。 */
export function createNativeImageConnection(ctx) {
  const salt = randomBytes(32)
  const objectIds = new WeakMap()
  let nextId = 0
  const objectId = value => {
    if (!value || !['object', 'function'].includes(typeof value)) return null
    if (!objectIds.has(value)) objectIds.set(value, ++nextId)
    return objectIds.get(value)
  }
  const stamp = value => createHmac('sha256', salt).update(JSON.stringify(value)).digest('hex')

  async function resolve(provider, model) {
    try {
      if (provider !== 'deepseek-official' || typeof model !== 'string' || !model || model.length > 200) {
        fail('route_unavailable')
      }
      const loader = ctx.get('loader')
      const directory = ctx.llm.listConfigurableProviders().filter(row => row.provider === provider)
      if (directory.length !== 1 || directory[0].settingsPath?.length !== 0) fail('connection_unavailable')
      const entries = [...loader.entries()]
      const matches = entries.filter(entry => entry.options.id === directory[0].settingsNs && active(entry))
      if (matches.length !== 1) fail('connection_unavailable')
      const entry = matches[0]
      // Runtime 只保存 callback/schema；原始 moduleNamespace 才是原生公开导出的解析函数。
      const module = entry.moduleNamespace
      if (entry.fiber.runtime?.name !== 'llm-deepseek-api-key' || module?.name !== 'llm-deepseek-api-key'
          || module.apply !== entry.fiber.runtime.callback
          || typeof module.plainOptions !== 'function' || typeof module.resolveAdapterOptions !== 'function') {
        fail('connection_unavailable')
      }
      const llmEntries = entries.filter(row => active(row) && row.fiber.runtime?.name === 'LlmRuntime'
        && row.moduleNamespace?.LlmRuntime === row.fiber.runtime.callback
        && typeof row.moduleNamespace?.assertUsableApiKey === 'function')
      if (llmEntries.length !== 1) fail('connection_unavailable')
      const environment = entry.fiber.ctx.get('launchEnvironment')
      // 产品 CLI 必须提供启动快照；缺失时不从 UI 或本轮 process.env 猜测。
      if (typeof environment?.get !== 'function') fail('connection_unavailable')
      const config = module.plainOptions(entry.fiber.config)
      const connection = module.resolveAdapterOptions(config, environment)
      const credentials = entry.fiber.ctx.get('credentials')
      let hit
      let credentialSource
      if (credentials !== undefined) {
        hit = await credentials.resolve(connection.apiKeyEnv)
        credentialSource = ['credentials', hit?.source]
      } else {
        hit = environment.get(connection.apiKeyEnv)
        credentialSource = ['launch-environment', hit?.source]
      }
      if (!hit || typeof hit.value !== 'string') fail('credential_unavailable')
      let apiKey
      try { apiKey = llmEntries[0].moduleNamespace.assertUsableApiKey(hit.value, 'awu-image', 'current-route') }
      catch { fail('credential_unavailable') }
      const base = new URL(connection.baseURL)
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        fail('connection_unavailable')
      }
      const apiRoot = connection.baseURL.replace(/\/+$/u, '')
      const endpoint = new URL(apiRoot).pathname.endsWith('/v1') ? apiRoot : `${apiRoot}/v1`
      const endpointSource = config.baseURL != null ? 'native-config'
        : environment.get('DEEPSEEK_BASE_URL')?.source ?? 'native-default'
      // Cordis 每次服务读取可返回新 proxy，不能把 proxy 引用误作配置修订。
      const revision = stamp([provider, model, entry.fiber.uid, objectId(module),
        config, connection, credentialSource, apiKey])
      return Object.freeze({ endpoint, listingURL: new URL('/models', base.origin).href,
        headers: Object.freeze({ 'x-api-key': apiKey }), revision,
        models: Object.freeze(structuredClone(connection.models)), maxTokens: connection.maxTokens,
        // 这是来源类别，不携带变量名、文件路径、端点或凭据指纹。
        endpointSource: ['native-config', 'process', 'project-env', 'user-env', 'native-default'].includes(endpointSource)
          ? endpointSource : 'native-config',
      })
    } catch (error) {
      if (error instanceof ImageAdmissionError) throw error
      fail('connection_unavailable')
    }
  }
  return Object.freeze({ resolve })
}
