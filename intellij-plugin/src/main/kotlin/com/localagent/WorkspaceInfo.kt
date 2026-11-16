package com.localagent

import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.TimeUnit

/**
 * 작업 폴더 인식 (VS Code workspace.ts · wsinfo.ts 와 같은 규칙):
 * 폴더 구조 · git 정보를 사용자 PC 에서 직접 읽어 에이전트에게 알려준다.
 * 원격 모드에서 서버(맥)는 이 PC 의 폴더를 볼 수 없으므로 여기서 모아 프롬프트에 넣는다.
 */
object WorkspaceInfo {
    val SKIP_DIRS = setOf(
        "node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "Pods", ".dart_tool",
        ".gradle", "out", ".idea", "coverage", ".yang", ".vscode", ".pub-cache", ".cxx", "DerivedData", ".mypy_cache", ".pytest_cache",
    )

    /** 승인 없이 실행해도 되는 읽기 전용 git 명령 */
    fun isReadOnlyGit(command: String): Boolean {
        val c = command.trim()
        if (Regex("[;&|`$<>\r\n]").containsMatchIn(c)) return false
        val m = Regex("""^git(?:\s+-C\s+\S+)?\s+(\S+)(.*)$""").find(c) ?: return false
        val (sub, rest) = m.destructured
        if (sub in setOf("status", "log", "diff", "show", "blame", "shortlog", "describe", "rev-parse", "ls-files", "grep")) return true
        return when (sub) {
            "branch" -> !Regex("""\s-(d|D|m|M|c|C|f|u)\b|--(delete|move|copy|force|set-upstream)""").containsMatchIn(rest)
            "remote" -> Regex("""^\s*(-v|show\b|get-url\b)?\s*\S*\s*$""").matches(rest) &&
                !Regex("""\b(add|remove|rm|rename|set-url|prune)\b""").containsMatchIn(rest)
            "stash" -> Regex("""^\s*list\b""").containsMatchIn(rest)
            "tag" -> Regex("""^\s*(-l\b|--list\b)?\s*$""").matches(rest)
            else -> false
        }
    }

    data class DirInfo(val rel: String, val files: Int, val dirs: Int)

    /** 폴더 구조 요약 (항상 같은 순서 → 엔진 캐시 재사용) */
    fun formatTree(dirs: List<DirInfo>, rootFiles: List<String>, maxDirs: Int = 120): String {
        val sorted = dirs.sortedBy { it.rel }
        val lines = sorted.take(maxDirs).map { d ->
            val depth = d.rel.count { it == '/' }
            val meta = listOfNotNull(if (d.files > 0) "${d.files} files" else null, if (d.dirs > 0) "${d.dirs} dirs" else null).joinToString(", ")
            "${"  ".repeat(depth)}${d.rel.substringAfterLast('/')}/" + if (meta.isNotEmpty()) " ($meta)" else " (비어 있음)"
        }.toMutableList()
        if (sorted.size > maxDirs) lines += "…(폴더 ${sorted.size - maxDirs}개 더: LIST 폴더경로 로 확인)"
        val files = rootFiles.sorted()
        lines += files.take(40)
        if (files.size > 40) lines += "…(루트 파일 ${files.size - 40}개 더)"
        return lines.joinToString("\n")
    }

    fun isDirListing(pattern: String) = !Regex("""[*?\[\]{}]""").containsMatchIn(pattern)

    /** 폴더 구조 (깊이 3) — 읽을 수 없는 폴더는 건너뜀 */
    fun folderTree(root: Path, maxDepth: Int = 3): String {
        val dirs = mutableListOf<DirInfo>()
        var rootFiles = emptyList<String>()
        fun walk(dir: Path, rel: String, depth: Int) {
            val entries = try { Files.newDirectoryStream(dir).use { it.toList() } } catch (e: Exception) { return }
            val subdirs = entries.filter { Files.isDirectory(it) && it.fileName.toString().let { n -> n !in SKIP_DIRS && !(n.startsWith(".") && n != ".github") } }
                .sortedBy { it.fileName.toString() }
            val files = entries.filter { Files.isRegularFile(it) }.map { it.fileName.toString() }
            if (rel.isNotEmpty()) dirs += DirInfo(rel, files.size, subdirs.size) else rootFiles = files
            if (depth >= maxDepth || dirs.size > 400) return
            for (d in subdirs) walk(d, if (rel.isEmpty()) d.fileName.toString() else "$rel/${d.fileName}", depth + 1)
        }
        walk(root, "", 0)
        return formatTree(dirs, rootFiles)
    }

    /** 제외 폴더는 들어가지 않고, 권한 없는 폴더는 건너뛰며 파일을 모은다 (Files.walk 는 하나만 막혀도 전체가 실패) */
    fun walkFiles(root: Path, limit: Int, accept: (Path) -> Boolean = { true }): List<Path> {
        val out = mutableListOf<Path>()
        Files.walkFileTree(root, object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult =
                if (dir != root && dir.fileName.toString() in SKIP_DIRS) FileVisitResult.SKIP_SUBTREE else FileVisitResult.CONTINUE
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                if (attrs.isRegularFile && accept(file)) out.add(file)
                return if (out.size >= limit) FileVisitResult.TERMINATE else FileVisitResult.CONTINUE
            }
            override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult = FileVisitResult.CONTINUE
        })
        return out
    }

    /** LIST 폴더경로: 한 단계 항목 (폴더는 / 로 끝남) */
    fun listDir(root: Path, dir: Path): List<String> {
        val base = root.relativize(dir).toString().replace('\\', '/')
        return Files.newDirectoryStream(dir).use { it.toList() }
            .sortedWith(compareBy({ !Files.isDirectory(it) }, { it.fileName.toString() }))
            .map { (if (base.isEmpty()) "" else "$base/") + it.fileName + if (Files.isDirectory(it)) "/" else "" }
    }

    private fun git(cwd: Path, vararg args: String): String? = try {
        val p = ProcessBuilder(listOf("git") + args).directory(cwd.toFile()).redirectErrorStream(false).start()
        val out = p.inputStream.bufferedReader().readText()
        if (p.waitFor(5, TimeUnit.SECONDS) && p.exitValue() == 0) out.trim() else null
    } catch (e: Exception) { null }

    fun gitStable(root: Path): String {
        val top = git(root, "rev-parse", "--show-toplevel")
            ?: return if (git(root, "--version") != null) "git 레포 아님 (필요하면 RUN git init)" else "git 이 설치되어 있지 않거나 PATH 에 없음"
        val origin = (git(root, "remote", "-v") ?: "").lines().filter { it.endsWith("(fetch)") }
            .joinToString(", ") { it.removeSuffix("(fetch)").trim().replace("\t", " → ") }
        val sub = runCatching { Path.of(top).relativize(root).toString() }.getOrDefault("")
        return "git 레포 루트: $top${if (sub.isNotEmpty()) " (작업 폴더는 그 안의 ${sub.replace('\\', '/')})" else ""}\n원격: ${origin.ifEmpty { "(없음)" }}"
    }

    fun gitNow(root: Path): String {
        val st = git(root, "status", "--porcelain=v1", "-b") ?: return ""
        val lines = st.lines().filter { it.isNotBlank() }.toMutableList()
        val branch = if (lines.firstOrNull()?.startsWith("## ") == true) lines.removeAt(0).substring(3) else "브랜치 정보 없음"
        val log = git(root, "log", "--oneline", "-5").orEmpty()
        val shown = lines.take(25)
        return "(git) $branch · 변경 ${lines.size}개" +
            (if (shown.isNotEmpty()) "\n" + shown.joinToString("\n") + (if (lines.size > shown.size) "\n…(${lines.size - shown.size}개 더)" else "") else "") +
            (if (log.isNotEmpty()) "\n최근 커밋:\n$log" else "")
    }

    /** 파일 이름의 역할 접미사: OrderController.kt → Controller · order_screen.dart → _screen */
    fun roleSuffix(file: String): String {
        val base = file.substringAfterLast('/').substringBeforeLast('.')
        Regex("(_[a-z]+)$").find(base)?.let { if (base.contains('_')) return it.groupValues[1] }
        val camel = Regex("([A-Z][a-z0-9]+)$").find(base)
        return if (camel != null && camel.range.first > 0) camel.groupValues[1] else ""
    }

    private val TEST_RE = Regex("""(^|/)(test|tests|__tests__|spec)/|[._-](test|spec)\.|Test\.[^.]+$""")

    /** 새 파일의 스타일 기준이 될 기존 파일 (같은 확장자 · 같은 역할 접미사 · 같은 폴더/레이어) */
    fun pickStyleSibling(newRel: String, candidates: List<String>): String? {
        val ext = Regex("\\.[^./]+$").find(newRel)?.value ?: return null
        if (Regex("\\.(md|txt|json|ya?ml|png|jpe?g|svg|lock)$", RegexOption.IGNORE_CASE).containsMatchIn(newRel)) return null
        val dir = newRel.substringBeforeLast('/', "")
        val layer = dir.substringAfterLast('/')
        val suf = roleSuffix(newRel)
        val isTest = TEST_RE.containsMatchIn(newRel)
        var best: String? = null
        var bestScore = 0
        for (c in candidates) {
            if (c == newRel || !c.endsWith(ext) || Regex("\\.(g|freezed|gr)\\.dart$").containsMatchIn(c)) continue
            if (TEST_RE.containsMatchIn(c) != isTest) continue
            val cDir = c.substringBeforeLast('/', "")
            var score = 1
            if (cDir == dir) score += 4 else if (layer.isNotEmpty() && cDir.substringAfterLast('/') == layer) score += 3
            if (suf.isNotEmpty() && roleSuffix(c) == suf) score += 5
            if (score > bestScore) { bestScore = score; best = c }
        }
        return if (bestScore >= 4) best else null
    }

    /** 새 내용에 기존 줄(공백 무시)이 얼마나 남아 있는지 0~1 */
    fun keptRatio(before: String, after: String): Double {
        fun norm(t: String) = t.lines().map { it.trim() }.filter { it.length > 2 }
        val old = norm(before)
        if (old.isEmpty()) return 1.0
        val now = norm(after).toHashSet()
        return old.count { it in now }.toDouble() / old.size
    }
}
