package com.nssf.ugandaid.export

import com.nssf.ugandaid.data.CitizenRecord
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets

class CsvExporter {
    fun export(records: List<CitizenRecord>, outputStream: OutputStream) {
        OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { writer ->
            writer.write('\uFEFF'.code)
            writer.appendLine(headers.joinToString(",") { quote(it) })
            records.forEach { r ->
                writer.appendLine(listOf(
                    r.surname, r.givenName, r.nationality, r.sex, r.nin, r.dateOfBirth,
                    r.village, r.parish, r.subCounty, r.county, r.district,
                    r.scanTimestamp.toString(), r.confidence.toString(), r.reviewStatus
                ).joinToString(",") { quote(it) })
            }
        }
    }

    private fun quote(value: String): String = "\"" + value.replace("\"", "\"\"") + "\""

    companion object {
        val headers = listOf(
            "Surname", "Given Name", "Nationality", "Sex", "NIN", "Date of Birth",
            "Village", "Parish", "Sub County", "County", "District",
            "Scan Timestamp", "Confidence", "Review Status"
        )
    }
}
