package com.agentwithu.android.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.agentwithu.android.data.ImageAttachment
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * 图片工具：从 ContentResolver 读取 URI，缩放，编码为 base64。
 *
 * 完整链路：URI → ContentResolver.openInputStream → InputStream → ByteArray
 *           → BitmapFactory 解码/缩放 → compress → base64 → ImageAttachment
 */
object ImageUtil {

    /** 最大边长（超过则等比缩放，控制传输体积） */
    private const val MAX_DIMENSION = 1920

    /** JPEG 压缩质量 */
    private const val COMPRESS_QUALITY = 80

    /**
     * 从 URI 读取图片，返回 ImageAttachment（base64 编码）。
     * 失败返回 null。
     */
    fun readImageFromUri(context: Context, uri: Uri): ImageAttachment? {
        return try {
            val resolver = context.contentResolver

            // ① 通过 ContentResolver 获取 MIME type（不依赖 URI 后缀）
            val contentType = resolver.getType(uri) ?: "image/png"

            // ② 打开 InputStream 读取原始字节
            val originalBytes = resolver.openInputStream(uri)?.use { it.readBytes() }
                ?: return null

            // ③ 解码获取尺寸（仅 bounds，不分配 bitmap 内存）
            val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(originalBytes, 0, originalBytes.size, boundsOpts)
            val origWidth = boundsOpts.outWidth
            val origHeight = boundsOpts.outHeight
            if (origWidth <= 0 || origHeight <= 0) return null

            // ④ 计算缩放 sampleSize（2 的幂次）
            val maxDim = maxOf(origWidth, origHeight)
            val sampleSize = if (maxDim > MAX_DIMENSION) {
                var size = 1
                while (size * 2 <= maxDim / MAX_DIMENSION) size *= 2
                size
            } else 1

            // ⑤ 实际解码（可能已经缩小）
            val decodeOpts = BitmapFactory.Options().apply {
                if (sampleSize > 1) inSampleSize = sampleSize
            }
            val bitmap = BitmapFactory.decodeByteArray(
                originalBytes, 0, originalBytes.size, decodeOpts
            ) ?: return null

            // ⑥ 根据 MIME type 选择压缩格式
            val compressFormat = when {
                contentType.contains("png", ignoreCase = true) -> Bitmap.CompressFormat.PNG
                contentType.contains("webp", ignoreCase = true) -> Bitmap.CompressFormat.WEBP
                else -> Bitmap.CompressFormat.JPEG
            }
            val finalMimeType = when (compressFormat) {
                Bitmap.CompressFormat.PNG -> "image/png"
                Bitmap.CompressFormat.WEBP -> "image/webp"
                else -> "image/jpeg"
            }

            // ⑦ 压缩为字节流（先缓存尺寸再 recycle）
            val bmpWidth = bitmap.width
            val bmpHeight = bitmap.height
            val outputStream = ByteArrayOutputStream()
            bitmap.compress(compressFormat, COMPRESS_QUALITY, outputStream)
            bitmap.recycle()
            val compressedBytes = outputStream.toByteArray()

            // ⑧ 编码 base64
            val b64 = Base64.encodeToString(compressedBytes, Base64.NO_WRAP)

            // ⑨ 构建 ImageAttachment（字段名对齐后端 Python ImageAttachment）
            ImageAttachment(
                id = UUID.randomUUID().toString(),
                base64 = b64,
                mime_type = finalMimeType,
                size = originalBytes.size,
                width = bmpWidth,
                height = bmpHeight,
            )
        } catch (e: Exception) {
            android.util.Log.e("ImageUtil", "Failed to read image from URI: ${e.message}", e)
            null
        }
    }
}
