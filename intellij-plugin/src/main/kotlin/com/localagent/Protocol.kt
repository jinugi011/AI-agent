package com.localagent

/**
 * 모델 ↔ 에이전트 도구 호출 프로토콜 (VS Code 확장 protocol.ts 와 동일한 규칙).
 * IntelliJ 의존성이 없어 단위 테스트 가능.
 */
sealed class ToolCall {
    data class Read(val path: String, val start: Int? = null, val end: Int? = null) : ToolCall()
    data class ListFiles(val pattern: String) : ToolCall()
    data class Grep(val pattern: String) : ToolCall()
    data class Search(val query: String) : ToolCall()
    data class Write(val path: String, val content: String) : ToolCall()
    data class Edit(val path: String, val blocks: List<SearchReplace>) : ToolCall()
    data class Run(val command: String) : ToolCall()
    data class Remember(val memKind: String, val scope: String, val scopeValue: String, val text: String) : ToolCall()
    data class Harness(val task: String) : ToolCall()
    data class Model(val action: String, val arg: String) : ToolCall()
    data class Connect(val location: String) : ToolCall()

    val kind: String
        get() = when (this) {
            is Read -> "read"; is ListFiles -> "list"; is Grep -> "grep"; is Search -> "search"
            is Write -> "write"; is Edit -> "edit"; is Run -> "run"; is Remember -> "remember"
            is Harness -> "harness"; is Model -> "model"; is Connect -> "connect"
        }

    val readOnly: Boolean get() = this is Read || this is ListFiles || this is Grep || this is Search
}

data class SearchReplace(val search: String, val replace: String)

data class EditResult(val content: String, val applied: Int, val failed: List<String>)

object Protocol {
    val TOOL_DOCS = """## 도구 (필요할 때만, 한 응답에 여러 개 가능)
도구 블록은 줄 맨 앞에서 시작한다. 결과는 다음 메시지로 돌려준다. 도구 없이 답하면 대화 턴이 끝난다.

<<<READ path/to/file>>>            파일 읽기 (부분: <<<READ path:120-200>>>)
<<<LIST src/**/*.kt>>>             파일 목록 (glob)
<<<GREP 정규식>>>                    워크스페이스 텍스트 검색
<<<SEARCH 자연어 질의>>>             벡터 DB 에서 관련 코드·코딩 방법 검색
<<<FILE path/to/file
전체 파일 내용
FILE>>>                            파일 생성/전체 교체 (새 파일 또는 작은 파일)
<<<EDIT path/to/file
<<<<<<< SEARCH
기존 코드 (파일과 글자 그대로 일치, 고유해야 함)
=======
바꿀 코드
>>>>>>> REPLACE
EDIT>>>                            부분 수정 (큰 파일은 반드시 EDIT 사용, SEARCH/REPLACE 쌍 여러 개 가능)
<<<RUN 셸 명령>>>                    터미널 명령 실행 (테스트, 빌드, git 등. 사용자 승인 필요)
<<<REMEMBER 종류 범위
내용
REMEMBER>>>                        사용자 스타일/선호/제약을 영구 저장. 종류: style|preference|constraint,
                                   범위: global | language:python | profile:flutter | project
<<<HARNESS
요구사항
HARNESS>>>                         요구사항→테스트 하네스→구현→테스트 반복을 새 브랜치에서 자동 수행 (큰 기능 구현 시)
<<<MODEL list|status|download <key>|start [key]|stop>>>   로컬 모델 관리
<<<CONNECT 경로 또는 git URL>>>      다른 레포 연결 + 벡터화"""

    private val SIMPLE_RE = Regex("""^<<<(READ|LIST|GREP|SEARCH|RUN|MODEL|CONNECT)[ \t]+([^\n]*?)>>>[ \t]*$""", RegexOption.MULTILINE)
    private val FILE_RE = Regex("""^<<<FILE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^FILE>>>""", RegexOption.MULTILINE)
    private val EDIT_RE = Regex("""^<<<EDIT[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^EDIT>>>""", RegexOption.MULTILINE)
    private val REMEMBER_RE = Regex("""^<<<REMEMBER[ \t]*([^\n]*)\n([\s\S]*?)\n?^REMEMBER>>>""", RegexOption.MULTILINE)
    private val HARNESS_RE = Regex("""^<<<HARNESS[ \t]*\n([\s\S]*?)\n?^HARNESS>>>""", RegexOption.MULTILINE)
    private val SR_RE = Regex("""<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE""")
    private val RANGE_RE = Regex("""^(.*?):(\d+)-(\d+)$""")

    private fun cleanPath(p: String) = p.trim().trim('"', '\'', '`').removePrefix("./")

    /** 응답 텍스트에서 도구 호출을 등장 순서대로 추출한다. 본문 블록 안의 태그는 무시. */
    fun parseToolCalls(text: String): List<ToolCall> {
        val found = mutableListOf<Pair<Int, ToolCall>>()
        val bodies = listOf(FILE_RE, EDIT_RE, REMEMBER_RE, HARNESS_RE)
            .flatMap { re -> re.findAll(text).map { it.range.first to it.range.last } }
        fun insideOther(i: Int) = bodies.any { (s, e) -> i > s && i <= e }

        for (m in SIMPLE_RE.findAll(text)) {
            val (tag, raw) = m.destructured
            val arg = raw.trim()
            val call: ToolCall = when (tag) {
                "READ" -> RANGE_RE.find(arg)?.let {
                    ToolCall.Read(cleanPath(it.groupValues[1]), it.groupValues[2].toInt(), it.groupValues[3].toInt())
                } ?: ToolCall.Read(cleanPath(arg))
                "LIST" -> ToolCall.ListFiles(arg.ifEmpty { "**/*" })
                "GREP" -> ToolCall.Grep(arg)
                "SEARCH" -> ToolCall.Search(arg)
                "RUN" -> ToolCall.Run(arg)
                "CONNECT" -> ToolCall.Connect(arg)
                else -> {
                    val parts = arg.split(Regex("\\s+")).filter { it.isNotEmpty() }
                    ToolCall.Model((parts.firstOrNull() ?: "status").lowercase(), parts.drop(1).joinToString(" "))
                }
            }
            found += m.range.first to call
        }
        for (m in FILE_RE.findAll(text)) found += m.range.first to ToolCall.Write(cleanPath(m.groupValues[1]), m.groupValues[2])
        for (m in EDIT_RE.findAll(text)) {
            val blocks = SR_RE.findAll(m.groupValues[2]).map { SearchReplace(it.groupValues[1], it.groupValues[2]) }.toList()
            found += m.range.first to ToolCall.Edit(cleanPath(m.groupValues[1]), blocks)
        }
        for (m in REMEMBER_RE.findAll(text)) {
            val head = m.groupValues[1].trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            val kind = head.getOrElse(0) { "preference" }
            val scopeRaw = head.getOrElse(1) { "global" }
            val scope = scopeRaw.substringBefore(':')
            val scopeValue = if (':' in scopeRaw) scopeRaw.substringAfter(':') else ""
            found += m.range.first to ToolCall.Remember(kind, scope, scopeValue, m.groupValues[2].trim())
        }
        for (m in HARNESS_RE.findAll(text)) found += m.range.first to ToolCall.Harness(m.groupValues[1].trim())

        return found.filter { !insideOther(it.first) }.sortedBy { it.first }.map { it.second }
    }

    /** 채팅 표시용: 도구 블록 제거 + 스트리밍 중 미완성 블록 숨김. */
    fun stripToolBlocks(text: String): String {
        var out = text
        for (re in listOf(FILE_RE, EDIT_RE, REMEMBER_RE, HARNESS_RE, SIMPLE_RE)) out = re.replace(out, "")
        Regex("^<<<[A-Z]*", RegexOption.MULTILINE).find(out)?.let { out = out.substring(0, it.range.first) }
        out = out.replace(Regex("<{1,3}$"), "")
        return out.replace(Regex("\n{3,}"), "\n\n").trim()
    }

    /** SEARCH/REPLACE 적용. 정확히 일치 → 줄 단위 trim 일치 순으로 시도. */
    fun applySearchReplace(original: String, blocks: List<SearchReplace>): EditResult {
        var content = original
        var applied = 0
        val failed = mutableListOf<String>()
        for ((search, replace) in blocks) {
            if (search.isEmpty()) {
                content += (if (content.isEmpty() || content.endsWith("\n")) "" else "\n") + replace + "\n"
                applied++
                continue
            }
            val idx = content.indexOf(search)
            if (idx != -1) {
                if (content.indexOf(search, idx + 1) != -1) {
                    failed += "SEARCH 블록이 여러 곳과 일치합니다(고유하지 않음):\n${search.take(200)}"
                    continue
                }
                content = content.substring(0, idx) + replace + content.substring(idx + search.length)
                applied++
                continue
            }
            val lines = content.split("\n").toMutableList()
            val needle = search.split("\n").map { it.trim() }
            var hit = -1
            for (i in 0..(lines.size - needle.size)) {
                if (needle.indices.all { j -> lines[i + j].trim() == needle[j] }) {
                    if (hit != -1) { hit = -2; break }
                    hit = i
                }
            }
            if (hit >= 0) {
                repeat(needle.size) { lines.removeAt(hit) }
                lines.addAll(hit, replace.split("\n"))
                content = lines.joinToString("\n")
                applied++
            } else {
                failed += "SEARCH 블록을 파일에서 찾지 못했습니다:\n${search.take(200)}"
            }
        }
        return EditResult(content, applied, failed)
    }

    fun lineDiffStats(before: String, after: String): Pair<Int, Int> {
        val a = if (before.isEmpty()) emptyList() else before.split("\n")
        val b = if (after.isEmpty()) emptyList() else after.split("\n")
        val count = HashMap<String, Int>()
        a.forEach { count[it] = (count[it] ?: 0) + 1 }
        var common = 0
        for (l in b) {
            val c = count[l] ?: 0
            if (c > 0) { common++; count[l] = c - 1 }
        }
        return (b.size - common) to (a.size - common)
    }
}
