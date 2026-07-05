package com.agentwithu.android.repository

import android.content.Context
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import com.agentwithu.android.data.*
import com.agentwithu.android.network.RelayConnection
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/** 安全获取 JsonElement 的字符串内容（JsonNull 或缺失返回 null） */
private fun JsonElement?.strOrNull(): String? = when {
    this == null || this is JsonNull -> null
    this is JsonPrimitive -> contentOrNull
    else -> null
}

/**
 * 中央数据仓库：管理会话、消息、后端，通过 RelayConnection 与远端交互。
 */
class ChatRepository(
    private val scope: CoroutineScope,
    private val connection: RelayConnection,
    private val appContext: Context,
) {
    companion object {
        private const val TAG = "ChatRepository"
        private val RELAY_URL = stringPreferencesKey("relay_url")
        private val RELAY_TOKEN = stringPreferencesKey("relay_token")
        private val RELAY_DEVICE_ID = stringPreferencesKey("relay_device_id")
        private val DARK_MODE = booleanPreferencesKey("dark_mode")
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }
    private val dataStore: DataStore<Preferences> =
        appContext.dataStore

    // ── 会话列表 ────────────────────────────────────────────
    private val _sessions = MutableStateFlow<List<Session>>(emptyList())
    val sessions: StateFlow<List<Session>> = _sessions.asStateFlow()

    // ── 当前会话 ────────────────────────────────────────────
    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId.asStateFlow()

    // ── 后端列表 ────────────────────────────────────────────
    private val _backends = MutableStateFlow<List<Backend>>(emptyList())
    val backends: StateFlow<List<Backend>> = _backends.asStateFlow()

    // ── DataStore 加载就绪标志 ──────────────────────────────
    private val _dataStoreReady = MutableStateFlow(false)
    val dataStoreReady: StateFlow<Boolean> = _dataStoreReady.asStateFlow()

    // ── 设置 ────────────────────────────────────────────────
    private val _settings = MutableStateFlow(AppSettings())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    /** 标记是否已完成首次自动连接，避免 saveRelayConfig 与 collector 双重触发 */
    private var initialAutoConnected = false

    init {
        // 监听推送事件 —— 切到 Main 调度器，避免 OkHttp 线程与 UI 线程对 _sessions 的竞态
        connection.onStreamDelta = { dataJson ->
            scope.launch(Dispatchers.Main) { handleStreamDelta(dataJson) }
        }
        connection.onSessionUpdated = { dataJson ->
            scope.launch(Dispatchers.Main) { handleSessionUpdated(dataJson) }
        }
        // 加载设置并在就绪后自动连接
        scope.launch {
            dataStore.data.collect { prefs ->
                val newSettings = AppSettings(
                    relayUrl = prefs[RELAY_URL] ?: "",
                    relayToken = prefs[RELAY_TOKEN] ?: "",
                    deviceId = prefs[RELAY_DEVICE_ID] ?: "",
                    darkMode = prefs[DARK_MODE] ?: true,
                )
                _settings.value = newSettings
                // 标记 DataStore 已完成首次加载
                if (!_dataStoreReady.value) {
                    _dataStoreReady.value = true
                }
                // 首次加载完成后自动连接（冷启动时 DataStore 加载完毕后触发一次）
                if (!initialAutoConnected && newSettings.relayUrl.isNotBlank() && newSettings.deviceId.isNotBlank()) {
                    initialAutoConnected = true
                    connectToRelay()
                }
            }
        }
    }

    // ── 设置持久化 ──────────────────────────────────────────

    suspend fun saveRelayConfig(url: String, token: String, deviceId: String) {
        dataStore.edit { prefs ->
            prefs[RELAY_URL] = url
            prefs[RELAY_TOKEN] = token
            prefs[RELAY_DEVICE_ID] = deviceId
        }
        // DataStore 写入完成后由 collector 触发连接，避免双重 connect
        // 如果 collector 已经完成了首次连接，此处直接连接（用户主动修改配置 → 用新配置重连）
        if (initialAutoConnected && url.isNotBlank() && deviceId.isNotBlank()) {
            connection.connect(url, token, deviceId)
        }
    }

    suspend fun saveDarkMode(dark: Boolean) {
        dataStore.edit { prefs ->
            prefs[DARK_MODE] = dark
        }
    }

    // ── 连接状态（暴露给 UI / sendMessage 检查） ────────────
    val connectionState = connection.connectionState

    // ── 连接 ────────────────────────────────────────────────

    fun connectToRelay() {
        val s = _settings.value
        if (s.relayUrl.isNotBlank() && s.deviceId.isNotBlank()) {
            connection.connect(s.relayUrl, s.relayToken, s.deviceId)
        }
    }

    fun disconnect() {
        connection.disconnect()
    }

    // ── 会话操作 ────────────────────────────────────────────

    suspend fun loadSessions() {
        try {
            val result = connection.request("listSessions") ?: return
            val list = json.parseToJsonElement(result) as? JsonArray ?: return
            _sessions.value = list.mapNotNull { elem ->
                val obj = elem as? JsonObject ?: return@mapNotNull null
                val id = obj["id"]?.strOrNull() ?: return@mapNotNull null
                Session(
                    id = id,
                    title = obj["title"]?.strOrNull() ?: "New Chat",
                    workingDir = obj["workingDir"]?.strOrNull() ?: "",
                    backendId = obj["backendId"]?.strOrNull() ?: "",
                    createdAt = obj["createdAt"]?.strOrNull() ?: "",
                    updatedAt = obj["updatedAt"]?.strOrNull() ?: "",
                    sessionType = obj["sessionType"]?.strOrNull() ?: "normal",
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "loadSessions failed", e)
        }
    }

    suspend fun loadBackends() {
        try {
            val result = connection.request("getBackends") ?: return
            val list = json.parseToJsonElement(result) as? JsonArray ?: return
            _backends.value = list.mapNotNull { elem ->
                val obj = elem as? JsonObject ?: return@mapNotNull null
                val id = obj["id"]?.strOrNull() ?: return@mapNotNull null
                // ★ 服务端返回字段：id, type, label, baseUrl, model, apiKey, workingDir,
                //   skipPermissions, env, cliPath, extraHeaders, mcpServers, pinned
                // 前端用 label 作为显示名；pinned 表示官方固定后端
                Backend(
                    id = id,
                    label = obj["label"]?.strOrNull() ?: "",
                    type = obj["type"]?.strOrNull() ?: "",
                    pinned = (obj["pinned"] as? JsonPrimitive)?.booleanOrNull ?: false,
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "loadBackends failed", e)
        }
    }

    suspend fun createSession(backendId: String): Session? {
        return try {
            val result = connection.request(
                "createSession",
                JsonPrimitive(""),              // workingDir
                JsonPrimitive(backendId),
                JsonPrimitive("normal"),        // sessionType
            ) ?: return null
            val obj = json.parseToJsonElement(result) as? JsonObject ?: return null
            val session = Session(
                id = obj["id"]?.strOrNull() ?: UUID.randomUUID().toString(),
                title = obj["title"]?.strOrNull() ?: "New Chat",
                workingDir = obj["workingDir"]?.strOrNull() ?: "",
                backendId = obj["backendId"]?.strOrNull() ?: backendId,
                sessionType = obj["sessionType"]?.strOrNull() ?: "normal",
            )
            _sessions.value = _sessions.value + session
            _currentSessionId.value = session.id
            session
        } catch (e: Exception) {
            Log.e(TAG, "createSession failed", e)
            null
        }
    }

    fun selectSession(sessionId: String) {
        _currentSessionId.value = sessionId
    }

    suspend fun deleteSession(sessionId: String) {
        try {
            connection.request("deleteSession", JsonPrimitive(sessionId))
            _sessions.value = _sessions.value.filter { it.id != sessionId }
            if (_currentSessionId.value == sessionId) {
                _currentSessionId.value = _sessions.value.firstOrNull()?.id
            }
        } catch (e: Exception) {
            Log.e(TAG, "deleteSession failed", e)
        }
    }

    suspend fun renameSession(sessionId: String, newTitle: String) {
        try {
            connection.request("renameSession", JsonPrimitive(sessionId), JsonPrimitive(newTitle))
            _sessions.value = _sessions.value.map {
                if (it.id == sessionId) it.copy(title = newTitle) else it
            }
        } catch (e: Exception) {
            Log.e(TAG, "renameSession failed", e)
        }
    }

    // ── 消息发送 ────────────────────────────────────────────

    /** 发送消息。返回 false 表示连接不可用、消息已丢弃。 */
    fun sendMessage(sessionId: String, text: String, images: List<ImageAttachment> = emptyList()): Boolean {
        // 连接检查：未连接时不发，避免消息静默丢失
        if (connection.connectionState.value != ConnectionState.CONNECTED) {
            Log.w(TAG, "sendMessage skipped: not connected")
            return false
        }

        val messageId = UUID.randomUUID().toString()
        val session = _sessions.value.find { it.id == sessionId }
        val backendId = session?.backendId ?: _backends.value.firstOrNull()?.id ?: ""

        // 添加用户消息到当前会话（本地 UI 展示用）
        val userMsg = ChatMessage(
            id = messageId,
            role = "user",
            content = text,
            images = images,
            timestamp = System.currentTimeMillis(),
        )
        appendToSession(sessionId, userMsg)

        // 添加占位 assistant 消息
        val assistantMsg = ChatMessage(
            id = "assistant-$messageId",
            role = "assistant",
            isStreaming = true,
            timestamp = System.currentTimeMillis(),
        )
        appendToSession(sessionId, assistantMsg)

        // 构建发送 payload（字段名与前端 TypeScript / 后端 Python 一致）
        // 后端 _handle_send_message 解析:
        //   payload["sessionId"], payload["content"], payload["backendId"],
        //   payload["messageId"], payload["images"], payload["autoContinue"],
        //   payload["skipPermissions"]
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            put("content", text)
            put("backendId", backendId)
            put("messageId", messageId)
            put("autoContinue", true)
            put("skipPermissions", true)
            if (images.isNotEmpty()) {
                put("images", JsonArray(images.map { img ->
                    buildJsonObject {
                        put("id", img.id)
                        put("base64", img.base64)
                        put("mime_type", img.mime_type)
                        put("size", img.size)
                        put("width", img.width)
                        put("height", img.height)
                    }
                }))
            }
        }

        // ★ sendMessage 是 fire-and-forget：整个 payload 作为单个 JSON 字符串参数
        // 与前端 api.sendMessage(payload) → send('sendMessage', JSON.stringify(payload)) 一致
        connection.sendRpc("sendMessage", JsonPrimitive(payload.toString()))
        return true
    }

    fun abortMessage(sessionId: String) {
        connection.sendRpc("abortMessage", JsonPrimitive(sessionId))
    }

    // ── 流式增量处理 ────────────────────────────────────────

    private fun handleStreamDelta(dataJson: String) {
        try {
            val obj = json.parseToJsonElement(dataJson) as? JsonObject ?: return
            val sessionId = obj["sessionId"]?.strOrNull() ?: return
            val messageId = obj["messageId"]?.strOrNull() ?: ""
            val type = obj["type"]?.strOrNull() ?: return

            // ★ 服务端实际 StreamDelta type 值（见 src/backend/base.py StreamDelta 注释）：
            //   text_delta / thinking / tool_start / tool_input / tool_result /
            //   subagent_start / subagent_progress / subagent_done / done / error
            when (type) {
                "text_delta" -> {
                    val text = obj["text"]?.strOrNull() ?: ""
                    updateAssistantMessage(sessionId, messageId) { msg ->
                        msg.copy(content = msg.content + text)
                    }
                }
                "thinking" -> {
                    // ★ 服务端发 "thinking"，不是 "thinking_delta"
                    val text = obj["text"]?.strOrNull() ?: ""
                    updateAssistantMessage(sessionId, messageId) { msg ->
                        msg.copy(thinking = msg.thinking + text)
                    }
                }
                "tool_start", "tool_input", "tool_result" -> {
                    // ★ 服务端 type: tool_start / tool_input / tool_result
                    // ★ 工具数据在 obj["toolCall"] 对象内，字段：
                    //   id, name, inputParts, status, error, parentToolUseId, subagent
                    val tc = obj["toolCall"] as? JsonObject
                    val toolId = tc?.get("id")?.strOrNull() ?: ""
                    val toolName = tc?.get("name")?.strOrNull() ?: ""
                    val toolStatus = when (tc?.get("status")?.strOrNull()) {
                        "completed" -> "done"
                        "failed" -> "error"
                        else -> tc?.get("status")?.strOrNull() ?: "running"
                    }
                    if (type == "tool_start") {
                        updateAssistantMessage(sessionId, messageId) { msg ->
                            val existing = msg.toolCalls.toMutableList()
                            val idx = existing.indexOfFirst { it.id == toolId }
                            if (idx >= 0) {
                                existing[idx] = existing[idx].copy(name = toolName, status = "running")
                            } else {
                                existing.add(ToolCallInfo(id = toolId, name = toolName, status = "running"))
                            }
                            msg.copy(toolCalls = existing)
                        }
                    } else if (type == "tool_result") {
                        updateAssistantMessage(sessionId, messageId) { msg ->
                            val existing = msg.toolCalls.toMutableList()
                            val idx = existing.indexOfFirst { it.id == toolId }
                            if (idx >= 0) {
                                existing[idx] = existing[idx].copy(status = toolStatus)
                            }
                            msg.copy(toolCalls = existing)
                        }
                    }
                }
                "done" -> {
                    updateAssistantMessage(sessionId, messageId) { msg ->
                        msg.copy(isStreaming = false)
                    }
                }
                "error" -> {
                    val errorText = obj["error"]?.strOrNull() ?: "未知错误"
                    updateAssistantMessage(sessionId, messageId) { msg ->
                        msg.copy(content = msg.content + "\n\n⚠️ $errorText", isStreaming = false)
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "handleStreamDelta error", e)
        }
    }

    private fun handleSessionUpdated(dataJson: String) {
        // 简化：重新拉取会话列表
        scope.launch { loadSessions() }
    }

    // ── 内部辅助 ────────────────────────────────────────────

    private fun appendToSession(sessionId: String, message: ChatMessage) {
        _sessions.value = _sessions.value.map { session ->
            if (session.id == sessionId) {
                session.copy(messages = session.messages + message)
            } else session
        }
    }

    private fun updateAssistantMessage(
        sessionId: String,
        messageId: String,
        transform: (ChatMessage) -> ChatMessage,
    ) {
        _sessions.value = _sessions.value.map { session ->
            if (session.id != sessionId) return@map session
            val msgs = session.messages.toMutableList()
            // 找最后一条 assistant streaming 消息
            val idx = msgs.indexOfLast { it.role == "assistant" && it.isStreaming }
            if (idx >= 0) {
                msgs[idx] = transform(msgs[idx])
            }
            session.copy(messages = msgs)
        }
    }
}

/** 应用设置 */
data class AppSettings(
    val relayUrl: String = "",
    val relayToken: String = "",
    val deviceId: String = "",
    val darkMode: Boolean = true,
)
