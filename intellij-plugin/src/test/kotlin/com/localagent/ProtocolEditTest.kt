package com.localagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolEditTest {
    @Test
    fun blankLineTolerantAndClosestSnippet() {
        val file = "class A {\n  int a = 1;\n\n  void f() {\n    print(a);\n  }\n}\n"
        val ok = Protocol.applySearchReplace(file, listOf(SearchReplace("  int a = 1;\n  void f() {", "  int a = 2;\n\n  void f() {")))
        assertEquals(1, ok.applied)
        assertTrue(ok.content.contains("int a = 2;"))
        val bad = Protocol.applySearchReplace(file, listOf(SearchReplace("  void f() {\n    print(b);\n  }", "x")))
        assertEquals(0, bad.applied)
        assertTrue(bad.failed[0], bad.failed[0].contains("가장 비슷한 부분") && bad.failed[0].contains("print(a);"))
    }
}

class ProtocolMalformedEditTest {
    @Test
    fun realMalformedModelOutput() {
        val out = "<tool_code>\n<<<EDIT lib/main.dart\n<<<<<<< SEARCH\n  void a() {}\n=======\n  void a() {}\n  void b() {}\n=======\n" +
            "<<<<<<< SEARCH\n    title: Text(x),\n=======\n    title: Text(x),\n    actions: [],\n>>>>>>> REPLACE\nEDIT>>>\n</tool_code>"
        val call = Protocol.parseToolCalls(out).single() as ToolCall.Edit
        assertEquals(2, call.blocks.size)
        assertEquals("  void a() {}\n  void b() {}", call.blocks[0].replace)
        val r = Protocol.applySearchReplace("class X {\n  void a() {}\n  Widget w() => AppBar(\n    title: Text(x),\n  );\n}", call.blocks)
        assertEquals(2, r.applied)
        assertTrue(!Regex("=======|SEARCH|REPLACE").containsMatchIn(r.content))
        val bad = Protocol.parseToolCalls("<<<EDIT a.dart\n<<<<<<< SEARCH\nfoo\nEDIT>>>").single() as ToolCall.Edit
        assertEquals(0, Protocol.applySearchReplace("foo", bad.blocks).applied)
    }
}

class ProtocolUnclosedEditTest {
    @Test
    fun unclosedEditIsApplied() {
        val calls = Protocol.parseToolCalls("<<<EDIT a.dart\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n<<<RUN flutter test>>>")
        assertEquals(listOf("edit", "run"), calls.map { it.kind })
        assertEquals("y", (calls[0] as ToolCall.Edit).blocks.single().replace)
    }
}
