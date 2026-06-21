package com.nssf.ugandaid.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "citizen_records",
    indices = [Index(value = ["nin"]), Index(value = ["scanTimestamp"])]
)
data class CitizenRecord(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val surname: String,
    val givenName: String,
    val nationality: String,
    val sex: String,
    val nin: String,
    val dateOfBirth: String,
    val village: String,
    val parish: String,
    val subCounty: String,
    val county: String,
    val district: String,
    val scanTimestamp: Long,
    val confidence: Double = 0.0,
    val reviewStatus: String = "NEEDS_REVIEW"
)
