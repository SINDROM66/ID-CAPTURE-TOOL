package com.nssf.ugandaid.extraction

import android.graphics.Bitmap
import com.nssf.ugandaid.ocr.OcrEngine
import com.nssf.ugandaid.ocr.OcrLine
import com.nssf.ugandaid.ocr.OcrResult

class FakeOcrEngine(private val values: Map<String, String>) : OcrEngine {
    override suspend fun recognize(bitmap: Bitmap, hint: String?): OcrResult {
        val text = values[hint].orEmpty()
        return OcrResult(text, listOf(OcrLine(text, 0.98)), 0.98)
    }
}
