package com.nssf.ugandaid.vision

import android.graphics.Bitmap

interface CardProcessor {
    fun detect(bitmap: Bitmap): CardDetection?
    fun warp(bitmap: Bitmap, detection: CardDetection, width: Int = 1000, height: Int = 630): Bitmap
}
