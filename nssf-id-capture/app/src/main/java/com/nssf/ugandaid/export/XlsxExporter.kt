package com.nssf.ugandaid.export

import com.nssf.ugandaid.data.CitizenRecord
import org.apache.poi.xssf.usermodel.XSSFWorkbook
import java.io.OutputStream

class XlsxExporter {
    fun export(records: List<CitizenRecord>, outputStream: OutputStream) {
        XSSFWorkbook().use { workbook ->
            val sheet = workbook.createSheet("Uganda ID Records")
            val header = sheet.createRow(0)
            CsvExporter.headers.forEachIndexed { index, label ->
                header.createCell(index).setCellValue(label)
            }
            records.forEachIndexed { rowIndex, r ->
                val row = sheet.createRow(rowIndex + 1)
                listOf(
                    r.surname, r.givenName, r.nationality, r.sex, r.nin, r.dateOfBirth,
                    r.village, r.parish, r.subCounty, r.county, r.district,
                    r.scanTimestamp.toString(), r.confidence.toString(), r.reviewStatus
                ).forEachIndexed { col, value -> row.createCell(col).setCellValue(value) }
            }
            for (i in CsvExporter.headers.indices) sheet.setColumnWidth(i, 18 * 256)
            workbook.write(outputStream)
        }
    }
}
