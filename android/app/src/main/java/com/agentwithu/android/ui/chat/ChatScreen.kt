package com.agentwithu.android.ui.chat

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentwithu.android.data.Backend
import com.agentwithu.android.data.ConnectionState
import com.agentwithu.android.ui.components.ChatInput
import com.agentwithu.android.ui.components.MessageBubble
import com.agentwithu.android.ui.theme.*
import kotlinx.coroutines.flow.collectLatest

/**
 * 聊天页：顶部栏（会话标题 + 模型选择 + 新建会话）+ 消息列表 + 输入栏。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    viewModel: ChatViewModel,
    connectionState: ConnectionState,
    onOpenSessions: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val awu = LocalAwuColors.current
    val session by viewModel.currentSession.collectAsState()
    val backends by viewModel.backends.collectAsState()
    val selectedBackendId by viewModel.selectedBackendId.collectAsState()
    val listState = rememberLazyListState()
    val messages = session?.messages ?: emptyList()
    val isStreaming = messages.any { it.isStreaming }

    // Snackbar 状态：sendMessage 失败时弹出提示
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(Unit) {
        viewModel.sendFailEvent.collectLatest {
            snackbarHostState.showSnackbar(
                message = "连接不可用，消息未发送",
                duration = SnackbarDuration.Short,
            )
        }
    }

    // 连接断开时是否显示顶部横幅（用户可手动关闭，但下次断开会重新显示）
    val isDisconnected = connectionState == ConnectionState.DISCONNECTED
            || connectionState == ConnectionState.ERROR
    var bannerDismissed by remember { mutableStateOf(false) }
    // 连接状态变化时重置 dismiss 状态
    LaunchedEffect(connectionState) {
        bannerDismissed = false
    }
    val showDisconnectBanner = isDisconnected && !bannerDismissed

    var userScrollToBottom by remember { mutableStateOf(true) }

    // 新消息到达时自动滚动（仅消息数量变化触发，不在每个流式 delta 都触发）
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty() && userScrollToBottom) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    // 流式输出期间：若用户在底部附近，跟随内容增长滚动到底部
    // 使用 snapshotFlow 监听滚动位置变化（用户手动滑动），而非 content.length
    LaunchedEffect(isStreaming) {
        if (!isStreaming) return@LaunchedEffect
        snapshotFlow {
            val info = listState.layoutInfo
            val total = info.totalItemsCount
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            total > 0 && lastVisible >= total - 3
        }.collect { nearBottom ->
            if (nearBottom && userScrollToBottom && messages.isNotEmpty()) {
                listState.scrollToItem(messages.size - 1)
            }
            if (!nearBottom) {
                userScrollToBottom = false
            }
        }
    }

    // FAB 点击后触发一次性滚动到底部
    var scrollTrigger by remember { mutableIntStateOf(0) }
    LaunchedEffect(scrollTrigger) {
        if (scrollTrigger > 0 && messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    var showBackendMenu by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier,
        snackbarHost = {
            SnackbarHost(hostState = snackbarHostState) { data ->
                Snackbar(
                    snackbarData = data,
                    containerColor = awu.error,
                    contentColor = awu.onPrimary,
                    actionColor = awu.onPrimary,
                )
            }
        },
        topBar = {
            Column {
                // 连接断开红色横幅
                if (showDisconnectBanner) {
                    Surface(
                        color = DisconnectedRed,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .statusBarsPadding()
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Default.Warning,
                                contentDescription = null,
                                tint = awu.onPrimary,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                when (connectionState) {
                                    ConnectionState.ERROR -> "连接错误，请检查设置"
                                    else -> "连接已断开，消息无法发送"
                                },
                                color = awu.onPrimary,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(
                                onClick = { bannerDismissed = true },
                                contentPadding = PaddingValues(horizontal = 4.dp),
                            ) {
                                Text(
                                    "关闭",
                                    color = awu.onPrimary.copy(alpha = 0.8f),
                                    fontSize = 12.sp,
                                )
                            }
                        }
                    }
                }
                TopAppBar(
                title = {
                    Column {
                        Text(
                            session?.title ?: "AgentWithU",
                            fontWeight = FontWeight.Bold,
                            fontSize = 18.sp,
                            maxLines = 1,
                        )
                        // 连接状态
                        val (statusText, statusColor) = when (connectionState) {
                            ConnectionState.CONNECTED -> "已连接" to ConnectedGreen
                            ConnectionState.CONNECTING -> "连接中…" to ConnectingYellow
                            ConnectionState.ERROR -> "连接错误" to awu.error
                            ConnectionState.DISCONNECTED -> "未连接" to DisconnectedRed
                        }
                        Text(
                            "● $statusText",
                            color = statusColor,
                            fontSize = 11.sp,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onOpenSessions) {
                        Icon(Icons.Default.Menu, contentDescription = "会话列表")
                    }
                },
                actions = {
                    // 模型选择
                    if (backends.size > 1) {
                        Box {
                            TextButton(onClick = { showBackendMenu = true }) {
                                val selectedName = backends.find { it.id == selectedBackendId }?.label
                                    ?: backends.firstOrNull()?.label ?: "选择模型"
                                Text(
                                    selectedName,
                                    color = awu.textSecondary,
                                    fontSize = 13.sp,
                                    maxLines = 1,
                                )
                                Icon(
                                    Icons.Default.ArrowDropDown,
                                    contentDescription = null,
                                    tint = awu.textSecondary,
                                )
                            }
                            DropdownMenu(
                                expanded = showBackendMenu,
                                onDismissRequest = { showBackendMenu = false },
                            ) {
                                backends.forEach { backend ->
                                    DropdownMenuItem(
                                        text = {
                                            Text(
                                                backend.label,
                                                fontWeight = if (backend.id == selectedBackendId)
                                                    FontWeight.Bold else FontWeight.Normal,
                                            )
                                        },
                                        onClick = {
                                            viewModel.selectBackend(backend.id)
                                            showBackendMenu = false
                                        },
                                        leadingIcon = {
                                            if (backend.id == selectedBackendId) {
                                                Icon(Icons.Default.Check, null, tint = awu.primary)
                                            }
                                        },
                                    )
                                }
                            }
                        }
                    }

                    // 新建会话
                    IconButton(onClick = { viewModel.createNewSession() }) {
                        Icon(Icons.Default.Add, contentDescription = "新建会话")
                    }

                    // 设置
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = "设置",
                            tint = awu.textSecondary,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = awu.surface,
                ),
            )
            } // Column
        },
        bottomBar = {
            ChatInput(
                onSend = { text, images ->
                    viewModel.sendMessage(text, images)
                },
                isStreaming = isStreaming,
                onStop = { viewModel.abortMessage() },
            )
        },
        containerColor = awu.background,
    ) { padding ->
        if (messages.isEmpty()) {
            // 空状态
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "💬",
                        fontSize = 48.sp,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        if (session == null) "选择或创建一个会话开始聊天" else "发送消息开始对话",
                        color = awu.textHint,
                        fontSize = 15.sp,
                    )
                }
            }
        } else {
            // 消息列表 + 回到底部按钮
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(vertical = 8.dp),
                ) {
                    items(messages, key = { it.id.ifBlank { it.timestamp.toString() } }) { msg ->
                        MessageBubble(message = msg)
                    }
                }

                // 回到底部 FAB（用户不在底部时显示）
                if (!userScrollToBottom && isStreaming) {
                    FloatingActionButton(
                        onClick = {
                            userScrollToBottom = true
                            scrollTrigger++
                        },
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(16.dp)
                            .size(40.dp),
                        containerColor = awu.primary,
                        elevation = FloatingActionButtonDefaults.elevation(4.dp),
                    ) {
                        Icon(
                            Icons.Default.KeyboardArrowDown,
                            contentDescription = "回到底部",
                            tint = awu.onPrimary,
                        )
                    }
                }
            }
        }
    }
}
