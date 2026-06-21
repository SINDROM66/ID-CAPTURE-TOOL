package com.nssf.ugandaid.validation

object NationalityValidator {
    fun validate(raw: String): ValidationResult {
        val compact = OcrCorrection.alphabetic(raw).replace(" ", "")
        val value = if (compact.contains("UGA")) "UGA" else compact.take(3)
        return ValidationResult(value, value == "UGA", if (value == "UGA") 0.99 else 0.0)
    }
}
