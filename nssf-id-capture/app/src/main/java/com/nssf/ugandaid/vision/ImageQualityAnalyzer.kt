package com.nssf.ugandaid.vision

import android.graphics.Bitmap

object ImageQualityAnalyzer {
    fun analyze(bitmap: Bitmap, cardAreaRatio: Double = 0.0): QualityReport {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        var over = 0
        var transitions = 0L
        var previous = -1
        for (p in pixels) {
            val gray = (((p shr 16) and 0xff) + ((p shr 8) and 0xff) + (p and 0xff)) / 3
            if (gray > 245) over++
            if (previous >= 0) transitions += kotlin.math.abs(gray - previous)
            previous = gray
        }
        val glare = over.toDouble() / pixels.size
        val blurScore = transitions.toDouble() / pixels.size
        val warnings = mutableListOf<String>()
        if (blurScore < 8.0) warnings += "Image appears blurry"
        if (glare > 0.12) warnings += "Too much glare"
        if (cardAreaRatio > 0.0 && cardAreaRatio < 0.35) warnings += "Move closer to the card"
        return QualityReport(
            blurScore = blurScore,
            glareRatio = glare,
            cardAreaRatio = cardAreaRatio,
            acceptable = warnings.isEmpty(),
            warnings = warnings
        )
    }
}
