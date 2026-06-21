package com.nssf.ugandaid

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(
            TextView(this).apply {
                text = "NSSF Uganda ID Capture\nNative offline OCR pipeline installed."
                textSize = 18f
                setPadding(32, 48, 32, 32)
            }
        )
    }
}
