package com.nssf.ugandaid.template

object BackTemplateV1 {
    val template = UgandaIdTemplate(
        id = "UGANDA_BACK_V1",
        side = CardSide.BACK,
        rois = listOf(
            RoiDefinition("village", 0.110f, 0.120f, 0.500f, 0.070f),
            RoiDefinition("parish", 0.110f, 0.215f, 0.500f, 0.070f),
            RoiDefinition("sub_county", 0.110f, 0.310f, 0.500f, 0.070f),
            RoiDefinition("county", 0.110f, 0.405f, 0.500f, 0.070f),
            RoiDefinition("district", 0.110f, 0.500f, 0.500f, 0.070f),
            RoiDefinition("mrz", 0.030f, 0.710f, 0.940f, 0.240f, padding = 0.004f)
        )
    )
}
