package com.nssf.ugandaid.vision

import android.graphics.Bitmap

object ImageEnhancer {
    fun enhanceForText(bitmap: Bitmap): Bitmap {
        val out = bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val pixels = IntArray(out.width * out.height)
        out.getPixels(pixels, 0, out.width, 0, 0, out.width, out.height)
        for (i in pixels.indices) {
            val p = pixels[i]
            val a = (p ushr 24) and 0xff
            val r = (p ushr 16) and 0xff
            val g = (p ushr 8) and 0xff
            val b = p and 0xff
            val gray = (0.299 * r + 0.587 * g + 0.114 * b).toInt()
            val boosted = ((gray - 128) * 1.25 + 138).toInt().coerceIn(0, 255)
            pixels[i] = (a shl 24) or (boosted shl 16) or (boosted shl 8) or boosted
        }
        out.setPixels(pixels, 0, out.width, 0, 0, out.width, out.height)
        return out
    }

    fun enhanceForMrz(bitmap: Bitmap): Bitmap {
        val gray = enhanceForText(bitmap)
        val pixels = IntArray(gray.width * gray.height)
        gray.getPixels(pixels, 0, gray.width, 0, 0, gray.width, gray.height)
        for (i in pixels.indices) {
            val v = pixels[i] and 0xff
            val binary = if (v > 160) 255 else 0
            pixels[i] = (0xff shl 24) or (binary shl 16) or (binary shl 8) or binary
        }
        gray.setPixels(pixels, 0, gray.width, 0, 0, gray.width, gray.height)
        return gray
    }
}
