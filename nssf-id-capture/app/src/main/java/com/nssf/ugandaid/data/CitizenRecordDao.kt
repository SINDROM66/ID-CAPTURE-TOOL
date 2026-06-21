package com.nssf.ugandaid.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Transaction
import com.nssf.ugandaid.domain.ExtractedCitizen

@Dao
interface CitizenRecordDao {
    @Insert
    suspend fun insertRecord(record: CitizenRecord): Long

    @Insert
    suspend fun insertFields(fields: List<ExtractedFieldRecord>)

    @Query("SELECT * FROM citizen_records ORDER BY scanTimestamp DESC")
    suspend fun allRecords(): List<CitizenRecord>

    @Query("SELECT * FROM citizen_records WHERE scanTimestamp BETWEEN :from AND :to ORDER BY scanTimestamp ASC")
    suspend fun recordsBetween(from: Long, to: Long): List<CitizenRecord>

    @Query("SELECT COUNT(*) FROM citizen_records WHERE nin = :nin")
    suspend fun countByNin(nin: String): Int

    @Transaction
    suspend fun saveExtraction(extraction: ExtractedCitizen): Long {
        val id = insertRecord(
            CitizenRecord(
                surname = extraction.surname,
                givenName = extraction.givenName,
                nationality = extraction.nationality,
                sex = extraction.sex,
                nin = extraction.nin,
                dateOfBirth = extraction.dateOfBirth,
                village = extraction.village,
                parish = extraction.parish,
                subCounty = extraction.subCounty,
                county = extraction.county,
                district = extraction.district,
                scanTimestamp = System.currentTimeMillis(),
                confidence = extraction.overallConfidence,
                reviewStatus = if (extraction.needsReview) "NEEDS_REVIEW" else "ACCEPTED"
            )
        )
        insertFields(extraction.fields.values.map {
            ExtractedFieldRecord(
                recordId = id,
                fieldName = it.name,
                value = it.value,
                rawText = it.rawText,
                source = it.source.name,
                confidence = it.confidence,
                valid = it.valid
            )
        })
        return id
    }
}
