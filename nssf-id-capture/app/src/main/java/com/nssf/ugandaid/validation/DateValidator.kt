package com.nssf.ugandaid.validation

import java.time.LocalDate
import java.time.Period
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

object DateValidator {
    private val outFmt = DateTimeFormatter.ofPattern("dd.MM.yyyy")
    private val patterns = listOf("dd.MM.yyyy", "dd/MM/yyyy", "dd-MM-yyyy", "dd MM yyyy")
        .map { DateTimeFormatter.ofPattern(it) }

    fun validateBirthDate(raw: String): ValidationResult {
        val normalized = OcrCorrection.normalizeSpaces(raw)
            .replace(Regex("[^0-9./ -]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        val parsed = patterns.asSequence().mapNotNull { fmt ->
            try { LocalDate.parse(normalized, fmt) } catch (_: DateTimeParseException) { null }
        }.firstOrNull()
        if (parsed == null) {
            return ValidationResult(normalized, false, 0.0, listOf("Invalid date"))
        }
        val age = Period.between(parsed, LocalDate.now()).years
        val valid = age in 16..110
        return ValidationResult(
            value = parsed.format(outFmt),
            valid = valid,
            confidence = if (valid) 0.96 else 0.0,
            warnings = if (valid) emptyList() else listOf("Age outside allowed range")
        )
    }

    fun fromMrzDate(raw: String, birthDate: Boolean): String? {
        if (!Regex("^\\d{6}$").matches(raw)) return null
        val yy = raw.take(2).toInt()
        val mm = raw.substring(2, 4)
        val dd = raw.substring(4, 6)
        val nowYY = LocalDate.now().year % 100
        val century = if (!birthDate) 2000 else if (yy > nowYY) 1900 else 2000
        return try {
            LocalDate.of(century + yy, mm.toInt(), dd.toInt()).format(outFmt)
        } catch (_: Exception) {
            null
        }
    }
}
