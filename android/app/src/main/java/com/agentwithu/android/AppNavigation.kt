package com.agentwithu.android

import androidx.compose.runtime.*
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.agentwithu.android.data.ConnectionState
import com.agentwithu.android.repository.ChatRepository
import com.agentwithu.android.ui.chat.ChatScreen
import com.agentwithu.android.ui.chat.ChatViewModel
import com.agentwithu.android.ui.sessions.SessionsScreen
import com.agentwithu.android.ui.sessions.SessionsViewModel
import com.agentwithu.android.ui.settings.SettingsScreen
import com.agentwithu.android.ui.settings.SettingsViewModel

/** 导航路由 */
object Routes {
    const val CHAT = "chat"
    const val SESSIONS = "sessions"
    const val SETTINGS = "settings"
}

/**
 * 主导航：Chat 为默认页，Sessions 和 Settings 覆盖其上。
 * 当 DataStore 加载完成且 relayUrl 为空时（首次启动），自动跳转到设置页引导配置。
 */
@Composable
fun AppNavigation(
    repo: ChatRepository,
    connectionState: ConnectionState,
    dataStoreReady: Boolean,
) {
    val navController = rememberNavController()
    val settings by repo.settings.collectAsState()

    // ── 首次连接引导：判断是否需要强制进入设置页 ──────────
    // null = 尚未确定（DataStore 未加载完），true = 需要引导设置，false = 正常进入
    var needsSetup by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(dataStoreReady) {
        if (dataStoreReady && needsSetup == null) {
            needsSetup = settings.relayUrl.isBlank()
        }
    }

    // 自动跳转到设置页（仅首次引导时触发，popUpTo(chat) 使设置页成为根）
    LaunchedEffect(needsSetup) {
        if (needsSetup == true) {
            navController.navigate(Routes.SETTINGS) {
                popUpTo(Routes.CHAT) { inclusive = true }
                launchSingleTop = true
            }
        }
    }

    // 用户保存配置后（relayUrl 非空），从设置页回到聊天页
    LaunchedEffect(settings.relayUrl) {
        if (needsSetup == true && settings.relayUrl.isNotBlank()) {
            needsSetup = false
            navController.navigate(Routes.CHAT) {
                popUpTo(Routes.SETTINGS) { inclusive = true }
                launchSingleTop = true
            }
        }
    }

    NavHost(
        navController = navController,
        startDestination = Routes.CHAT,
        modifier = Modifier.fillMaxSize(),
    ) {
        composable(Routes.CHAT) {
            val chatVm = remember { ChatViewModel(repo) }
            LaunchedEffect(Unit) { chatVm.init() }

            ChatScreen(
                viewModel = chatVm,
                connectionState = connectionState,
                onOpenSessions = { navController.navigate(Routes.SESSIONS) },
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
            )
        }

        composable(Routes.SESSIONS) {
            val sessionsVm = remember { SessionsViewModel(repo) }
            SessionsScreen(
                viewModel = sessionsVm,
                onSelectSession = { sessionId ->
                    navController.popBackStack()
                },
                onOpenSettings = {
                    navController.navigate(Routes.SETTINGS)
                },
            )
        }

        composable(Routes.SETTINGS) {
            val settingsVm = remember { SettingsViewModel(repo) }
            // 首次引导时不允许返回（设置页即为根页面）
            val canGoBack = needsSetup != true
            SettingsScreen(
                viewModel = settingsVm,
                connectionState = connectionState,
                onBack = { navController.popBackStack() },
                canGoBack = canGoBack,
            )
        }
    }
}
