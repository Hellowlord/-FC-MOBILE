pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "FC-Mobile"

// :core is a pure Kotlin/JVM module with zero Android dependencies.
// That is deliberate: the match simulation must be unit-testable on a laptop in
// seconds, with no emulator, so it can be regression-tested in CI on every
// tuning change. Only :app touches the Android SDK.
include(":core")
include(":app")
