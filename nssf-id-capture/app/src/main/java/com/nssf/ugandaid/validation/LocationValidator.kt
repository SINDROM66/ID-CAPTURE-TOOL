package com.nssf.ugandaid.validation

object LocationValidator {
    private val labelWords = setOf("VILLAGE", "PARISH", "COUNTY", "DISTRICT", "THUMB", "RIGHT", "IDUGA")

    fun validate(raw: String): ValidationResult {
        val value = OcrCorrection.normalizeSpaces(raw)
            .replace(Regex("[^A-Z0-9' -]"), " ")
            .split(" ")
            .filter { it.isNotBlank() && it !in labelWords }
            .joinToString(" ")
        val valid = value.length in 2..45 &&
            Regex("^[A-Z0-9][A-Z0-9' -]*$").matches(value) &&
            value.any { it in "AEIOU" } &&
            !Regex("(.)\\1{3,}").containsMatchIn(value)
        return ValidationResult(
            value = value,
            valid = valid,
            confidence = if (valid) 0.88 else 0.0,
            warnings = if (valid) emptyList() else listOf("Invalid location")
        )
    }
}
