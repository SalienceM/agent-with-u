package com.agentwithu.android.ui.theme

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// ── 语义色 CompositionLocal ────────────────────────────────
// 让各屏幕可直接引用 MaterialTheme 下的语义色，自动跟随深浅主题切换。

data class AwuColors(
    val background: Color,
    val surface: Color,
    val surfaceVariant: Color,
    val primary: Color,
    val onPrimary: Color,
    val error: Color,
    val userBubble: Color,
    val assistantBubble: Color,
    val thinkingBubble: Color,
    val toolCall: Color,
    val toolCallBorder: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textHint: Color,
    val textCode: Color,
    val divider: Color,
    val border: Color,
)

val LocalAwuColors = staticCompositionLocalOf {
    // 默认深色（永远不会真正命中，Theme 里总会提供）
    AwuColors(
        background = AwuBackground,
        surface = AwuSurface,
        surfaceVariant = AwuSurfaceVariant,
        primary = AwuPrimary,
        onPrimary = AwuOnPrimary,
        error = AwuError,
        userBubble = UserBubbleColor,
        assistantBubble = AssistantBubbleColor,
        thinkingBubble = ThinkingBubbleColor,
        toolCall = ToolCallColor,
        toolCallBorder = ToolCallBorderColor,
        textPrimary = TextPrimary,
        textSecondary = TextSecondary,
        textHint = TextHint,
        textCode = TextCode,
        divider = DividerColor,
        border = BorderColor,
    )
}

/** 便捷访问器：MaterialTheme.awuColors.xxx */
object AwuThemeExt {
    val colors: AwuColors
        @Composable
        @ReadOnlyComposable
        get() = LocalAwuColors.current
}

// ── Material3 ColorScheme ─────────────────────────────────

private val DarkColorScheme = darkColorScheme(
    primary = AwuPrimary,
    onPrimary = AwuOnPrimary,
    secondary = AwuSecondary,
    onSecondary = AwuOnSecondary,
    background = AwuBackground,
    onBackground = AwuOnBackground,
    surface = AwuSurface,
    onSurface = AwuOnSurface,
    surfaceVariant = AwuSurfaceVariant,
    error = AwuError,
    outline = BorderColor,
    outlineVariant = DividerColor,
)

private val LightColorScheme = lightColorScheme(
    primary = AwuPrimary,
    onPrimary = LightAwuOnPrimary,
    secondary = AwuSecondary,
    onSecondary = LightAwuOnSecondary,
    background = LightAwuBackground,
    onBackground = LightAwuOnBackground,
    surface = LightAwuSurface,
    onSurface = LightAwuOnSurface,
    surfaceVariant = LightAwuSurfaceVariant,
    error = AwuError,
    outline = LightBorderColor,
    outlineVariant = LightDividerColor,
)

// ── 深色 / 浅色语义色实例 ──────────────────────────────────

private val DarkAwuColors = AwuColors(
    background = AwuBackground,
    surface = AwuSurface,
    surfaceVariant = AwuSurfaceVariant,
    primary = AwuPrimary,
    onPrimary = AwuOnPrimary,
    error = AwuError,
    userBubble = UserBubbleColor,
    assistantBubble = AssistantBubbleColor,
    thinkingBubble = ThinkingBubbleColor,
    toolCall = ToolCallColor,
    toolCallBorder = ToolCallBorderColor,
    textPrimary = TextPrimary,
    textSecondary = TextSecondary,
    textHint = TextHint,
    textCode = TextCode,
    divider = DividerColor,
    border = BorderColor,
)

private val LightAwuColors = AwuColors(
    background = LightAwuBackground,
    surface = LightAwuSurface,
    surfaceVariant = LightAwuSurfaceVariant,
    primary = AwuPrimary,
    onPrimary = LightAwuOnPrimary,
    error = AwuError,
    userBubble = LightUserBubbleColor,
    assistantBubble = LightAssistantBubbleColor,
    thinkingBubble = LightThinkingBubbleColor,
    toolCall = LightToolCallColor,
    toolCallBorder = LightToolCallBorderColor,
    textPrimary = LightTextPrimary,
    textSecondary = LightTextSecondary,
    textHint = LightTextHint,
    textCode = LightTextCode,
    divider = LightDividerColor,
    border = LightBorderColor,
)

// ── 主题入口 ───────────────────────────────────────────────

@Composable
fun AgentWithUTheme(
    darkMode: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkMode) DarkColorScheme else LightColorScheme
    val awuColors = if (darkMode) DarkAwuColors else LightAwuColors

    CompositionLocalProvider(
        LocalAwuColors provides awuColors,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = Typography(),
            content = content,
        )
    }
}
