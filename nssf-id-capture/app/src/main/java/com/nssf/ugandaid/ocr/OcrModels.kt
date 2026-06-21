package com.nssf.ugandaid.ocr

data class OcrBox(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float
)

data class OcrLine(
    val text: String,
    val confidence: Double,
    val box: OcrBox? = null
)

data class OcrResult(
    val text: String,
    val lines: List<OcrLine>,
    val confidence: Double
)
