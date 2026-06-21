package com.nssf.ugandaid.domain

data class ExtractedCitizen(
    val surname: String = "",
    val givenName: String = "",
    val nationality: String = "",
    val sex: String = "",
    val nin: String = "",
    val dateOfBirth: String = "",
    val village: String = "",
    val parish: String = "",
    val subCounty: String = "",
    val county: String = "",
    val district: String = "",
    val fields: Map<String, ExtractedField> = emptyMap(),
    val overallConfidence: Double = 0.0,
    val needsReview: Boolean = true
) {
    fun toRequiredJsonMap(): Map<String, String> = mapOf(
        "surname" to surname,
        "given_name" to givenName,
        "nationality" to nationality,
        "sex" to sex,
        "nin" to nin,
        "date_of_birth" to dateOfBirth,
        "village" to village,
        "parish" to parish,
        "sub_county" to subCounty,
        "county" to county,
        "district" to district
    )
}
