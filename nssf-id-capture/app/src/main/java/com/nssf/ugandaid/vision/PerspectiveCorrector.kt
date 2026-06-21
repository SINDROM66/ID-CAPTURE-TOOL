package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.PointF

class PerspectiveCorrector {
    fun warp(bitmap: Bitmap, corners: List<PointF>, width: Int = 1000, height: Int = 630): Bitmap {
        // Replace this fallback with OpenCV getPerspectiveTransform/warpPerspective in production builds.
        val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val matrix = Matrix()
        matrix.setRectToRect(
            android.graphics.RectF(0f, 0f, bitmap.width.toFloat(), bitmap.height.toFloat()),
            android.graphics.RectF(0f, 0f, width.toFloat(), height.toFloat()),
            Matrix.ScaleToFit.FILL
        )
        canvas.drawBitmap(bitmap, matrix, null)
        return out
    }
}
