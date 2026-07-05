package com.agentwithu.android.ui.components

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentwithu.android.data.ImageAttachment
import com.agentwithu.android.ui.theme.*
import com.agentwithu.android.util.ImageUtil

/**
 * 聊天输入栏：文本 + 图片选择 + 发送按钮。
 */
@Composable
fun ChatInput(
    onSend: (text: String, images: List<ImageAttachment>) -> Unit,
    isStreaming: Boolean,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val awu = LocalAwuColors.current
    var text by remember { mutableStateOf("") }
    var selectedImages by remember { mutableStateOf<List<ImageAttachment>>(emptyList()) }
    val focusRequester = remember { FocusRequester() }

    // 图片选择 → 实际读取 URI 转 base64
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris: List<Uri> ->
        val loaded = uris.mapNotNull { uri ->
            ImageUtil.readImageFromUri(context, uri)
        }
        selectedImages = selectedImages + loaded
    }

    Surface(
        modifier = modifier.fillMaxWidth(),
        color = awu.surface,
        tonalElevation = 4.dp,
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            // 已选图片预览（横向可滚动，防止多张图片在小屏溢出）
            if (selectedImages.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .padding(bottom = 8.dp)
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    selectedImages.forEach { img ->
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = awu.surfaceVariant,
                            modifier = Modifier.size(48.dp),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Text("🖼", fontSize = 20.sp)
                                IconButton(
                                    onClick = { selectedImages = selectedImages - img },
                                    modifier = Modifier
                                        .align(Alignment.TopEnd)
                                        .size(16.dp),
                                ) {
                                    Icon(
                                        Icons.Default.Close,
                                        contentDescription = "移除",
                                        tint = awu.error,
                                        modifier = Modifier.size(12.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // 输入行
            Row(
                verticalAlignment = Alignment.Bottom,
                modifier = Modifier.fillMaxWidth(),
            ) {
                IconButton(
                    onClick = { imagePicker.launch("image/*") },
                    modifier = Modifier.size(40.dp),
                ) {
                    Icon(Icons.Default.Image, contentDescription = "选择图片", tint = awu.textSecondary)
                }

                Spacer(Modifier.width(4.dp))

                Box(
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 40.dp, max = 120.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(awu.surfaceVariant),
                ) {
                    if (text.isEmpty()) {
                        Text(
                            "发送消息…",
                            color = awu.textHint,
                            fontSize = 15.sp,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                    BasicTextField(
                        value = text,
                        onValueChange = { text = it },
                        textStyle = TextStyle(color = awu.textPrimary, fontSize = 15.sp),
                        cursorBrush = SolidColor(awu.primary),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 10.dp)
                            .focusRequester(focusRequester),
                    )
                }

                Spacer(Modifier.width(8.dp))

                if (isStreaming) {
                    IconButton(
                        onClick = onStop,
                        modifier = Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(awu.error),
                    ) {
                        Icon(Icons.Default.Stop, contentDescription = "停止生成", tint = awu.onPrimary)
                    }
                } else {
                    IconButton(
                        onClick = {
                            if (text.isNotBlank()) {
                                onSend(text.trim(), selectedImages)
                                text = ""
                                selectedImages = emptyList()
                            }
                        },
                        enabled = text.isNotBlank(),
                        modifier = Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(if (text.isNotBlank()) awu.primary else awu.surfaceVariant),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.Send,
                            contentDescription = "发送",
                            tint = if (text.isNotBlank()) awu.onPrimary else awu.textHint,
                        )
                    }
                }
            }
        }
    }
}
