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
    private const val MAX_FILES = 2500
    private const val MAX_FILE = 200_000L
    private const val MAX_TOTAL = 25_000_000L
    private const val REINDEX_AFTER_MS = 6 * 3600_000L
    private val indexedAt = ConcurrentHashMap<String, Long>()

    fun projectName(root: Path): String = root.fileName.toString()

    fun ensure(root: Path, log: AgentLog, force: Boolean = false) {
        val project = projectName(root)
        if (!force && System.currentTimeMillis() - (indexedAt[project] ?: 0) < REINDEX_AFTER_MS) return
        val t0 = System.currentTimeMillis()
        val files = mutableListOf<Map<String, String>>()
        var total = 0L
        Files.walk(root).use { stream ->
            for (p in stream) {
                if (files.size >= MAX_FILES) break
                if (!p.isRegularFile()) continue
                val relPath = p.relativeTo(root)
                if (relPath.any { it.name in EXCLUDED }) continue
                val rel = relPath.joinToString("/")
                if (p.extension.lowercase() !in CODE_EXT && rel !in CONFIG_FILES) continue
                val size = runCatching { p.fileSize() }.getOrDefault(Long.MAX_VALUE)
                if (size > MAX_FILE || total + size > MAX_TOTAL) continue
                val content = runCatching { Files.readString(p) }.getOrNull() ?: continue
                files += mapOf("path" to rel, "content" to content)
                total += size
            }
        }
        log.line("[원격 색인] $project: 파일 ${files.size}개 (${"%.1f".format(total / 1e6)}MB) 업로드 중…")
        val res = Clients.post("/api/remote/index", mapOf("project" to project, "files" to files), 180)
        indexedAt[project] = System.currentTimeMillis()
        val profile = res.getAsJsonObject("project")?.get("profile")?.asString?.ifBlank { null } ?: "감지 안 됨"
        log.line("[원격 색인] 서버에서 벡터화 시작 · 프로필 $profile · ${"%.1f".format((System.currentTimeMillis() - t0) / 1000.0)}s")
    }
}
