package com.nssf.ugandaid.validation

object OcrCorrection {
    fun normalizeSpaces(value: String): String = value
        .uppercase()
        .replace(Regex("[\\t\\n\\r]+"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()

    fun alphabetic(value: String): String = normalizeSpaces(value)
        .replace('0', 'O')
        .replace('1', 'I')
        .replace('5', 'S')
        .replace('8', 'B')
        .replace(Regex("[^A-Z' -]"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()

    fun numeric(value: String): String = normalizeSpaces(value)
        .replace('O', '0')
        .replace('Q', '0')
        .replace('I', '1')
        .replace('L', '1')
        .replace('S', '5')
        .replace('B', '8')
        .replace(Regex("[^0-9]"), "")

    fun nin(value: String): String {
        val compact = normalizeSpaces(value).replace(Regex("[^A-Z0-9]"), "")
        if (compact.length < 5) return compact
        val prefix = compact.take(2).replace('0', 'O').replace('1', 'I')
        val middleEnd = compact.drop(2)
        val corrected = middleEnd.mapIndexed { index, ch ->
            if (index < 10) {
                when (ch) {
                    'O', 'Q' -> '0'
                    'I', 'L' -> '1'
                    'S' -> '5'
                    'B' -> '8'
                    else -> ch
                }
            } else ch
        }.joinToString("")
        return prefix + corrected
    }
}
