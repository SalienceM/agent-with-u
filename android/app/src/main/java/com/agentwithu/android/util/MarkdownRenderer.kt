package com.agentwithu.android.util

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp

/**
 * 轻量 Markdown -> AnnotatedString 渲染器（无外部依赖）。
 * 支持: #标题、**粗体**、*斜体*、***粗斜体***、`行内代码`、```代码块```、- 列表、
 *       链接 [text](url)、表格 | col |、引用块 >
 */
object MarkdownRenderer {

    fun renderToAnnotatedString(
        markdown: String,
        codeColor: Color = Color(0xFFA5D6FF),
        textPrimary: Color = Color(0xFFE8E8FF),
        textSecondary: Color = Color(0xFFB0B0D0),
    ): AnnotatedString {
        return buildAnnotatedString {
            val lines = markdown.lines()
            var inCodeBlock = false
            var codeBlockLang = ""
            val codeBlockLines = mutableListOf<String>()
            var i = 0

            while (i < lines.size) {
                val line = lines[i]
                when {
                    // ── 代码块开始 ──
                    line.trimStart().startsWith("```") && !inCodeBlock -> {
                        inCodeBlock = true
                        codeBlockLang = line.trimStart().removePrefix("```").trim()
                        codeBlockLines.clear()
                        i++
                    }
                    // ── 代码块结束 ──
                    line.trimStart().startsWith("```") && inCodeBlock -> {
                        inCodeBlock = false
                        pushStyle(SpanStyle(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            color = codeColor,
                        ))
                        append("\n")
                        append(codeBlockLines.joinToString("\n"))
                        append("\n")
                        pop()
                        i++
                    }
                    // ── 代码块内 ──
                    inCodeBlock -> {
                        codeBlockLines.add(line)
                        i++
                    }
                    // ── 表格：连续 | 开头的行 ──
                    line.trimStart().startsWith("|") -> {
                        val tableLines = mutableListOf<String>()
                        while (i < lines.size && lines[i].trimStart().startsWith("|")) {
                            tableLines.add(lines[i])
                            i++
                        }
                        renderTable(tableLines, codeColor, textSecondary)
                    }
                    // ── 引用块：> 开头的行 ──
                    line.trimStart().startsWith(">") -> {
                        val quoteLines = mutableListOf<String>()
                        while (i < lines.size && lines[i].trimStart().startsWith(">")) {
                            // 去掉 > 前缀，保留内容（支持 > 和 >text 两种形式）
                            val raw = lines[i].trimStart().removePrefix(">")
                            quoteLines.add(if (raw.startsWith(" ")) raw.substring(1) else raw)
                            i++
                        }
                        renderBlockquote(quoteLines, codeColor, textSecondary)
                    }
                    // ── 标题 ──
                    line.startsWith("# ") -> {
                        pushStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = 20.sp))
                        appendInlineStyle(line.removePrefix("# "), codeColor)
                        pop()
                        append("\n")
                        i++
                    }
                    line.startsWith("## ") -> {
                        pushStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = 17.sp))
                        appendInlineStyle(line.removePrefix("## "), codeColor)
                        pop()
                        append("\n")
                        i++
                    }
                    line.startsWith("### ") -> {
                        pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold, fontSize = 15.sp))
                        appendInlineStyle(line.removePrefix("### "), codeColor)
                        pop()
                        append("\n")
                        i++
                    }
                    // ── 列表 ──
                    line.matches(Regex("^\\s*[-*]\\s+.+")) -> {
                        val indent = line.takeWhile { it == ' ' }.length
                        val content = line.replace(Regex("^\\s*[-*]\\s+"), "")
                        append("  ".repeat(indent / 2))
                        append("• ")
                        appendInlineStyle(content, codeColor)
                        append("\n")
                        i++
                    }
                    // ── 空行 ──
                    line.isBlank() -> {
                        append("\n")
                        i++
                    }
                    // ── 普通文本 ──
                    else -> {
                        appendInlineStyle(line, codeColor)
                        append("\n")
                        i++
                    }
                }
            }
            // 未关闭的代码块
            if (inCodeBlock && codeBlockLines.isNotEmpty()) {
                pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = codeColor))
                append("\n")
                append(codeBlockLines.joinToString("\n"))
                append("\n")
                pop()
            }
        }
    }

    // ──────────────────────────────────────────────
    //  表格渲染
    // ──────────────────────────────────────────────

    /**
     * 渲染表格：解析 | col | 行，计算列宽，等宽对齐 + 制表符边框
     *
     * 示例输入:
     *   | 名称 | 价格 |
     *   |------|------|
     *   | 苹果 | 5    |
     *   | 香蕉 | 3    |
     *
     * 输出为带 ┌─┬─┐ 边框的等宽表格 AnnotatedString
     */
    private fun AnnotatedString.Builder.renderTable(
        tableLines: List<String>,
        codeColor: Color,
        textSecondary: Color,
    ) {
        val rows = tableLines.map { parseTableRow(it) }
        if (rows.isEmpty()) return

        // 检测分隔行（所有 cell 均匹配 :?---:? 格式）
        val separatorIndices = mutableSetOf<Int>()
        for ((idx, row) in rows.withIndex()) {
            if (row.isNotEmpty() && row.all { it.matches(Regex("^:?-+:?$")) }) {
                separatorIndices.add(idx)
            }
        }
        val dataRows = rows.filterIndexed { idx, _ -> idx !in separatorIndices }
        if (dataRows.isEmpty()) return

        // 计算列数与每列最大显示宽度（CJK 字符算 2 宽）
        val colCount = dataRows.maxOf { it.size }
        val colWidths = IntArray(colCount)
        for (row in dataRows) {
            for ((c, cell) in row.withIndex()) {
                colWidths[c] = maxOf(colWidths[c], displayWidth(cell))
            }
        }

        val borderChar = Color(0xFF606080)
        val monoSmall = SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp)

        // ┌───┬───┐
        pushStyle(monoSmall.copy(color = borderChar))
        append(buildBorderLine(colWidths, "┌", "┬", "┐"))
        pop()
        append("\n")

        for ((rowIdx, row) in dataRows.withIndex()) {
            // 数据行 │ cell │ cell │
            pushStyle(monoSmall.copy(color = codeColor))
            append(buildDataLine(row, colWidths))
            pop()
            append("\n")

            // 表头后紧跟分隔行时，渲染中间分隔线 ├───┼───┤
            if (rowIdx == 0 && separatorIndices.isNotEmpty()) {
                pushStyle(monoSmall.copy(color = borderChar))
                append(buildBorderLine(colWidths, "├", "┼", "┤"))
                pop()
                append("\n")
            }
        }

        // └───┴───┘
        pushStyle(monoSmall.copy(color = borderChar))
        append(buildBorderLine(colWidths, "└", "┴", "┘"))
        pop()
        append("\n")
    }

    /** 构建边框线：如 ┌───┬───┐ / ├───┼───┤ / └───┴───┘ */
    private fun buildBorderLine(
        colWidths: IntArray,
        left: String,
        mid: String,
        right: String,
    ): String = buildString {
        append(left)
        for (c in colWidths.indices) {
            append("─".repeat(colWidths[c] + 2))
            append(if (c < colWidths.lastIndex) mid else right)
        }
    }

    /** 构建数据行：│ cell │ cell │（cell 按 displayWidth 右补空格对齐） */
    private fun buildDataLine(row: List<String>, colWidths: IntArray): String = buildString {
        append("│")
        for (c in colWidths.indices) {
            val cell = row.getOrElse(c) { "" }
            val pad = colWidths[c] - displayWidth(cell)
            append(" ")
            append(cell)
            append(" ".repeat(maxOf(0, pad)))
            append(" │")
        }
    }

    /** 解析表格行：| cell1 | cell2 | → [cell1, cell2] */
    private fun parseTableRow(line: String): List<String> {
        val trimmed = line.trim()
        // 去掉首尾 |
        val inner = trimmed.removePrefix("|").removeSuffix("|")
        return inner.split("|").map { it.trim() }
    }

    /** 计算字符串显示宽度（CJK 字符算 2，其余算 1），用于表格对齐 */
    private fun displayWidth(s: String): Int {
        var w = 0
        for (ch in s) {
            w += if (
                ch.code in 0x1100..0x115F ||   // Hangul Jamo
                ch.code in 0x2E80..0x9FFF ||   // CJK Radicals, Ideographs
                ch.code in 0xAC00..0xD7AF ||   // Hangul Syllables
                ch.code in 0xF900..0xFAFF ||   // CJK Compatibility Ideographs
                ch.code in 0xFE30..0xFE6F ||   // CJK Compatibility Forms
                ch.code in 0xFF01..0xFF60 ||   // Fullwidth Forms
                ch.code in 0xFFE0..0xFFE6 ||   // Fullwidth Signs
                ch.code in 0x20000..0x2FFFF     // CJK Extension B+
            ) 2 else 1
        }
        return w
    }

    // ──────────────────────────────────────────────
    //  引用块渲染
    // ──────────────────────────────────────────────

    /**
     * 渲染引用块：左侧竖线 + 次要色文本
     *
     * 示例输入（已去掉 > 前缀）:
     *   "这是一段引用"
     *   "第二行引用"
     *
     * 输出为:
     *   │ 这是一段引用
     *   │ 第二行引用
     * 其中 │ 为青色粗体，内容为次要色（支持行内 Markdown 样式）
     */
    private fun AnnotatedString.Builder.renderBlockquote(
        quoteLines: List<String>,
        codeColor: Color,
        textSecondary: Color,
    ) {
        val quoteBarColor = Color(0xFF80CBC4) // 青绿色竖线
        for (qLine in quoteLines) {
            // 竖线标记
            pushStyle(SpanStyle(color = quoteBarColor, fontWeight = FontWeight.Bold))
            append("│ ")
            pop()
            // 引用内容用次要色，保留行内样式解析
            if (qLine.isNotEmpty()) {
                pushStyle(SpanStyle(color = textSecondary))
                appendInlineStyle(qLine, codeColor)
                pop()
            }
            append("\n")
        }
    }

    // ──────────────────────────────────────────────
    //  行内样式
    // ──────────────────────────────────────────────

    /**
     * 处理行内样式：***粗斜体***、**粗体**、*斜体*、`代码`、[链接文本](url)
     * 正则顺序很重要：先匹配更具体的（粗斜体 > 粗体 > 斜体 > 链接 > 代码），避免嵌套误判
     */
    private fun AnnotatedString.Builder.appendInlineStyle(text: String, codeColor: Color) {
        // 使用 non-greedy 匹配；链接 [text](url) 加入正则链
        val pattern = Regex(
            """(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+?)`)|(\[([^\]]+?)]\(([^)]+?)\))"""
        )
        var lastEnd = 0
        for (match in pattern.findAll(text)) {
            // 添加匹配前的普通文本
            if (match.range.first > lastEnd) {
                append(text.substring(lastEnd, match.range.first))
            }
            when {
                // ***粗斜体*** : groups 1,2
                match.groupValues[1].isNotEmpty() -> {
                    pushStyle(SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic))
                    append(match.groupValues[2])
                    pop()
                }
                // **粗体** : groups 3,4
                match.groupValues[3].isNotEmpty() -> {
                    pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                    append(match.groupValues[4])
                    pop()
                }
                // *斜体* : groups 5,6
                match.groupValues[5].isNotEmpty() -> {
                    pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                    append(match.groupValues[6])
                    pop()
                }
                // `行内代码` : groups 7,8
                match.groupValues[7].isNotEmpty() -> {
                    pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = codeColor))
                    append(match.groupValues[8])
                    pop()
                }
                // [链接](url) : groups 9(full), 10(text), 11(url)
                match.groupValues[9].isNotEmpty() -> {
                    val linkText = match.groupValues[10]
                    val url = match.groupValues[11]
                    withLink(LinkAnnotation.Url(url = url)) {
                        pushStyle(SpanStyle(
                            color = Color(0xFF64B5F6), // 浅蓝
                            textDecoration = TextDecoration.Underline,
                        ))
                        append(linkText)
                        pop()
                    }
                }
            }
            lastEnd = match.range.last + 1
        }
        if (lastEnd < text.length) {
            append(text.substring(lastEnd))
        }
    }
}
