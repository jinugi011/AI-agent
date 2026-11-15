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
private const val MAX_READ = 24_000 // 큰 파일 하나가 대화 예산을 다 쓰지 않게
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
    val binaries = HashMap<String, ByteArray>()       // 이미지 등 바이너리 원본
    val moves = mutableListOf<Pair<String, String>>() // 이동 기록 (원래 → 새), 되돌릴 때 역순

    fun record(path: Path, before: String?) {
        originals.putIfAbsent(path.toString(), before)
    }

    /** 바이너리 파일(이미지) 원본 기록: null = 새 파일 */
    fun recordBinary(path: Path, before: ByteArray?) {
        if (originals.containsKey(path.toString())) return
        originals[path.toString()] = if (before == null) null else ""
        if (before != null) binaries[path.toString()] = before
    }

    fun revert(project: Project): Int {
        val n = originals.size + moves.size
        for ((from, to) in moves.reversed()) try { FileOps.move(project, Path.of(to), Path.of(from)) } catch (e: Exception) { }
        moves.clear()
        for ((p, before) in originals) {
            when {
                before == null -> FileOps.delete(project, Path.of(p))
                binaries.containsKey(p) -> FileOps.writeBytes(project, Path.of(p), binaries.getValue(p))
                else -> FileOps.write(project, Path.of(p), before)
            }
        }
        originals.clear()
        binaries.clear()
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
    /** IDE 파일 시스템으로 이동/이름 바꾸기 (에디터·인덱스가 따라감) */
    fun move(project: Project, from: Path, to: Path) {
        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project, "Yang Coding 이동", "local-agent", {
                val vf = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(from) ?: throw IllegalStateException("파일이 없습니다: $from")
                val parent = VfsUtil.createDirectoryIfMissing(to.parent.toString()) ?: throw IllegalStateException("폴더를 만들 수 없습니다: ${to.parent}")
                if (vf.parent != parent) vf.move(this, parent)
                if (vf.name != to.fileName.toString()) vf.rename(this, to.fileName.toString())
            })
        }
    }

    fun mkdirs(project: Project, path: Path) {
        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project, "Yang Coding 폴더", "local-agent", {
                VfsUtil.createDirectoryIfMissing(path.toString()) ?: throw IllegalStateException("폴더를 만들 수 없습니다: $path")
            })
        }
    }

    fun writeBytes(project: Project, path: Path, bytes: ByteArray) {
        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project, "Yang Coding 이미지", "local-agent", {
                val parent = VfsUtil.createDirectoryIfMissing(path.parent.toString())
                    ?: throw IllegalStateException("폴더를 만들 수 없습니다: ${path.parent}")
                val vf = parent.findChild(path.fileName.toString()) ?: parent.createChildData(this, path.fileName.toString())
                vf.setBinaryContent(bytes)
            })
        }
    }

    fun write(project: Project, path: Path, content: String) {
        val text = content.replace("\r\n", "\n")
        ApplicationManager.getApplication().invokeAndWait {
            WriteCommandAction.runWriteCommandAction(project, "Yang Coding 편집", "local-agent", {
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
            WriteCommandAction.runWriteCommandAction(project, "Yang Coding 삭제", "local-agent", {
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

/** 운영체제에 맞는 셸: Windows → PowerShell(UTF-8 출력), macOS/Linux → 로그인 셸 */
object Shell {
    val isWindows = System.getProperty("os.name").lowercase().contains("win")
    fun command(cmd: String): List<String> = if (isWindows)
        listOf("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \$OutputEncoding=[System.Text.Encoding]::UTF8; $cmd")
    else listOf(if (File("/bin/zsh").exists()) "/bin/zsh" else System.getenv("SHELL") ?: "/bin/bash", "-lc", cmd)
}

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

    // 원격 모드: 서버(맥)에서 코드를 실행하거나 서버 설정을 바꾸는 기능은 쓸 수 없다
    val serverSide = call is ToolCall.Harness || call is ToolCall.Connect ||
        (call is ToolCall.Model && call.action in setOf("download", "start", "stop"))
    if (Clients.remote && serverSide) {
        emit(call.kind, "denied", "원격 모드에서는 사용할 수 없음")
        return "[${call.kind.uppercase()}] 원격 모드에서는 사용할 수 없습니다 (서버에서 코드를 실행/설정하는 기능은 보안상 차단). " +
            "대신 이 PC 에서 READ/EDIT/RUN 으로 직접 구현·테스트하세요."
    }
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
                        .limit(400).map { it.toString().replace('\\', '/') }.sorted().toList()
                }
                emit("List ${call.pattern}", "done", "${files.size}개")
                "[LIST ${call.pattern}] ${files.size}개\n${files.joinToString("\n")}"
            }

            is ToolCall.Grep -> {
                emit("Grep ${call.pattern}", "running")
                val lines = grepFiles(host.root, call.pattern) { host.isCancelled() }
                emit("Grep ${call.pattern}", "done", "${lines.size}건")
                "[GREP ${call.pattern}] ${lines.size}건${if (lines.size >= 200) " (200건까지만)" else ""}\n${truncate(lines.joinToString("\n"))}"
            }

            is ToolCall.Delete, is ToolCall.Move, is ToolCall.Mkdir -> fileOp(call, host) { t, st, d -> emit(t, st, d) }

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
                val (code, out) = runProcess(Shell.command(call.command), host.root, host)
                val t = truncate(out.trim())
                emit(title, if (code == 0) "done" else "error", "exit $code\n${t.takeLast(3000)}")
                "[RUN ${call.command}] exit code $code\n$t"
            }

            is ToolCall.Image -> runImage(call, host) { t, st, d, imgs -> host.emit(mapOf("type" to "tool", "id" to id, "title" to t, "status" to st, "detail" to d, "images" to imgs)) }

            is ToolCall.Check -> {
                emit("Check (정적 검사)", "running")
                val rep = DebugRunner.runCheck(host.project, host.root, null)
                emit("Check (정적 검사)", if (rep.errors > 0) "error" else "done", rep.text.take(3000))
                rep.text.replace("[자동 검사]", "[CHECK]")
            }

            is ToolCall.Play -> {
                val r = call.req
                val title = "Play: ${r.kind}${if (r.target.isNotBlank()) " " + r.target else ""}${if (r.seconds > 0) " (${r.seconds}초)" else ""}"
                if (!host.approve("run", title, "게임·앱을 실행해 오류와 화면을 확인합니다.\n$title")) {
                    emit(title, "denied")
                    return "[PLAY] 사용자가 실행을 거부했습니다. CHECK 나 코드 확인으로 대신 진행하세요."
                }
                emit(title, "running")
                val res = DebugRunner.runPlay(host.root, r, { host.isCancelled() }) { emit(title, "running", it) }
                emit(title, if (res.errors > 0) "error" else "done", res.text.take(4000))
                res.text
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


// ---- IMAGE: 맥의 이미지 모델로 생성·가공해 프로젝트에 저장 ----------------------------------------------
private fun runImage(call: ToolCall.Image, host: ToolHost, emit: (String, String, String?, List<String>?) -> Unit): String {
    val f = call.fields
    val title = "Image: ${call.path}${f["size"]?.let { " ($it)" } ?: ""}"
    if (!Regex("""\.(png|webp)$""", RegexOption.IGNORE_CASE).containsMatchIn(call.path)) return "[IMAGE ${call.path}] 오류: 저장 경로는 .png (또는 .webp) 여야 합니다"
    // 이미 있는 그림은 다시 만들지 않는다 (요청마다 같은 그림 세트를 또 만드는 것 방지)
    val overwrite = Regex("^(yes|true|y|1|예|네)$", RegexOption.IGNORE_CASE).matches(f["overwrite"]?.trim() ?: "")
    if (f["prompt"] != null && f["from"] == null && !overwrite && Files.exists(FileOps.resolveInRoot(host.root, call.path))) {
        emit(title, "done", "이미 있음 → 다시 만들지 않음", null)
        return "[IMAGE ${call.path}] 이미 있어서 다시 만들지 않았습니다. 그대로 쓰세요 (꼭 새로 그려야 하면 overwrite: yes)."
    }
    if (!host.approve("edit", title, f["prompt"]?.let { "생성: $it" } ?: "가공: ${f["ops"] ?: ""}")) {
        emit(title, "denied", null, null)
        return "[IMAGE ${call.path}] 사용자가 거부했습니다"
    }
    if (f["prompt"] != null) Art.ensure(host.root) { emit(title, "running", it, null) } // 프로젝트 아트 컨셉이 없으면 먼저 분석
    emit(title, "running", if (f["prompt"] != null) "이미지 생성 중 (15~40초)…" else "이미지 가공 중…", null)
    val size = Regex("""^(\d+)\s*[x×*]\s*(\d+)$""", RegexOption.IGNORE_CASE).find(f["size"]?.trim() ?: "")
    fun yes(v: String?) = Regex("^(yes|true|y|1|예|네)$", RegexOption.IGNORE_CASE).matches(v?.trim() ?: "")
    val b64 = java.util.Base64.getEncoder()
    fun read(rel: String) = b64.encodeToString(Files.readAllBytes(FileOps.resolveInRoot(host.root, rel.trim())))
    val body = HashMap<String, Any?>()
    body["prompt"] = f["prompt"] ?: ""
    body["width"] = size?.groupValues?.get(1)?.toInt() ?: 0
    body["height"] = size?.groupValues?.get(2)?.toInt() ?: 0
    body["transparent"] = f["transparent"]?.let { yes(it) }
    body["project"] = Art.projectName(host.root)
    body["kind"] = f["kind"]?.trim()?.lowercase() ?: ""
    body["verify"] = !Regex("^(no|false|n|0|아니오|아니)$", RegexOption.IGNORE_CASE).matches(f["verify"]?.trim() ?: "")
    body["pixel"] = f["pixel"]?.toIntOrNull() ?: 0
    body["colors"] = f["colors"]?.toIntOrNull() ?: 24
    body["strength"] = f["strength"]?.toDoubleOrNull() ?: 0.0
    body["ops"] = f["ops"] ?: ""
    body["cols"] = f["cols"]?.toIntOrNull() ?: 0
    f["seed"]?.toIntOrNull()?.let { body["seed"] = it }
    try {
        val ref = f["ref"]?.trim() ?: ""
        when {
            ref.startsWith("search:") -> body["ref_search"] = ref.removePrefix("search:").trim()
            ref.startsWith("attachment:") -> body["ref_attachment"] = ref.removePrefix("attachment:").trim()
            ref.isNotEmpty() -> body["refs"] = listOf(read(ref))
        }
        f["from"]?.let { body["source"] = read(it) }
        f["join"]?.let { j -> body["join"] = j.split(",").map { it.trim() }.filter { it.isNotEmpty() }.map { read(it) } }
    } catch (e: Exception) {
        emit(title, "error", e.message, null)
        return "[IMAGE ${call.path}] 오류: 참고/원본 이미지를 읽을 수 없습니다 — ${e.message}"
    }
    val res = try { Clients.post("/api/images/generate", body, 900) } catch (e: Exception) {
        emit(title, "error", e.message, null)
        return "[IMAGE ${call.path}] 오류: ${e.message}"
    }
    val images = res.getAsJsonArray("images")?.map { it.asString } ?: emptyList()
    val ext = call.path.substringAfterLast('.', "png")
    val base = call.path.removeSuffix(".$ext")
    val targets = if (images.size == 1) listOf(call.path) else images.indices.map { "${base}_$it.$ext" }
    val dec = java.util.Base64.getDecoder()
    images.forEachIndexed { i, img ->
        val p = FileOps.resolveInRoot(host.root, targets[i])
        host.checkpoint.recordBinary(p, if (Files.exists(p)) Files.readAllBytes(p) else null)
        FileOps.writeBytes(host.project, p, dec.decode(img))
    }
    val credits = res.getAsJsonArray("credits")?.map { it.asJsonObject } ?: emptyList()
    if (credits.isNotEmpty()) {
        val cp = host.root.resolve("ASSET_CREDITS.md")
        val before = FileOps.read(cp)
        host.checkpoint.record(cp, before)
        val lines = credits.joinToString("\n") { c ->
            "- `${call.path}` 스타일 참고: [${c.get("title")?.asString?.ifBlank { "제목 없음" }}](${c.get("source")?.asString}) — ${c.get("creator")?.asString?.ifBlank { "작성자 미상" }} · ${c.get("license")?.asString} ${c.get("license_url")?.asString}"
        }
        FileOps.write(host.project, cp, (before ?: "# 에셋 출처\n\n프로젝트 그림은 FLUX.1-schnell(Apache-2.0)로 생성했습니다. 아래는 스타일 참고에 쓴 무료 이미지입니다.\n\n") + lines + "\n")
    }
    val t = res.getAsJsonObject("timings")
    fun tm(k: String) = t?.get(k)?.asString
    val sizes = res.getAsJsonArray("sizes")?.joinToString(", ") { s -> s.asJsonArray.joinToString("x") { it.asString } } ?: ""
    val v = res.getAsJsonObject("verify")
    val scores = v?.getAsJsonArray("scores")?.map { it.asDouble.toInt() }
    val verifyText = scores?.let { sc -> " · 컨셉 일치 ${sc.joinToString("→")}/10${if (sc.size > 1) " (다시 그림)" else ""}${v.get("problems")?.asString?.takeIf { it.isNotBlank() }?.let { " · 남은 문제: $it" } ?: ""}" } ?: ""
    val summary = "${targets.joinToString(", ")} 저장 ($sizes) · ${tm("total") ?: "?"}초$verifyText" +
        (tm("generate")?.let { g -> " (생성 ${g}s${tm("style")?.let { " · 스타일 분석 ${it}s" } ?: ""}${tm("process")?.let { " · 가공 ${it}s" } ?: ""})" } ?: "")
    val prompt = res.get("prompt_used")?.asString ?: ""
    emit(title, "done", summary + if (prompt.isNotEmpty()) "\n프롬프트: $prompt" else "", images.take(4).map { "data:image/png;base64,$it" })
    return "[IMAGE ${call.path}] 완료: $summary" +
        (if (prompt.isNotEmpty()) "\n사용한 프롬프트: $prompt" else "") +
        (res.get("style")?.asString?.takeIf { it.isNotEmpty() }?.let { "\n참고 이미지 스타일: $it" } ?: "") +
        (if (credits.isNotEmpty()) "\n참고 출처를 ASSET_CREDITS.md 에 기록함" else "") +
        "\n(코드에서 이 경로로 불러오세요. 확인이 필요하면 PLAY 로 화면을 보세요.)"
}


// ---- GREP (셸 없이: Windows 에서도 동작) ------------------------------------------------------------
private fun grepFiles(root: Path, pattern: String, cancelled: () -> Boolean): List<String> {
    val re = try { Regex(pattern) } catch (e: Exception) { Regex(Regex.escape(pattern)) }
    val out = mutableListOf<String>()
    Files.walk(root).use { stream ->
        val it = stream.filter { p -> p.relativeTo(root).none { seg -> seg.name in EXCLUDED_DIRS } && Files.isRegularFile(p) }.iterator()
        while (it.hasNext() && out.size < 200 && !cancelled()) {
            val p = it.next()
            val bytes = try { if (Files.size(p) > 1_000_000) continue else Files.readAllBytes(p) } catch (e: Exception) { continue }
            if (bytes.take(4000).any { b -> b == 0.toByte() }) continue // 바이너리 제외
            val rel = root.relativize(p).toString().replace('\\', '/')
            bytes.toString(Charsets.UTF_8).split(Regex("\r?\n")).forEachIndexed { i, line ->
                if (out.size < 200 && re.containsMatchIn(line)) out += "$rel:${i + 1}:${if (line.length > 300) line.take(300) + "…" else line}"
            }
        }
    }
    return out
}

// ---- DELETE · MOVE · MKDIR (IDE 파일 API: Windows·macOS·Linux, 승인 필요, /undo 지원) -----------------------
private fun fileOp(call: ToolCall, host: ToolHost, emit: (String, String, String?) -> Unit): String {
    val (tag, label, title) = when (call) {
        is ToolCall.Delete -> Triple("DELETE", call.path, "Delete: ${call.path}")
        is ToolCall.Move -> Triple("MOVE", "${call.from} -> ${call.to}", "Move: ${call.from} -> ${call.to}")
        is ToolCall.Mkdir -> Triple("MKDIR", call.path, "Mkdir: ${call.path}")
        else -> return "지원하지 않는 작업"
    }
    return try {
        if (call is ToolCall.Mkdir) {
            FileOps.mkdirs(host.project, FileOps.resolveInRoot(host.root, call.path))
            emit(title, "done", null)
            return "[MKDIR ${call.path}] 완료"
        }
        val src = FileOps.resolveInRoot(host.root, if (call is ToolCall.Move) call.from else (call as ToolCall.Delete).path)
        if (src.normalize() == host.root.normalize()) error("프로젝트 폴더 자체는 삭제·이동할 수 없습니다")
        if (!Files.exists(src)) return "[$tag $label] 오류: 파일이 없습니다"
        val isDir = Files.isDirectory(src)
        if (!host.approve("edit", title, if (isDir) "폴더 전체 (되돌리기 대신 휴지통/로컬 기록에서 복구)" else "파일")) {
            emit(title, "denied", null)
            return "[$tag $label] 사용자가 거부했습니다"
        }
        if (call is ToolCall.Delete) {
            if (!isDir) {
                val bytes = Files.readAllBytes(src)
                if (bytes.take(4000).any { it == 0.toByte() }) host.checkpoint.recordBinary(src, bytes)
                else host.checkpoint.record(src, bytes.toString(Charsets.UTF_8))
            }
            FileOps.delete(host.project, src)
            emit(title, "done", if (isDir) "폴더 삭제" else "파일 삭제 (/undo 로 복구)")
            "[DELETE $label] 완료"
        } else {
            val dst = FileOps.resolveInRoot(host.root, (call as ToolCall.Move).to)
            if (Files.exists(dst)) return "[MOVE $label] 오류: 대상이 이미 있습니다 (${call.to})"
            FileOps.move(host.project, src, dst)
            host.checkpoint.moves += src.toString() to dst.toString()
            emit(title, "done", null)
            "[MOVE $label] 완료 (코드에서 옛 경로를 쓰는 곳이 있으면 GREP 으로 찾아 고치세요)"
        }
    } catch (e: Exception) {
        emit(title, "error", e.message)
        "[$tag $label] 오류: ${e.message}"
    }
}
