package com.nssf.ugandaid.extraction

import android.graphics.Bitmap
import com.nssf.ugandaid.domain.ExtractedField
import com.nssf.ugandaid.domain.ExtractionSource
import com.nssf.ugandaid.ocr.OcrEngine
import com.nssf.ugandaid.template.FrontTemplateV1
import com.nssf.ugandaid.validation.DateValidator
import com.nssf.ugandaid.validation.NameValidator
import com.nssf.ugandaid.validation.NationalityValidator
import com.nssf.ugandaid.validation.NinValidator
import com.nssf.ugandaid.validation.SexValidator
import com.nssf.ugandaid.vision.ImageEnhancer
import com.nssf.ugandaid.vision.RoiExtractor

class FrontSideExtractor(private val ocrEngine: OcrEngine) {
    suspend fun extract(frontCard: Bitmap): Map<String, ExtractedField> {
        val out = mutableMapOf<String, ExtractedField>()
        suspend fun read(field: String, validator: (String) -> com.nssf.ugandaid.validation.ValidationResult) {
            val roi = FrontTemplateV1.template.roi(field) ?: return
            val crop = ImageEnhancer.enhanceForText(RoiExtractor.crop(frontCard, roi))
            val ocr = ocrEngine.recognize(crop, field)
            out[field] = FieldFactory.fromValidation(
                name = field,
                raw = ocr.text,
                source = ExtractionSource.FRONT_ROI,
                validation = validator(ocr.text),
                ocrConfidence = ocr.confidence
            )
        }

        read("surname", NameValidator::validate)
        read("given_name", NameValidator::validate)
        read("nationality", NationalityValidator::validate)
        read("sex", SexValidator::validate)
        read("nin", NinValidator::validate)
        read("date_of_birth", DateValidator::validateBirthDate)
        return out
    }
}
