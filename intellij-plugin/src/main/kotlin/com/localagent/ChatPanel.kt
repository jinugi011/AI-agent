package com.localagent

import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.UIManager

private val HELP = """**사용법** — 자연어로 요청하면 됩니다. 예:
- "장바구니에 쿠폰 할인 기능 추가하고 테스트 돌려줘"
- "이 함수 왜 느린지 봐줘" (에디터에서 코드 선택 후)
- "앞으로 Kotlin 은 ktlint 규칙으로 해줘" → 선호로 영구 저장
- "30B 모델 다운로드해줘" / "엔진 시작해줘" / "모델 상태"

**슬래시 명령**
- `/new` 새 대화 · `/stop` 중단 · `/undo` 마지막 턴의 파일 변경 되돌리기 · `/log` 작업 로그 콘솔 열기
- `/model` 모델 목록 · `/model 코딩` 평소 코딩 (Qwen3.6) · `/model 이전` 이전 모델 (Qwen3-Coder-30B)
- `/remember <style|preference|constraint> <global|language:x|profile:x|project> 내용`
- `/task 요구사항` → 하네스(테스트 우선) 자동 구현 · `/connect 경로|URL` · `/reindex`
- `/langchain 원하는 기능` 서버 LangChain으로 명세 생성 → 이 PC에서 구현 · `/langchain 하네스 목표와 완료 조건` 테스트 우선 구현
- 입력창 작업 방식에서 **자연어 하네스**를 선택하면 문서 없이 목표·완료 조건을 입력할 수 있습니다.
- `/arch 분석` 코드·문서 임베딩 + 코딩 스타일 + 아키텍처 분석 (1~3분) · `/arch` 보기 · `/arch 저장` (.yang/architecture.md 를 고친 뒤)
- `/harness 문서.md` 요구사항 md → 체크리스트(.yang/harness) → 테스트 먼저 → 구현 → 통과까지 · `/harness` 목록·진행률
- 에이전트도 필요하면 스스로 ANALYZE(프로젝트 분석)를 요청합니다 (승인 창)

**디버깅**
- `/debug 증상` → 재현(실행) → 원인 위치 → 가설 → 임시 로그 → 수정 → 재검증 → 정리 순서로 버그 잡기
  예) `/debug 점프하면 캐릭터가 사라짐` · `/debug` (증상 없이: 실행해서 문제 찾기)
- `/play [web|python|flutter|godot|unity|cmd] [대상] [초]` → 게임·앱을 실행해 오류·콘솔·리소스 실패·프레임·화면 분석
- `/check` → 프로젝트 전체 정적 검사 (문법·타입·IDE 오류·리소스 경로)
- 파일을 고칠 때마다 자동 검사가 돌고, 오류가 남아 있으면 끝내지 않고 고칩니다 (설정에서 끌 수 있음)

**그림 (다운로드하지 않고 생성)**
- `/image 설명` → 맥의 이미지 모델(Z-Image)로 생성해 프로젝트에 저장 · 예) `/image 64x64 투명 배경 픽셀아트 슬라임`
- `/art` → 프로젝트(문서·코드·기존 그림·벡터 DB)를 분석해 **아트 컨셉** 만들기 → 모든 그림에 자동 적용 · `/art 어두운 판타지 16비트 픽셀아트` (직접 컨셉 지정) · `/art 수정 …` · `/art 보기`
- `/assets` → 코드가 쓰는데 파일이 없는 그림을 찾아 컨셉에 맞게 생성 (그림 하네스)
- 대화로도 가능: "주인공 스프라이트 만들어서 assets 에 넣어줘", "이 첨부 그림 스타일로 배경 그려줘", "무료 이미지 참고해서 아이콘 만들어줘"
- 가공: 배경 제거 · 픽셀아트 · 크기 · 자르기 · 뒤집기 · 색조 · 스프라이트 시트 나누기/합치기 · `/undo` 로 되돌리기

**원격 모드**에서는 모델·LangChain은 서버에서, 파일 수정과 하네스 테스트는 현재 PC의 열린 프로젝트에서 수행합니다. 웹 LangChain 결과를 이 IDE에 전달할 수도 있습니다."""

/** Yang Coding 툴 윈도우: JCEF 로 채팅 UI(VS Code 확장과 동일한 chat.js/css)를 띄우고 세션과 연결한다. */
class ChatPanel(private val project: Project) : Disposable {
    companion object {
        val instances = ConcurrentHashMap<Project, ChatPanel>()
    }

    val component: JComponent
    private val browser: JBCefBrowser?
    private val query: JBCefJSQuery?
    private var swing: SwingChatView? = null
    private val approvals = ConcurrentHashMap<String, CompletableFuture<String>>()
    private val pending = mutableListOf<String>()
    @Volatile private var ready = false
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "local-agent-status").apply { isDaemon = true } }
    private val log = AgentLogService.of(project)
    private val session = AgentSession(project, ::post, ::askApproval, log)
    private val workflowRunning = java.util.concurrent.atomic.AtomicBoolean(false)
    private val workflowCancelled = java.util.concurrent.atomic.AtomicBoolean(false)
    private var remoteInbox: RemoteWorkInbox? = null

    init {
        instances[project] = this
        if (!JBCefApp.isSupported()) {
            // Android Studio 기본 런타임 등 내장 브라우저가 없는 IDE → Swing 채팅 화면 (같은 이벤트·같은 기능)
            browser = null
            query = null
            val view = SwingChatView { raw -> runCatching { onMessage(raw) }.onFailure { post(mapOf("type" to "notice", "level" to "error", "text" to (it.message ?: it.toString()))) } }
            swing = view
            component = view.component
            ready = true
            scheduler.scheduleWithFixedDelay({ runCatching { pushStatus() } }, 1, 4, TimeUnit.SECONDS)
            if (AgentSettings.current.autoStartBackend)
                pooled { BackendLauncher.ensureRunning(project.basePath)?.let { post(mapOf("type" to "notice", "level" to "warn", "text" to it)) } }
        } else {
            browser = JBCefBrowser()
            query = JBCefJSQuery.create(browser as JBCefBrowserBase)
            query.addHandler { raw ->
                runCatching { onMessage(raw) }.onFailure { post(mapOf("type" to "notice", "level" to "error", "text" to (it.message ?: it.toString()))) }
                null
            }
            browser.loadHTML(buildHtml())
            component = browser.component
            Disposer.register(this, browser)
            Disposer.register(this, query)
            scheduler.scheduleWithFixedDelay({ runCatching { pushStatus() } }, 1, 4, TimeUnit.SECONDS)
            ApplicationManager.getApplication().messageBus.connect(this)
                .subscribe(LafManagerListener.TOPIC, LafManagerListener { applyTheme() })
        }
        // 웹 관리 페이지에서 '이 PC 의 경로'로 등록한 프로젝트를 찾아 올린다 (켜질 때 + 10분마다)
        scheduler.scheduleWithFixedDelay({
            if (Clients.remote) runCatching {
                val done = RemoteIndex.syncPending(log)
                if (done.isNotEmpty()) notice("원격 등록 프로젝트를 올려 분석을 시작했습니다: ${done.joinToString(", ")}")
            }
        }, 5, 600, TimeUnit.SECONDS)
        projectRoot(project)?.let { root ->
            remoteInbox = RemoteWorkInbox(root, { session.running || workflowRunning.get() },
                { text, cancelled -> askCancellableApproval("run", "웹에서 전달한 원격 작업", "$root\n\n$text", cancelled) != "deny" },
                { text, harness -> runWorkflowTask(text, harness) },
                { if (workflowRunning.get()) { workflowCancelled.set(true); session.stop(); approvals.values.forEach { it.complete("deny") } } }, ::notice)
        }
    }

    override fun dispose() {
        workflowCancelled.set(true)
        remoteInbox?.close()
        instances.remove(project, this)
        session.stop()
        scheduler.shutdownNow()
        approvals.values.forEach { it.complete("deny") }
    }

    // ---- Kotlin → 웹뷰 -----------------------------------------------------------
    private fun post(msg: Map<String, Any?>) {
        swing?.let { it.render(msg); return }
        val json = Clients.gson.toJson(msg)
        synchronized(pending) {
            if (!ready) { pending += json; return }
        }
        exec("window.dispatchEvent(new MessageEvent('message', {data: $json}));")
    }

    private fun exec(js: String) {
        browser?.cefBrowser?.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    private fun pushStatus() {
        val backendUp = Clients.backendAlive()
        val eng = Clients.engineHealth()?.getAsJsonObject("model")
        val models = if (backendUp) runCatching { Clients.get("/api/models", 3).getAsJsonArray("catalog") }.getOrNull() else null
        val status = mapOf(
            "type" to "status",
            "backend" to backendUp,
            "engine" to eng?.let { mapOf("name" to it.get("model_name").asString, "ctx" to it.get("n_ctx").asInt) },
            "models" to (models?.map { Clients.gson.fromJson(it, Map::class.java) } ?: emptyList<Any>()),
            "repo" to session.repoName,
            "workspace" to project.name,
            "remote" to Clients.remote,
            "server" to if (Clients.remote) DefaultServer.effective() else "",
            "defaultServer" to DefaultServer.url,
            "error" to if (backendUp) "" else Clients.lastBackendError,
        )
        post(status)
    }

    // ---- 테마: IntelliJ 색을 VS Code CSS 변수로 매핑 -----------------------------------
    private fun hex(c: Color?) = c?.let { String.format("#%02x%02x%02x", it.red, it.green, it.blue) } ?: "inherit"

    private fun themeCss(): String {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val dark = !JBColor.isBright()
        val font = UIUtil.getLabelFont()
        val accent = UIManager.getColor("Button.default.startBackground") ?: JBUI.CurrentTheme.Focus.focusColor()
        val vars = mapOf(
            "--vscode-foreground" to hex(UIUtil.getLabelForeground()),
            "--vscode-descriptionForeground" to hex(UIUtil.getContextHelpForeground()),
            "--vscode-sideBar-background" to hex(UIUtil.getPanelBackground()),
            "--vscode-panel-border" to hex(JBColor.border()),
            "--vscode-input-background" to hex(UIUtil.getTextFieldBackground()),
            "--vscode-input-foreground" to hex(UIUtil.getTextFieldForeground()),
            "--vscode-input-border" to hex(JBColor.border()),
            "--vscode-editorWidget-background" to hex(UIManager.getColor("EditorPane.inactiveBackground") ?: UIUtil.getPanelBackground()),
            "--vscode-textCodeBlock-background" to hex(scheme.defaultBackground),
            "--vscode-button-background" to hex(accent),
            "--vscode-button-hoverBackground" to hex(accent),
            "--vscode-button-foreground" to "#ffffff",
            "--vscode-button-secondaryBackground" to hex(UIManager.getColor("Button.startBackground") ?: UIUtil.getPanelBackground()),
            "--vscode-button-secondaryHoverBackground" to hex(UIManager.getColor("Button.startBackground") ?: UIUtil.getPanelBackground()),
            "--vscode-button-secondaryForeground" to hex(UIUtil.getLabelForeground()),
            "--vscode-focusBorder" to hex(JBUI.CurrentTheme.Focus.focusColor()),
            "--vscode-textLink-foreground" to hex(JBUI.CurrentTheme.Link.Foreground.ENABLED),
            "--vscode-progressBar-background" to hex(JBUI.CurrentTheme.Focus.focusColor()),
            "--vscode-errorForeground" to if (dark) "#f75464" else "#c7222d",
            "--vscode-testing-iconPassed" to if (dark) "#5fb865" else "#208a3c",
            "--vscode-editorWarning-foreground" to if (dark) "#d6ae58" else "#a46704",
            "--vscode-font-family" to "'${font.family}', -apple-system, sans-serif",
            "--vscode-font-size" to "${font.size}px",
            "--vscode-editor-font-family" to "'${scheme.editorFontName}', monospace",
        )
        return ":root{color-scheme:${if (dark) "dark" else "light"};" + vars.entries.joinToString("") { "${it.key}:${it.value};" } + "}"
    }

    private fun applyTheme() {
        val css = Clients.gson.toJson(themeCss())
        exec("document.getElementById('theme').textContent = $css;")
    }

    private fun resource(name: String) =
        javaClass.getResourceAsStream("/chat-ui/$name")?.readAllBytes()?.decodeToString() ?: error("리소스 없음: $name")

    private fun buildHtml(): String {
        val send = query!!.inject("s")
        // VS Code 웹뷰 API 를 흉내 내는 shim → chat.js 를 수정 없이 재사용
        val shim = """
            window.__send = function(s){ $send };
            window.acquireVsCodeApi = function(){ return {
              postMessage: function(m){ window.__send(JSON.stringify(m)); },
              setState: function(){}, getState: function(){ return undefined; } }; };
        """.trimIndent()
        return """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<style id="theme">${themeCss()}</style>
<style>${resource("chat.css")}</style>
</head><body data-host="intellij">
  <header id="status"><span class="dot"></span><span id="status-text">연결 확인 중…</span></header>
  <section id="setup" hidden></section>
  <main id="log" aria-live="polite"></main>
  <form id="composer">
    <textarea id="input" rows="3" placeholder="무엇을 만들까요? (Enter 전송 · Shift+Enter 줄바꿈 · /help)"></textarea>
    <div class="row">
      <span class="hint" id="hint"></span>
      <button type="button" id="stop" class="secondary" hidden>중단</button>
      <button type="submit" id="send">보내기</button>
    </div>
  </form>
  <script>$shim</script>
  <script>${resource("chat.js")}</script>
  <script>window.__send(JSON.stringify({type:'ready'}));</script>
</body></html>"""
    }

    // ---- 승인 (백그라운드 스레드에서 블로킹 대기) --------------------------------------
    private fun askApproval(kind: String, title: String, detail: String): String =
        askCancellableApproval(kind, title, detail) { false }

    private fun askCancellableApproval(kind: String, title: String, detail: String, cancelled: () -> Boolean): String {
        val reqId = "ap${System.nanoTime()}"
        val future = CompletableFuture<String>()
        approvals[reqId] = future
        post(mapOf("type" to "approval", "reqId" to reqId, "kind" to kind, "title" to title, "detail" to detail))
        return try {
            var answer: String? = null
            while (answer == null) {
                if (cancelled()) future.complete("deny")
                try { answer = future.get(1, TimeUnit.SECONDS) }
                catch (_: java.util.concurrent.TimeoutException) { /* Recheck only this approval's cancellation. */ }
            }
            requireNotNull(answer)
        } finally { approvals.remove(reqId) }
    }

    // ---- 웹뷰 → Kotlin -----------------------------------------------------------
    private fun onMessage(raw: String) {
        val m = JsonParser.parseString(raw).asJsonObject
        fun s(k: String) = m.get(k)?.takeIf { !it.isJsonNull }?.asString ?: ""
        when (s("type")) {
            "ready" -> {
                val queued = synchronized(pending) { ready = true; pending.toList().also { pending.clear() } }
                queued.forEach { exec("window.dispatchEvent(new MessageEvent('message', {data: $it}));") }
                if (AgentSettings.current.autoStartBackend)
                    pooled { BackendLauncher.ensureRunning(project.basePath)?.let { post(mapOf("type" to "notice", "level" to "warn", "text" to it)) } }
            }
            "send" -> handleInput(s("text"), m.getAsJsonArray("attachments")?.map { it.asString } ?: emptyList())
            "pickFiles" -> ApplicationManager.getApplication().invokeLater { pickFiles() }
            "attachData" -> pooled { uploadAttachment(s("key"), s("name"), s("data")) }
            "attachUris" -> m.getAsJsonArray("uris")?.map { it.asString }?.let { uris ->
                pooled {
                    uris.forEach { u ->
                        runCatching { if (u.startsWith("/")) java.nio.file.Path.of(u) else java.nio.file.Path.of(java.net.URI.create(u)) }
                            .getOrNull()?.let { attachPath(it) }
                    }
                }
            }
            "stop" -> { workflowCancelled.set(true); session.stop() }
            "new" -> newChat()
            "approval" -> approvals[s("reqId")]?.complete(s("answer"))
            "undo" -> pooled { undo() }
            "openDiff" -> session.originals[s("id")]?.let { before -> projectRoot(project)?.let { FileOps.showDiff(project, it, s("path"), before) } }
            "openFile" -> projectRoot(project)?.resolve(s("path"))?.let { p ->
                ApplicationManager.getApplication().invokeLater {
                    LocalFileSystem.getInstance().refreshAndFindFileByNioFile(p)?.let { FileEditorManager.getInstance(project).openFile(it, true) }
                }
            }
            "setup" -> pooled { notice(direct(ToolCall.Model(s("action"), s("model")))) }
            "startBackend" -> pooled { notice(BackendLauncher.ensureRunning(project.basePath) ?: "백엔드가 실행되었습니다.") }
            "configureRemote" -> ApplicationManager.getApplication().invokeLater { askTokenAndConnect() }
        }
    }

    /** 승인 없이 도구 하나를 바로 실행 (슬래시 명령·설정 카드) + 작업 로그 기록 */
    private fun direct(call: ToolCall): String {
        log.line("▶ (직접 실행) " + Protocol.describeCall(call), "tool")
        val result = session.runDirect(call)
        log.line(result.lines().joinToString("\n") { "    $it" }, if ("오류" in result) "error" else "result")
        return result
    }

    /** 원격 접속: 서버 주소는 설치 파일에 고정 → 토큰만 입력하면 바로 접속 (주소가 없으면 설정 화면) */
    private fun askTokenAndConnect() {
        val url = DefaultServer.effective()
        if (url.isBlank()) {
            com.intellij.openapi.options.ShowSettingsUtil.getInstance().showSettingsDialog(project, AgentConfigurable::class.java)
            return
        }
        val token = com.intellij.openapi.ui.Messages.showPasswordDialog(project,
            "서버: ${url.removePrefix("http://").removePrefix("https://")}\n관리 페이지(서버 주소를 브라우저로 열기) → 접속 토큰에서 발급한 값을 붙여 넣으세요.",
            "Yang Coding 접속 토큰", null)?.trim()
        if (token.isNullOrBlank()) return
        AgentSecrets.set(AgentSecrets.TOKEN, token)
        AgentSettings.current.mode = "remote"
        pooled {
            val ok = Clients.backendAlive()
            notice(if (ok) "원격 서버 연결 성공: $url" else "연결 오류: ${Clients.lastBackendError}")
            pushStatus()
        }
    }

    private fun pooled(block: () -> Unit) = ApplicationManager.getApplication().executeOnPooledThread(block)

    private fun notice(text: String) =
        post(mapOf("type" to "notice", "level" to if ("오류" in text) "error" else "info", "text" to text.lineSequence().first()))

    fun newChat() {
        workflowCancelled.set(true)
        session.reset()
        approvals.values.forEach { it.complete("deny") }
        post(mapOf("type" to "cleared"))
    }

    private fun undo() {
        val cp = session.lastCheckpoint
        if (cp == null || cp.originals.isEmpty()) {
            post(mapOf("type" to "notice", "level" to "info", "text" to "되돌릴 변경이 없습니다.")); return
        }
        val n = cp.revert(project)
        post(mapOf("type" to "notice", "level" to "info", "text" to "${n}개 파일을 이전 상태로 되돌렸습니다."))
    }

    private fun editorContext(): EditorContext {
        var ctx = EditorContext()
        ApplicationManager.getApplication().invokeAndWait {
            val fem = FileEditorManager.getInstance(project)
            val base = project.basePath ?: ""
            fun rel(path: String) = path.removePrefix("$base/")
            val editor = fem.selectedTextEditor
            val file = editor?.virtualFile ?: fem.selectedFiles.firstOrNull()
            val sel = editor?.selectionModel?.takeIf { it.hasSelection() }
            ctx = EditorContext(
                file = file?.path?.let(::rel),
                selection = sel?.selectedText,
                selectionRange = sel?.let {
                    val doc = editor.document
                    "${file?.path?.let(::rel)}:${doc.getLineNumber(it.selectionStart) + 1}-${doc.getLineNumber(it.selectionEnd) + 1}"
                },
                openFiles = fem.openFiles.map { rel(it.path) },
            )
        }
        return ctx
    }

    // ---- 첨부 파일 (이미지 · PDF · MD) → 서버에서 분석 --------------------------------------
    /** 이번 세션에서 올린 첨부 (id → 분석 결과) */
    private val attached = ConcurrentHashMap<String, Attachment>()

    private fun pickFiles() {
        val descriptor = com.intellij.openapi.fileChooser.FileChooserDescriptor(true, false, false, false, false, true)
            .withTitle("Yang Coding: 파일 첨부 (이미지 · PDF · MD)")
            .withDescription("화면 캡처·디자인 시안·PDF·MD 파일을 고르세요 (여러 개 가능, 파일당 25MB 까지)")
        com.intellij.openapi.fileChooser.FileChooser.chooseFiles(descriptor, project, null) { files ->
            pooled { files.forEach { f -> attachPath(f.toNioPath()) } }
        }
    }

    private fun attachPath(path: java.nio.file.Path) {
        val key = "h${System.nanoTime()}"
        val name = path.fileName.toString()
        try {
            if (Files.size(path) > 25L * 1024 * 1024) error("25MB 를 넘는 파일은 첨부할 수 없습니다")
            uploadAttachment(key, name, java.util.Base64.getEncoder().encodeToString(Files.readAllBytes(path)))
        } catch (e: Exception) {
            post(mapOf("type" to "attachment", "key" to key, "name" to name, "status" to "error", "detail" to (e.message ?: "읽기 실패")))
        }
    }

    /** 첨부를 서버에 올려 분석 (이미지는 비전 모델 · PDF 는 텍스트 추출 + 스캔 페이지 분석) */
    private fun uploadAttachment(key: String, name: String, data: String) {
        post(mapOf("type" to "attachment", "key" to key, "name" to name, "status" to "uploading"))
        log.line("[첨부] $name 업로드 · 분석 시작 (${"%,d".format(data.length * 3 / 4 / 1024)}KB)")
        val started = System.currentTimeMillis()
        try {
            val project = projectRoot(project)?.let { RemoteIndex.projectName(it) } ?: ""
            val res = Clients.post("/api/attachments", mapOf("name" to name, "data" to data, "project" to project), 900)
            val a = Attachment.from(res.getAsJsonObject("attachment"))
            attached[a.id] = a
            val secs = "%.1f".format((System.currentTimeMillis() - started) / 1000.0)
            val pages = if (a.kind == "pdf") " · ${a.pages}쪽" + (if (a.visionPages > 0) " (이미지 분석 ${a.visionPages}쪽)" else "") else ""
            val detail = "${"%,d".format(a.chars)}자$pages · ${secs}초" + (if (a.notes.isNotEmpty()) "\n" + a.notes.joinToString("\n") else "")
            post(mapOf("type" to "attachment", "key" to key, "name" to a.name, "status" to "ready", "id" to a.id, "kind" to a.kind, "detail" to detail))
            log.line("[첨부] ${a.name} 분석 완료 · ${detail.replace("\n", " · ")}", "result")
        } catch (e: Exception) {
            post(mapOf("type" to "attachment", "key" to key, "name" to name, "status" to "error", "detail" to (e.message ?: "실패")))
            post(mapOf("type" to "notice", "level" to "warn", "text" to "첨부 실패 ($name): ${e.message}"))
            log.line("[첨부] $name 실패: ${e.message}", "error")
        }
    }

    fun handleInput(input: String, attachmentIds: List<String> = emptyList()) {
        val text = input.trim()
        if (text.isEmpty()) return
        if ((session.running || workflowRunning.get()) && text !in setOf("/stop", "/new", "/clear")) return notice("현재 작업이 끝나거나 중단된 뒤 요청하세요.")
        val atts = attachmentIds.mapNotNull { attached[it] }
        post(mapOf("type" to "user", "text" to text, "attachments" to atts.map { it.name }))
        if (text.startsWith("/")) {
            val parts = text.split(Regex("\\s+"))
            val arg = text.removePrefix(parts[0]).trim()
            when (parts[0]) {
                "/help" -> post(mapOf("type" to "notice", "level" to "info", "text" to HELP))
                "/new", "/clear" -> newChat()
                "/stop" -> { workflowCancelled.set(true); session.stop() }
                "/undo" -> pooled { undo() }
                "/log" -> log.show()
                "/model" -> pooled {
                    val action = parts.getOrElse(1) { "" }
                    val preset = mapOf("코딩" to "coder", "coder" to "coder", "이전" to "coder-old", "30b" to "coder-old", "coder-old" to "coder-old")[action.lowercase()]
                    if (action.isNotEmpty() && preset == null) return@pooled notice(direct(ToolCall.Model(action, parts.drop(2).joinToString(" "))))
                    try {
                        if (preset == null) {
                            val list = Clients.get("/api/admin/models").getAsJsonArray("presets").joinToString("\n") {
                                val m = it.asJsonObject
                                val mark = if (m.get("active").asBoolean) "✅" else if (m.get("available").asBoolean) "⬜" else "⏳"
                                "- $mark **${m.get("label").asString}** — ${m.get("help").asString}" + if (m.get("available").asBoolean) "" else " (아직 없음)"
                            }
                            return@pooled notice("$list\n\n`/model 코딩` · `/model 이전` 으로 바꿉니다 (엔진 재시작 20~60초).")
                        }
                        val r = Clients.post("/api/admin/models", mapOf("preset" to preset))
                        notice(r.get("message").asString)
                        for (i in 0 until 60) {
                            Thread.sleep(3000)
                            val st = runCatching { Clients.get("/api/engine/status", 3) }.getOrNull()
                            if (st?.get("online")?.asBoolean == true && i > 1) {
                                return@pooled notice("모델 준비 완료: ${st.getAsJsonObject("model")?.get("model_name")?.asString ?: ""}")
                            }
                        }
                        notice("엔진이 아직 준비되지 않았습니다. 관리 페이지 → 서버 관리에서 로그를 확인하세요.")
                    } catch (e: Exception) { notice("모델 변경 실패: ${e.message}") }
                }
                "/remember" -> Protocol.parseToolCalls("<<<REMEMBER ${parts.drop(1).take(2).joinToString(" ")}\n${parts.drop(3).joinToString(" ")}\nREMEMBER>>>")
                    .firstOrNull()?.let { call -> pooled { notice(direct(call)) } }
                "/connect" -> pooled { notice(direct(ToolCall.Connect(arg))) }
                "/langchain", "/chain" -> pooled {
                    val (goal, harness) = Workflow.request(arg)
                    if (goal.isBlank()) notice("/langchain 원하는 기능 · /langchain 하네스 목표와 완료 조건")
                    else runCatching { runWorkflowTask(goal, harness, generate = true) }.onFailure { notice("워크플로 오류: ${it.message}") }
                }
                "/debug" -> { val ctx = editorContext(); pooled { session.send(DebugKit.debugPrompt(arg), ctx, atts, debug = true) } }
                "/check" -> pooled { notice(direct(ToolCall.Check)) }
                "/art" -> pooled {
                    val root = projectRoot(project) ?: return@pooled notice("프로젝트 폴더를 먼저 여세요.")
                    val parts = arg.split(Regex("\\s+"), limit = 2)
                    try {
                        post(mapOf("type" to "notice", "level" to "info", "text" to when (parts[0]) { "수정" -> "아트 컨셉 수정 중…"; "보기" -> "아트 컨셉 불러오는 중…"; else -> "프로젝트를 분석해 아트 컨셉을 만드는 중… (문서·코드·기존 그림·벡터 DB, 30초~1분)" }))
                        val md = when (parts[0]) {
                            "보기" -> Art.get(root) ?: "아직 아트 컨셉이 없습니다. `/art` 로 분석하세요."
                            "수정" -> Art.revise(root, parts.getOrElse(1) { "" })
                            else -> Art.analyze(root, arg.trim())
                        }
                        post(mapOf("type" to "notice", "level" to "info", "text" to md + "\n\n(`/art 수정 더 어둡게, 보라색 위주` 로 고치기 · `/art 보기` · `.yang/art-style.md`)"))
                    } catch (e: Exception) {
                        post(mapOf("type" to "notice", "level" to "error", "text" to "아트 컨셉 오류: ${e.message}"))
                    }
                }
                "/assets" -> {
                    val ctx = editorContext()
                    pooled {
                        val root = projectRoot(project) ?: return@pooled notice("프로젝트 폴더를 먼저 여세요.")
                        val missing = Art.missingAssets(root)
                        if (missing.isEmpty()) return@pooled notice("코드가 쓰는 그림 파일이 모두 있습니다 ✓")
                        val list = missing.take(20).joinToString("\n") { "- ${it.ref} (${it.file}:${it.line})" }
                        session.send("[그림 하네스] 코드가 쓰는데 파일이 없는 그림 ${missing.size}개:\n$list\n\n" +
                            "각 그림이 쓰이는 코드를 READ 로 확인해 용도(kind)와 크기를 정하고, 프로젝트 아트 컨셉에 맞게 IMAGE 로 그 경로에 생성하세요. " +
                            "한 응답에 최대 4개씩, 모두 만든 뒤 CHECK 로 경로 오류가 없는지 확인하세요.", ctx, atts)
                    }
                }
                "/image" -> { val ctx = editorContext(); pooled { session.send("다음 그림을 IMAGE 도구로 만들어 프로젝트에 추가하고, 필요하면 코드에서 불러오도록 연결해줘 (prompt 는 영어로):\n$arg", ctx, atts) } }
                "/play" -> pooled { notice(direct(ToolCall.Play(DebugKit.parsePlay(arg)))) }
                "/task", "/harness" -> pooled {
                    val root = projectRoot(project) ?: return@pooled notice("프로젝트 폴더를 먼저 여세요.")
                    val files = WorkspaceInfo.walkFiles(root, 4000).map { root.relativize(it).toString().replace('\\', '/') }
                    val testCmd = HarnessKit.detectTestCommand(files, Shell.isWindows)
                    val a = arg.trim()
                    if (a.isEmpty()) {
                        val hs = files.filter { it.startsWith(HarnessKit.DIR + "/") && it.endsWith(".md") }.map {
                            val (d, t) = HarnessKit.progress(java.nio.file.Files.readString(root.resolve(it))); "- `$it` $d/$t 완료"
                        }
                        val docs = files.filter { Regex("\\.(md|markdown)$", RegexOption.IGNORE_CASE).containsMatchIn(it) && !it.startsWith(".yang/") && !Regex("node_modules|CHANGELOG|LICENSE", RegexOption.IGNORE_CASE).containsMatchIn(it) }.take(15)
                        return@pooled notice("**하네스** (요구사항 md → 테스트 우선 구현, 테스트 명령: `${testCmd.ifBlank { "감지 못함" }}`)\n\n" +
                            (if (hs.isNotEmpty()) "진행 중인 하네스:\n${hs.joinToString("\n")}\n\n" else "") +
                            "사용법: `/harness docs/기능명세.md` · `/harness .yang/harness/x.md` (이어서) · `/harness 요구사항 문장`" +
                            (if (docs.isNotEmpty()) "\n\n프로젝트의 md 문서:\n${docs.joinToString("\n") { "- `$it`" }}" else ""))
                    }
                    val ctx = editorContext()
                    if (Regex("\\.(md|markdown|txt)$", RegexOption.IGNORE_CASE).containsMatchIn(a)) {
                        val rel = a.removePrefix("./")
                        val text = runCatching { java.nio.file.Files.readString(root.resolve(rel)) }.getOrNull() ?: return@pooled notice("파일이 없습니다: $a")
                        val own = rel.startsWith(HarnessKit.DIR + "/") || HarnessKit.isChecklist(text)
                        val tgt = if (own) rel else "${HarnessKit.DIR}/${HarnessKit.name(rel)}.md"
                        val resume = own || tgt in files
                        notice("하네스 시작: $a → `$tgt`${if (resume) " (이어서)" else ""} · 테스트 `${testCmd.ifBlank { "감지 못함" }}`")
                        session.send(HarnessKit.prompt(a, text, tgt, testCmd, resume), ctx, atts, harness = true)
                    } else {
                        val tgt = "${HarnessKit.DIR}/${HarnessKit.name(a.split(Regex("\\s+")).take(4).joinToString("-"))}.md"
                        session.send(HarnessKit.fromRequest(a, tgt, testCmd), ctx, atts, harness = true)
                    }
                }
                "/arch" -> pooled {
                    val root = projectRoot(project) ?: return@pooled notice("프로젝트 폴더를 먼저 여세요.")
                    val name = RemoteIndex.projectName(root)
                    val enc = java.net.URLEncoder.encode(name, Charsets.UTF_8).replace("+", "%20")
                    val local = root.resolve(".yang").resolve("architecture.md")
                    when (arg.trim()) {
                        "분석" -> {
                            notice("프로젝트를 올려 분석합니다: 코드·문서 임베딩 → 코딩 스타일 → 아키텍처 (1~3분).")
                            try {
                                val (summary, md) = RemoteIndex.analyze(root, log) { log.line("[분석] $it") }
                                if (md.isNotBlank()) runCatching { java.nio.file.Files.createDirectories(local.parent); java.nio.file.Files.writeString(local, md) }
                                notice("$summary\n\n${md.ifBlank { "(아키텍처 문서 없음)" }}")
                            } catch (e: Exception) { notice("분석 실패: ${e.message}") }
                        }
                        "저장" -> {
                            val md = runCatching { java.nio.file.Files.readString(local) }.getOrDefault("")
                            if (md.isBlank()) notice(".yang/architecture.md 가 없습니다. 먼저 /arch 로 받으세요.")
                            else { Clients.put("/api/arch/$enc", mapOf("markdown" to md)); notice("아키텍처 규칙을 저장했습니다. 다음 요청부터 적용됩니다.") }
                        }
                        else -> {
                            val r = runCatching { Clients.get("/api/arch/$enc") }.getOrNull()
                            val md = r?.get("markdown")?.takeIf { !it.isJsonNull }?.asString
                            if (md != null) runCatching { java.nio.file.Files.createDirectories(local.parent); java.nio.file.Files.writeString(local, md) }
                            val st = r?.get("status")?.takeIf { !it.isJsonNull }?.asString
                            val extra = when (st) { "analyzing" -> "\n\n(지금 다시 분석 중…)"; "error" -> "\n\n(최근 분석 실패: ${r.get("error")?.takeIf { !it.isJsonNull }?.asString})"; else -> "" }
                            notice((md ?: "아직 아키텍처 분석이 없습니다. /arch 분석 으로 시작하세요.") + extra +
                                "\n\n(/arch 분석 다시 분석 · .yang/architecture.md 를 고친 뒤 /arch 저장 하면 내 규칙으로 덮어씀)")
                        }
                    }
                }
                "/reindex" -> pooled {
                    if (Clients.remote) {
                        projectRoot(project)?.let { RemoteIndex.ensure(it, log, force = true) }
                        notice("원격 서버에서 재색인을 시작했습니다.")
                        return@pooled
                    }
                    if (session.repoName.isBlank()) notice("연결된 레포가 없습니다. 먼저 아무 요청이나 보내면 자동 연결됩니다.")
                    else { Clients.post("/api/repos/${session.repoName}/reindex", emptyMap<String, Any>(), 600); notice("${session.repoName} 재색인 완료") }
                }
                else -> post(mapOf("type" to "notice", "level" to "warn", "text" to "알 수 없는 명령: ${parts[0]} (/help)"))
            }
            return
        }
        val ctx = editorContext()
        pooled { session.send(text, ctx, atts) }
    }

    private fun runWorkflowTask(text: String, harness: Boolean, generate: Boolean = false) {
        if (session.running || !workflowRunning.compareAndSet(false, true)) error("다른 작업이 실행 중입니다")
        workflowCancelled.set(false)
        post(mapOf("type" to "busy", "busy" to true))
        try {
            val root = projectRoot(project) ?: error("프로젝트 폴더를 먼저 여세요")
            val task = if (generate) Workflow.generate(text, RemoteIndex.projectName(root), harness, { workflowCancelled.get() }, ::notice) else text
            if (workflowCancelled.get()) error("중단됨")
            val files = if (harness) WorkspaceInfo.walkFiles(root, 4000).map { root.relativize(it).toString().replace('\\', '/') } else emptyList()
            val prompt = if (harness) HarnessKit.fromRequest(task, "${HarnessKit.DIR}/workflow-${System.currentTimeMillis()}.md", HarnessKit.detectTestCommand(files, Shell.isWindows)) else task
            session.send(prompt, editorContext(), harness = harness)
            if (workflowCancelled.get()) error("사용자가 중단했습니다")
        } finally { workflowRunning.set(false); post(mapOf("type" to "busy", "busy" to false)) }
    }
}
