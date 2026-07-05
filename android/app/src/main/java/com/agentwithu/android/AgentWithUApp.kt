package com.agentwithu.android

import android.app.Application
import com.agentwithu.android.network.RelayConnection
import com.agentwithu.android.repository.ChatRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Application 单例：持有全局共享的 Repository 和 RelayConnection。
 */
class AgentWithUApp : Application() {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    lateinit var relayConnection: RelayConnection
    lateinit var chatRepository: ChatRepository

    override fun onCreate() {
        super.onCreate()
        relayConnection = RelayConnection(appScope)
        chatRepository = ChatRepository(appScope, relayConnection, this)
        // 自动连接由 ChatRepository 的 DataStore collector 在配置加载完成后触发
    }
}
