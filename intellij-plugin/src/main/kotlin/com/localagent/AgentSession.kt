package com.localagent

import com.google.gson.JsonObject
import com.intellij.openapi.project.Project
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.io.path.isDirectory
import kotlin.io.path.name
import kotlin.io.path.relativeTo

data class EditorContext(
    val file: String? = null,
    val selection: String? = null,
    val selectionRange: String? = null,
    val openFiles: List<String> = emptyList(),
)

private const val CONTEXT_CHAR_BUDGET = 45_000 // ~13k 토큰 (문맥이 길면 생성이 느려짐: 1만→2만 토큰 49→25 tok/s)
private const val COMPACT_TARGET = 0.6         // 넘치면 예산의 60% 까지 한 번에 (자주 조금씩 줄이면 엔진 KV 재사용이 깨짐)
private const val MAX_IMAGES_PER_STEP = 4      // 한 응답에서 그림은 최대 4장

private fun indent(s: String, max: Int = 40): String {
    val lines = s.trim().lines()
    val shown = lines.take(max).joinToString("\n") { "    $it" }
    return if (lines.size > max) "$shown\n    …(${lines.size - max}줄 더)" else shown
}
private val TREE_EXCLUDES = setOf("node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "Pods", ".dart_tool", ".gradle", "models", "out", ".idea")

/** 채팅 에이전트 루프 (VS Code agent.ts 와 동일한 동작). 백그라운드 스레드에서 send() 를 호출한다. */
/** 서버가 분석한 첨부 파일 (이미지 · PDF · MD) */
data class Attachment(
    val id: String, val name: String, val kind: String, val content: String, val chars: Int,
    val pages: Int = 0, val visionPages: Int = 0, val notes: List<String> = emptyList(),
) {
    companion object {
        fun from(o: JsonObject) = Attachment(
            id = o.get("id").asString, name = o.get("name").asString, kind = o.get("kind").asString,
            content = o.get("content")?.asString ?: "", chars = o.get("chars")?.asInt ?: 0,
            pages = o.get("pages")?.asInt ?: 0, visionPages = o.get("vision_pages")?.asInt ?: 0,
            notes = o.getAsJsonArray("notes")?.map { it.asString } ?: emptyList(),
        )
    }
}

private const val ATT_PER_FILE = 12_000  // 첨부 하나를 대화에 넣는 최대 글자 수
private const val ATT_TOTAL = 24_000     // 한 요청의 첨부 합계 (나머지는 .yang/attachments 파일을 READ)
private const val ATT_DIR = ".yang/attachments"

/** 첨부 분석 결과를 프로젝트의 .yang/attachments/ 에 저장 (에이전트가 READ/GREP 로 전체를 볼 수 있게, git 에는 안 올라감) */
private fun saveAttachments(root: Path, atts: List<Attachment>): Map<String, String> = try {
    val dir = root.resolve(ATT_DIR).also { Files.createDirectories(it) }
    Files.writeString(root.resolve(".yang/.gitignore"), "*\n")
    atts.associate { a ->
        val file = "${a.id}-${a.name.replace(Regex("[^\\w.가-힣-]"), "_")}.md"
        Files.writeString(dir.resolve(file), a.content)
        a.id to "$ATT_DIR/$file"
    }
} catch (e: Exception) { emptyMap() }

private fun attachmentBlock(atts: List<Attachment>, paths: Map<String, String>): String {
    if (atts.isEmpty()) return ""
    var budget = ATT_TOTAL
    val kinds = mapOf("image" to "이미지 (비전 모델 분석 결과)", "pdf" to "PDF", "text" to "문서")
    val parts = atts.map { a ->
        val limit = maxOf(1500, minOf(ATT_PER_FILE, budget))
        val cut = a.content.length > limit
        val body = if (cut) a.content.take(limit) + "\n…(이하 ${"%,d".format(a.content.length - limit)}자 생략)" else a.content
        budget -= minOf(a.content.length, limit)
        val full = paths[a.id]?.let { " · 전체: $it" + if (cut) " (READ 로 나머지 확인)" else "" } ?: ""
        "### 📎 ${a.name} — ${kinds[a.kind] ?: a.kind}$full\n$body"
    }
    return "\n\n[첨부 파일 ${atts.size}개] 사용자가 첨부한 자료입니다. 요청을 처리할 때 이 내용을 근거로 사용하세요." +
        " 이미지는 비전 모델이 글로 풀어 쓴 것이므로 수치(색·간격)는 추정일 수 있습니다.\n\n" + parts.joinToString("\n\n")
}

class AgentSession(
    private val project: Project,
    private val emit: (Map<String, Any?>) -> Unit,
    private val requestApproval: (kind: String, title: String, detail: String) -> String, // allow|always|deny (블로킹)
    private val log: AgentLog,
) {
    private val history = mutableListOf<ChatMessage>()
    private val alwaysAllowed = mutableSetOf<String>()
    private val cancelled = AtomicBoolean(false)
    private val streamHandle = AtomicReference<InputStream?>(null)
    @Volatile private var runningProcess: Process? = null
    @Volatile var running = false
        private set
    @Volatile var repoName = ""
    var lastCheckpoint: Checkpoint? = null
    val originals = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun reset() {
        stop()
        synchronized(history) { history.clear() }
        alwaysAllowed.clear()
    }

    fun stop() {
        if (!running) return
        cancelled.set(true)
        runCatching { streamHandle.get()?.close() }
        runningProcess?.destroyForcibly()
    }

    private fun approve(kind: String, title: String, detail: String): Boolean {
        val s = AgentSettings.current
        val mode = if (kind == "edit") s.approveEdits else s.approveCommands
        if (mode == "auto" || kind in alwaysAllowed) return true
        log.line("[승인 대기] $title")
        val answer = requestApproval(kind, title, detail)
        log.line("[승인] " + (mapOf("allow" to "허용", "always" to "항상 허용", "deny" to "거부")[answer] ?: answer), if (answer == "deny") "error" else "info")
        if (answer == "always") alwaysAllowed += kind
        return answer != "deny"
    }

    private fun host(root: Path, checkpoint: Checkpoint, autoApprove: Boolean = false) = object : ToolHost {
        override val project = this@AgentSession.project
        override val root = root
        override val repoName = this@AgentSession.repoName
        override val checkpoint = checkpoint
        override val originals = this@AgentSession.originals
        override fun isCancelled() = cancelled.get()
        override fun approve(kind: String, title: String, detail: String) = autoApprove || this@AgentSession.approve(kind, title, detail)
        private var lastDetail: Any? = null
        override fun emit(event: Map<String, Any?>) {
            // 하네스 등 오래 걸리는 도구의 진행 상황을 콘솔에도 표시
            if (event["type"] == "tool" && event["status"] == "running" && event["detail"] != null && event["detail"] != lastDetail) {
                lastDetail = event["detail"]
                log.line("    … " + event["detail"].toString().lineSequence().first(), "result")
            }
            this@AgentSession.emit(event)
        }
        override fun registerProcess(p: Process?) { runningProcess = p }
    }

    private fun fileTree(root: Path): String {
        val files = Files.walk(root).use { s ->
            s.filter { p -> !p.isDirectory() && p.relativeTo(root).none { it.name in TREE_EXCLUDES } }
                .limit(250).map { it.relativeTo(root).toString() }.sorted().toList()
        }
        return files.joinToString("\n") + if (files.size >= 250) "\n…(더 있음: LIST 로 확인)" else ""
    }

    private fun editorBlock(editor: EditorContext): String =
        "(에디터 상태) 현재 파일: ${editor.file ?: "없음"} · 열린 파일: ${editor.openFiles.take(15).joinToString(", ").ifBlank { "없음" }}" +
            (editor.selection?.let { "\n선택 영역 (${editor.selectionRange}):\n```\n${it.take(4000)}\n```" } ?: "")

    // 시스템 프롬프트는 대화 중 바뀌지 않는 내용만 담는다 → 엔진 KV 캐시 재사용으로 다음 요청이 빨라짐.
    private fun systemPrompt(ctx: JsonObject?, repoInfo: String, tree: String): String {
        fun s(key: String) = ctx?.get(key)?.takeIf { !it.isJsonNull }?.asString
        return """당신은 "Yang Coding" — 사용자의 IntelliJ IDE 안에서 동작하는 로컬 코딩 에이전트입니다 (Claude Code 와 유사). 이름을 물으면 Yang Coding 이라고 답한다.
사용자 PC 운영체제: ${if (Shell.isWindows) "Windows (RUN 은 PowerShell 로 실행됨: rm/mv 대신 DELETE/MOVE 도구, 경로 구분은 / 로 써도 됨)" else System.getProperty("os.name")}
사용자의 자연어 요청을 이해해 코드를 읽고, 수정하고, 명령을 실행해 작업을 끝까지 완료합니다.

## 일하는 방식
- 추측하지 말고 먼저 READ/GREP/SEARCH 로 확인한 뒤 수정한다.
- 기존 코드의 스타일·구조·네이밍을 그대로 따른다. 아래 선호/제약은 반드시 지킨다.
- 파일을 고치면 [자동 검사] 결과(문법·타입·IDE 오류·리소스 경로)가 도구 결과에 붙는다. 오류가 있으면 먼저 고친다.
- 수정 후에는 RUN(테스트·빌드) 또는 PLAY(게임·앱 실행)로 실제 동작을 확인한다. 확인하지 못했으면 그 사실을 답변에 적는다.
- 사용자가 지정한 함수 이름·시그니처·동작은 절대 바꾸지 않는다 (예: total(prices) 를 total() 로 바꾸지 말 것).
- 테스트가 실패하면 테스트를 구현에 맞추지 말고, 요구사항에 맞게 구현을 고친다. 테스트 자체가 요구사항과
  모순될 때만 테스트를 고치고, 그 이유를 답변에 명시한다. 테스트를 약화시켜 통과시키는 것은 금지.
- 완료라고 말하기 전에 사용자 요청을 항목별로 다시 대조하고, 빠진 것이 있으면 계속 작업한다.
- 큰 기능(여러 파일, 명확한 요구사항)은 HARNESS 로 테스트 우선 구현을 수행해도 된다.
- 사용자가 "기억해", "앞으로는", "항상" 같은 말로 스타일/선호/제약을 알려주면 REMEMBER 로 저장한다.
- 사용자가 모델 다운로드/교체/엔진 관련 요청을 하면 MODEL 도구를 쓴다.
- 프로젝트에 필요한 그림(캐릭터·배경·아이콘·UI)은 인터넷에서 받지 말고 IMAGE 로 생성한다. prompt 는 영어로 쓴다. 생성한 경로를 코드에서 정확히 불러온다.
- 이미 있는 그림은 다시 만들지 않는다 (LIST 로 먼저 확인). 한 응답에 IMAGE 는 최대 4개, 꼭 필요한 그림만.
- IMAGE 에는 kind 를 꼭 쓰고, prompt 는 프로젝트 아트 컨셉·캐릭터 설명에 맞춰 무엇을 그릴지 구체적으로 쓴다.
- 답변은 사용자의 언어(기본 한국어)로 간결하게. 완료 후에는 무엇을 바꿨는지 1~3줄로 요약한다.
- 도구 결과를 기다려야 하면 그 응답에서는 도구 블록까지만 쓰고 멈춘다. 파일을 READ 하기 전에는 EDIT 하지 않는다.

${DebugKit.DEBUG_RULES}

${Protocol.TOOL_DOCS}

## 레포
$repoInfo

${ctx?.get("art")?.takeIf { !it.isJsonNull && it.asString.isNotBlank() }?.let { "## 프로젝트 아트 컨셉 (그림을 만들 때 이 컨셉에 맞게 · IMAGE 에 자동 적용됨)\n${it.asString}\n\n" } ?: ""}## 사용자 선호 · 스타일 · 제약 (항상 준수)
${s("preferences")?.ifBlank { null } ?: "- (없음)"}

## 이 레포의 코딩 방법 (자동 추출)
${s("methods") ?: "(색인 전)"}

## 파일 목록 (일부)
$tree"""
    }

    /** 대화 기록 압축: 예산을 넘었을 때만 기록 자체를 60% 까지 한 번에 줄인다 (프리픽스 KV 재사용 유지). */
    private fun compactHistory(systemLen: Int): Boolean = synchronized(history) {
        fun size() = systemLen + history.sumOf { it.content.length }
        if (size() <= CONTEXT_CHAR_BUDGET) return@synchronized false
        val target = CONTEXT_CHAR_BUDGET * COMPACT_TARGET
        var i = 0
        while (i < history.size - 2 && size() > target) {
            val m = history[i]
            if (m.role == "user" && m.content.startsWith("[도구 결과]") && m.content.length > 600) {
                history[i] = m.copy(content = m.content.take(500) + "\n…(이전 도구 결과 생략: 필요하면 다시 READ)")
            } else if (m.role == "assistant" && m.content.length > 1500) {
                history[i] = m.copy(content = Protocol.stripToolBlocks(m.content).take(800) + "\n(이전 응답의 코드 블록 생략)")
            }
            i++
        }
        while (size() > target && history.size > 2) history.removeAt(0)
        true
    }

    /** 승인 없이 도구 하나를 바로 실행 (슬래시 명령·설정 카드용). */
    fun runDirect(call: ToolCall): String {
        val root = projectRoot(project) ?: return "프로젝트 폴더가 없습니다."
        cancelled.set(false)
        return executeTool(call, host(root, Checkpoint(), autoApprove = true))
    }

    fun send(userText: String, editor: EditorContext, attachments: List<Attachment> = emptyList(), debug: Boolean = false) {
        if (running) return
        running = true
        cancelled.set(false)
        val checkpoint = Checkpoint().also { lastCheckpoint = it }
        emit(mapOf("type" to "busy", "busy" to true))
        val started = System.currentTimeMillis()
        var steps = 0
        var outcome = "완료"
        log.show()
        log.line("━━━━━━━━ [${java.time.LocalTime.now().withNano(0)}] 요청 ━━━━━━━━", "head")
        log.line(if (userText.length > 500) userText.take(500) + "…" else userText)
        try {
            val root = projectRoot(project) ?: run {
                emit(mapOf("type" to "notice", "level" to "warn", "text" to "프로젝트 폴더를 먼저 여세요.")); return
            }
            BackendLauncher.ensureRunning(project.basePath)?.let {
                say(it); return
            }
            if (Clients.engineHealth() == null) {
                log.line("[엔진] 꺼져 있음 → 설정 요청만 처리")
                handleOffline(userText); return
            }
            val ctx = try {
                if (Clients.remote) {
                    // 원격: 이 PC 의 파일을 서버로 올려 벡터화(처음/6시간마다) 후 프로젝트 이름으로 컨텍스트 조회
                    runCatching { RemoteIndex.ensure(root, log) }.onFailure { log.line("[원격 색인] 실패: ${it.message}", "error") }
                    Clients.post("/api/context", mapOf("query" to userText, "project" to RemoteIndex.projectName(root), "attachment_project" to RemoteIndex.projectName(root), "top_k" to 6), 60)
                } else {
                    Clients.post("/api/context", mapOf("query" to userText, "workspace_path" to root.toString(), "attachment_project" to RemoteIndex.projectName(root), "top_k" to 6), 600)
                }
            } catch (e: Exception) {
                emit(mapOf("type" to "notice", "level" to "warn", "text" to "백엔드 컨텍스트를 가져오지 못했습니다 (선호/벡터 검색 없이 진행): ${e.message}"))
                log.line("[컨텍스트] 실패: ${e.message}", "error")
                null
            }
            val repo = ctx?.get("repo")?.takeIf { it.isJsonObject }?.asJsonObject
            repoName = repo?.get("name")?.asString ?: ""
            val repoInfo = repo?.let { "${it.get("name").asString} · ${it.get("profile").asString} · ${it.get("language").asString} · $root" } ?: "$root (미연결)"
            val related = ctx?.getAsJsonArray("hits")?.take(4)?.joinToString("\n") {
                val h = it.asJsonObject; "--- ${h.get("source").asString} ---\n${h.get("content").asString}"
            }.orEmpty()

            // 이번에 첨부한 파일은 내용을 직접 넣고, 예전에 올린 첨부는 질문과 관련된 부분만 (벡터 검색)
            val attPaths = saveAttachments(root, attachments)
            val thisTurn = attachments.map { it.id }.toSet()
            val pastAtts = ctx?.getAsJsonArray("attachments")?.map { it.asJsonObject }
                ?.filter { it.get("attachment_id")?.asString !in thisTurn }?.take(2)
                ?.joinToString("\n") { "--- 📎 ${it.get("source").asString} ---\n${it.get("content").asString}" }.orEmpty()
            if (attachments.isNotEmpty()) {
                log.line("[첨부] ${attachments.joinToString(", ") { "${it.name}(${"%,d".format(it.chars)}자)" }} → 대화에 포함 · 전체는 $ATT_DIR/")
            }
            synchronized(history) {
                history += ChatMessage("user", "$userText\n\n${editorBlock(editor)}" + attachmentBlock(attachments, attPaths) +
                    (if (pastAtts.isNotBlank()) "\n\n(참고: 이전에 첨부한 자료 중 관련 부분)\n$pastAtts" else "") +
                    if (related.isNotBlank()) "\n\n(참고: 벡터 검색으로 찾은 관련 코드)\n$related" else "")
            }
            // 같은 대화에서 시스템 프롬프트가 그대로면 엔진이 앞부분을 재사용한다
            val system = systemPrompt(ctx, repoInfo, fileTree(root))
            val prefCount = ctx?.get("preferences")?.takeIf { !it.isJsonNull }?.asString?.lines()?.count { it.isNotBlank() } ?: 0
            val hitNames = ctx?.getAsJsonArray("hits")?.joinToString(", ") { it.asJsonObject.get("source").asString }.orEmpty()
            log.line("[컨텍스트] 레포 $repoInfo")
            log.line("[컨텍스트] 선호·제약 ${prefCount}개 · 코딩 방법 ${if (ctx?.get("methods")?.isJsonNull == false) "있음" else "없음"} · 관련 코드 ${hitNames.ifBlank { "없음" }}")
            log.line("[컨텍스트] 현재 파일 ${editor.file ?: "-"}${editor.selectionRange?.let { " · 선택 $it" } ?: ""} · 시스템 프롬프트 ${"%,d".format(system.length)}자")
            val h = host(root, checkpoint)
            val s = AgentSettings.current
            // 디버그 모드는 재현 → 계측 → 수정 → 재검증으로 단계가 많아 두 배까지 허용
            val maxSteps = if (debug) maxOf(24, s.maxSteps * 2) else s.maxSteps
            val gate = Gate()

            for (step in 0 until maxSteps) {
                if (cancelled.get()) break
                steps = step + 1
                val id = "a${System.currentTimeMillis()}"
                emit(mapOf("type" to "assistant-start", "id" to id))
                val raw = StringBuilder()
                var lastShown = ""
                if (compactHistory(system.length)) log.line("[대화 압축] 기록이 길어 오래된 도구 결과·코드를 줄였습니다 (이번 단계만 전체 다시 계산)")
                val messages = listOf(ChatMessage("system", system)) + synchronized(history) { history.toList() }
                val stepStart = System.currentTimeMillis()
                log.line("[모델 #$steps] 생성 시작 · 메시지 ${messages.size}개 · ${"%,d".format(messages.sumOf { it.content.length })}자", "head")
                val (text, stats) = Clients.stream(messages, s.maxTokens, s.temperature, streamHandle, { cancelled.get() }) { tok ->
                    raw.append(tok)
                    log.raw(tok)
                    val shown = Protocol.stripToolBlocks(raw.toString())
                    if (shown != lastShown) {
                        lastShown = shown
                        emit(mapOf("type" to "assistant-delta", "id" to id, "text" to shown))
                    }
                }
                emit(mapOf("type" to "assistant-end", "id" to id,
                    "stats" to stats?.let { "${it.completionTokens} tok · ${"%.1f".format(it.tokensPerSecond)} tok/s" }))
                synchronized(history) { history += ChatMessage("assistant", text) }
                log.raw("\n")
                log.line("[모델 #$steps] 완료 · ${stats?.completionTokens ?: "?"} tok · ${stats?.let { "%.1f".format(it.tokensPerSecond) } ?: "?"} tok/s · ${"%.1f".format((System.currentTimeMillis() - stepStart) / 1000.0)}s", "head")
                if (cancelled.get()) break

                var calls = Protocol.parseToolCalls(text)
                if (calls.isEmpty()) {
                    val nudge = if (step < maxSteps - 1) finishGate(checkpoint, gate, s.verifyBeforeFinish || debug) else ""
                    if (nudge.isNotEmpty()) {
                        log.line("[완료 관문] " + nudge.lineSequence().first())
                        synchronized(history) { history += ChatMessage("user", nudge) }
                        continue
                    }
                    log.line("[턴 종료] 도구 호출 없음 → 최종 답변")
                    break
                }
                // 결과를 보기 전에 수정·실행을 몰아서 호출하지 못하게: 앞쪽 조회 도구만 실행
                // 그림은 한 응답에 최대 MAX_IMAGES_PER_STEP 장
                val imgCount = calls.count { it is ToolCall.Image }
                val imgDeferred = maxOf(0, imgCount - MAX_IMAGES_PER_STEP)
                if (imgDeferred > 0) {
                    var kept = 0
                    calls = calls.filter { c -> c !is ToolCall.Image || kept++ < MAX_IMAGES_PER_STEP }
                }
                val firstAction = calls.indexOfFirst { !it.readOnly }
                val deferred = if (firstAction > 0) calls.size - firstAction else 0
                if (deferred > 0) calls = calls.subList(0, firstAction)
                log.line("[도구 계획] " + calls.joinToString(" | ") { Protocol.describeCall(it) } +
                    if (deferred > 0) "  (+수정/실행 ${deferred}개 보류: 조회 결과 확인 후 재요청)" else "", "tool")
                val results = mutableListOf<String>()
                for (call in calls) {
                    if (cancelled.get()) break
                    val t0 = System.currentTimeMillis()
                    log.line("▶ " + Protocol.describeCall(call), "tool")
                    val result = executeTool(call, h)
                    results += result
                    val failed = Regex("오류\\]|실패|거부|exit code [1-9]").containsMatchIn(result.lineSequence().first())
                    log.line(indent(result, if (call is ToolCall.Read) 3 else 40) + "\n    (${"%.1f".format((System.currentTimeMillis() - t0) / 1000.0)}s)", if (failed) "error" else "result")
                }
                if (deferred > 0) results += "(주의: 같은 응답의 수정/실행 도구 ${deferred}개는 실행하지 않았습니다. 위 조회 결과를 확인한 뒤 필요한 수정만 다시 요청하세요.)"
                if (imgDeferred > 0) results += "(주의: 그림은 한 번에 최대 ${MAX_IMAGES_PER_STEP}장만 만듭니다. 남은 IMAGE ${imgDeferred}개는 실행하지 않았습니다. 필요한 것만 다음 응답에서 다시 요청하세요.)"
                // 실행으로 확인했는지 · CHECK 결과 기록
                calls.forEachIndexed { i, c ->
                    if (c is ToolCall.Run || c is ToolCall.Play || c is ToolCall.Harness) gate.ran = true
                    if (c is ToolCall.Check) {
                        gate.errors = Regex("오류 (\\d+)개").find(results.getOrElse(i) { "" })?.groupValues?.get(1)?.toInt() ?: 0
                        gate.errorText = if (gate.errors > 0) results[i] else ""
                    }
                }
                // 수정 직후 자동 검사: 문법·타입·IDE 오류·리소스 경로를 바로 돌려줘 다음 단계에서 고치게 한다
                val changed = calls.mapNotNull { c -> (c as? ToolCall.Write)?.path ?: (c as? ToolCall.Edit)?.path }.distinct()
                if (changed.isNotEmpty()) {
                    if (changed.any { Regex("""\.(py|m?jsx?|cjs|tsx?|dart|gd|cs|html?|kt|java|rs|go|lua|vue|svelte)$""", RegexOption.IGNORE_CASE).containsMatchIn(it) }) gate.codeChanged = true
                    if (s.autoCheck && !cancelled.get()) {
                        val t0 = System.currentTimeMillis()
                        val rep = try { DebugRunner.runCheck(project, root, changed) } catch (e: Exception) { DebugRunner.CheckReport(0, 0, "[자동 검사] 실패: ${e.message}") }
                        gate.errors = rep.errors
                        gate.errorText = if (rep.errors > 0) rep.text else ""
                        results += rep.text
                        log.line(indent(rep.text, 30) + "\n    (${"%.1f".format((System.currentTimeMillis() - t0) / 1000.0)}s)", if (rep.errors > 0) "error" else "result")
                        if (rep.errors + rep.warnings > 0) emit(mapOf("type" to "tool", "id" to "chk${System.currentTimeMillis()}",
                            "title" to "자동 검사: 오류 ${rep.errors} · 경고 ${rep.warnings}", "status" to if (rep.errors > 0) "error" else "done", "detail" to rep.text.take(3000)))
                    }
                }
                synchronized(history) { history += ChatMessage("user", "[도구 결과]\n" + results.joinToString("\n\n")) }
                if (step == maxSteps - 1) {
                    emit(mapOf("type" to "notice", "level" to "warn", "text" to "최대 단계(${maxSteps})에 도달해 멈췄습니다. \"계속\"이라고 입력하면 이어서 진행합니다."))
                }
            }
            if (cancelled.get()) emit(mapOf("type" to "notice", "level" to "info", "text" to "중단했습니다."))
        } catch (e: Exception) {
            outcome = if (cancelled.get()) "중단" else "오류"
            if (!cancelled.get()) log.line("[오류] ${e.stackTraceToString().take(3000)}", "error")
            emit(mapOf("type" to "notice", "level" to if (cancelled.get()) "info" else "error",
                "text" to if (cancelled.get()) "중단했습니다." else (e.message ?: e.toString())))
        } finally {
            if (cancelled.get()) outcome = "중단"
            log.line("━━━━━━━━ $outcome · ${steps}단계 · 변경 파일 ${checkpoint.originals.size}개 · ${"%.1f".format((System.currentTimeMillis() - started) / 1000.0)}s ━━━━━━━━\n",
                if (outcome == "오류") "error" else "head")
            running = false
            emit(mapOf("type" to "turn-end", "changedFiles" to checkpoint.originals.size))
            emit(mapOf("type" to "busy", "busy" to false))
        }
    }

    /** 완료 관문 상태: 남은 오류 · 실행 확인 여부 · 같은 독촉 반복 횟수 */
    private class Gate {
        var errors = 0
        var errorText = ""
        var ran = false
        var codeChanged = false
        var nudgeErrors = 0
        var nudgeMarkers = 0
        var nudgeVerify = 0
    }

    /** 모델이 끝내려 할 때 남은 오류·임시 로그·미검증을 확인해 한 번 더 일하게 한다. 할 말이 없으면 "". */
    private fun finishGate(checkpoint: Checkpoint, gate: Gate, verify: Boolean): String {
        if (gate.errors > 0 && gate.nudgeErrors < 2) {
            gate.nudgeErrors++
            return "[완료 관문] 아직 오류 ${gate.errors}개가 남아 있습니다. 고친 뒤 끝내세요. 고칠 수 없거나 의도된 것이면 이유를 설명하고 끝내세요.\n\n${gate.errorText.take(3000)}"
        }
        if (gate.nudgeMarkers < 1) {
            val left = checkpoint.originals.keys.flatMap { p ->
                try { Files.readAllLines(Path.of(p)).mapIndexedNotNull { i, l -> if ("YANG-DEBUG" in l) "${projectRoot(project)?.relativize(Path.of(p)) ?: p}:${i + 1}: ${l.trim()}" else null } }
                catch (e: Exception) { emptyList() }
            }
            if (left.isNotEmpty()) {
                gate.nudgeMarkers++
                return "[완료 관문] 임시 디버그 로그(YANG-DEBUG)가 남아 있습니다. 모두 지운 뒤 끝내세요:\n" + left.take(15).joinToString("\n")
            }
        }
        if (verify && gate.codeChanged && !gate.ran && gate.nudgeVerify < 1) {
            gate.nudgeVerify++
            return "[완료 관문] 코드를 바꿨지만 실행으로 확인하지 않았습니다. 테스트가 있으면 RUN, 게임·앱이면 PLAY 로 실제 동작을 확인하세요. " +
                "실행할 수 없는 상황이면(필요한 도구·기기 없음 등) 그 이유를 한 줄로 말하고 끝내세요."
        }
        return ""
    }

    private fun say(text: String) {
        val id = "a${System.currentTimeMillis()}"
        emit(mapOf("type" to "assistant-start", "id" to id))
        emit(mapOf("type" to "assistant-delta", "id" to id, "text" to text))
        emit(mapOf("type" to "assistant-end", "id" to id))
    }

    /** 엔진이 꺼져 있을 때 모델 다운로드/시작 같은 설정 요청은 규칙 기반으로 처리. */
    private fun handleOffline(text: String) {
        if (Clients.remote) {
            say(if (Clients.backendAlive())
                "원격 서버(맥)의 코딩 엔진이 꺼져 있습니다. 서버에서 `local-agent start` 를 실행하거나 서버 모드(`scripts/server-mode.sh on`)를 켜 두세요."
            else "원격 서버에 연결할 수 없습니다: ${Clients.lastBackendError}\nSettings → Tools → Yang Coding 에서 주소와 토큰을 확인하세요.")
            return
        }
        val t = text.lowercase()
        val key = when {
            Regex("30b|qwen3").containsMatchIn(t) -> "qwen3-coder-30b"
            "14b" in t -> "qwen2.5-coder-14b"
            "7b" in t -> "qwen2.5-coder-7b"
            else -> ""
        }
        when {
            Regex("다운|받아|설치|download|install").containsMatchIn(t) -> {
                runDirect(ToolCall.Model("download", key.ifBlank { "qwen3-coder-30b" }))
                say("다운로드를 시작했습니다. 위 설정 카드에서 진행률을 볼 수 있고, 끝나면 \"엔진 시작해줘\"라고 말해주세요.")
            }
            Regex("시작|켜|실행|로드|start|run|load").containsMatchIn(t) -> {
                val res = runDirect(ToolCall.Model("start", key))
                say(if ("오류" in res) res else "엔진이 준비되었습니다. 이제 무엇을 만들지 말씀해 주세요.")
            }
            Regex("상태|목록|status|list|모델").containsMatchIn(t) -> say(runDirect(ToolCall.Model("status", "")))
            else -> say("로컬 모델 엔진이 꺼져 있어 아직 코딩할 수 없습니다.\n- \"30B 모델 다운로드해줘\" → 권장 모델(18.6GB) 받기\n- \"엔진 시작해줘\" → 받아둔 모델로 엔진 실행\n- \"모델 상태 알려줘\"")
        }
    }
}
