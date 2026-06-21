package com.nssf.ugandaid.vision

data class QualityReport(
    val blurScore: Double,
    val glareRatio: Double,
    val cardAreaRatio: Double,
    val acceptable: Boolean,
    val warnings: List<String>
)
