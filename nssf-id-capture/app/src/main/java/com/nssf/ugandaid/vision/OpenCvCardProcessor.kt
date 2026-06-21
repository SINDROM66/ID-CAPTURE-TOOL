package com.nssf.ugandaid.vision

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.PointF
import org.opencv.android.Utils
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.sqrt

/**
 * Production card processor.
 *
 * This class is intentionally isolated from the main pipeline so the project can still be opened
 * before the OpenCV Android SDK AAR is vendored. In production, move this file into the active
 * source set after adding app/libs/opencv-android-sdk.aar, or replace the reflective calls with
 * direct org.opencv imports.
 */
class OpenCvCardProcessor : CardProcessor { // Production implementation
    override fun detect(bitmap: Bitmap): CardDetection? {
        // Ensure OpenCV is loaded
        if (!org.opencv.android.OpenCVLoader.initDebug()) {
            // Handle error or log that OpenCV is not loaded
        }
        val src = Mat()
        Utils.bitmapToMat(bitmap, src)

        val gray = Mat()
        Imgproc.cvtColor(src, gray, Imgproc.COLOR_RGBA2GRAY)

        val blurred = Mat()
        Imgproc.GaussianBlur(gray, blurred, Size(5.0, 5.0), 0.0)

        val edges = Mat()
        Imgproc.Canny(blurred, edges, 70.0, 180.0)

        val contours: List<MatOfPoint> = ArrayList()
        val hierarchy = Mat()
        Imgproc.findContours(edges, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)

        var bestContour: MatOfPoint? = null
        var maxArea = 0.0

        val minCardArea = bitmap.width * bitmap.height * 0.1 // Minimum 10% of image area
        val maxCardArea = bitmap.width * bitmap.height * 0.9 // Maximum 90% of image area

        for (contour in contours) {
            val area = Imgproc.contourArea(contour)
            if (area < minCardArea || area > maxCardArea) {
                contour.release()
                continue // Ignore too small or too large contours
            }

            val approxCurve = MatOfPoint2f()
            val contour2f = MatOfPoint2f(*contour.toArray())
            val epsilon = 0.02 * Imgproc.arcLength(contour2f, true)
            Imgproc.approxPolyDP(contour2f, approxCurve, epsilon, true)

            // Check if the approximated contour has 4 vertices and is convex
            if (approxCurve.total() == 4L && Imgproc.isContourConvex(MatOfPoint(*approxCurve.toArray()))) {
                if (area > maxArea) {
                    maxArea = area
                    bestContour?.release() // Release previous best contour
                    bestContour = contour
                } else {
                    contour.release() // Release current contour if not the best
                }
            } else {
                contour.release() // Release contour if not a valid quadrilateral
            }
            contour2f.release()
            approxCurve.release()
        }

        src.release()
        // gray.release() // Released by blurred.release() if not used further
        gray.release()
        blurred.release()
        edges.release()
        hierarchy.release()

        if (bestContour != null) {
            val points = bestContour.toArray().map { PointF(it.x.toFloat(), it.y.toFloat()) }
            bestContour.release() // Release the best contour after converting to PointF

            val orderedCorners = orderCorners(points)

            // Validate aspect ratio and area
            val side1 = distance(orderedCorners[0], orderedCorners[1]) // Top side
            val side2 = distance(orderedCorners[1], orderedCorners[2]) // Right side
            val side3 = distance(orderedCorners[2], orderedCorners[3]) // Bottom side
            val side4 = distance(orderedCorners[3], orderedCorners[0]) // Left side

            // Average width and height
            val avgWidth = (side1 + side3) / 2
            val avgHeight = (side2 + side4) / 2

            val aspectRatio = if (avgHeight > 0) avgWidth / avgHeight else 0f

            val minAspectRatio = 1.55f // Typical ID card aspect ratio
            val maxAspectRatio = 1.70f
            val minAreaRatio = 0.35 // Card should occupy at least 35% of the image

            if (aspectRatio in minAspectRatio..maxAspectRatio && maxArea > (bitmap.width * bitmap.height * minAreaRatio)) {
                return CardDetection(orderedCorners, 0.8f) // High confidence for detected card
            }
        }
        return null
    }

    override fun warp(bitmap: Bitmap, detection: CardDetection, width: Int, height: Int): Bitmap {
        if (!org.opencv.android.OpenCVLoader.initDebug()) {
            // Handle error or log that OpenCV is not loaded
        }
        val src = Mat()
        Utils.bitmapToMat(bitmap, src)

        val srcPts = MatOfPoint2f(
            Point(detection.corners[0].x.toDouble(), detection.corners[0].y.toDouble()), // Top-left
            Point(detection.corners[1].x.toDouble(), detection.corners[1].y.toDouble()), // Top-right
            Point(detection.corners[2].x.toDouble(), detection.corners[2].y.toDouble()), // Bottom-right
            Point(detection.corners[3].x.toDouble(), detection.corners[3].y.toDouble())  // Bottom-left
        )

        val dstPts = MatOfPoint2f(
            Point(0.0, 0.0),
            Point(width.toDouble(), 0.0),
            Point(width.toDouble(), height.toDouble()),
            Point(0.0, height.toDouble())
        )

        val transform = Imgproc.getPerspectiveTransform(srcPts, dstPts)
        val dst = Mat(height, width, CvType.CV_8UC4)

        Imgproc.warpPerspective(src, dst, transform, Size(width.toDouble(), height.toDouble()))

        val resultBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        Utils.matToBitmap(dst, resultBitmap)

        src.release()
        srcPts.release()
        dstPts.release()
        transform.release()
        dst.release()

        return resultBitmap
    }

    private fun distance(p1: PointF, p2: PointF): Float {
        val dx = p2.x - p1.x
        val dy = p2.y - p1.y
        return sqrt(dx * dx + dy * dy)
    }

    private fun orderCorners(corners: List<PointF>): List<PointF> {
        // Sort points based on their x-coordinate
        val sortedX = corners.sortedBy { it.x }

        // Take the first two (leftmost) and sort them by y-coordinate to get top-left and bottom-left
        val leftPoints = sortedX.subList(0, 2).sortedBy { it.y }
        val topLeft = leftPoints[0]
        val bottomLeft = leftPoints[1]

        // Take the last two (rightmost) and sort them by y-coordinate to get top-right and bottom-right
        val rightPoints = sortedX.subList(2, 4).sortedBy { it.y }
        val topRight = rightPoints[0]
        val bottomRight = rightPoints[1]

        // Return in the order: Top-Left, Top-Right, Bottom-Right, Bottom-Left
        return listOf(topLeft, topRight, bottomRight, bottomLeft)
    }
}
