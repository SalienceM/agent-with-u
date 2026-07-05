package com.agentwithu.android.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentwithu.android.data.Backend
import com.agentwithu.android.data.ChatMessage
import com.agentwithu.android.data.ImageAttachment
import com.agentwithu.android.data.Session
import com.agentwithu.android.repository.ChatRepository
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/**
 * 聊天页 ViewModel：管理当前会话的消息列表、流式状态、后端选择。
 */
class ChatViewModel(
    private val repo: ChatRepository,
) : ViewModel() {

    private val _currentSession = MutableStateFlow<Session?>(null)
    val currentSession: StateFlow<Session?> = _currentSession.asStateFlow()

    val sessions = repo.sessions
    val backends = repo.backends

    private val _selectedBackendId = MutableStateFlow("")
    val selectedBackendId: StateFlow<String> = _selectedBackendId.asStateFlow()

    /** 发送失败事件（连接不可用时触发，UI 消费后显示 Snackbar） */
    private val _sendFailEvent = Channel<Unit>(Channel.BUFFERED)
    val sendFailEvent: Flow<Unit> = _sendFailEvent.receiveAsFlow()

    val isStreaming: Boolean
        get() = _currentSession.value?.messages?.any { it.isStreaming } == true

    fun init() {
        viewModelScope.launch {
            repo.loadBackends()
            repo.loadSessions()
        }
        // 监听 sessions 变化，更新 currentSession
        viewModelScope.launch {
            combine(repo.sessions, repo.currentSessionId) { sessions, currentId ->
                sessions.find { it.id == currentId }
            }.collect { session ->
                _currentSession.value = session
                if (session?.backendId?.isNotBlank() == true) {
                    _selectedBackendId.value = session.backendId
                }
            }
        }
    }

    fun selectSession(sessionId: String) {
        repo.selectSession(sessionId)
    }

    /** 发送消息。返回 false 表示未连接或无会话；同时通过 sendFailEvent 通知 UI。 */
    fun sendMessage(text: String, images: List<ImageAttachment> = emptyList()): Boolean {
        val sessionId = _currentSession.value?.id ?: run {
            _sendFailEvent.trySend(Unit)
            return false
        }
        val ok = repo.sendMessage(sessionId, text, images)
        if (!ok) {
            _sendFailEvent.trySend(Unit)
        }
        return ok
    }

    fun abortMessage() {
        val sessionId = _currentSession.value?.id ?: return
        repo.abortMessage(sessionId)
    }

    fun createNewSession() {
        viewModelScope.launch {
            val backendId = _selectedBackendId.value.ifBlank {
                backends.value.firstOrNull()?.id ?: ""
            }
            repo.createSession(backendId)
        }
    }

    fun selectBackend(backendId: String) {
        _selectedBackendId.value = backendId
    }

    fun getMessages(): List<ChatMessage> {
        return _currentSession.value?.messages ?: emptyList()
    }
}
