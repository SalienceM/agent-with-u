package com.agentwithu.android.data

import kotlinx.serialization.Serializable

/** 会话模型 */
@Serializable
data class Session(
    val id: String,
    val title: String = "New Chat",
    val workingDir: String = "",
    val backendId: String = "",
    val messages: List<ChatMessage> = emptyList(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val sessionType: String = "normal",
)

/** 聊天消息 */
@Serializable
data class ChatMessage(
    val id: String = "",
    val role: String = "user",       // "user" | "assistant"
    val content: String = "",
    val images: List<ImageAttachment> = emptyList(),
    val thinking: String = "",
    val toolCalls: List<ToolCallInfo> = emptyList(),
    val isStreaming: Boolean = false,
    val timestamp: Long = System.currentTimeMillis(),
)

/** 图片附件（字段名与后端 Python ImageAttachment 一致） */
@Serializable
data class ImageAttachment(
    val id: String = "",            // UUID
    val base64: String = "",        // base64 编码的图片数据
    val mime_type: String = "image/png",
    val size: Int = 0,              // 原始字节数（base64 解码前）
    val width: Int = 0,
    val height: Int = 0,
)

/** 工具调用 */
@Serializable
data class ToolCallInfo(
    val id: String = "",
    val name: String = "",
    val input: String = "",
    val output: String = "",
    val status: String = "pending", // "pending" | "running" | "done" | "error"
)

/** 流式增量（注释已更正为服务端实际 type 值） */
data class StreamDelta(
    val sessionId: String = "",
    val messageId: String = "",
    val type: String = "",          // "text_delta" | "thinking" | "tool_start" | "tool_input" | "tool_result" | "done" | "error"
    val text: String = "",
    val toolCall: ToolCallInfo? = null,
)

/** 后端配置（与服务端 ModelBackendConfig.to_dict() 对齐） */
@Serializable
data class Backend(
    val id: String,
    val label: String = "",                // ★ 服务端字段名 label（非 name）
    val type: String = "",                 // "claude-agent-sdk" | "openai-compatible" | ...
    val pinned: Boolean = false,           // ★ 官方固定后端（getBackends 返回的 pinned）
)

/** 中继连接配置 */
data class RelayConfig(
    val url: String = "",
    val token: String = "",
    val deviceId: String = "",
)

/** 连接状态 */
enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    ERROR,
}
