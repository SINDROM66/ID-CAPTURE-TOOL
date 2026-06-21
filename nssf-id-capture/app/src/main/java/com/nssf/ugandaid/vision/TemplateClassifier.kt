package com.nssf.ugandaid.vision

import com.nssf.ugandaid.ocr.OcrResult
import com.nssf.ugandaid.template.BackTemplateV1
import com.nssf.ugandaid.template.FrontTemplateV1
import com.nssf.ugandaid.template.UgandaIdTemplate

object TemplateClassifier {
    fun classify(probeText: OcrResult?): UgandaIdTemplate {
        val text = probeText?.text?.uppercase().orEmpty()
        return if (
            text.contains("VILLAGE") ||
            text.contains("PARISH") ||
            text.contains("DISTRICT") ||
            text.contains("IDUGA") ||
            text.contains("<<")
        ) BackTemplateV1.template else FrontTemplateV1.template
    }
}
