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
- `/model [status|download <key>|start [key]|stop]`
- `/remember <style|preference|constraint> <global|language:x|profile:x|project> 내용`
- `/task 요구사항` → 하네스(테스트 우선) 자동 구현 · `/connect 경로|URL` · `/reindex`

**원격 모드**에서는 하네스·레포 연결·모델 다운로드/시작이 서버 보안상 막혀 있습니다 (읽기·수정·명령 실행·선호 저장은 가능)."""

/** Yang Coding 툴 윈도우: JCEF 로 채팅 UI(VS Code 확장과 동일한 chat.js/css)를 띄우고 세션과 연결한다. */
class ChatPanel(private val project: Project) : Disposable {
    companion object {
        val instances = ConcurrentHashMap<Project, ChatPanel>()
    }

    val component: JComponent
    private val browser: JBCefBrowser?
    private val query: JBCefJSQuery?
    private val approvals = ConcurrentHashMap<String, CompletableFuture<String>>()
    private val pending = mutableListOf<String>()
    @Volatile private var ready = false
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "local-agent-status").apply { isDaemon = true } }
    private val log = AgentLogService.of(project)
    private val session = AgentSession(project, ::post, ::askApproval, log)

    init {
        instances[project] = this
        if (!JBCefApp.isSupported()) {
            browser = null
            query = null
            component = JPanel(BorderLayout()).apply {
                add(JLabel("이 IDE 에서는 JCEF(내장 브라우저)를 사용할 수 없습니다. JetBrains Runtime 으로 실행하세요.", SwingConstants.CENTER))
            }
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
    }

    override fun dispose() {
        instances.remove(project, this)
        session.stop()
        scheduler.shutdownNow()
        approvals.values.forEach { it.complete("deny") }
    }

    // ---- Kotlin → 웹뷰 -----------------------------------------------------------
    private fun post(msg: Map<String, Any?>) {
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
            "server" to if (Clients.remote) AgentSettings.current.serverUrl else "",
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
</head><body>
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
    private fun askApproval(kind: String, title: String, detail: String): String {
        val reqId = "ap${System.nanoTime()}"
        val future = CompletableFuture<String>()
        approvals[reqId] = future
        post(mapOf("type" to "approval", "reqId" to reqId, "kind" to kind, "title" to title, "detail" to detail))
        return try { future.get() } finally { approvals.remove(reqId) }
    }

    // ---- 웹뷰 → Kotlin -----------------------------------------------------------
    private fun onMessage(raw: String) {
        val m = JsonParser.parseString(raw).asJsonObject
        fun s(k: String) = m.get(k)?.takeIf { !it.isJsonNull }?.asString ?: ""
        when (s("type")) {
            "ready" -> {
                val queued = synchronized(pending) { ready = true; pending.toList().also { pending.clear() } }
                queued.forEach { exec("window.dispatchEvent(new MessageEvent('message', {data: $it}));") }
                pooled { BackendLauncher.ensureRunning(project.basePath)?.let { post(mapOf("type" to "notice", "level" to "warn", "text" to it)) } }
            }
            "send" -> handleInput(s("text"))
            "stop" -> session.stop()
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
            "configureRemote" -> ApplicationManager.getApplication().invokeLater {
                com.intellij.openapi.options.ShowSettingsUtil.getInstance().showSettingsDialog(project, AgentConfigurable::class.java)
            }
        }
    }

    /** 승인 없이 도구 하나를 바로 실행 (슬래시 명령·설정 카드) + 작업 로그 기록 */
    private fun direct(call: ToolCall): String {
        log.line("▶ (직접 실행) " + Protocol.describeCall(call), "tool")
        val result = session.runDirect(call)
        log.line(result.lines().joinToString("\n") { "    $it" }, if ("오류" in result) "error" else "result")
        return result
    }

    private fun pooled(block: () -> Unit) = ApplicationManager.getApplication().executeOnPooledThread(block)

    private fun notice(text: String) =
        post(mapOf("type" to "notice", "level" to if ("오류" in text) "error" else "info", "text" to text.lineSequence().first()))

    fun newChat() {
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

    fun handleInput(input: String) {
        val text = input.trim()
        if (text.isEmpty()) return
        post(mapOf("type" to "user", "text" to text))
        if (text.startsWith("/")) {
            val parts = text.split(Regex("\\s+"))
            val arg = parts.drop(1).joinToString(" ")
            when (parts[0]) {
                "/help" -> post(mapOf("type" to "notice", "level" to "info", "text" to HELP))
                "/new", "/clear" -> newChat()
                "/stop" -> session.stop()
                "/undo" -> pooled { undo() }
                "/log" -> log.show()
                "/model" -> pooled { notice(direct(ToolCall.Model(parts.getOrElse(1) { "status" }, parts.drop(2).joinToString(" ")))) }
                "/remember" -> Protocol.parseToolCalls("<<<REMEMBER ${parts.drop(1).take(2).joinToString(" ")}\n${parts.drop(3).joinToString(" ")}\nREMEMBER>>>")
                    .firstOrNull()?.let { call -> pooled { notice(direct(call)) } }
                "/connect" -> pooled { notice(direct(ToolCall.Connect(arg))) }
                "/task" -> { val ctx = editorContext(); pooled { session.send("다음 요구사항을 HARNESS 도구로 구현해줘:\n$arg", ctx) } }
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
        pooled { session.send(text, ctx) }
    }
}
