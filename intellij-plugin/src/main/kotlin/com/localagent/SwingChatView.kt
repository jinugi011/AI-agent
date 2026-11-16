package com.localagent

import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.event.HyperlinkEvent

/**
 * 내장 브라우저(JCEF)가 없는 IDE(Android Studio 기본 런타임 등)용 채팅 화면.
 * JCEF 화면(chat.js)과 같은 이벤트를 받아 Swing 으로 그리고, 입력·승인은 같은 JSON 메시지로 돌려준다.
 */
class SwingChatView(private val send: (String) -> Unit) {
    /** 창 너비를 따라가는 세로 목록: 항목마다 너비를 창에 맞추고 그 너비에서의 높이로 쌓는다 (긴 줄은 줄바꿈, 잘림 없음) */
    private class StackPanel : JPanel(), javax.swing.Scrollable {
        init {
            border = JBUI.Borders.empty(6, 8)
            layout = object : java.awt.LayoutManager {
                override fun addLayoutComponent(name: String?, comp: java.awt.Component?) {}
                override fun removeLayoutComponent(comp: java.awt.Component?) {}
                override fun minimumLayoutSize(p: java.awt.Container) = preferredLayoutSize(p)
                override fun preferredLayoutSize(p: java.awt.Container): Dimension {
                    val w = width(p)
                    var h = p.insets.top + p.insets.bottom
                    for (c in p.components) h += heightAt(c, w) + GAP
                    return Dimension(w + p.insets.left + p.insets.right, h)
                }
                override fun layoutContainer(p: java.awt.Container) {
                    val w = width(p)
                    var y = p.insets.top
                    for (c in p.components) {
                        val h = heightAt(c, w)
                        c.setBounds(p.insets.left, y, w, h)
                        y += h + GAP
                    }
                }
            }
        }
        private fun width(p: java.awt.Container): Int {
            val vw = (p.parent as? javax.swing.JViewport)?.width ?: p.width
            return maxOf(50, vw - p.insets.left - p.insets.right)
        }
        private fun heightAt(c: java.awt.Component, w: Int): Int {
            c.setSize(w, 100_000)
            (c as? java.awt.Container)?.doLayout()
            return c.preferredSize.height
        }
        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
        override fun getScrollableUnitIncrement(r: java.awt.Rectangle, o: Int, d: Int) = 16
        override fun getScrollableBlockIncrement(r: java.awt.Rectangle, o: Int, d: Int) = r.height - 32
        override fun getScrollableTracksViewportWidth() = true
        override fun getScrollableTracksViewportHeight() = false
        companion object { val GAP = JBUI.scale(6) }
    }

    private val list = StackPanel()
    private val scroll = JBScrollPane(list).apply {
        verticalScrollBar.unitIncrement = 16
        horizontalScrollBarPolicy = javax.swing.ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
        border = JBUI.Borders.empty()
        viewport.addChangeListener { list.revalidate() }
    }
    private val status = JLabel("연결 확인 중…").apply { border = JBUI.Borders.empty(4, 8); foreground = JBColor.GRAY }
    private val input = JBTextArea(3, 20).apply {
        lineWrap = true; wrapStyleWord = true
        emptyText.text = "요청을 입력하세요 (Enter 보내기 · Shift+Enter 줄바꿈 · /help)"
    }
    private val sendBtn = JButton("보내기")
    private val workMode = javax.swing.JComboBox(arrayOf("일반 코딩", "자연어 하네스", "LangChain 구현", "LangChain 하네스")).apply { toolTipText = "작업 방식" }
    private val stopBtn = JButton("중단").apply { isEnabled = false }
    private val assistants = HashMap<String, Pair<JEditorPane, StringBuilder>>()
    private val tools = HashMap<String, JEditorPane>()
    private val gson = Clients.gson
    private val pendingAtts = mutableListOf<String>()

    val component: JComponent = JPanel(BorderLayout()).apply {
        add(status, BorderLayout.NORTH)
        add(scroll, BorderLayout.CENTER)
        val bottom = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(6)
            add(workMode, BorderLayout.NORTH)
            add(JBScrollPane(input).apply { preferredSize = Dimension(100, JBUI.scale(72)) }, BorderLayout.CENTER)
            add(JPanel(FlowLayout(FlowLayout.RIGHT, 4, 2)).apply {
                add(JButton("첨부").apply { toolTipText = "이미지 · PDF · MD 파일 첨부"; addActionListener { msg("pickFiles") } })
                add(JButton("새 대화").apply { addActionListener { msg("new") } })
                add(stopBtn); add(sendBtn)
            }, BorderLayout.SOUTH)
        }
        add(bottom, BorderLayout.SOUTH)
    }

    init {
        sendBtn.addActionListener { submit() }
        stopBtn.addActionListener { msg("stop") }
        input.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) { e.consume(); submit() }
            }
        })
        add(html("<b>Yang Coding</b> — 자연어로 요청하세요. <code>/help</code> 로 명령을 볼 수 있습니다.<br>" +
            "<span style='color:gray'>(이 IDE 에는 내장 브라우저가 없어 기본 화면으로 표시합니다)</span>"))
    }

    private fun msg(type: String, vararg kv: Pair<String, Any?>) = send(gson.toJson(mapOf("type" to type) + kv.toMap()))

    private fun submit() {
        val text = input.text.trim()
        if (text.isEmpty() && pendingAtts.isEmpty()) return
        input.text = ""
        val prefix = if (text.startsWith("/")) "" else listOf("", "/harness ", "/langchain ", "/langchain 하네스 ")[workMode.selectedIndex]
        msg("send", "text" to prefix + text.ifEmpty { "첨부한 파일을 분석해서 무엇을 만들 수 있는지 정리해 주세요." }, "attachments" to pendingAtts.toList())
        pendingAtts.clear()
    }

    /** chat.js 와 같은 이벤트 처리 (어느 스레드에서 와도 EDT 에서 그림) */
    fun render(m: Map<String, Any?>) {
        if (!SwingUtilities.isEventDispatchThread()) { ApplicationManager.getApplication().invokeLater { render(m) }; return }
        fun s(k: String) = m[k]?.toString() ?: ""
        when (s("type")) {
            "status" -> {
                val eng = m["engine"] as? Map<*, *>
                status.text = buildString {
                    append(if (m["backend"] == true) "● 서버 연결됨" else "○ 서버 연결 안 됨")
                    if (eng != null) append(" · ${eng["name"]}")
                    if (m["remote"] == true) append(" · 원격 ${s("server")}")
                    if (s("repo").isNotEmpty()) append(" · ${s("repo")}")
                    if (s("error").isNotEmpty()) append(" · ${s("error")}")
                }
                status.foreground = if (m["backend"] == true) JBColor(Color(0x2E7D32), Color(0x81C784)) else JBColor.RED
            }
            "user" -> add(html("<div style='background:${bg(0.08)};padding:6px'><b>나</b><br>${md(s("text"))}</div>"))
            "attachment" -> {
                val label = when (s("status")) { "uploading" -> "분석 중…"; "ready" -> "준비됨 (다음 요청에 함께 보냄)"; else -> "오류 ${s("detail")}" }
                if (s("status") == "ready") pendingAtts += s("id")
                add(html("📎 ${esc(s("name"))} <span style='color:gray'>${esc(label)}</span>"))
            }
            "assistant-start" -> {
                val pane = html("<i style='color:gray'>생각 중…</i>")
                assistants[s("id")] = pane to StringBuilder()
                add(pane)
            }
            "assistant-delta" -> assistants[s("id")]?.let { (pane, sb) ->
                sb.setLength(0); sb.append(s("text")) // 지금까지의 전체 답변이 온다
                pane.text = wrap(md(Protocol.stripToolBlocks(sb.toString())))
                scrollDown()
            }
            "assistant-end" -> assistants[s("id")]?.let { (pane, sb) ->
                val body = md(Protocol.stripToolBlocks(sb.toString()))
                pane.text = wrap(body + if (s("stats").isNotEmpty()) "<div style='color:gray;font-size:90%'>${esc(s("stats"))}</div>" else "")
            }
            "tool" -> {
                val icon = when (s("status")) { "running" -> "⏳"; "done" -> "✅"; "error" -> "❌"; "denied" -> "🚫"; else -> "•" }
                val detail = s("detail").take(600)
                val diff = m["diff"] as? Map<*, *>
                val text = "<span style='font-family:monospace'>$icon ${brk(esc(s("title")))}</span>" +
                    (if (diff != null) " <a href='diff:${s("detail")}|${diff["path"]}'>변경 보기 (+${num(diff["added"])} −${num(diff["removed"])})</a>" else "") +
                    (if (detail.isNotEmpty() && diff == null) "<div style='color:gray;font-family:monospace;font-size:90%'>${brk(esc(detail)).replace("\n", "<br>")}</div>" else "")
                val pane = tools[s("id")]
                if (pane == null) tools[s("id")] = html(text).also { add(it) } else pane.text = wrap(text)
                scrollDown()
            }
            "approval" -> add(approvalCard(s("reqId"), s("kind"), s("title"), s("detail")))
            "turn-end" -> {
                val n = (m["changedFiles"] as? Number)?.toInt() ?: 0
                if (n > 0) add(html("${n}개 파일 변경됨 · <a href='undo:'>되돌리기</a>"))
            }
            "notice" -> {
                val color = when (s("level")) { "error" -> "#d32f2f"; "warn" -> "#ef6c00"; else -> "gray" }
                add(html("<div style='border-left:3px solid $color;padding-left:6px'>${md(s("text"))}</div>"))
            }
            "busy" -> { val b = m["busy"] == true; stopBtn.isEnabled = b; sendBtn.isEnabled = !b }
            "cleared" -> { list.removeAll(); assistants.clear(); tools.clear(); list.revalidate(); list.repaint() }
        }
    }

    private fun approvalCard(reqId: String, kind: String, title: String, detail: String): JComponent {
        val head = when (kind) { "run" -> "명령 실행 승인"; "files" -> "파일·폴더 삭제/이동 승인"; "index" -> "프로젝트 분석·임베딩 승인"; else -> "파일 수정 승인" }
        val card = object : JPanel(BorderLayout()) {
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
        }.apply {
            border = JBUI.Borders.compound(JBUI.Borders.customLine(JBColor.ORANGE, 1), JBUI.Borders.empty(6))
            alignmentX = 0f
        }
        card.add(html("<b>$head</b><br><span style='font-family:monospace'>${esc(title)}</span>" +
            (if (detail.isNotBlank() && detail != title) "<br><span style='color:gray'>${esc(detail.take(800)).replace("\n", "<br>")}</span>" else "")), BorderLayout.CENTER)
        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 4, 2))
        fun answer(a: String, label: String) = JButton(label).apply {
            addActionListener {
                msg("approval", "reqId" to reqId, "answer" to a)
                buttons.components.forEach { it.isEnabled = false }
                buttons.add(JLabel(if (a == "deny") "  거부함" else "  허용함"))
                buttons.revalidate()
            }
        }
        buttons.add(answer("allow", "허용")); buttons.add(answer("always", "항상 허용")); buttons.add(answer("deny", "거부"))
        card.add(buttons, BorderLayout.SOUTH)
        return card
    }

    private fun add(c: JComponent) {
        list.add(c)
        list.revalidate()
        scrollDown()
    }

    private fun scrollDown() = SwingUtilities.invokeLater { scroll.verticalScrollBar.value = scroll.verticalScrollBar.maximum }

    /** 세로로 늘어나지 않게 (BoxLayout 에서 항목 사이가 벌어지지 않도록) 선호 높이로 고정 */
    private class Pane : JEditorPane() {
        override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
    }

    private fun html(body: String): JEditorPane = Pane().apply {
        contentType = "text/html"
        text = wrap(body)
        isEditable = false
        isOpaque = false
        putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, true)
        font = UIUtil.getLabelFont()
        addHyperlinkListener { e ->
            if (e.eventType != HyperlinkEvent.EventType.ACTIVATED) return@addHyperlinkListener
            val d = e.description ?: return@addHyperlinkListener
            when {
                d.startsWith("undo:") -> msg("undo")
                d.startsWith("diff:") -> d.removePrefix("diff:").split("|", limit = 2).let { msg("openDiff", "id" to it[0], "path" to it.getOrElse(1) { "" }) }
                d.startsWith("file:") -> msg("openFile", "path" to d.removePrefix("file:"))
                else -> runCatching { com.intellij.ide.BrowserUtil.browse(d) }
            }
        }
    }

    private fun wrap(body: String) = "<html><body style='font-family:${UIUtil.getLabelFont().family};font-size:${UIUtil.getLabelFont().size}pt'>$body</body></html>"
    @Suppress("UNUSED_PARAMETER")
    private fun bg(alpha: Double) = if (JBColor.isBright()) "#eef2f7" else "#2b3240"
    private fun num(v: Any?) = (v as? Number)?.toInt() ?: 0

    companion object {
        fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        /** 긴 경로·식별자도 줄바꿈되게 / . _ 뒤에 줄바꿈 가능 지점 (보이지 않는 공백) */
        fun brk(s: String) = s.replace(Regex("\\S{40,}")) { m ->
            // Swing HTML 은 공백에서만 줄을 바꾼다 → 아주 긴 경로·식별자는 / . _ 뒤(없으면 24자마다)에 얇은 공백을 넣는다
            val parts = m.value.split(Regex("(?<=[/._])"))
            val chunks = parts.flatMap { p -> if (p.length > 24) p.chunked(24) else listOf(p) }
            chunks.joinToString("\u2009")
        }

        /** 간단한 마크다운 → HTML (코드 블록 · 인라인 코드 · 굵게 · 목록 · 줄바꿈) */
        fun md(src: String): String {
            val out = StringBuilder()
            val parts = src.split("```")
            parts.forEachIndexed { i, part ->
                if (i % 2 == 1) {
                    val code = part.substringAfter('\n', part)
                    out.append("<div style='font-family:monospace;font-size:90%;padding:4px'>").append(code.trimEnd().lines().joinToString("<br>") { l -> val n = l.length - l.trimStart().length; "&nbsp;".repeat(n) + brk(esc(l.trimStart())) }).append("</div>")
                } else {
                    val html = brk(esc(part))
                        .replace(Regex("`([^`\n]+)`"), "<code>$1</code>")
                        .replace(Regex("\\*\\*([^*\n]+)\\*\\*"), "<b>$1</b>")
                        .replace(Regex("(?m)^#{1,6} (.+)$"), "<b>$1</b>")
                        .replace(Regex("(?m)^\\s*[-*] "), "• ")
                        .replace("\n", "<br>")
                    out.append(html)
                }
            }
            return out.toString()
        }
    }
}
