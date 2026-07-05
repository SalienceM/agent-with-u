package com.agentwithu.android.ui.components

import android.util.Base64
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import com.agentwithu.android.data.ChatMessage
import com.agentwithu.android.data.ImageAttachment
import com.agentwithu.android.ui.theme.*
import com.agentwithu.android.util.MarkdownRenderer

/**
 * 单条消息气泡：用户消息右对齐紫色，助手消息左对齐深色。
 */
@Composable
fun MessageBubble(
    message: ChatMessage,
    modifier: Modifier = Modifier,
) {
    val awu = LocalAwuColors.current
    val isUser = message.role == "user"
    val alignment = if (isUser) Alignment.End else Alignment.Start
    val bubbleColor = when {
        isUser -> awu.userBubble
        message.isStreaming -> awu.assistantBubble.copy(alpha = 0.8f)
        else -> awu.assistantBubble
    }
    val shape = if (isUser) {
        RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp)
    } else {
        RoundedCornerShape(16.dp, 16.dp, 16.dp, 4.dp)
    }

    // 全屏图片放大对话框状态
    var zoomImage by remember { mutableStateOf<ImageAttachment?>(null) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalAlignment = alignment,
    ) {
        // 图片附件 — 真实渲染 base64 缩略图
        if (message.images.isNotEmpty()) {
            Column(
                modifier = Modifier.fillMaxWidth(0.85f),
                horizontalAlignment = alignment,
            ) {
                message.images.forEachIndexed { idx, img ->
                    ImageThumbnail(
                        image = img,
                        index = idx,
                        onClick = { zoomImage = img },
                    )
                }
            }
        }

        // 消息文本
        if (message.content.isNotEmpty()) {
            Surface(
                shape = shape,
                color = bubbleColor,
                modifier = Modifier
                    .fillMaxWidth(0.85f)
                    .wrapContentWidth(alignment)
                    .animateContentSize(),
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    if (isUser) {
                        Text(
                            text = message.content,
                            color = awu.textPrimary,
                            fontSize = 15.sp,
                        )
                    } else {
                        val annotated = remember(message.content) {
                            MarkdownRenderer.renderToAnnotatedString(
                                message.content,
                                codeColor = awu.textCode,
                            )
                        }
                        Text(
                            text = annotated,
                            style = androidx.compose.ui.text.TextStyle(
                                color = awu.textPrimary,
                                fontSize = 15.sp,
                                lineHeight = 22.sp,
                            ),
                        )
                        // 流式光标
                        if (message.isStreaming) {
                            Text(
                                text = "▊",
                                color = awu.primary,
                                fontSize = 15.sp,
                            )
                        }
                    }
                }
            }
        }

        // Thinking 块（可折叠）
        if (message.thinking.isNotEmpty() && !isUser) {
            ThinkingBlock(message.thinking)
        }

        // 工具调用（简化展示）
        if (message.toolCalls.isNotEmpty()) {
            message.toolCalls.forEach { tc ->
                ToolCallCard(tc.name, tc.status)
            }
        }
    }

    // 全屏放大对话框
    zoomImage?.let { img ->
        FullscreenImageDialog(
            image = img,
            onDismiss = { zoomImage = null },
        )
    }
}

/**
 * 图片缩略图：用 Coil SubcomposeAsyncImage 解码 base64 字节显示真实图片。
 * 点击触发全屏放大。
 */
@Composable
private fun ImageThumbnail(
    image: ImageAttachment,
    index: Int,
    onClick: () -> Unit,
) {
    val awu = LocalAwuColors.current
    val bytes = remember(image.base64) {
        try {
            Base64.decode(image.base64, Base64.DEFAULT)
        } catch (_: Exception) {
            null
        }
    }

    if (bytes == null) {
        // base64 解码失败 → 兜底文字占位
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = awu.assistantBubble,
            modifier = Modifier
                .padding(bottom = 4.dp)
                .widthIn(max = 200.dp),
        ) {
            Text(
                "🖼 图片 ${index + 1}",
                color = awu.textSecondary,
                fontSize = 12.sp,
                modifier = Modifier.padding(8.dp),
            )
        }
        return
    }

    SubcomposeAsyncImage(
        model = ImageRequest.Builder(LocalContext.current)
            .data(bytes)
            .crossfade(200)
            .build(),
        contentDescription = "图片 ${index + 1}",
        contentScale = ContentScale.Crop,
        modifier = Modifier
            .padding(bottom = 4.dp)
            .sizeIn(minWidth = 80.dp, minHeight = 80.dp, maxWidth = 200.dp, maxHeight = 200.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        loading = {
            // 加载中占位
            Box(
                modifier = Modifier
                    .sizeIn(minWidth = 80.dp, minHeight = 80.dp, maxWidth = 200.dp, maxHeight = 200.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(awu.assistantBubble),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "⏳",
                    color = awu.textHint,
                    fontSize = 14.sp,
                )
            }
        },
        error = {
            // 解码失败兜底
            Box(
                modifier = Modifier
                    .sizeIn(minWidth = 80.dp, minHeight = 80.dp, maxWidth = 200.dp, maxHeight = 200.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(awu.assistantBubble),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "🖼 图片 ${index + 1}",
                    color = awu.textSecondary,
                    fontSize = 12.sp,
                )
            }
        },
    )
}

/**
 * 全屏图片对话框：支持双指缩放与单指平移。
 */
@Composable
private fun FullscreenImageDialog(
    image: ImageAttachment,
    onDismiss: () -> Unit,
) {
    val bytes = remember(image.base64) {
        try {
            Base64.decode(image.base64, Base64.DEFAULT)
        } catch (_: Exception) {
            null
        }
    }

    // 缩放 & 平移状态
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            if (bytes != null) {
                SubcomposeAsyncImage(
                    model = ImageRequest.Builder(LocalContext.current)
                        .data(bytes)
                        .crossfade(true)
                        .build(),
                    contentDescription = "图片放大",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer(
                            scaleX = scale,
                            scaleY = scale,
                            translationX = offsetX,
                            translationY = offsetY,
                        )
                        .pointerInput(Unit) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(0.5f, 5f)
                                offsetX += pan.x
                                offsetY += pan.y
                            }
                        },
                )
            } else {
                Text(
                    "图片加载失败",
                    color = Color.White,
                    fontSize = 16.sp,
                )
            }

            // 关闭按钮（右上角）
            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 48.dp, end = 16.dp)
                    .size(40.dp)
                    .background(Color.Black.copy(alpha = 0.5f), CircleShape),
            ) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = "关闭",
                    tint = Color.White,
                )
            }
        }
    }
}

@Composable
private fun ThinkingBlock(text: String) {
    var expanded by remember { mutableStateOf(false) }
    val interactionSource = remember { MutableInteractionSource() }
    val awu = LocalAwuColors.current
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = awu.thinkingBubble,
        modifier = Modifier
            .padding(top = 4.dp)
            .fillMaxWidth(0.85f)
            .wrapContentWidth(Alignment.Start)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) { expanded = !expanded },
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.Lightbulb,
                    contentDescription = "思考",
                    tint = awu.primary,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    "思考过程",
                    color = awu.primary,
                    fontSize = 12.sp,
                )
            }
            if (expanded) {
                Text(
                    text = text,
                    color = awu.textSecondary,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun ToolCallCard(name: String, status: String) {
    val awu = LocalAwuColors.current
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = awu.toolCall,
        modifier = Modifier
            .padding(top = 4.dp)
            .fillMaxWidth(0.85f)
            .wrapContentWidth(Alignment.Start),
    ) {
        Row(
            modifier = Modifier.padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.Code,
                contentDescription = null,
                tint = awu.textSecondary,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(name, color = awu.textSecondary, fontSize = 12.sp)
            Spacer(Modifier.weight(1f))
            Text(
                when (status) {
                    "done" -> "✓"
                    "error" -> "✗"
                    "running" -> "…"
                    else -> "·"
                },
                color = when (status) {
                    "done" -> ConnectedGreen
                    "error" -> awu.error
                    "running" -> ConnectingYellow
                    else -> awu.textHint
                },
                fontSize = 12.sp,
            )
        }
    }
}
