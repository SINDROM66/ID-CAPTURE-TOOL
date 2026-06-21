package com.nssf.ugandaid.validation

object NinValidator {
    private val ninRegex = Regex("^C[MF][0-9]{9,10}[A-Z0-9]{3}$")

    fun validate(raw: String): ValidationResult {
        val value = OcrCorrection.nin(raw)
        val warnings = mutableListOf<String>()
        if (!value.startsWith("CM") && !value.startsWith("CF")) warnings += "Invalid prefix"
        if (value.length !in 14..15) warnings += "Unexpected length"
        if (!ninRegex.matches(value)) warnings += "Pattern mismatch"
        return ValidationResult(
            value = value,
            valid = warnings.isEmpty(),
            confidence = if (warnings.isEmpty()) 0.98 else 0.0,
            warnings = warnings
        )
    }
}
