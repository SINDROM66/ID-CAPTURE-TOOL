package com.nssf.ugandaid.extraction

import android.graphics.Bitmap
import com.nssf.ugandaid.domain.ExtractedField
import com.nssf.ugandaid.domain.ExtractionSource
import com.nssf.ugandaid.ocr.OcrEngine
import com.nssf.ugandaid.template.BackTemplateV1
import com.nssf.ugandaid.validation.LocationValidator
import com.nssf.ugandaid.vision.ImageEnhancer
import com.nssf.ugandaid.vision.RoiExtractor

data class BackExtraction(
    val fields: Map<String, ExtractedField>,
    val mrz: MrzResult
)

class BackSideExtractor(private val ocrEngine: OcrEngine) {
    suspend fun extract(backCard: Bitmap): BackExtraction {
        val out = mutableMapOf<String, ExtractedField>()
        suspend fun readLocation(field: String) {
            val roi = BackTemplateV1.template.roi(field) ?: return
            val crop = ImageEnhancer.enhanceForText(RoiExtractor.crop(backCard, roi))
            val ocr = ocrEngine.recognize(crop, field)
            out[field] = FieldFactory.fromValidation(
                name = field,
                raw = ocr.text,
                source = ExtractionSource.BACK_ROI,
                validation = LocationValidator.validate(ocr.text),
                ocrConfidence = ocr.confidence
            )
        }

        listOf("village", "parish", "sub_county", "county", "district").forEach { readLocation(it) }

        val mrzCrop = BackTemplateV1.template.roi("mrz")
            ?.let { RoiExtractor.crop(backCard, it) }
            ?.let(ImageEnhancer::enhanceForMrz)
        val mrzText = mrzCrop?.let { ocrEngine.recognize(it, "mrz").text }.orEmpty()

        return BackExtraction(out, MrzParser.parse(mrzText))
    }
}
