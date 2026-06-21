package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import com.nssf.ugandaid.template.RoiDefinition
import kotlin.math.roundToInt

object RoiExtractor {
    fun crop(bitmap: Bitmap, roi: RoiDefinition): Bitmap {
        val padX = (roi.padding * bitmap.width).roundToInt()
        val padY = (roi.padding * bitmap.height).roundToInt()
        val x = ((roi.x * bitmap.width).roundToInt() - padX).coerceAtLeast(0)
        val y = ((roi.y * bitmap.height).roundToInt() - padY).coerceAtLeast(0)
        val right = (((roi.x + roi.width) * bitmap.width).roundToInt() + padX).coerceAtMost(bitmap.width)
        val bottom = (((roi.y + roi.height) * bitmap.height).roundToInt() + padY).coerceAtMost(bitmap.height)
        return Bitmap.createBitmap(bitmap, x, y, right - x, bottom - y)
    }
}
