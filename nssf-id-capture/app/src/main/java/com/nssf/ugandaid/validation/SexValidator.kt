package com.nssf.ugandaid.validation

object SexValidator {
    fun validate(raw: String): ValidationResult {
        val value = OcrCorrection.normalizeSpaces(raw).replace(Regex("[^MF]"), "").take(1)
        return ValidationResult(
            value = value,
            valid = value == "M" || value == "F",
            confidence = if (value == "M" || value == "F") 0.99 else 0.0
        )
    }
}
