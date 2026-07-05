package com.agentwithu.android.network

import android.util.Log
import com.agentwithu.android.data.ConnectionState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*
import okhttp3.*
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.*

/** 安全获取 JsonElement 的字符串内容 */
private fun JsonElement?.strOrNull(): String? = when {
    this == null || this is JsonNull -> null
    this is JsonPrimitive -> contentOrNull
    else -> null
}

/**
 * 与中继服务器维持 WebSocket 长连接，实现 JSON-RPC over WebSocket 协议。
 *
 * 连接流程（Relay 模式）：
 *   1. ws 连接中继 URL
 *   2. 发送 {"t":"hello","token":"...","deviceId":"..."}
 *   3. 收到 {"t":"ready"} → 进入 JSON-RPC 模式
 *   4. 发送 {"id":"r1","method":"...","params":[...]}
 *   5. 收到 {"id":"r1","result":"..."} 或 推送 {"event":"streamDelta","data":"..."}
 */
class RelayConnection(
    private val scope: CoroutineScope,
) {
    companion object {
        private const val TAG = "RelayConnection"
        private const val HEARTBEAT_INTERVAL_MS = 25_000L
        private const val RECONNECT_INITIAL_DELAY_MS = 500L
        private const val RECONNECT_MAX_DELAY_MS = 30_000L
    }

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = false
    }

    /**  protects webSocket, handshakeComplete, reconnectDelay */
    private val lock = Any()

    @Volatile private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var reconnectDelay = RECONNECT_INITIAL_DELAY_MS
    private val reqCounter = AtomicInteger(0)
    private val pendingRequests = mutableMapOf<String, CancellableContinuation<String?>>()

    /** 已调用 disconnect()，阻止后续重连 / doConnect */
    private val disposed = AtomicBoolean(false)

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    /** Relay 配置 */
    @Volatile var relayUrl: String = ""
    @Volatile var relayToken: String = ""
    @Volatile var deviceId: String = ""

    /** 是否完成了 relay 握手（收到 ready） */
    @Volatile private var handshakeComplete = false

    // ── 事件回调 ────────────────────────────────────────────
    @Volatile var onStreamDelta: ((String) -> Unit)? = null       // raw delta JSON
    @Volatile var onSessionUpdated: ((String) -> Unit)? = null    // raw session JSON
    @Volatile var onConnectionChanged: ((ConnectionState) -> Unit)? = null

    /**
     * 信任所有证书的 TrustManager，用于支持自签证书的 Relay 服务器。
     * 生产环境应替换为正规 CA 签发的证书。
     */
    private val trustAllManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private val okHttpClient by lazy {
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustAllManager), SecureRandom())
        }
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MINUTES)     // no read timeout for WS
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .sslSocketFactory(sslContext.socketFactory, trustAllManager)
            .hostnameVerifier { _, _ -> true }    // 自签证书不校验主机名
            .build()
    }

    // ── 连接管理 ────────────────────────────────────────────

    fun connect(url: String, token: String, deviceId: String) {
        relayUrl = url
        relayToken = token
        this.deviceId = deviceId
        disposed.set(false)          // 重新连接时清除 disposed
        synchronized(lock) { handshakeComplete = false }
        doConnect()
    }

    fun disconnect() {
        disposed.set(true)
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        val ws: WebSocket?
        synchronized(lock) {
            ws = webSocket
            webSocket = null
            handshakeComplete = false
        }
        ws?.close(1000, "User disconnect")
        _connectionState.value = ConnectionState.DISCONNECTED
        // reject all pending
        synchronized(pendingRequests) {
            pendingRequests.values.forEach { it.cancel() }
            pendingRequests.clear()
        }
    }

    private fun doConnect() {
        if (disposed.get()) return
        if (relayUrl.isBlank()) return
        _connectionState.value = ConnectionState.CONNECTING
        onConnectionChanged?.invoke(ConnectionState.CONNECTING)

        val request = Request.Builder()
            .url(relayUrl)
            .build()

        val newWs = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "WebSocket connected, sending hello")
                // 发送 Relay 握手
                val hello = buildJsonObject {
                    put("t", "hello")
                    put("token", relayToken)
                    put("deviceId", deviceId)
                }
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closing: $code $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closed: $code $reason")
                handleDisconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}", t)
                handleDisconnect()
            }
        })
        // 同步赋值，如果已 disposed 则立刻关闭
        synchronized(lock) {
            if (disposed.get()) {
                newWs.cancel()
                return
            }
            webSocket = newWs
        }
    }

    private fun handleMessage(raw: String) {
        try {
            val element = json.parseToJsonElement(raw)
            val obj = element as? JsonObject ?: return

            // 1) Relay 握手阶段
            val hsComplete = synchronized(lock) { handshakeComplete }
            if (!hsComplete) {
                when ((obj["t"] as? JsonPrimitive)?.contentOrNull) {
                    "ready" -> {
                        synchronized(lock) { handshakeComplete = true }
                        reconnectDelay = RECONNECT_INITIAL_DELAY_MS
                        _connectionState.value = ConnectionState.CONNECTED
                        onConnectionChanged?.invoke(ConnectionState.CONNECTED)
                        startHeartbeat()
                        Log.d(TAG, "Relay handshake complete")
                    }
                    "error" -> {
                        val msg = (obj["message"] as? JsonPrimitive)?.contentOrNull ?: "unknown"
                        Log.e(TAG, "Relay error: $msg")
                        _connectionState.value = ConnectionState.ERROR
                        onConnectionChanged?.invoke(ConnectionState.ERROR)
                    }
                }
                return
            }

            // 2) JSON-RPC 模式
            val idPrimitive = obj["id"] as? JsonPrimitive
            val id = idPrimitive?.contentOrNull
            val hasId = !id.isNullOrEmpty()
            if (hasId) {
                // RPC 响应
                val result = obj["result"]?.let {
                    when {
                        it is JsonNull -> null
                        it is JsonPrimitive -> it.contentOrNull
                        // result 可能是 JSON 对象/数组（如 relay 直连模式），转回字符串
                        else -> it.toString()
                    }
                }
                val error = obj["error"]?.strOrNull()
                val cont = synchronized(pendingRequests) { pendingRequests.remove(id!!) }
                if (cont != null) {
                    if (error != null) {
                        cont.resumeWith(Result.failure(RuntimeException(error)))
                    } else {
                        cont.resumeWith(Result.success(result))
                    }
                }
            } else {
                // 推送事件
                val event = obj["event"]?.strOrNull() ?: return
                val data = obj["data"]?.strOrNull() ?: ""
                when (event) {
                    "streamDelta" -> onStreamDelta?.invoke(data)
                    "sessionUpdated" -> onSessionUpdated?.invoke(data)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Message parse error", e)
        }
    }

    private fun handleDisconnect() {
        heartbeatJob?.cancel()
        synchronized(lock) {
            webSocket = null
            handshakeComplete = false
        }

        val wasConnected = _connectionState.value == ConnectionState.CONNECTED
        _connectionState.value = ConnectionState.DISCONNECTED
        onConnectionChanged?.invoke(ConnectionState.DISCONNECTED)

        // reject pending
        synchronized(pendingRequests) {
            pendingRequests.values.forEach { it.cancel() }
            pendingRequests.clear()
        }

        // 自动重连（如未 disposed）
        if (!disposed.get() && relayUrl.isNotBlank()) {
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            Log.d(TAG, "Reconnecting in ${reconnectDelay}ms")
            delay(reconnectDelay)
            val newDelay = (reconnectDelay * 2).coerceAtMost(RECONNECT_MAX_DELAY_MS)
            synchronized(lock) { reconnectDelay = newDelay }
            if (!disposed.get()) {
                doConnect()
            }
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive && _connectionState.value == ConnectionState.CONNECTED) {
                delay(HEARTBEAT_INTERVAL_MS)
                val ws: WebSocket?
                synchronized(lock) { ws = webSocket }
                if (ws != null) {
                    val id = "hb-${reqCounter.incrementAndGet()}"
                    sendRaw(buildJsonObject {
                        put("id", id)
                        put("method", "ping")
                        put("params", JsonArray(emptyList()))
                    }.toString())
                }
            }
        }
    }

    // ── JSON-RPC ────────────────────────────────────────────

    /** 发起 RPC 请求并等待响应 */
    suspend fun request(method: String, vararg params: JsonElement): String? {
        if (_connectionState.value != ConnectionState.CONNECTED) {
            throw IllegalStateException("Not connected")
        }
        val id = "r${reqCounter.incrementAndGet()}"
        val rpcReq = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", JsonArray(params.toList()))
        }
        return suspendCancellableCoroutine { cont ->
            synchronized(pendingRequests) {
                pendingRequests[id] = cont
            }
            sendRaw(rpcReq.toString())
        }
    }

    /** Fire-and-forget RPC */
    fun sendRpc(method: String, vararg params: JsonElement) {
        if (_connectionState.value != ConnectionState.CONNECTED) return
        val id = "r${reqCounter.incrementAndGet()}"
        val rpcReq = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", JsonArray(params.toList()))
        }
        sendRaw(rpcReq.toString())
    }

    private fun sendRaw(text: String): Boolean {
        return try {
            val ws: WebSocket?
            synchronized(lock) { ws = webSocket }
            ws?.send(text) ?: false
        } catch (e: Exception) {
            Log.e(TAG, "Send failed", e)
            false
        }
    }
}
