package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import android.graphics.PointF

data class CardDetection(
    val corners: List<PointF>,
    val areaRatio: Double,
    val confidence: Double
)

class CardDetector {
    fun detect(bitmap: Bitmap): CardDetection? {
        // Production implementation should call OpenCV:
        // gray -> blur -> Canny -> findContours -> approxPolyDP -> largest ID-ratio quad.
        // This fallback treats the full bitmap as the card so the rest of the pipeline can run.
        val w = bitmap.width.toFloat()
        val h = bitmap.height.toFloat()
        return CardDetection(
            corners = listOf(PointF(0f, 0f), PointF(w, 0f), PointF(w, h), PointF(0f, h)),
            areaRatio = 1.0,
            confidence = 0.5
        )
    }
}
