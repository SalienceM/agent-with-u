// 仅由受信打包入口装配；不创建第二个 stdin/stdout reader。
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createImageAdmission } from './image-admission.mjs'
import { createSteering } from './steering.mjs'
import { IMAGE_LIMITS, RUNTIME_VERSION, SOURCE_COMMIT } from './image-limits.mjs'
export { RUNTIME_VERSION, SOURCE_COMMIT } from './image-limits.mjs'

export const PROTOCOL_VERSION = 1
const MAX_FRAME = IMAGE_LIMITS.maxFrameBytes
const MAX_PENDING = IMAGE_LIMITS.maxPendingBytes
const MAX_CALLS = 256

export function installBridge(ctx, transport, server, config, io = process, extensions = {}) {
  for (const key of ['sessionId', 'generation', 'configFingerprint']) {
    if (typeof config[key] !== 'string' || !config[key] || config[key].length > 200) {
      throw new Error(`Invalid AWU bridge identity: ${key}`)
    }
  }
  const calls = new Map()
  const parents = new Map()
  const pending = new Map()
  const toolExecution = new AsyncLocalStorage()
  const disposers = []
  let closed = false
  let initialized = false
  let handshaken = false
  let configured = false
  let allowedTools
  let textOnly = false
  const permissionMode = config.permissionMode ?? 'workspace-write'
  const approvalPolicy = config.approvalPolicy ?? 'ask'
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permissionMode)
      || !['ask', 'never'].includes(approvalPolicy)) throw new Error('Invalid AWU access policy')
  let exitTask
  const steering = createSteering(config, extensions.createUserMessage)
  const images = createImageAdmission(ctx, config,
    { runtimeVersion: RUNTIME_VERSION, sourceCommit: SOURCE_COMMIT },
    { maxFrameBytes: MAX_FRAME, maxPendingBytes: MAX_PENDING }, extensions.imageCatalogProtocol)
  const belongs = (id) => {
    const seen = new Set()
    while (typeof id === 'string' && !seen.has(id)) {
      if (id === config.sessionId) return true
      seen.add(id)
      id = parents.get(id)
    }
    return false
  }
  const sendNotification = transport.notify.bind(transport)
  const notify = (method, params) => {
    if (closed) throw new Error('AWU bridge closed')
    if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n', 'utf8') > MAX_FRAME
        || io.stdout.writableLength > MAX_PENDING) {
      // 明确失败，不能无界积压或静默丢掉授权/输出。
      closed = true
      for (const item of pending.values()) item.finish('cancelled')
      io.exitCode = 1
      io.stdin.destroy(new Error('AWU bridge output limit exceeded'))
      throw new Error('AWU bridge output limit exceeded')
    }
    sendNotification(method, params)
  }
  // 上游的 committed/status 通知也走同一限额，而不仅是 AWU 实时帧。
  transport.notify = notify
  const identity = (sessionId) => ({ sessionId, generation: config.generation, configFingerprint: config.configFingerprint })
  disposers.push(ctx.on('agent/pre-step', (payload, next) => {
    steering.step(payload)
    return next()
  }))
  disposers.push(ctx.on('tools/execute', (execution, next) => toolExecution.run({
    sessionId: String(execution.agent?.session.id), callId: execution.callId,
  }, next)))
  disposers.push(ctx.on('agent/created', ({ agent }) => {
    if (!belongs(String(agent.session.id))) return
    if (!configured) throw new Error('AWU turn configuration missing before agent creation')
    images.mount(agent)
    steering.mount(agent)
    // resume 会恢复旧日志中的权限；每次创建/恢复都在输入前覆盖为当前冻结策略。
    agent.session.append('sandbox/mode', { mode: permissionMode })
    agent.session.append('approval/policy', { policy: approvalPolicy })
    if (allowedTools !== undefined) agent.ctx.tools.restrict({ allow: allowedTools })
    if (textOnly) {
      agent.ctx.tools.restrict({ allow: [] })
      agent.ctx.tools.guard(() => 'AWU text-only invocation disables every tool')
      agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => ({ ...await next(), tools: [] }))
    }
  }))
  disposers.push(ctx.on('session/created', (session) => {
    if (session.header.parentSession) {
      if (parents.size >= MAX_CALLS) throw new Error('AWU child-session limit exceeded')
      parents.set(String(session.id), String(session.header.parentSession))
      const execution = toolExecution.getStore()
      if (execution?.sessionId === String(session.header.parentSession) && typeof execution.callId === 'string') {
        notify('awu/subagentLink', { ...identity(String(session.id)),
          parentSessionId: execution.sessionId, callId: execution.callId })
      }
    }
  }))
  disposers.push(ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (!belongs(sessionId)) return
    steering.observe(sessionId, event)
    if (event.type === 'tool/call') {
      const call = event.data
      if (typeof call.callId !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
        throw new Error('Invalid native tool call')
      }
      if (calls.size >= MAX_CALLS) throw new Error('AWU pending tool-call limit exceeded')
      calls.set(`${sessionId}:${call.callId}`, call)
    }
    if (event.type === 'tool/result') calls.delete(`${sessionId}:${event.data.message?.toolCallId}`)
  }))
  disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = String(agent.session.id)
    if (belongs(sessionId)) notify('awu/assistantStream', { ...identity(sessionId), frame })
  }))
  disposers.push(ctx.on('approval/request', async (request) => {
    const sessionId = String(request.agent.session.id)
    if (closed || !belongs(sessionId) || request.signal?.aborted) return 'cancelled'
    const call = calls.get(`${sessionId}:${request.callId}`)
    if (!request.callId || !call || call.name !== request.toolName || pending.size >= MAX_CALLS) return 'unavailable'
    const id = randomUUID()
    return new Promise((resolve) => {
      const onAbort = () => finish('cancelled')
      let timer
      const finish = (outcome) => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      pending.set(id, { ...identity(sessionId), callId: request.callId, finish })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish('unavailable'), 300_000)
      if (request.signal?.aborted) { finish('cancelled'); return }
      try {
        notify('awu/approvalRequested', { ...identity(sessionId), requestId: id, callId: request.callId,
          toolName: call.name, arguments: call.arguments, reason: request.reason ?? '' })
      } catch { finish('unavailable') }
    })
  }, { prepend: true }))

  transport.onRequest(async (method, params = {}) => {
    if (closed && method !== 'shutdown') throw new Error('AWU bridge closed')
    if (method === 'initialize') await ctx.get('loader')?.await()
    if (method === 'awu/capabilities') {
      handshaken = true
      return { protocolVersion: PROTOCOL_VERSION, runtimeVersion: RUNTIME_VERSION, sourceCommit: SOURCE_COMMIT,
        ...identity(config.sessionId), realtime: true, approvals: true, questions: false,
        questionProtocol: 'none', imageAdmission: images.descriptor,
        steering: steering.supported ? { version: 1, text: true, images: false } : null }
    }
    if (method === 'awu/steer' || method === 'awu/steerStatus') {
      if (!configured || textOnly) throw new Error('AWU steering unavailable for this invocation')
      return steering.request(method, params)
    }
    if (method === 'awu/imageAdmission') {
      if (!configured || textOnly) return { version: images.descriptor.version, admitted: false,
        capability: 'unknown', reason: textOnly ? 'text_only' : 'configuration_required', source: 'none' }
      return images.admit(params)
    }
    if (method === 'awu/configure') {
      if (!initialized || !handshaken || configured
          || !['sessionId', 'generation', 'configFingerprint'].every(key => params[key] === config[key])
          || typeof params.constraints !== 'string' || Buffer.byteLength(params.constraints, 'utf8') > 262144
          || !ctx.systemPrompt
          || (params.allowedTools !== undefined && (!Array.isArray(params.allowedTools)
            || params.allowedTools.length > 256 || !params.allowedTools.every(name => typeof name === 'string' && name.length <= 200)))
          || (params.textOnly !== undefined && typeof params.textOnly !== 'boolean')) throw new Error('Invalid AWU turn configuration')
      if (params.mcpServers !== undefined && (!Array.isArray(params.mcpServers) || params.mcpServers.length > 8)) {
        throw new Error('Invalid AWU MCP configuration')
      }
      if (params.textOnly === true && params.mcpServers?.length) throw new Error('MCP unavailable in text-only invocation')
      for (const options of params.mcpServers ?? []) {
        if (!extensions.mountMcp || options.failOnStartupError !== true || options.reconnect?.enabled !== false) {
          throw new Error('AWU MCP requires fail-closed owned startup')
        }
        await extensions.mountMcp(options)
      }
      // 不把动态凭据/约束写入 YAML，也不进行 {{variable}} 插值。
      disposers.push(ctx.systemPrompt.section({ name: 'awu:session-constraints', order: 10300,
        text: params.constraints, interpolate: false }))
      if (config.allowedSkills !== undefined) {
        const entries = await ctx.skills.list({ cwd: io.cwd() })
        // Windows sandbox-local 自带诊断 Skill；只关闭其未绑定调用入口，
        // 不卸载 sandbox provider、不改变 ACL 或文件/命令的访问策略。
        for (const entry of entries) {
          if (entry.name === 'diagnose-windows-sandbox-acl' && entry.provider === 'dsh-windows-acl'
              && entry.source === 'bundled' && !config.allowedSkills.includes(entry.name)) {
            disposers.push(ctx.skills.register({ name: entry.name, source: 'runtime',
              description: 'Not bound to this AWU Session', content: '',
              invocation: { modelInvocable: false, userInvocable: false } }))
          }
        }
        const discovered = (await ctx.skills.list({ cwd: io.cwd() }))
          .filter(skill => skill.invocation.modelInvocable || skill.invocation.userInvocable).map(skill => skill.name).sort()
        if (JSON.stringify(discovered) !== JSON.stringify([...config.allowedSkills].sort())) {
          throw new Error(`AWU bound Skill catalog mismatch (${discovered.join(',')}); refusing prompt`)
        }
      }
      configured = true
      allowedTools = params.allowedTools
      textOnly = params.textOnly === true
      return {}
    }
    if (method === 'awu/approvalRespond') {
      const item = pending.get(params.requestId)
      if (!item || !['sessionId', 'generation', 'configFingerprint', 'callId'].every((key) => item[key] === params[key])
          || typeof params.allowed !== 'boolean') throw new Error('Stale or invalid AWU approval')
      item.finish(params.allowed ? 'allowed-once' : 'rejected')
      return {}
    }
    if (method.startsWith('session/') && params.sessionId !== config.sessionId) {
      throw new Error('AWU root session identity mismatch')
    }
    if (['session/prompt', 'session/resume'].includes(method) && !configured) {
      throw new Error('AWU handshake and turn configuration required before prompt/resume')
    }
    if (method === 'session/prompt') {
      const rejection = await images.beforePrompt(params)
      if (rejection) return rejection
      // AWU 元数据只在桥中消费，不转发成原生内容或持久附件字段。
      const { awuImageAdmission: _admission, ...nativeParams } = params
      params = nativeParams
    }
    const result = await server.handleRequest(method, params)
    if (method === 'initialize') { initialized = true; images.initialize(params) }
    if (method === 'shutdown') {
      closed = true
      images.close()
      for (const item of pending.values()) item.finish('cancelled')
      setImmediate(() => {
        exitTask ??= (async () => {
          await transport.flush()
          await ctx.root.fiber.dispose()
          io.exit(0)
        })().catch(() => io.exit(1))
      })
    }
    return result
  })
  return async () => {
    closed = true
    images.close()
    for (const item of pending.values()) item.finish('cancelled')
    for (const dispose of disposers) dispose()
    calls.clear()
    parents.clear()
    await server.shutdown()
    transport.close()
  }
}
