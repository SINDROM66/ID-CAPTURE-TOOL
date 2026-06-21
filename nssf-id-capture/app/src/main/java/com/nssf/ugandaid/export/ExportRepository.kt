package com.nssf.ugandaid.export

import android.content.Context
import android.net.Uri
import com.nssf.ugandaid.data.AppDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class ExportRepository(private val context: Context) {
    private val dao = AppDatabase.get(context).citizenRecordDao()

    suspend fun exportCsv(uri: Uri) = withContext(Dispatchers.IO) {
        val records = dao.allRecords()
        context.contentResolver.openOutputStream(uri)?.use { CsvExporter().export(records, it) }
    }

    suspend fun exportXlsx(uri: Uri) = withContext(Dispatchers.IO) {
        val records = dao.allRecords()
        context.contentResolver.openOutputStream(uri)?.use { XlsxExporter().export(records, it) }
    }
}
