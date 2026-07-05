package com.agentwithu.android.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentwithu.android.repository.AppSettings
import com.agentwithu.android.repository.ChatRepository
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * 设置页 ViewModel。
 */
class SettingsViewModel(
    private val repo: ChatRepository,
) : ViewModel() {

    val settings: StateFlow<AppSettings> = repo.settings

    fun saveRelayConfig(url: String, token: String, deviceId: String) {
        viewModelScope.launch {
            repo.saveRelayConfig(url, token, deviceId)
        }
    }

    fun saveDarkMode(dark: Boolean) {
        viewModelScope.launch {
            repo.saveDarkMode(dark)
        }
    }

    fun disconnect() {
        repo.disconnect()
    }
}
