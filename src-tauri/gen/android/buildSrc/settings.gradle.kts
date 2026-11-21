// buildSrc has its own classpath for the `kotlin-dsl` plugin, resolved before
// build.gradle.kts's project repositories ever apply. Without this file that
// classpath falls back to the Gradle Plugin Portal alone, and the portal's
// proxy of the Kotlin artifacts is unreliable (kotlin-stdlib 2.3.21 — the
// version Gradle 9.6.1's kotlin-dsl pins — 404s there while Maven Central
// serves it, which is what broke the CI android build). google() is included
// for parity with the project repositories: AGP and the Android tooling live
// there.
pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}
