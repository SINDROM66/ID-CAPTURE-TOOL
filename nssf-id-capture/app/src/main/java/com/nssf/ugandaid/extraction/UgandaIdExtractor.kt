package com.nssf.ugandaid.extraction

import android.graphics.Bitmap
import com.nssf.ugandaid.domain.ExtractedCitizen
import com.nssf.ugandaid.domain.ExtractedField
import com.nssf.ugandaid.domain.ExtractionSource
import com.nssf.ugandaid.ocr.OcrEngine
import com.nssf.ugandaid.validation.ConfidenceScorer

class UgandaIdExtractor(private val ocrEngine: OcrEngine) {
    private val frontExtractor = FrontSideExtractor(ocrEngine)
    private val backExtractor = BackSideExtractor(ocrEngine)

    suspend fun extract(frontCard: Bitmap, backCard: Bitmap): ExtractedCitizen {
        val front = frontExtractor.extract(frontCard)
        val back = backExtractor.extract(backCard)
        val fields = mutableMapOf<String, ExtractedField>()
        fields.putAll(front)
        fields.putAll(back.fields)

        fun mrzField(name: String, value: String, confidence: Double): ExtractedField? {
            if (value.isBlank()) return null
            return ExtractedField(name, value, value, ExtractionSource.MRZ, confidence, true)
        }

        val surname = FieldMerger.best(front["surname"], mrzField("surname", back.mrz.surname, back.mrz.confidence))
        val given = FieldMerger.best(front["given_name"], mrzField("given_name", back.mrz.givenName, back.mrz.confidence))
        val nationality = FieldMerger.best(front["nationality"], mrzField("nationality", back.mrz.nationality, back.mrz.confidence))
        val sex = FieldMerger.best(front["sex"], mrzField("sex", back.mrz.sex, back.mrz.confidence))
        val dob = FieldMerger.best(front["date_of_birth"], mrzField("date_of_birth", back.mrz.dateOfBirth, back.mrz.confidence))
        val nin = FieldMerger.best(front["nin"], mrzField("nin", back.mrz.nin, back.mrz.confidence))

        listOf(surname, given, nationality, sex, dob, nin).filterNotNull().forEach { fields[it.name] = it }

        val required = listOf(
            surname, given, nationality, sex, nin, dob,
            back.fields["village"], back.fields["parish"], back.fields["sub_county"], back.fields["county"], back.fields["district"]
        )
        val confidence = ConfidenceScorer.combine(required.map { it?.confidence ?: 0.0 })

        return ExtractedCitizen(
            surname = surname?.value.orEmpty(),
            givenName = given?.value.orEmpty(),
            nationality = nationality?.value.orEmpty(),
            sex = sex?.value.orEmpty(),
            nin = nin?.value.orEmpty(),
            dateOfBirth = dob?.value.orEmpty(),
            village = back.fields["village"]?.takeIf { it.valid }?.value.orEmpty(),
            parish = back.fields["parish"]?.takeIf { it.valid }?.value.orEmpty(),
            subCounty = back.fields["sub_county"]?.takeIf { it.valid }?.value.orEmpty(),
            county = back.fields["county"]?.takeIf { it.valid }?.value.orEmpty(),
            district = back.fields["district"]?.takeIf { it.valid }?.value.orEmpty(),
            fields = fields,
            overallConfidence = confidence,
            needsReview = required.any { it == null || !it.valid || it.confidence < 0.90 }
        )
    }
}
