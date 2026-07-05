package com.agentwithu.android.ui.settings

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentwithu.android.data.ConnectionState
import com.agentwithu.android.ui.theme.*

/** 连接状态展示信息 */
private data class StatusInfo(val text: String, val color: Color, val icon: ImageVector)

/**
 * 设置页：中继连接配置 + 主题切换。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    connectionState: ConnectionState,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    canGoBack: Boolean = true,
) {
    val settings by viewModel.settings.collectAsState()
    val awu = LocalAwuColors.current
    var relayUrl by remember(settings) { mutableStateOf(settings.relayUrl) }
    var relayToken by remember(settings) { mutableStateOf(settings.relayToken) }
    var deviceId by remember(settings) { mutableStateOf(settings.deviceId) }
    var darkMode by remember(settings) { mutableStateOf(settings.darkMode) }

    // ── 保存反馈状态 ─────────────────────────────────────
    // 点击保存后进入 "等待中" 状态，连接状态变化时给出反馈
    var savePending by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }

    // 保存后监听连接状态变化，给出实时反馈
    LaunchedEffect(savePending, connectionState) {
        if (!savePending) return@LaunchedEffect
        when (connectionState) {
            ConnectionState.CONNECTED -> {
                savePending = false
                snackbarHostState.showSnackbar("✓ 已连接", duration = SnackbarDuration.Short)
            }
            ConnectionState.ERROR -> {
                savePending = false
                snackbarHostState.showSnackbar("✗ 连接失败，请检查配置", duration = SnackbarDuration.Long)
            }
            ConnectionState.DISCONNECTED -> {
                // 如果刚保存就立即断开了，说明可能配置有问题
                // 但不立即报错（可能用户主动断开），等 CONNECTING 后再判断
            }
            ConnectionState.CONNECTING -> {
                // 仍在连接中，等待
            }
        }
    }

    // 连接状态变化时的闪烁动画（状态卡片背景脉冲）
    val statusPulse = remember { Animatable(0f) }
    LaunchedEffect(connectionState) {
        statusPulse.snapTo(1f)
        statusPulse.animateTo(0f, animationSpec = tween(600))
    }

    Scaffold(
        modifier = modifier,
        snackbarHost = {
            SnackbarHost(hostState = snackbarHostState) { data ->
                val isError = data.visuals.message.startsWith("✗")
                Snackbar(
                    snackbarData = data,
                    containerColor = if (isError) awu.error else ConnectedGreen,
                    contentColor = awu.onPrimary,
                )
            }
        },
        topBar = {
            TopAppBar(
                title = {
                    if (canGoBack) {
                        Text("设置", fontWeight = FontWeight.Bold)
                    } else {
                        Column {
                            Text("欢迎使用", fontWeight = FontWeight.Bold)
                            Text(
                                "请先配置中继连接",
                                fontSize = 12.sp,
                                color = awu.textSecondary,
                            )
                        }
                    }
                },
                navigationIcon = {
                    if (canGoBack) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = awu.surface,
                ),
            )
        },
        containerColor = awu.background,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // ── 首次引导提示 ────────────────────────────────
            if (!canGoBack) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = awu.primary.copy(alpha = 0.12f),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            Icons.Default.Info,
                            contentDescription = null,
                            tint = awu.primary,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                        Spacer(Modifier.width(12.dp))
                        Column {
                            Text(
                                "配置中继服务器以连接远端执行节点",
                                color = awu.textPrimary,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Medium,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "填写你的中继 WebSocket 地址、认证令牌和执行节点设备 ID，保存后即可开始使用。",
                                color = awu.textSecondary,
                                fontSize = 13.sp,
                            )
                        }
                    }
                }
            }

            // ── 连接状态 ────────────────────────────────────
            SectionHeader("连接状态")
            val statusInfo = when (connectionState) {
                ConnectionState.CONNECTED -> StatusInfo("已连接", ConnectedGreen, Icons.Default.CheckCircle)
                ConnectionState.CONNECTING -> StatusInfo("连接中…", ConnectingYellow, Icons.Default.HourglassTop)
                ConnectionState.ERROR -> StatusInfo("连接错误", awu.error, Icons.Default.Error)
                ConnectionState.DISCONNECTED -> StatusInfo("未连接", DisconnectedRed, Icons.Default.LinkOff)
            }
            // 保存中状态覆盖
            val displayInfo = if (savePending && connectionState != ConnectionState.CONNECTED) {
                StatusInfo("正在连接…", ConnectingYellow, Icons.Default.HourglassTop)
            } else statusInfo
            val pulseAlpha = statusPulse.value * 0.15f
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = awu.surface,
            ) {
                Box {
                    // 脉冲背景（状态变化时短暂闪烁）
                    if (pulseAlpha > 0.01f) {
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = displayInfo.color.copy(alpha = pulseAlpha),
                            modifier = Modifier.fillMaxSize(),
                        ) {}
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // 连接中时显示旋转加载图标
                        if (displayInfo.icon == Icons.Default.HourglassTop && savePending) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = ConnectingYellow,
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(displayInfo.icon, contentDescription = null, tint = displayInfo.color)
                        }
                        Spacer(Modifier.width(12.dp))
                        Column {
                            Text("中继连接", color = awu.textPrimary, fontSize = 15.sp)
                            Text(displayInfo.text, color = displayInfo.color, fontSize = 13.sp)
                        }
                    }
                }
            }

            // ── 中继配置 ────────────────────────────────────
            SectionHeader("中继服务器")
            OutlinedTextField(
                value = relayUrl,
                onValueChange = { relayUrl = it },
                label = { Text("WebSocket URL") },
                placeholder = { Text("ws://your-relay:44360") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = awu.textPrimary,
                    unfocusedTextColor = awu.textPrimary,
                    focusedBorderColor = awu.primary,
                    unfocusedBorderColor = awu.border,
                    focusedLabelColor = awu.primary,
                    unfocusedLabelColor = awu.textHint,
                ),
            )
            OutlinedTextField(
                value = relayToken,
                onValueChange = { relayToken = it },
                label = { Text("Token") },
                placeholder = { Text("认证令牌") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = awu.textPrimary,
                    unfocusedTextColor = awu.textPrimary,
                    focusedBorderColor = awu.primary,
                    unfocusedBorderColor = awu.border,
                    focusedLabelColor = awu.primary,
                    unfocusedLabelColor = awu.textHint,
                ),
            )
            OutlinedTextField(
                value = deviceId,
                onValueChange = { deviceId = it },
                label = { Text("设备 ID") },
                placeholder = { Text("执行节点 ID") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = awu.textPrimary,
                    unfocusedTextColor = awu.textPrimary,
                    focusedBorderColor = awu.primary,
                    unfocusedBorderColor = awu.border,
                    focusedLabelColor = awu.primary,
                    unfocusedLabelColor = awu.textHint,
                ),
            )

            // 保存 & 连接按钮
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = {
                        savePending = true
                        viewModel.saveRelayConfig(relayUrl, relayToken, deviceId)
                    },
                    enabled = !savePending || connectionState != ConnectionState.CONNECTED,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(containerColor = awu.primary),
                ) {
                    if (savePending && connectionState == ConnectionState.CONNECTING) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            color = awu.onPrimary,
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(6.dp))
                    } else {
                        Icon(Icons.Default.Save, contentDescription = null)
                        Spacer(Modifier.width(4.dp))
                    }
                    Text(if (savePending && connectionState == ConnectionState.CONNECTING) "连接中…" else "保存并连接")
                }
                OutlinedButton(
                    onClick = { viewModel.disconnect() },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = awu.error),
                ) {
                    Icon(Icons.Default.LinkOff, contentDescription = null)
                    Spacer(Modifier.width(4.dp))
                    Text("断开")
                }
            }

            // ── 外观 ────────────────────────────────────────
            SectionHeader("外观")
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = awu.surface,
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.DarkMode, contentDescription = null, tint = awu.primary)
                    Spacer(Modifier.width(12.dp))
                    Text("深色模式", color = awu.textPrimary, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    Switch(
                        checked = darkMode,
                        onCheckedChange = {
                            darkMode = it
                            viewModel.saveDarkMode(it)
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = awu.primary,
                            checkedTrackColor = awu.primary.copy(alpha = 0.3f),
                        ),
                    )
                }
            }

            // ── 关于 ────────────────────────────────────────
            SectionHeader("关于")
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = awu.surface,
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("AgentWithU Android", color = awu.textPrimary, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                    Text("版本 1.0.0", color = awu.textSecondary, fontSize = 13.sp)
                    Text("通过 Relay 连接远端执行节点", color = awu.textHint, fontSize = 12.sp)
                }
            }

            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    val awu = LocalAwuColors.current
    Text(
        text = title,
        color = awu.textSecondary,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.padding(start = 4.dp),
    )
}
