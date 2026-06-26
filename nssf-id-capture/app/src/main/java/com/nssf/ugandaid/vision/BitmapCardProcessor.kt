package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.PointF
import android.graphics.RectF

class BitmapCardProcessor(
    private val openCv: CardProcessor = OpenCvCardProcessor()
) : CardProcessor {
    override fun detect(bitmap: Bitmap): CardDetection? {
        return runCatching { openCv.detect(bitmap) }.getOrNull()
            ?: fallbackDetection(bitmap)
    }

    override fun warp(bitmap: Bitmap, detection: CardDetection, width: Int, height: Int): Bitmap {
        return runCatching { openCv.warp(bitmap, detection, width, height) }.getOrNull()
            ?: fallbackWarp(bitmap, width, height)
    }

    private fun fallbackDetection(bitmap: Bitmap): CardDetection {
        val w = bitmap.width.toFloat()
        val h = bitmap.height.toFloat()
        return CardDetection(
            corners = listOf(PointF(0f, 0f), PointF(w, 0f), PointF(w, h), PointF(0f, h)),
            areaRatio = 1.0,
            confidence = 0.25
        )
    }

    companion object {
        fun fallbackWarp(bitmap: Bitmap, width: Int, height: Int): Bitmap {
            val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val matrix = Matrix()
            matrix.setRectToRect(
                RectF(0f, 0f, bitmap.width.toFloat(), bitmap.height.toFloat()),
                RectF(0f, 0f, width.toFloat(), height.toFloat()),
                Matrix.ScaleToFit.FILL
            )
            canvas.drawBitmap(bitmap, matrix, null)
            return out
        }
    }
}
