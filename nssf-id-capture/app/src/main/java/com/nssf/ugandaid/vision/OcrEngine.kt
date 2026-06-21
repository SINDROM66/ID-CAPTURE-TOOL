package com.nssf.ugandaid.ocr

import android.graphics.Bitmap
import com.nssf.ugandaid.domain.OcrResult
import com.nssf.ugandaid.vision.RoiDefinition

interface OcrEngine {
    suspend fun initialize(modelPath: String)

    suspend fun recognize(bitmap: Bitmap, roi: RoiDefinition? = null): OcrResult

    fun close()
}