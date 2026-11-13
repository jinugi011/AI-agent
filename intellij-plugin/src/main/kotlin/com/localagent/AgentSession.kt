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

private const val CONTEXT_CHAR_BUDGET = 70_000
private val TREE_EXCLUDES = setOf("node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "Pods", ".dart_tool", ".gradle", "models", "out", ".idea")

/** 채팅 에이전트 루프 (VS Code agent.ts 와 동일한 동작). 백그라운드 스레드에서 send() 를 호출한다. */
class AgentSession(
    private val project: Project,
    private val emit: (Map<String, Any?>) -> Unit,
    private val requestApproval: (kind: String, title: String, detail: String) -> String, // allow|always|deny (블로킹)
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
        val answer = requestApproval(kind, title, detail)
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
        override fun emit(event: Map<String, Any?>) = this@AgentSession.emit(event)
        override fun registerProcess(p: Process?) { runningProcess = p }
    }

    private fun fileTree(root: Path): String {
        val files = Files.walk(root).use { s ->
            s.filter { p -> !p.isDirectory() && p.relativeTo(root).none { it.name in TREE_EXCLUDES } }
                .limit(250).map { it.relativeTo(root).toString() }.sorted().toList()
        }
        return files.joinToString("\n") + if (files.size >= 250) "\n…(더 있음: LIST 로 확인)" else ""
    }

    private fun systemPrompt(ctx: JsonObject?, repoInfo: String, editor: EditorContext, tree: String): String {
        fun s(key: String) = ctx?.get(key)?.takeIf { !it.isJsonNull }?.asString
        return """당신은 사용자의 IntelliJ IDE 안에서 동작하는 로컬 코딩 에이전트입니다 (Claude Code 와 유사).
사용자의 자연어 요청을 이해해 코드를 읽고, 수정하고, 명령을 실행해 작업을 끝까지 완료합니다.

## 일하는 방식
- 추측하지 말고 먼저 READ/GREP/SEARCH 로 확인한 뒤 수정한다.
- 기존 코드의 스타일·구조·네이밍을 그대로 따른다. 아래 선호/제약은 반드시 지킨다.
- 수정 후에는 가능하면 RUN 으로 테스트/빌드를 실행해 검증한다.
- 사용자가 지정한 함수 이름·시그니처·동작은 절대 바꾸지 않는다 (예: total(prices) 를 total() 로 바꾸지 말 것).
- 테스트가 실패하면 테스트를 구현에 맞추지 말고, 요구사항에 맞게 구현을 고친다. 테스트 자체가 요구사항과
  모순될 때만 테스트를 고치고, 그 이유를 답변에 명시한다. 테스트를 약화시켜 통과시키는 것은 금지.
- 완료라고 말하기 전에 사용자 요청을 항목별로 다시 대조하고, 빠진 것이 있으면 계속 작업한다.
- 큰 기능(여러 파일, 명확한 요구사항)은 HARNESS 로 테스트 우선 구현을 수행해도 된다.
- 사용자가 "기억해", "앞으로는", "항상" 같은 말로 스타일/선호/제약을 알려주면 REMEMBER 로 저장한다.
- 사용자가 모델 다운로드/교체/엔진 관련 요청을 하면 MODEL 도구를 쓴다.
- 답변은 사용자의 언어(기본 한국어)로 간결하게. 완료 후에는 무엇을 바꿨는지 1~3줄로 요약한다.
- 도구 결과를 기다려야 하면 그 응답에서는 도구 블록까지만 쓰고 멈춘다. 파일을 READ 하기 전에는 EDIT 하지 않는다.

${Protocol.TOOL_DOCS}

## 레포
$repoInfo

## 사용자 선호 · 스타일 · 제약 (항상 준수)
${s("preferences")?.ifBlank { null } ?: "- (없음)"}

## 이 레포의 코딩 방법 (자동 추출)
${s("methods") ?: "(색인 전)"}

## 에디터 상태
현재 파일: ${editor.file ?: "(없음)"}
열린 파일: ${editor.openFiles.take(15).joinToString(", ").ifBlank { "(없음)" }}
${editor.selection?.let { "선택 영역 (${editor.selectionRange}):\n```\n${it.take(4000)}\n```" } ?: ""}

## 파일 목록 (일부)
$tree"""
    }

    private fun compact(messages: MutableList<ChatMessage>): List<ChatMessage> {
        fun size() = messages.sumOf { it.content.length }
        var i = 1
        while (i < messages.size - 2 && size() > CONTEXT_CHAR_BUDGET) {
            val m = messages[i]
            if (m.role == "user" && m.content.startsWith("[도구 결과]") && m.content.length > 600) {
                messages[i] = m.copy(content = m.content.take(500) + "\n…(이전 도구 결과 생략: 필요하면 다시 READ)")
            } else if (m.role == "assistant" && m.content.length > 1500) {
                messages[i] = m.copy(content = Protocol.stripToolBlocks(m.content).take(800) + "\n(이전 응답의 코드 블록 생략)")
            }
            i++
        }
        while (size() > CONTEXT_CHAR_BUDGET && messages.size > 3) messages.removeAt(1)
        return messages
    }

    /** 승인 없이 도구 하나를 바로 실행 (슬래시 명령·설정 카드용). */
    fun runDirect(call: ToolCall): String {
        val root = projectRoot(project) ?: return "프로젝트 폴더가 없습니다."
        cancelled.set(false)
        return executeTool(call, host(root, Checkpoint(), autoApprove = true))
    }

    fun send(userText: String, editor: EditorContext) {
        if (running) return
        running = true
        cancelled.set(false)
        val checkpoint = Checkpoint().also { lastCheckpoint = it }
        emit(mapOf("type" to "busy", "busy" to true))
        try {
            val root = projectRoot(project) ?: run {
                emit(mapOf("type" to "notice", "level" to "warn", "text" to "프로젝트 폴더를 먼저 여세요.")); return
            }
            BackendLauncher.ensureRunning(project.basePath)?.let {
                say(it); return
            }
            if (Clients.engineHealth() == null) {
                handleOffline(userText); return
            }
            val ctx = try {
                Clients.post("/api/context", mapOf("query" to userText, "workspace_path" to root.toString(), "top_k" to 6), 600)
            } catch (e: Exception) {
                emit(mapOf("type" to "notice", "level" to "warn", "text" to "백엔드 컨텍스트를 가져오지 못했습니다 (선호/벡터 검색 없이 진행): ${e.message}"))
                null
            }
            val repo = ctx?.get("repo")?.takeIf { it.isJsonObject }?.asJsonObject
            repoName = repo?.get("name")?.asString ?: ""
            val repoInfo = repo?.let { "${it.get("name").asString} · ${it.get("profile").asString} · ${it.get("language").asString} · $root" } ?: "$root (미연결)"
            val related = ctx?.getAsJsonArray("hits")?.take(4)?.joinToString("\n") {
                val h = it.asJsonObject; "--- ${h.get("source").asString} ---\n${h.get("content").asString}"
            }.orEmpty()

            synchronized(history) {
                history += ChatMessage("user", if (related.isNotBlank()) "$userText\n\n(참고: 벡터 검색으로 찾은 관련 코드)\n$related" else userText)
            }
            val system = systemPrompt(ctx, repoInfo, editor, fileTree(root))
            val h = host(root, checkpoint)
            val s = AgentSettings.current

            for (step in 0 until s.maxSteps) {
                if (cancelled.get()) break
                val id = "a${System.currentTimeMillis()}"
                emit(mapOf("type" to "assistant-start", "id" to id))
                val raw = StringBuilder()
                var lastShown = ""
                val messages = compact((listOf(ChatMessage("system", system)) + synchronized(history) { history.toList() }).toMutableList())
                val (text, stats) = Clients.stream(messages, s.maxTokens, s.temperature, streamHandle, { cancelled.get() }) { tok ->
                    raw.append(tok)
                    val shown = Protocol.stripToolBlocks(raw.toString())
                    if (shown != lastShown) {
                        lastShown = shown
                        emit(mapOf("type" to "assistant-delta", "id" to id, "text" to shown))
                    }
                }
                emit(mapOf("type" to "assistant-end", "id" to id,
                    "stats" to stats?.let { "${it.completionTokens} tok · ${"%.1f".format(it.tokensPerSecond)} tok/s" }))
                synchronized(history) { history += ChatMessage("assistant", text) }
                if (cancelled.get()) break

                var calls = Protocol.parseToolCalls(text)
                if (calls.isEmpty()) break
                // 결과를 보기 전에 수정·실행을 몰아서 호출하지 못하게: 앞쪽 조회 도구만 실행
                val firstAction = calls.indexOfFirst { !it.readOnly }
                val deferred = if (firstAction > 0) calls.size - firstAction else 0
                if (deferred > 0) calls = calls.subList(0, firstAction)
                val results = mutableListOf<String>()
                for (call in calls) {
                    if (cancelled.get()) break
                    results += executeTool(call, h)
                }
                if (deferred > 0) results += "(주의: 같은 응답의 수정/실행 도구 ${deferred}개는 실행하지 않았습니다. 위 조회 결과를 확인한 뒤 필요한 수정만 다시 요청하세요.)"
                synchronized(history) { history += ChatMessage("user", "[도구 결과]\n" + results.joinToString("\n\n")) }
                if (step == s.maxSteps - 1) {
                    emit(mapOf("type" to "notice", "level" to "warn", "text" to "최대 단계(${s.maxSteps})에 도달해 멈췄습니다. \"계속\"이라고 입력하면 이어서 진행합니다."))
                }
            }
            if (cancelled.get()) emit(mapOf("type" to "notice", "level" to "info", "text" to "중단했습니다."))
        } catch (e: Exception) {
            emit(mapOf("type" to "notice", "level" to if (cancelled.get()) "info" else "error",
                "text" to if (cancelled.get()) "중단했습니다." else (e.message ?: e.toString())))
        } finally {
            running = false
            emit(mapOf("type" to "turn-end", "changedFiles" to checkpoint.originals.size))
            emit(mapOf("type" to "busy", "busy" to false))
        }
    }

    private fun say(text: String) {
        val id = "a${System.currentTimeMillis()}"
        emit(mapOf("type" to "assistant-start", "id" to id))
        emit(mapOf("type" to "assistant-delta", "id" to id, "text" to text))
        emit(mapOf("type" to "assistant-end", "id" to id))
    }

    /** 엔진이 꺼져 있을 때 모델 다운로드/시작 같은 설정 요청은 규칙 기반으로 처리. */
    private fun handleOffline(text: String) {
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
