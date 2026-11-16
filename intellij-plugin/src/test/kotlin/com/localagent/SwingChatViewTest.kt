package com.localagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.image.BufferedImage
import javax.swing.JEditorPane
import javax.swing.SwingUtilities

class SwingChatViewTest {
    @Test
    fun rendersChatEventsAndSendsMessages() {
        val sent = mutableListOf<String>()
        lateinit var view: SwingChatView
        SwingUtilities.invokeAndWait {
            view = SwingChatView { sent += it }
            val ev = listOf(
                mapOf("type" to "status", "backend" to true, "engine" to mapOf("name" to "Qwen3.6-35B-A3B"), "remote" to true, "server" to "http://mac:18010", "repo" to "gehs_mobile"),
                mapOf("type" to "user", "text" to "로그인 화면에 **비밀번호 찾기** 버튼 추가해줘"),
                mapOf("type" to "assistant-start", "id" to "a1"),
                mapOf("type" to "assistant-delta", "id" to "a1", "text" to "먼저 화면을 확인합니다."),
                mapOf("type" to "assistant-delta", "id" to "a1", "text" to "먼저 화면을 확인합니다.\n<<<READ lib/screens/login_screen.dart>>>"),
                mapOf("type" to "tool", "id" to "t1", "title" to "Read lib/screens/login_screen.dart", "status" to "done", "detail" to "48줄"),
                mapOf("type" to "tool", "id" to "t2", "title" to "Edit lib/screens/login_screen.dart", "status" to "done", "detail" to "t2", "diff" to mapOf("path" to "lib/screens/login_screen.dart", "added" to 12, "removed" to 1)),
                mapOf("type" to "approval", "reqId" to "ap1", "kind" to "run", "title" to "Run: flutter test", "detail" to "flutter test"),
                mapOf("type" to "assistant-end", "id" to "a1", "stats" to "52.8 tok/s"),
                mapOf("type" to "notice", "level" to "info", "text" to "`flutter analyze` 오류 0개"),
                mapOf("type" to "turn-end", "changedFiles" to 1),
            )
            ev.forEach { view.render(it) }
            val c = view.component
            view.render(mapOf("type" to "notice", "level" to "warn", "text" to "아주 긴 경로 lib/features/authentication/presentation/screens/very_long_screen_name_for_wrapping_test_screen.dart 와 코드\n```dart\n    final controller = TextEditingController(text: 'Hello');\n```"))
            c.setSize(460, 900)
            c.doLayout()
            fun layoutAll(x: java.awt.Component) { (x as? java.awt.Container)?.let { it.doLayout(); it.components.forEach(::layoutAll) } }
            layoutAll(c)
            val img = BufferedImage(460, 900, BufferedImage.TYPE_INT_RGB)
            val g = img.createGraphics(); c.paint(g); g.dispose()
            System.getProperty("yang.shot")?.let { javax.imageio.ImageIO.write(img, "png", java.io.File(it)) }
            // 답변 텍스트는 도구 블록을 빼고, 마지막 전체 텍스트로 (중복 없이)
            val texts = mutableListOf<String>()
            fun collect(x: java.awt.Component) { if (x is JEditorPane) texts += x.document.getText(0, x.document.length); (x as? java.awt.Container)?.components?.forEach(::collect) }
            collect(c)
            val answer = texts.first { it.contains("먼저 화면을 확인합니다") }
            assertEquals(1, Regex("먼저 화면을 확인합니다").findAll(answer).count())
            assertTrue(!answer.contains("<<<READ"))
            assertTrue(texts.any { it.contains("변경 보기 (+12 −1)") })
            assertTrue(texts.any { it.contains("명령 실행 승인") })
            // 승인 버튼 → approval 메시지
            fun find(x: java.awt.Component, label: String): javax.swing.JButton? =
                if (x is javax.swing.JButton && x.text == label) x else (x as? java.awt.Container)?.components?.firstNotNullOfOrNull { find(it, label) }
            find(c, "허용")!!.doClick()
        }
        assertTrue(sent.any { it.contains("\"approval\"") && it.contains("\"allow\"") && it.contains("ap1") })
    }

    @Test
    fun markdownBasics() {
        val h = SwingChatView.md("**굵게** `code`\n- 항목\n```dart\nvoid main() {}\n```")
        assertTrue(h.contains("<b>굵게</b>") && h.contains("<code>code</code>") && h.contains("• 항목") && h.contains("font-family:monospace") && h.contains("void main() {}"))
    }
}
