package com.localagent

import org.junit.Assert.assertEquals
import org.junit.Test

class ProtocolTest {
    @Test
    fun `여러 도구를 등장 순서대로 파싱하고 본문 안 태그는 무시`() {
        val text = """먼저 확인합니다.
<<<READ src/app.py:10-20>>>
<<<GREP def total>>>
<<<FILE src/new.py
print("<<<RUN rm -rf />>>")
FILE>>>
<<<EDIT src/app.py
<<<<<<< SEARCH
a = 1
=======
a = 2
>>>>>>> REPLACE
EDIT>>>
<<<RUN npm test>>>
<<<REMEMBER constraint language:python
pydantic v2 만 사용
REMEMBER>>>
<<<MODEL download 30b>>>"""
        val calls = Protocol.parseToolCalls(text)
        assertEquals(listOf("read", "grep", "write", "edit", "run", "remember", "model"), calls.map { it.kind })
        assertEquals(ToolCall.Read("src/app.py", 10, 20), calls[0])
        assertEquals(1, calls.count { it is ToolCall.Run })
        assertEquals(ToolCall.Edit("src/app.py", listOf(SearchReplace("a = 1", "a = 2"))), calls[3])
        assertEquals(ToolCall.Remember("constraint", "language", "python", "pydantic v2 만 사용"), calls[5])
        assertEquals(ToolCall.Model("download", "30b"), calls[6])
    }

    @Test
    fun `도구가 없으면 빈 목록`() {
        assertEquals(emptyList<ToolCall>(), Protocol.parseToolCalls("완료했습니다. `<<<READ x>>>` 는 줄 맨 앞에서만 인식"))
    }

    @Test
    fun `스트리밍 중 미완성 블록 숨김`() {
        assertEquals("수정할게요.", Protocol.stripToolBlocks("수정할게요.\n<<<FILE a.py\nprint(1)"))
        assertEquals("보는 중", Protocol.stripToolBlocks("보는 중 <<"))
    }

    @Test
    fun `SEARCH REPLACE 정확 일치, 중복 거부, 들여쓰기 차이 허용`() {
        val src = "def f():\n    return 1\n\ndef g():\n    return 1\n"
        assertEquals(
            "def f():\n    return 2\n\ndef g():\n    return 1\n",
            Protocol.applySearchReplace(src, listOf(SearchReplace("def f():\n    return 1", "def f():\n    return 2"))).content,
        )
        val dup = Protocol.applySearchReplace(src, listOf(SearchReplace("    return 1", "x")))
        assertEquals(0, dup.applied)
        val ws = Protocol.applySearchReplace("if x:\n\ty = 1\n", listOf(SearchReplace("if x:\n    y = 1", "if x:\n\ty = 2")))
        assertEquals("if x:\n\ty = 2\n", ws.content)
    }

    @Test
    fun `diff 통계`() {
        assertEquals(2 to 1, Protocol.lineDiffStats("a\nb\nc", "a\nB\nc\nd"))
    }

    @Test
    fun `작업 로그 요약`() {
        assertEquals("READ a.py:3-9", Protocol.describeCall(ToolCall.Read("a.py", 3, 9)))
        assertEquals("EDIT b.py (1블록)", Protocol.describeCall(ToolCall.Edit("b.py", listOf(SearchReplace("x", "y")))))
        assertEquals("FILE c.py (2줄)", Protocol.describeCall(ToolCall.Write("c.py", "a\nb")))
    }
}
