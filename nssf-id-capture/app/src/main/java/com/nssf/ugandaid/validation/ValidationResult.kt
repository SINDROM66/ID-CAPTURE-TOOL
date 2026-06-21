package com.nssf.ugandaid.validation

data class ValidationResult(
    val value: String,
    val valid: Boolean,
    val confidence: Double,
    val warnings: List<String> = emptyList()
)
