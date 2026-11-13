package com.localagent

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.google.gson.JsonObject
import java.io.File
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.io.path.isDirectory
import kotlin.io.path.name
import kotlin.io.path.relativeTo

private val EXCLUDED_DIRS = setOf(
    "node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next",
    "Pods", ".dart_tool", ".gradle", "models", "out", ".idea",
)
private const val MAX_READ = 60_000
private const val MAX_OUT = 8_000

/** 도구 실행 환경 (세션이 제공). */
interface ToolHost {
    val project: Project
    val root: Path
    val repoName: String
    val checkpoint: Checkpoint
    val originals: MutableMap<String, String> // diff id → 변경 전 내용
    fun isCancelled(): Boolean
    fun approve(kind: String, title: String, detail: String): Boolean
    fun emit(event: Map<String, Any?>)
    fun registerProcess(p: Process?)
}

/** 대화 턴 단위 변경 기록: 원본 스냅샷으로 되돌리기. */
class Checkpoint {
    val originals = LinkedHashMap<String, String?>() // 절대경로 → 원본(null = 새 파일)

    fun record(path: Path, before: String?) {
        originals.putIfAbsent(path.toString(), before)
    }

    fun revert(project: Project): Int {
        val n = originals.size
        for ((p, before) in originals) {
            if (before == null) FileOps.delete(project, Path.of(p)) else FileOps.write(project, Path.of(p), before)
        }
        originals.clear()
        return n
    }
}

object FileOps {
    fun resolveInRoot(root: Path, rel: String): Path {
        val abs = root.resolve(rel).normalize()
        require(abs.startsWith(root.normalize())) { "프로젝트 밖 경로는 사용할 수 없습니다: $rel" }
        require(".git" !in abs.relativeTo(root).map { it.name }) { ".git 내부는 수정할 수 없습니다" }
        return abs
    }

    /** 에디터에 열린(저장 안 된) 내용까지 반영해 읽는다. */
    fun read(path: Path): String? {
        val vf = LocalFileSystem.getInstance().findFileByNioFile(path)
        if (vf != null) {
            val doc = ApplicationManager.getApplication().runReadAction<com.intellij.openapi.editor.Document?> {
                FileDocumentManager.getInstance().getCachedDocument(vf)
            }
            if (doc != null) return ApplicationManager.getApplication().runReadAction<String> { doc.text }
        }
        return if (Files.isRegularFile(path)) Files.readString(path) else null
    }

    /** IntelliJ 문서 편집으로 기록 → 에디터에서 Cmd+Z 로 되돌릴 수 있다. */
    fun write(project: Project, path: Path, content: String) {
        val text = content.replace("\r\n", "\n")
        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project, "Local Agent 편집", "local-agent", {
                val parent = VfsUtil.createDirectoryIfMissing(path.parent.toString())
                    ?: throw IllegalStateException("폴더를 만들 수 없습니다: ${path.parent}")
                val vf = parent.findChild(path.fileName.toString()) ?: parent.createChildData(this, path.fileName.toString())
                val doc = FileDocumentManager.getInstance().getDocument(vf)
                if (doc != null) {
                    doc.setText(text)
                    FileDocumentManager.getInstance().saveDocument(doc)
                } else {
                    VfsUtil.saveText(vf, text)
                }
            })
        }
    }

    fun delete(project: Project, path: Path) {
        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project, "Local Agent 삭제", "local-agent", {
                LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path)?.delete(this)
            })
        }
    }

    fun showDiff(project: Project, root: Path, rel: String, before: String) {
        val path = root.resolve(rel)
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path) ?: return
        val factory = DiffContentFactory.getInstance()
        val type = FileTypeManager.getInstance().getFileTypeByFileName(path.fileName.toString())
        val request = SimpleDiffRequest(
            "${path.fileName} (에이전트 변경 전 ↔ 후)",
            factory.create(project, before, type),
            factory.create(project, vf),
            "변경 전", "변경 후",
        )
        ApplicationManager.getApplication().invokeLater { DiffManager.getInstance().showDiff(project, request) }
    }
}

private fun truncate(s: String, max: Int = MAX_OUT) =
    if (s.length <= max) s else s.take(max / 2) + "\n…(${s.length - max}자 생략)…\n" + s.takeLast(max / 2)

/** 셸 명령 실행 (취소 시 프로세스 종료). */
fun runProcess(cmd: List<String>, cwd: Path, host: ToolHost, timeoutSec: Long = 300): Pair<Int, String> {
    val pb = ProcessBuilder(cmd).directory(cwd.toFile()).redirectErrorStream(true)
    pb.environment()["CI"] = "1"
    pb.environment()["FORCE_COLOR"] = "0"
    val p = pb.start()
    host.registerProcess(p)
    val out = StringBuilder()
    val reader = Thread {
        p.inputStream.bufferedReader().forEachLine {
            synchronized(out) { out.appendLine(it); if (out.length > 200_000) out.delete(0, 100_000) }
        }
    }.apply { isDaemon = true; start() }
    val deadline = System.currentTimeMillis() + timeoutSec * 1000
    while (!p.waitFor(200, TimeUnit.MILLISECONDS)) {
        if (host.isCancelled() || System.currentTimeMillis() > deadline) {
            p.destroyForcibly()
            synchronized(out) { out.appendLine(if (host.isCancelled()) "[중단됨]" else "[시간 초과 ${timeoutSec}s — 종료됨]") }
            break
        }
    }
    reader.join(2000)
    host.registerProcess(null)
    return (if (p.isAlive) -1 else p.exitValue()) to synchronized(out) { out.toString() }
}

private var seq = 0

private fun JsonObject.str(key: String) = get(key)?.takeIf { !it.isJsonNull }?.asString ?: ""

fun executeTool(call: ToolCall, host: ToolHost): String {
    val id = "t${System.currentTimeMillis()}-${seq++}"
    fun emit(title: String, status: String, detail: String? = null, diff: Map<String, Any>? = null) =
        host.emit(mapOf("type" to "tool", "id" to id, "title" to title, "status" to status, "detail" to detail, "diff" to diff))

    return try {
        when (call) {
            is ToolCall.Read -> {
                val path = FileOps.resolveInRoot(host.root, call.path)
                val text = FileOps.read(path)
                if (text == null) {
                    emit("Read ${call.path}", "error", "파일 없음"); "[READ ${call.path}] 파일이 없습니다."
                } else {
                    val body = if (call.start != null) text.split("\n").let { it.subList((call.start - 1).coerceIn(0, it.size), (call.end ?: it.size).coerceIn(0, it.size)) }.joinToString("\n") else text
                    val range = if (call.start != null) ":${call.start}-${call.end}" else ""
                    emit("Read ${call.path}$range", "done", "${body.count { it == '\n' } + 1}줄")
                    "[READ ${call.path}$range]\n" + if (body.length > MAX_READ) body.take(MAX_READ) + "\n…(잘림: 범위를 지정해 다시 READ 하세요)" else body
                }
            }

            is ToolCall.ListFiles -> {
                val patterns = listOf(call.pattern, call.pattern.removePrefix("**/")).distinct()
                    .map { FileSystems.getDefault().getPathMatcher("glob:$it") }
                val files = Files.walk(host.root).use { stream ->
                    stream.filter { p -> p.relativeTo(host.root).none { it.name in EXCLUDED_DIRS } && !p.isDirectory() }
                        .map { it.relativeTo(host.root) }
                        .filter { rel -> patterns.any { it.matches(rel) } }
                        .limit(400).map { it.toString() }.sorted().toList()
                }
                emit("List ${call.pattern}", "done", "${files.size}개")
                "[LIST ${call.pattern}] ${files.size}개\n${files.joinToString("\n")}"
            }

            is ToolCall.Grep -> {
                emit("Grep ${call.pattern}", "running")
                var (code, out) = runProcess(listOf("git", "grep", "-n", "-I", "-E", call.pattern), host.root, host, 30)
                if (code > 1) {
                    val excludes = EXCLUDED_DIRS.map { "--exclude-dir=$it" }
                    val r = runProcess(listOf("grep", "-rnIE") + excludes + listOf(call.pattern, "."), host.root, host, 30)
                    code = r.first; out = r.second
                }
                val lines = out.lines().filter { it.isNotBlank() }
                emit("Grep ${call.pattern}", "done", "${lines.size}건")
                "[GREP ${call.pattern}] ${lines.size}건\n${truncate(lines.take(200).joinToString("\n"))}"
            }

            is ToolCall.Search -> {
                val res = Clients.post("/api/style/search", mapOf("query" to call.query, "top_k" to 6, "project" to host.repoName.ifBlank { null }))
                val hits = res.getAsJsonArray("hits")?.map { it.asJsonObject } ?: emptyList()
                emit("Search \"${call.query}\"", "done", hits.joinToString(", ") { it.str("source") })
                "[SEARCH ${call.query}]\n" + hits.joinToString("\n") {
                    "--- ${it.str("source")} (${it.str("kind")}, ${"%.2f".format(it.get("score").asDouble)}) ---\n${it.str("content")}"
                }
            }

            is ToolCall.Write, is ToolCall.Edit -> {
                val rel = if (call is ToolCall.Write) call.path else (call as ToolCall.Edit).path
                val path = FileOps.resolveInRoot(host.root, rel)
                val before = FileOps.read(path)
                var warn = ""
                val after: String = if (call is ToolCall.Write) {
                    if (call.content.endsWith("\n")) call.content else call.content + "\n"
                } else {
                    call as ToolCall.Edit
                    if (before == null) {
                        emit("Edit $rel", "error", "파일 없음")
                        return "[EDIT $rel] 파일이 없습니다. 새 파일은 FILE 블록으로 만드세요."
                    }
                    if (call.blocks.isEmpty()) return "[EDIT $rel] SEARCH/REPLACE 블록을 찾지 못했습니다. 형식을 확인하세요."
                    val r = Protocol.applySearchReplace(before, call.blocks)
                    if (r.applied == 0) {
                        emit("Edit $rel", "error", r.failed.joinToString("\n"))
                        return "[EDIT $rel] 실패:\n${r.failed.joinToString("\n")}\n파일을 다시 READ 한 뒤 정확한 원문으로 SEARCH 하세요."
                    }
                    if (r.failed.isNotEmpty()) warn = "\n일부 블록 실패:\n" + r.failed.joinToString("\n")
                    r.content
                }
                if (before == after) return "[${call.kind.uppercase()} $rel] 변경 사항 없음"
                val (added, removed) = Protocol.lineDiffStats(before ?: "", after)
                val title = "${if (before == null) "Create" else "Edit"} $rel"
                if (!host.approve("edit", title, "+$added −$removed")) {
                    emit(title, "denied"); return "[$title] 사용자가 거부했습니다."
                }
                host.checkpoint.record(path, before)
                host.originals[id] = before ?: ""
                FileOps.write(host.project, path, after)
                emit(title, "done", id, mapOf("path" to rel, "added" to added, "removed" to removed))
                "[$title] 완료 (+$added −$removed)$warn"
            }

            is ToolCall.Run -> {
                val title = "Run: ${call.command}"
                if (!host.approve("run", title, call.command)) {
                    emit(title, "denied")
                    return "[RUN ${call.command}] 사용자가 실행을 거부했습니다. 다른 방법을 제안하거나 이유를 물어보세요."
                }
                emit(title, "running")
                val (code, out) = runProcess(listOf("/bin/zsh", "-lc", call.command), host.root, host)
                val t = truncate(out.trim())
                emit(title, if (code == 0) "done" else "error", "exit $code\n${t.takeLast(3000)}")
                "[RUN ${call.command}] exit code $code\n$t"
            }

            is ToolCall.Remember -> {
                val value = if (call.scope == "project") call.scopeValue.ifBlank { host.repoName } else call.scopeValue
                Clients.post("/api/preferences", mapOf("text" to call.text, "kind" to call.memKind, "scope" to call.scope, "scope_value" to value))
                emit("Remember (${call.memKind}/${call.scope}${if (value.isNotBlank()) ":$value" else ""})", "done", call.text)
                "[REMEMBER] 저장됨: ${call.text}"
            }

            is ToolCall.Harness -> {
                if (host.repoName.isBlank()) return "[HARNESS] 연결된 레포가 없습니다. 먼저 CONNECT 하세요."
                val title = "Harness: ${call.task.lineSequence().first().take(60)}"
                emit(title, "running", "요구사항 → 테스트 → 구현 반복 시작")
                val jobId = Clients.post("/api/agent/run", mapOf("repo" to host.repoName, "task" to call.task)).getAsJsonObject("job").str("id")
                var job: JsonObject
                while (true) {
                    if (host.isCancelled()) return "[HARNESS] 사용자가 중단했습니다 (백엔드 작업은 계속 진행될 수 있음)."
                    TimeUnit.SECONDS.sleep(2)
                    job = Clients.get("/api/agent/jobs/$jobId").getAsJsonObject("job")
                    val logs = job.getAsJsonArray("logs")
                    if (logs.size() > 0) logs.last().asJsonObject.let { emit(title, "running", "${it.str("step")}: ${it.str("message")}") }
                    if (job.str("status") !in setOf("queued", "running")) break
                }
                val summary = job.getAsJsonArray("logs").joinToString("\n") { val l = it.asJsonObject; "${l.str("step")}: ${l.str("message")}" }
                val status = job.str("status")
                emit(title, if (status == "passed") "done" else "error", "$status · ${job.str("branch")} ${job.str("commit")}\n$summary")
                "[HARNESS] $status (브랜치 ${job.str("branch")}, 커밋 ${job.str("commit").ifBlank { "없음" }})\n" +
                    "요구사항: ${job.getAsJsonObject("harness")?.get("requirements")?.toString()?.take(2000)}\n로그:\n$summary\n" +
                    "마지막 테스트 출력:\n${truncate(job.getAsJsonObject("last_test")?.str("output") ?: "", 3000)}"
            }

            is ToolCall.Model -> when (call.action) {
                "list", "status" -> {
                    val models = Clients.get("/api/models").getAsJsonArray("catalog").map { it.asJsonObject }
                    val eng = Clients.get("/api/engine/status")
                    val lines = models.joinToString("\n") { m ->
                        val state = when {
                            m.get("downloaded").asBoolean -> "다운로드됨"
                            m.get("downloading").asBoolean -> "다운로드 중 ${(m.get("progress").asDouble * 100).toInt()}%"
                            else -> "미설치"
                        }
                        "- ${m.str("key")}: ${m.str("label")} ${m.get("size_gb")}GB · $state · ${m.str("note")}"
                    }
                    val engLine = if (eng.get("online").asBoolean)
                        "엔진 실행 중: ${eng.getAsJsonObject("model")?.str("model_name")} (ctx ${eng.getAsJsonObject("model")?.get("n_ctx")})"
                    else "엔진 꺼짐"
                    emit("Model status", "done", "$engLine\n$lines")
                    "[MODEL ${call.action}]\n$engLine\n$lines"
                }
                "download" -> {
                    val res = Clients.post("/api/models/download", mapOf("model" to call.arg.ifBlank { "qwen3-coder-30b" }))
                    emit("Model download ${res.str("model")}", "done", res.str("status"))
                    "[MODEL download] ${res.str("model")}: ${res.str("status")}"
                }
                "start" -> {
                    emit("Engine start", "running", "모델 로딩 중 (최대 3분)")
                    val res = Clients.post("/api/engine/start", mapOf("model" to call.arg), 240)
                    val name = res.getAsJsonObject("model")?.str("model_name") ?: res.str("message")
                    emit("Engine start", "done", "${res.str("status")} $name")
                    "[MODEL start] ${res.str("status")} $name"
                }
                "stop" -> {
                    val res = Clients.post("/api/engine/stop", emptyMap<String, Any>())
                    emit("Engine stop", "done", res.str("status"))
                    "[MODEL stop] ${res.str("status")}"
                }
                else -> "[MODEL] 알 수 없는 동작: ${call.action}"
            }

            is ToolCall.Connect -> {
                emit("Connect ${call.location}", "running", "연결 + 벡터화 중")
                val repo = Clients.post("/api/repos/connect", mapOf("location" to call.location, "init_if_missing" to false), 600).getAsJsonObject("repo")
                val chunks = repo.getAsJsonObject("index_stats")?.get("chunks")
                emit("Connect ${repo.str("name")}", "done", "${repo.str("profile")} · $chunks chunks")
                "[CONNECT] ${repo.str("name")} (${repo.str("profile")}) 연결됨, $chunks 청크 벡터화"
            }
        }
    } catch (e: Exception) {
        val msg = e.message ?: e.toString()
        emit(call.kind, "error", msg)
        "[${call.kind.uppercase()} 오류] $msg"
    }
}

fun projectRoot(project: Project): Path? = project.basePath?.let { File(it).toPath() }
