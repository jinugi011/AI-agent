package com.localagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HarnessKitTest {
    @Test
    fun semanticWorkflowInput() {
        assertEquals("주문 취소\n배송 중 취소 불가" to true, Workflow.request("하네스 주문 취소\n배송 중 취소 불가"))
        assertEquals("로그인 기능" to false, Workflow.request("로그인 기능"))
        assertTrue(HarnessKit.fromRequest("재고 한 번만 복구", ".yang/harness/order.md", "npm test").contains("Given/When/Then"))
    }
    @Test
    fun testCommandAndChecklist() {
        assertEquals("flutter test", HarnessKit.detectTestCommand(listOf("pubspec.yaml")))
        assertEquals("./gradlew test", HarnessKit.detectTestCommand(listOf("build.gradle.kts", "gradlew")))
        assertEquals(".\\gradlew.bat test", HarnessKit.detectTestCommand(listOf("build.gradle.kts", "gradlew.bat"), true))
        assertEquals("주문-취소-명세", HarnessKit.name("docs/주문 취소 명세.md"))
        val md = "- [x] R1\n- [ ] R2\n  - [ ] R3\n"
        assertTrue(HarnessKit.isChecklist(md))
        assertEquals(1 to 3, HarnessKit.progress(md))
        assertTrue(HarnessKit.prompt("a.md", "x", ".yang/harness/a.md", "", true).contains("남은 항목부터"))
        assertTrue(Protocol.parseToolCalls("<<<ANALYZE>>>").single() is ToolCall.Analyze)
    }

    @Test
    fun styleSibling() {
        val files = listOf("src/main/kotlin/com/ehs/incident/controller/IncidentController.kt", "src/main/kotlin/com/ehs/incident/service/IncidentService.kt",
            "lib/features/report/report_screen.dart", "test/report_bloc_test.dart", "lib/features/report/report_bloc.dart")
        assertEquals("src/main/kotlin/com/ehs/incident/controller/IncidentController.kt",
            WorkspaceInfo.pickStyleSibling("src/main/kotlin/com/ehs/order/controller/OrderController.kt", files))
        assertEquals("lib/features/report/report_screen.dart", WorkspaceInfo.pickStyleSibling("lib/features/order/order_screen.dart", files))
        assertEquals("test/report_bloc_test.dart", WorkspaceInfo.pickStyleSibling("test/order_bloc_test.dart", files))
        assertNull(WorkspaceInfo.pickStyleSibling("README.md", files))
    }
}
