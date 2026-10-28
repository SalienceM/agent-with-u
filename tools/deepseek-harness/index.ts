// 此入口只在固定上游源码构建环境 bundle；输出不依赖系统 Node/npm。
import type { Context } from '@deepseek-ai/cordis'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { installBridge } from './bridge.mjs'

export const name = 'awu-sdk-bridge'
export const inject = ['agents', 'workingDirectory', 'systemPrompt', 'tools', 'skills']

interface BridgeConfig {
  sessionId: string
  generation: string
  configFingerprint: string
  permissionMode: string
  approvalPolicy: string
  allowedSkills: string[]
}

export function apply(ctx: Context, config: BridgeConfig): void {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: false })
  const dispose = installBridge(ctx, transport, server, config, process, {
    mountMcp: async (options: McpClient.Config) => { await ctx.plugin(McpClient, options) },
  })
  ctx.effect(() => {
    transport.start()
    return dispose
  }, 'awu.jsonrpc.serve')
}
