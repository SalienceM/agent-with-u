package com.agentwithu.android.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentwithu.android.data.Session
import com.agentwithu.android.repository.ChatRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/**
 * 会话列表页 ViewModel。
 */
class SessionsViewModel(
    private val repo: ChatRepository,
) : ViewModel() {

    val sessions: StateFlow<List<Session>> = repo.sessions
    val currentSessionId: StateFlow<String?> = repo.currentSessionId

    fun refresh() {
        viewModelScope.launch {
            repo.loadSessions()
        }
    }

    fun selectSession(sessionId: String) {
        repo.selectSession(sessionId)
    }

    fun createSession() {
        viewModelScope.launch {
            val backends = repo.backends.value
            val backendId = backends.firstOrNull()?.id ?: ""
            repo.createSession(backendId)
        }
    }

    fun deleteSession(sessionId: String) {
        viewModelScope.launch {
            repo.deleteSession(sessionId)
        }
    }

    fun renameSession(sessionId: String, newTitle: String) {
        viewModelScope.launch {
            repo.renameSession(sessionId, newTitle)
        }
    }
}
