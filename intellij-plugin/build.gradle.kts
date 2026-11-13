plugins {
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.20.1"
}

group = "com.localagent"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

kotlin { jvmToolchain(21) }

dependencies {
    intellijPlatform {
        local(providers.gradleProperty("localIdePath"))
    }
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "252"
            untilBuild = provider { null }
        }
    }
    buildSearchableOptions = false
    instrumentCode = false
}

// 채팅 UI 는 VS Code 확장과 같은 파일을 사용한다 (단일 소스)
val copyChatUi by tasks.registering(Copy::class) {
    from("../vscode-extension/media") { include("chat.js", "chat.css") }
    into(layout.buildDirectory.dir("generated/chat-ui/chat-ui"))
}
sourceSets["main"].resources.srcDir(layout.buildDirectory.dir("generated/chat-ui"))
tasks.processResources { dependsOn(copyChatUi) }

tasks.test { useJUnit() }
