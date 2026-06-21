package com.nssf.ugandaid.domain

data class ExtractedField(
    val name: String,
    val value: String,
    val rawText: String,
    val source: ExtractionSource,
    val confidence: Double,
    val valid: Boolean,
    val warnings: List<String> = emptyList()
)
