package com.nssf.ugandaid.extraction

import com.nssf.ugandaid.validation.DateValidator
import com.nssf.ugandaid.validation.NameValidator
import com.nssf.ugandaid.validation.NinValidator
import com.nssf.ugandaid.validation.OcrCorrection
import com.nssf.ugandaid.validation.SexValidator

data class MrzResult(
    val surname: String = "",
    val givenName: String = "",
    val nationality: String = "",
    val sex: String = "",
    val nin: String = "",
    val dateOfBirth: String = "",
    val confidence: Double = 0.0
)

object MrzParser {
    fun parse(raw: String): MrzResult {
        val lines = raw.uppercase()
            .replace('«', '<')
            .replace('>', '<')
            .split('\n')
            .map { it.replace(Regex("[^A-Z0-9<]"), "") }
            .filter { it.length >= 15 }

        val nameLine = lines.firstOrNull { Regex("[A-Z]<<[A-Z]").containsMatchIn(it) }
        val detailLine = lines.firstOrNull { Regex("\\d{6}\\d?[MF]\\d{6}").containsMatchIn(it) }
        val docLine = lines.firstOrNull { it.startsWith("IDUGA") || it.startsWith("UGA") }

        val surname = nameLine?.substringBefore("<<")?.replace('<', ' ')?.let(NameValidator::validate)
        val given = nameLine?.substringAfter("<<", "")?.replace('<', ' ')?.let(NameValidator::validate)
        val detail = detailLine?.let { Regex("(\\d{6})\\d?([MF])(\\d{6})").find(it) }
        val ninCandidate = lines.asSequence()
            .map { OcrCorrection.nin(it) }
            .firstOrNull { NinValidator.validate(it).valid }

        val dob = detail?.groupValues?.getOrNull(1)?.let { DateValidator.fromMrzDate(it, birthDate = true) } ?: ""
        val sex = detail?.groupValues?.getOrNull(2)?.let { SexValidator.validate(it).value } ?: ""
        val nationality = if (lines.any { it.contains("UGA") } || docLine != null) "UGA" else ""

        val scores = listOf(
            surname?.confidence ?: 0.0,
            given?.confidence ?: 0.0,
            if (dob.isNotBlank()) 0.95 else 0.0,
            if (sex.isNotBlank()) 0.99 else 0.0,
            if (nationality == "UGA") 0.99 else 0.0,
            ninCandidate?.let { 0.95 } ?: 0.0
        ).filter { it > 0.0 }

        return MrzResult(
            surname = surname?.takeIf { it.valid }?.value ?: "",
            givenName = given?.takeIf { it.valid }?.value ?: "",
            nationality = nationality,
            sex = sex,
            nin = ninCandidate ?: "",
            dateOfBirth = dob,
            confidence = if (scores.isEmpty()) 0.0 else scores.average()
        )
    }
}
