// 仅复制原生已解析的调用参数与白名单错误事实，不复制供应商正文或重试指令。
const CONTROL_KEYS = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop']
const FAILURE_CODES = new Set([
  'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT',
  'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST', 'SERVER', 'TRANSPORT', 'TIMEOUT',
  'MALFORMED_RESPONSE', 'EMPTY_RESPONSE', 'ABORTED', 'INVALID_PREPARED_CALL',
  'UNSUPPORTED_REASONING_EFFORT', 'NO_ADAPTER',
])

export function callConfig(options) {
  return Object.fromEntries(CONTROL_KEYS.filter(key => options[key] !== undefined).map(key => [key, options[key]]))
}

export function preparedOptions(options, config) {
  // 普通 Agent 请求已冻结并带原生身份标记；配置一致时保留原对象。
  if (CONTROL_KEYS.every(key => key === 'stop'
    ? options.stop === config.stop || (Array.isArray(options.stop) && Array.isArray(config.stop)
      && options.stop.length === config.stop.length && options.stop.every((value, index) => value === config.stop[index]))
    : options[key] === config[key])) return options
  // 压缩等辅助调用尚未补齐默认值。复制到新对象，不改调用方的冻结配置/消息。
  const resolved = { ...options }
  for (const key of CONTROL_KEYS) {
    if (config[key] === undefined) delete resolved[key]
    else resolved[key] = config[key]
  }
  return Object.freeze(resolved)
}

export function modelCallError(LlmError, failure) {
  const code = FAILURE_CODES.has(failure?.code) ? failure.code : 'UNKNOWN'
  const status = failure?.status
  const facts = Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : undefined
  // 使用已挂载运行时导出的类，避免 bundle 内的另一份构造器导致 instanceof 失效。
  // 直接抛出而非转发 finish，保留“不自动重发/不删图恢复”的现有边界。
  return new LlmError(`AWU model call failed: ${code}`, code, facts)
}
