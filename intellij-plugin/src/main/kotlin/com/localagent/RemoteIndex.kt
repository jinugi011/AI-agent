package com.localagent

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import kotlin.io.path.extension
import kotlin.io.path.fileSize
import kotlin.io.path.isRegularFile
import kotlin.io.path.name
import kotlin.io.path.relativeTo

/** 원격 모드: 이 PC 의 프로젝트 파일을 서버(맥)로 올려 벡터화 (VS Code remoteIndex.ts 와 동일 규칙). */
object RemoteIndex {
    private val EXCLUDED = setOf(
        "node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "Pods",
        ".dart_tool", ".gradle", "models", "out", ".idea", "coverage",
    )
    private val CODE_EXT = setOf(
        "py", "js", "jsx", "ts", "tsx", "java", "kt", "kts", "dart", "swift", "go", "rs", "cpp", "cc", "hpp", "h", "c",
        "sql", "md", "yaml", "yml", "json", "toml", "css",
    )
    private val CONFIG_FILES = setOf(
        ".editorconfig", ".prettierrc", ".prettierrc.json", ".eslintrc", ".eslintrc.json", "eslint.config.js", "ruff.toml", ".flake8",
        "pyproject.toml", "rustfmt.toml", "analysis_options.yaml", ".swiftlint.yml", "detekt.yml", ".golangci.yml", "tsconfig.json",
        "requirements.txt", "setup.py", "package.json", "pubspec.yaml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
        "build.gradle.kts", "Package.swift", "app/build.gradle", "app/build.gradle.kts", "vite.config.js", "vite.config.ts",
    )
    // MyBatis 매퍼 XML · Spring 설정 · Gradle 설정 (EHS 같은 Spring 백엔드의 구조 분석에 필요)
    private val EXTRA_RE = Regex("""(^|/)docs?/.*\.(txt|adoc|rst)$|\.(adoc|rst)$|(^|/)(mapper|mappers|sqlmap|mybatis)/.*\.xml$|Mapper\.xml$|(^|/)pom\.xml$|(^|/)(application|bootstrap)(-\w+)?\.(ya?ml|properties)$|(^|/)(settings|build)\.gradle(\.kts)?$|(^|/)gradle\.properties$""")
    private const val MAX_FILES = 2500
    private const val MAX_FILE = 200_000L
    private const val MAX_TOTAL = 25_000_000L
    private const val REINDEX_AFTER_MS = 6 * 3600_000L
    private val indexedAt = ConcurrentHashMap<String, Long>()

    fun projectName(root: Path): String = root.fileName.toString()

    fun ensure(root: Path, log: AgentLog, force: Boolean = false, arch: String = "auto", name: String = "") {
        val project = name.ifBlank { projectName(root) }
        if (!force && System.currentTimeMillis() - (indexedAt[project] ?: 0) < REINDEX_AFTER_MS) return
        val t0 = System.currentTimeMillis()
        val files = mutableListOf<Map<String, String>>()
        var total = 0L
        run {
            for (p in WorkspaceInfo.walkFiles(root, 20_000)) {
                if (files.size >= MAX_FILES) break
                val relPath = p.relativeTo(root)
                if (relPath.any { it.name in EXCLUDED }) continue
                val rel = relPath.joinToString("/")
                if (p.extension.lowercase() !in CODE_EXT && rel !in CONFIG_FILES && !EXTRA_RE.containsMatchIn(rel)) continue
                val size = runCatching { p.fileSize() }.getOrDefault(Long.MAX_VALUE)
                if (size > MAX_FILE || total + size > MAX_TOTAL) continue
                val content = runCatching { Files.readString(p) }.getOrNull() ?: continue
                files += mapOf("path" to rel, "content" to content)
                total += size
            }
        }
        log.line("[원격 색인] $project: 파일 ${files.size}개 (${"%.1f".format(total / 1e6)}MB) 업로드 중…")
        val res = Clients.post("/api/remote/index", mapOf("project" to project, "files" to files, "arch" to arch, "client_path" to root.toString()), 180)
        indexedAt[project] = System.currentTimeMillis()
        val profile = res.getAsJsonObject("project")?.get("profile")?.asString?.ifBlank { null } ?: "감지 안 됨"
        log.line("[원격 색인] 서버에서 벡터화 시작 · 프로필 $profile · ${"%.1f".format((System.currentTimeMillis() - t0) / 1000.0)}s")
    }

    /** 웹 관리 페이지에서 '원격 PC 경로'로 등록한 프로젝트(PC 대기)를 이 PC 에서 찾아 올린다. */
    @Volatile private var syncing = false
    fun syncPending(log: AgentLog): List<String> {
        if (syncing) return emptyList()
        syncing = true
        val done = mutableListOf<String>()
        try {
            val items = Clients.get("/api/remote/pending", 5).getAsJsonArray("items") ?: return done
            for (it in items) {
                val o = it.asJsonObject
                val path = runCatching { Path.of(o.get("client_path").asString) }.getOrNull() ?: continue
                if (!Files.isDirectory(path)) continue // 다른 PC 의 경로
                val name = o.get("name").asString
                log.line("[원격 등록] '$name' ($path) → 이 PC 에서 파일을 올려 분석합니다")
                ensure(path, log, force = true, name = name)
                done += name
            }
        } catch (e: Exception) { /* 서버 연결 전 등 — 다음에 다시 */ } finally { syncing = false }
        return done
    }

    /** 프로젝트 전체 분석 (ANALYZE · /arch 분석): 올려서 임베딩 → 코딩 스타일 → 아키텍처 문서까지 기다린다. */
    fun analyze(root: Path, log: AgentLog, name: String = "", cancelled: () -> Boolean = { false }, onProgress: (String) -> Unit = {}): Pair<String, String> {
        val project = name.ifBlank { projectName(root) }
        val key = project.lowercase().replace(Regex("[^a-z0-9_-]+"), "-").trim('-')
        onProgress("파일을 모아 서버로 올리는 중…")
        ensure(root, log, force = true, arch = "force", name = project)
        val t0 = System.currentTimeMillis()
        var rec: com.google.gson.JsonObject? = null
        fun s(k: String) = rec?.get(k)?.takeIf { !it.isJsonNull }?.asString ?: ""
        while (System.currentTimeMillis() - t0 < 420_000) {
            if (cancelled()) error("중단됨")
            Thread.sleep(3000)
            rec = runCatching { Clients.get("/api/remote/projects", 10).getAsJsonObject("projects").getAsJsonObject(key) }.getOrNull() ?: continue
            val sec = (System.currentTimeMillis() - t0) / 1000
            when {
                s("status") == "error" -> error("임베딩 실패: ${s("error")}")
                s("status") == "indexing" -> onProgress("코드·문서 임베딩 중… (${sec}초)")
                s("arch_status") == "analyzing" -> onProgress("아키텍처 분석 중… (${sec}초)")
                s("status") == "ready" -> break
            }
        }
        val md = runCatching { Clients.get("/api/arch/" + java.net.URLEncoder.encode(project, Charsets.UTF_8).replace("+", "%20")).get("markdown") }
            .getOrNull()?.takeIf { !it.isJsonNull }?.asString ?: ""
        val m = rec?.getAsJsonObject("methods")
        val langs = m?.getAsJsonObject("languages")?.entrySet()?.joinToString(", ") { "${it.key} ${it.value}" } ?: "-"
        val summary = "프로젝트 ${s("name").ifBlank { project }} · 프로필 ${s("profile").ifBlank { "감지 안 됨" }} · 파일 ${rec?.get("files") ?: "?"}개 · 청크 ${rec?.get("chunks") ?: "?"}개\n" +
            "언어: $langs · 들여쓰기 ${m?.get("indentation")?.asString ?: "-"} · 네이밍 ${m?.get("naming")?.asString ?: "-"}" +
            (if (s("arch_status") == "error") "\n아키텍처 분석 실패: ${s("arch_error")}" else "")
        return summary to md
    }
}
