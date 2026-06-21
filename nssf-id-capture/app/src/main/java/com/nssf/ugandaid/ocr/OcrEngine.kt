package com.nssf.ugandaid.ocr

import android.graphics.Bitmap

interface OcrEngine {
    suspend fun recognize(bitmap: Bitmap, hint: String? = null): OcrResult
}
