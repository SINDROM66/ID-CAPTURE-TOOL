package com.nssf.ugandaid.extraction

import android.graphics.Bitmap
import com.nssf.ugandaid.domain.ExtractedCitizen
import com.nssf.ugandaid.ocr.OcrEngine
import com.nssf.ugandaid.vision.BitmapCardProcessor
import com.nssf.ugandaid.vision.CardProcessor
import com.nssf.ugandaid.vision.ImageQualityAnalyzer

class OcrPipeline(
    ocrEngine: OcrEngine,
    private val cardProcessor: CardProcessor = BitmapCardProcessor()
) {
    private val extractor = UgandaIdExtractor(ocrEngine)

    suspend fun process(frontImage: Bitmap, backImage: Bitmap): ExtractedCitizen {
        val frontDetection = requireNotNull(cardProcessor.detect(frontImage)) { "Front card not detected" }
        val backDetection = requireNotNull(cardProcessor.detect(backImage)) { "Back card not detected" }

        val frontQuality = ImageQualityAnalyzer.analyze(frontImage, frontDetection.areaRatio)
        val backQuality = ImageQualityAnalyzer.analyze(backImage, backDetection.areaRatio)
        require(frontQuality.acceptable) { "Front image quality failed: ${frontQuality.warnings.joinToString()}" }
        require(backQuality.acceptable) { "Back image quality failed: ${backQuality.warnings.joinToString()}" }

        val frontCard = cardProcessor.warp(frontImage, frontDetection)
        val backCard = cardProcessor.warp(backImage, backDetection)
        return extractor.extract(frontCard, backCard)
    }
}
