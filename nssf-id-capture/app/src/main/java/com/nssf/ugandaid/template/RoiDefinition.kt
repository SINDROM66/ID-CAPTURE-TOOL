package com.nssf.ugandaid.template

data class RoiDefinition(
    val fieldName: String,
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float,
    val padding: Float = 0.012f
) {
    init {
        require(x in 0f..1f)
        require(y in 0f..1f)
        require(width > 0f && x + width <= 1f)
        require(height > 0f && y + height <= 1f)
    }
}
