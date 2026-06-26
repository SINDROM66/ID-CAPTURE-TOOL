package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import android.graphics.PointF
import org.opencv.android.OpenCVLoader
import org.opencv.android.Utils
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.RotatedRect
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.hypot

class OpenCvCardProcessor : CardProcessor {
    override fun detect(bitmap: Bitmap): CardDetection? {
        if (!OpenCVLoader.initDebug()) return null

        val src = Mat()
        val gray = Mat()
        val blurred = Mat()
        val edges = Mat()
        val closed = Mat()
        val hierarchy = Mat()
        val kernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(5.0, 5.0))

        var bestCorners: List<PointF>? = null
        var bestScore = Double.NEGATIVE_INFINITY
        val imageArea = bitmap.width.toDouble() * bitmap.height.toDouble()

        try {
            Utils.bitmapToMat(bitmap, src)
            Imgproc.cvtColor(src, gray, Imgproc.COLOR_RGBA2GRAY)
            Imgproc.GaussianBlur(gray, blurred, Size(5.0, 5.0), 0.0)

            val thresholds = listOf(35.0 to 110.0, 50.0 to 150.0, 75.0 to 200.0, 100.0 to 240.0)
            for ((low, high) in thresholds) {
                Imgproc.Canny(blurred, edges, low, high)
                Imgproc.morphologyEx(edges, closed, Imgproc.MORPH_CLOSE, kernel)

                val contours = mutableListOf<MatOfPoint>()
                Imgproc.findContours(closed, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)

                for (contour in contours) {
                    val area = Imgproc.contourArea(contour)
                    val areaRatio = area / imageArea
                    if (areaRatio < 0.05 || areaRatio > 0.95) {
                        contour.release()
                        continue
                    }

                    val contour2f = MatOfPoint2f(*contour.toArray())
                    val perimeter = Imgproc.arcLength(contour2f, true)
                    val approx = MatOfPoint2f()
                    Imgproc.approxPolyDP(contour2f, approx, 0.018 * perimeter, true)

                    val rect = Imgproc.minAreaRect(contour2f)
                    val rectCorners = rect.toPointFList()
                    val rectScore = scoreCorners(rectCorners, areaRatio) - 0.15
                    if (rectScore > bestScore) {
                        bestScore = rectScore
                        bestCorners = rectCorners
                    }

                    if (approx.total() == 4L) {
                        val approxPoint = MatOfPoint(*approx.toArray())
                        if (Imgproc.isContourConvex(approxPoint)) {
                            val corners = approx.toArray().map { PointF(it.x.toFloat(), it.y.toFloat()) }
                            val score = scoreCorners(corners, areaRatio)
                            if (score > bestScore) {
                                bestScore = score
                                bestCorners = corners
                            }
                        }
                        approxPoint.release()
                    }

                    approx.release()
                    contour2f.release()
                    contour.release()
                }
            }
        } finally {
            src.release()
            gray.release()
            blurred.release()
            edges.release()
            closed.release()
            hierarchy.release()
            kernel.release()
        }

        val ordered = bestCorners?.let { orderCorners(it) } ?: return null
        val areaRatio = polygonArea(ordered) / imageArea
        val confidence = confidenceFor(ordered, areaRatio)
        return if (confidence >= 0.35) CardDetection(ordered, areaRatio, confidence) else null
    }

    override fun warp(bitmap: Bitmap, detection: CardDetection, width: Int, height: Int): Bitmap {
        if (!OpenCVLoader.initDebug()) {
            return BitmapCardProcessor.fallbackWarp(bitmap, width, height)
        }

        val src = Mat()
        val dst = Mat(height, width, CvType.CV_8UC4)
        val srcPts = MatOfPoint2f(
            Point(detection.corners[0].x.toDouble(), detection.corners[0].y.toDouble()),
            Point(detection.corners[1].x.toDouble(), detection.corners[1].y.toDouble()),
            Point(detection.corners[2].x.toDouble(), detection.corners[2].y.toDouble()),
            Point(detection.corners[3].x.toDouble(), detection.corners[3].y.toDouble())
        )
        val dstPts = MatOfPoint2f(
            Point(0.0, 0.0),
            Point(width.toDouble(), 0.0),
            Point(width.toDouble(), height.toDouble()),
            Point(0.0, height.toDouble())
        )
        val transform = Imgproc.getPerspectiveTransform(srcPts, dstPts)

        return try {
            Utils.bitmapToMat(bitmap, src)
            Imgproc.warpPerspective(src, dst, transform, Size(width.toDouble(), height.toDouble()))
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
                Utils.matToBitmap(dst, it)
            }
        } finally {
            src.release()
            dst.release()
            srcPts.release()
            dstPts.release()
            transform.release()
        }
    }

    private fun RotatedRect.toPointFList(): List<PointF> {
        val out = arrayOf(Point(), Point(), Point(), Point())
        this.points(out)
        return out.map { PointF(it.x.toFloat(), it.y.toFloat()) }
    }

    private fun scoreCorners(corners: List<PointF>, areaRatio: Double): Double {
        val ordered = orderCorners(corners)
        val confidence = confidenceFor(ordered, areaRatio)
        return confidence * 5.0 + areaRatio
    }

    private fun confidenceFor(corners: List<PointF>, areaRatio: Double): Double {
        val width = (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2.0
        val height = (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2.0
        val ratio = if (height > 0) width / height else 0.0
        val ratioScore = (1.0 - abs(ratio - 1.586) / 0.55).coerceIn(0.0, 1.0)
        val areaScore = if (areaRatio in 0.12..0.92) (areaRatio / 0.35).coerceIn(0.0, 1.0) else 0.0
        return (ratioScore * 0.6 + areaScore * 0.4).coerceIn(0.0, 1.0)
    }

    private fun orderCorners(corners: List<PointF>): List<PointF> {
        val sortedByY = corners.sortedBy { it.y }
        val top = sortedByY.take(2).sortedBy { it.x }
        val bottom = sortedByY.takeLast(2).sortedBy { it.x }
        return listOf(top[0], top[1], bottom[1], bottom[0])
    }

    private fun distance(a: PointF, b: PointF): Double = hypot((a.x - b.x).toDouble(), (a.y - b.y).toDouble())

    private fun polygonArea(points: List<PointF>): Double {
        var sum = 0.0
        for (i in points.indices) {
            val a = points[i]
            val b = points[(i + 1) % points.size]
            sum += a.x * b.y - b.x * a.y
        }
        return abs(sum) / 2.0
    }
}
