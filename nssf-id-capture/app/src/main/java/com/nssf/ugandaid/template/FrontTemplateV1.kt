package com.nssf.ugandaid.template

object FrontTemplateV1 {
    val template = UgandaIdTemplate(
        id = "UGANDA_FRONT_V1",
        side = CardSide.FRONT,
        rois = listOf(
            RoiDefinition("surname", 0.285f, 0.205f, 0.455f, 0.070f),
            RoiDefinition("given_name", 0.285f, 0.292f, 0.500f, 0.078f),
            RoiDefinition("nationality", 0.285f, 0.392f, 0.170f, 0.060f),
            RoiDefinition("sex", 0.510f, 0.392f, 0.090f, 0.060f),
            RoiDefinition("date_of_birth", 0.285f, 0.482f, 0.285f, 0.066f),
            RoiDefinition("nin", 0.285f, 0.618f, 0.475f, 0.074f)
        )
    )
}
