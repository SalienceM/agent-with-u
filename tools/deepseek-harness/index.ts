// 此入口只在固定上游源码构建环境 bundle；输出不依赖系统 Node/npm。
import type { Context } from '@deepseek-ai/cordis'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { parseModelListing, resolveListedCatalog } from '@deepseek-ai/dsh-llm-deepseek'
import { APP_IDENTITY, createUserMessage } from '@deepseek-ai/dsh-llm'
import { installBridge } from './bridge.mjs'
import { createBoundedJsonlIO } from './jsonl-io.mjs'
// 离线构建核对只读取静态导出，不调用 apply、不启动 worker 或目录查询。
export { IMAGE_RESOURCE_CONTRACT } from './image-limits.mjs'

export const name = 'awu-sdk-bridge'
export const inject = ['agents', 'workingDirectory', 'systemPrompt', 'tools', 'skills', 'llm']
export const imageCatalogProtocol = Object.freeze({ parseModelListing, resolveListedCatalog, clientVersion: APP_IDENTITY.version })

interface BridgeConfig {
  sessionId: string
  generation: string
  configFingerprint: string
  permissionMode: string
  approvalPolicy: string
  allowedSkills: string[]
  imageIdentity?: { ownerId: string; executorId: string; awuSessionId: string; backendId: string;
    provider: string; model: string }
}

export function apply(ctx: Context, config: BridgeConfig): void {
  const framed = createBoundedJsonlIO(process.stdin, process.stdout, () => {
    transport.close()
    process.exitCode = 1
    // 只结束本 owned root；归属 Job/supervisor 仍负责确认后代退出，不能伪称成功。
    setImmediate(() => process.exit(1))
  })
  const transport = new JsonRpcLineTransport(framed.input, framed.output)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: false })
  const dispose = installBridge(ctx, transport, server, config, process, {
    imageCatalogProtocol,
    createUserMessage,
    mountMcp: async (options: McpClient.Config) => { await ctx.plugin(McpClient, options) },
  })
  ctx.effect(() => {
    transport.start()
    framed.start()
    return async () => { try { await dispose() } finally { framed.close() } }
  }, 'awu.jsonrpc.serve')
}
