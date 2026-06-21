package com.nssf.ugandaid.validation

object NameValidator {
    private val labelWords = setOf(
        "SURNAME", "GIVEN", "NAME", "NATIONALITY", "SEX", "DATE", "BIRTH", "UGANDA", "REPUBLIC", "CARD"
    )

    fun validate(raw: String): ValidationResult {
        val value = OcrCorrection.alphabetic(raw)
            .split(" ")
            .filter { it.isNotBlank() && it !in labelWords }
            .joinToString(" ")
        val valid = value.length in 2..45 &&
            Regex("^[A-Z][A-Z' -]*$").matches(value) &&
            value.split(" ").all { it.length in 2..20 && it.any { ch -> ch in "AEIOU" } } &&
            !Regex("(.)\\1{3,}").containsMatchIn(value)
        return ValidationResult(
            value = value,
            valid = valid,
            confidence = if (valid) 0.92 else 0.0,
            warnings = if (valid) emptyList() else listOf("Invalid name")
        )
    }
}
