package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import android.graphics.PointF

data class CardDetection(
    val corners: List<PointF>,
    val areaRatio: Double,
    val confidence: Double
)

class CardDetector {
    private val processor = BitmapCardProcessor()

    fun detect(bitmap: Bitmap): CardDetection? {
        return processor.detect(bitmap)
    }
}
