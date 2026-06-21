package com.nssf.ugandaid.extraction

import com.nssf.ugandaid.domain.ExtractedField

object FieldMerger {
    fun best(vararg fields: ExtractedField?): ExtractedField? {
        return fields.filterNotNull()
            .filter { it.valid && it.value.isNotBlank() }
            .maxByOrNull { it.confidence }
    }

    fun agree(a: String, b: String): Boolean {
        if (a.isBlank() || b.isBlank()) return false
        if (a == b) return true
        val x = a.replace(" ", "")
        val y = b.replace(" ", "")
        return levenshtein(x, y).toDouble() / maxOf(x.length, y.length) <= 0.18
    }

    private fun levenshtein(a: String, b: String): Int {
        val dp = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) dp[i][0] = i
        for (j in 0..b.length) dp[0][j] = j
        for (i in 1..a.length) {
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                dp[i][j] = minOf(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
            }
        }
        return dp[a.length][b.length]
    }
}
