package com.nssf.ugandaid.validation

object ConfidenceScorer {
    fun combine(values: List<Double>): Double {
        val usable = values.filter { it > 0.0 }
        if (usable.isEmpty()) return 0.0
        return usable.average().coerceIn(0.0, 1.0)
    }

    fun accepted(confidence: Double): Boolean = confidence >= 0.90
    fun review(confidence: Double): Boolean = confidence < 0.90
}
