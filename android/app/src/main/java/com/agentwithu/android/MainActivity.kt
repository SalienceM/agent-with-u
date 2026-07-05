package com.agentwithu.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.agentwithu.android.ui.theme.AgentWithUTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val app = application as AgentWithUApp
        val repo = app.chatRepository
        val connection = app.relayConnection

        setContent {
            val settings by repo.settings.collectAsState()

            AgentWithUTheme(darkMode = settings.darkMode) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val connectionState by connection.connectionState.collectAsState()
                    val dataStoreReady by repo.dataStoreReady.collectAsState()
                    AppNavigation(
                        repo = repo,
                        connectionState = connectionState,
                        dataStoreReady = dataStoreReady,
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // 断开 WebSocket 长连接，避免泄漏
        (application as AgentWithUApp).relayConnection.disconnect()
    }
}
