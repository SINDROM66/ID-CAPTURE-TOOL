package com.nssf.ugandaid.extraction

import com.nssf.ugandaid.domain.ExtractedField
import com.nssf.ugandaid.domain.ExtractionSource
import com.nssf.ugandaid.validation.ValidationResult

object FieldFactory {
    fun fromValidation(
        name: String,
        raw: String,
        source: ExtractionSource,
        validation: ValidationResult,
        ocrConfidence: Double
    ): ExtractedField {
        val confidence = if (validation.valid) {
            ((validation.confidence * 0.7) + (ocrConfidence.coerceIn(0.0, 1.0) * 0.3)).coerceIn(0.0, 1.0)
        } else 0.0
        return ExtractedField(
            name = name,
            value = validation.value,
            rawText = raw,
            source = source,
            confidence = confidence,
            valid = validation.valid,
            warnings = validation.warnings
        )
    }
}
