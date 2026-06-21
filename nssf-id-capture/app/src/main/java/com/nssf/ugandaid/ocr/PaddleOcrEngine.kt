package com.nssf.ugandaid.ocr

import android.content.Context
import android.graphics.Bitmap
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.FloatBuffer

class PaddleOcrEngine(
    context: Context,
    private val recognizerAsset: String = "paddleocr/rec.onnx",
    private val keysAsset: String = "paddleocr/keys.txt"
) : OcrEngine, AutoCloseable {
    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val keys: List<String>

    init {
        val model = context.assets.open(recognizerAsset).readBytes()
        session = env.createSession(model)
        keys = context.assets.open(keysAsset).bufferedReader().readLines()
    }

    override suspend fun recognize(bitmap: Bitmap, hint: String?): OcrResult = withContext(Dispatchers.Default) {
        val input = normalizeForRecognition(bitmap)
        val inputName = session.inputNames.first()
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input.data), input.shape).use { tensor ->
            session.run(mapOf(inputName to tensor)).use { output ->
                val raw = output[0].value
                val decoded = decodeCtc(raw)
                OcrResult(
                    text = decoded.text,
                    lines = listOf(OcrLine(decoded.text, decoded.confidence)),
                    confidence = decoded.confidence
                )
            }
        }
    }

    private data class TensorInput(val data: FloatArray, val shape: LongArray)
    private data class DecodedText(val text: String, val confidence: Double)

    private fun normalizeForRecognition(bitmap: Bitmap): TensorInput {
        val targetH = 48
        val targetW = 320
        val scaled = Bitmap.createScaledBitmap(bitmap, targetW, targetH, true)
        val pixels = IntArray(targetW * targetH)
        scaled.getPixels(pixels, 0, targetW, 0, 0, targetW, targetH)

        val data = FloatArray(1 * 3 * targetH * targetW)
        for (y in 0 until targetH) {
            for (x in 0 until targetW) {
                val p = pixels[y * targetW + x]
                val r = ((p shr 16) and 0xff) / 255f
                val g = ((p shr 8) and 0xff) / 255f
                val b = (p and 0xff) / 255f
                val idx = y * targetW + x
                data[idx] = (r - 0.5f) / 0.5f
                data[targetH * targetW + idx] = (g - 0.5f) / 0.5f
                data[2 * targetH * targetW + idx] = (b - 0.5f) / 0.5f
            }
        }
        return TensorInput(data, longArrayOf(1, 3, targetH.toLong(), targetW.toLong()))
    }

    @Suppress("UNCHECKED_CAST")
    private fun decodeCtc(raw: Any): DecodedText {
        val logits = raw as Array<Array<FloatArray>>
        val timeSteps = logits[0]
        val chars = StringBuilder()
        var lastIndex = -1
        var confidenceSum = 0.0
        var emitted = 0

        for (step in timeSteps) {
            var bestIndex = 0
            var bestScore = Float.NEGATIVE_INFINITY
            for (i in step.indices) {
                if (step[i] > bestScore) {
                    bestScore = step[i]
                    bestIndex = i
                }
            }
            if (bestIndex > 0 && bestIndex != lastIndex) {
                val keyIndex = bestIndex - 1
                if (keyIndex in keys.indices) {
                    chars.append(keys[keyIndex])
                    confidenceSum += bestScore.toDouble().coerceIn(0.0, 1.0)
                    emitted += 1
                }
            }
            lastIndex = bestIndex
        }

        return DecodedText(
            text = chars.toString(),
            confidence = if (emitted == 0) 0.0 else (confidenceSum / emitted).coerceIn(0.0, 1.0)
        )
    }

    override fun close() {
        session.close()
    }
}
