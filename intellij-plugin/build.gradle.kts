plugins {
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.20.1"
}

group = "com.localagent"
version = "0.5.1"

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
// 설치 파일에 넣을 고정 서버 주소 (server.json) — 사용자는 토큰만 입력하면 된다.
// 우선순위: 환경변수 YANG_SERVER_URL > 서버(맥)의 Tailscale 주소(backend/data/agent_state/tailscale_url → http://…:18010)
val writeServerJson by tasks.registering {
    val out = layout.buildDirectory.file("generated/server/server.json")
    val tsFile = rootProject.file("../backend/data/agent_state/tailscale_url")
    inputs.property("env", System.getenv("YANG_SERVER_URL") ?: "")
    inputs.property("ts", if (tsFile.exists()) tsFile.readText().trim() else "")
    outputs.file(out)
    doLast {
        var url = (System.getenv("YANG_SERVER_URL") ?: "").trim()
        if (url.isEmpty() && tsFile.exists()) {
            val ts = tsFile.readText().trim().trimEnd('/')
            if (ts.isNotEmpty()) url = ts.replaceFirst("https:", "http:") + ":" + (System.getenv("TS_HTTP_PORT") ?: "18010")
        }
        out.get().asFile.apply { parentFile.mkdirs(); writeText("{\"url\": \"$url\"}\n") }
        println("server.json: ${url.ifEmpty { "(비어 있음 — 설치 후 직접 입력)" }}")
    }
}
sourceSets["main"].resources.srcDir(layout.buildDirectory.dir("generated/server"))
tasks.processResources { dependsOn(copyChatUi, writeServerJson) }

tasks.test { useJUnit() }
