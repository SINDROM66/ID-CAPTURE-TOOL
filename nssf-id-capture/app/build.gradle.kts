plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // KSP was removed due to build issues in constrained environment, replaced with KAPT
    // id("com.google.devtools.ksp") version "1.9.23-1.0.20"
    // Ensure KAPT is applied for Room annotation processing
    // This plugin is typically applied automatically by the Kotlin Android plugin,
    // but explicitly adding it here for clarity and to ensure it's available for Room.
    id("kotlin-kapt")
}

android {
    namespace = "com.nssf.ugandaid"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nssf.ugandaid"
        minSdk = 26
        targetSdk = 34 // Changed to 34 for broader compatibility and to match common build-tools versions
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8 // Changed to 1.8 for broader compatibility
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")

    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")
    implementation("org.apache.poi:poi-ooxml:5.2.3") // Changed to a slightly older, stable version for compatibility

    // Import the official OpenCV Android SDK as app/libs/opencv-android-sdk.aar.
    // Many teams keep this AAR vendored to preserve fully offline reproducible builds.
    implementation(files("libs/opencv-android-sdk.aar"))

    testImplementation("junit:junit:4.13.2")
}
