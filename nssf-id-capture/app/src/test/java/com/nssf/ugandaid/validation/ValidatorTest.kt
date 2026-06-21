package com.nssf.ugandaid.validation

import com.nssf.ugandaid.extraction.MrzParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ValidatorTest {
    @Test
    fun ninRejectsNoiseThatOnlyStartsWithCf() {
        val result = NinValidator.validate("CFWERDPAGONE3BT")
        assertFalse(result.valid)
    }

    @Test
    fun ninAcceptsUgandaStyleCode() {
        val result = NinValidator.validate("CM0003510932UXF")
        assertTrue(result.valid)
        assertEquals("CM0003510932UXF", result.value)
    }

    @Test
    fun sexAllowsOnlyMOrF() {
        assertTrue(SexValidator.validate("M").valid)
        assertTrue(SexValidator.validate("F").valid)
        assertFalse(SexValidator.validate("X").valid)
    }

    @Test
    fun mrzExtractsIdentityFallbackFields() {
        val raw = """
            IDUGA0119307246<<<<<<<<<<<<<<<
            8805121M3009301UGA<<<<<<<<<<<<
            KATO<<JOHN<PAUL<<<<<<<<<<<<<<<
        """.trimIndent()

        val result = MrzParser.parse(raw)
        assertEquals("KATO", result.surname)
        assertEquals("JOHN PAUL", result.givenName)
        assertEquals("M", result.sex)
        assertEquals("UGA", result.nationality)
        assertEquals("12.05.1988", result.dateOfBirth)
    }
}
