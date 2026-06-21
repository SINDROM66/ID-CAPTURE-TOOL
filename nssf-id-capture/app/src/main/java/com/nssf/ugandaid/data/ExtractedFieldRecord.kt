package com.nssf.ugandaid.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "extracted_fields",
    foreignKeys = [
        ForeignKey(
            entity = CitizenRecord::class,
            parentColumns = ["id"],
            childColumns = ["recordId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("recordId"), Index("fieldName")]
)
data class ExtractedFieldRecord(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val recordId: Long,
    val fieldName: String,
    val value: String,
    val rawText: String,
    val source: String,
    val confidence: Double,
    val valid: Boolean
)
