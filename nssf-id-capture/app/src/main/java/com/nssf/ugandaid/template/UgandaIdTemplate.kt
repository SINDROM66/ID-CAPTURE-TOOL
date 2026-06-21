package com.nssf.ugandaid.template

enum class CardSide { FRONT, BACK }

data class UgandaIdTemplate(
    val id: String,
    val side: CardSide,
    val canonicalWidth: Int = 1000,
    val canonicalHeight: Int = 630,
    val rois: List<RoiDefinition>
) {
    fun roi(fieldName: String): RoiDefinition? = rois.firstOrNull { it.fieldName == fieldName }
}
