package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import android.graphics.PointF

class PerspectiveCorrector {
    private val processor = BitmapCardProcessor()

    fun warp(bitmap: Bitmap, corners: List<PointF>, width: Int = 1000, height: Int = 630): Bitmap {
        val detection = CardDetection(
            corners = corners,
            areaRatio = 0.0,
            confidence = 1.0
        )
        return processor.warp(bitmap, detection, width, height)
    }
}
