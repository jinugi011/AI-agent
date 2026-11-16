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
    data class Analyze(val path: String) : ToolCall()
    object Check : ToolCall()
    data class Play(val req: PlayRequest) : ToolCall()
    data class Image(val path: String, val fields: Map<String, String>) : ToolCall()
    data class Delete(val path: String) : ToolCall()
    data class Move(val from: String, val to: String) : ToolCall()
    data class Mkdir(val path: String) : ToolCall()

    val kind: String
        get() = when (this) {
            is Read -> "read"; is ListFiles -> "list"; is Grep -> "grep"; is Search -> "search"
            is Write -> "write"; is Edit -> "edit"; is Run -> "run"; is Remember -> "remember"
            is Harness -> "harness"; is Model -> "model"; is Connect -> "connect"; is Analyze -> "analyze"
            is Check -> "check"; is Play -> "play"; is Image -> "image"
            is Delete -> "delete"; is Move -> "move"; is Mkdir -> "mkdir"
        }

    val readOnly: Boolean get() = this is Read || this is ListFiles || this is Grep || this is Search || this is Check
}

data class SearchReplace(val search: String, val replace: String)

data class EditResult(val content: String, val applied: Int, val failed: List<String>)

object Protocol {
    val TOOL_DOCS = """## 도구 (필요할 때만, 한 응답에 여러 개 가능)
도구 블록은 줄 맨 앞에서 시작한다. 결과는 다음 메시지로 돌려준다. 도구 없이 답하면 대화 턴이 끝난다.

<<<READ path/to/file>>>            파일 읽기 (부분: <<<READ path:120-200>>>)
<<<LIST src/**/*.kt>>>             파일 찾기 (glob)
<<<LIST src/main>>>                 폴더 한 단계 보기 (폴더는 / 로 끝남 · LIST . = 최상위)
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
<<<RUN 셸 명령>>>                    터미널 명령 실행 (테스트, 빌드, git 등. 사용자 승인 필요. Windows 는 PowerShell)
<<<DELETE path>>>                   파일·폴더 삭제 (승인 필요 · 파일은 /undo 로 복구, 폴더는 휴지통)
<<<MOVE 원래경로 -> 새경로>>>         파일·폴더 이동/이름 바꾸기 (승인 필요 · /undo 가능)
<<<MKDIR path>>>                    폴더 만들기
(파일 삭제·이동·폴더 생성은 RUN 의 rm/mv/mkdir 대신 위 도구를 쓴다: Windows·macOS 모두 동작)
<<<REMEMBER 종류 범위
내용
REMEMBER>>>                        사용자 스타일/선호/제약을 영구 저장. 종류: style|preference|constraint,
                                   범위: global | language:python | profile:flutter | project
<<<HARNESS
요구사항
HARNESS>>>                         요구사항→테스트 하네스→구현→테스트 반복을 새 브랜치에서 자동 수행 (큰 기능 구현 시)
<<<MODEL list|status|download <key>|start [key]|stop>>>   로컬 모델 관리
<<<ANALYZE>>>                       프로젝트 전체 분석: 코드·문서를 임베딩하고 코딩 스타일·아키텍처 문서를 새로 만든다 (승인 필요, 1~3분).
                                   구조를 모르거나 아키텍처 규칙이 없을 때, 큰 구조 변경 뒤에 쓴다. 결과로 아키텍처 문서를 돌려준다.
<<<CONNECT git URL 또는 다른 폴더>>>  작업 폴더 밖의 다른 레포를 벡터화 (작업 폴더는 이미 연결됨 → 쓰지 말 것)
""" + DebugKit.PLAY_DOC + "\n" + DebugKit.IMAGE_DOC

    private val SIMPLE_RE = Regex("""^<<<(READ|LIST|GREP|SEARCH|RUN|MODEL|CONNECT|ANALYZE|CHECK|PLAY|DELETE|MOVE|MKDIR)(?:[ \t]+([^\n]*?))?>>>[ \t]*$""", RegexOption.MULTILINE)
    private val FILE_RE = Regex("""^<<<FILE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^FILE>>>""", RegexOption.MULTILINE)
    private val EDIT_RE = Regex("""^<<<EDIT[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^EDIT>>>""", RegexOption.MULTILINE)
    private val REMEMBER_RE = Regex("""^<<<REMEMBER[ \t]*([^\n]*)\n([\s\S]*?)\n?^REMEMBER>>>""", RegexOption.MULTILINE)
    private val HARNESS_RE = Regex("""^<<<HARNESS[ \t]*\n([\s\S]*?)\n?^HARNESS>>>""", RegexOption.MULTILINE)
    private val IMAGE_RE = Regex("""^<<<IMAGE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^IMAGE>>>""", RegexOption.MULTILINE)


    private val SR_RE = Regex("""<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE""")
    private val RANGE_RE = Regex("""^(.*?):(\d+)-(\d+)$""")

    private fun cleanPath(p: String) = p.trim().trim('"', '\'', '`').removePrefix("./")

    /** 응답 텍스트에서 도구 호출을 등장 순서대로 추출한다. 본문 블록 안의 태그는 무시. */
    /** 모델이 도구 블록을 엉뚱한 태그로 감싸는 경우 정리 (<tool_code> … </tool_code> 등) */
    fun normalizeToolText(text: String) = closeOpenEdits(text.replace(Regex("</?tool_(code|call)>"), "\n"))

    /** 닫는 줄 EDIT>>> 를 빠뜨린 EDIT 블록을 닫아 준다 (FILE 은 잘린 파일일 수 있어 닫지 않음) */
    fun closeOpenEdits(text: String): String {
        val out = mutableListOf<String>()
        var open = false
        for (line in text.split("\n")) {
            if (open && Regex("^<<<[A-Z]").containsMatchIn(line)) { out += "EDIT>>>"; open = false }
            if (Regex("^<<<EDIT[ \t]+\\S").containsMatchIn(line)) open = true
            else if (Regex("^EDIT>>>\\s*$").matches(line)) open = false
            out += line
        }
        if (open) out += "EDIT>>>"
        return out.joinToString("\n")
    }

    private const val FORMAT_MARK = "\u0000FORMAT\u0000"

    /** EDIT 본문의 SEARCH/REPLACE 블록을 줄 단위로 읽는다 (VS Code parseSearchReplace 와 같은 규칙, 흔한 형식 실수 허용) */
    fun parseSearchReplace(body: String): List<SearchReplace> {
        val out = mutableListOf<SearchReplace>()
        var state = 0 // 0 idle · 1 search · 2 replace
        val sea = mutableListOf<String>()
        val rep = mutableListOf<String>()
        fun close() { out += SearchReplace(sea.joinToString("\n"), rep.joinToString("\n")); sea.clear(); rep.clear(); state = 0 }
        for (line in body.split("\n")) {
            val t = line.trim()
            when {
                Regex("^<{5,9}\\s*SEARCH$").matches(t) -> {
                    if (state == 2) close() else if (state == 1) { out += SearchReplace(FORMAT_MARK + sea.joinToString("\n"), ""); sea.clear() }
                    state = 1
                }
                Regex("^={5,9}$").matches(t) && state == 1 -> state = 2
                Regex("^={5,9}$").matches(t) && state == 2 -> close() // REPLACE 대신 ======= 로 닫은 실수
                Regex("^>{5,9}\\s*REPLACE$").matches(t) -> if (state == 2) close()
                state == 1 -> sea += line
                state == 2 -> rep += line
            }
        }
        if (state == 2) close() else if (state == 1) out += SearchReplace(FORMAT_MARK + sea.joinToString("\n"), "")
        return out
    }

    fun parseToolCalls(rawText: String): List<ToolCall> {
        val text = normalizeToolText(rawText)
        val found = mutableListOf<Pair<Int, ToolCall>>()
        val bodies = listOf(FILE_RE, EDIT_RE, REMEMBER_RE, HARNESS_RE, IMAGE_RE)
            .flatMap { re -> re.findAll(text).map { it.range.first to it.range.last } }
        fun insideOther(i: Int) = bodies.any { (s, e) -> i > s && i <= e }

        for (m in SIMPLE_RE.findAll(text)) {
            val tag = m.groupValues[1]
            val arg = m.groupValues[2].trim()
            if (arg.isEmpty() && tag !in setOf("CHECK", "PLAY", "MODEL", "LIST", "ANALYZE")) continue
            val call: ToolCall = when (tag) {
                "CHECK" -> ToolCall.Check
                "DELETE" -> ToolCall.Delete(cleanPath(arg))
                "MKDIR" -> ToolCall.Mkdir(cleanPath(arg))
                "MOVE" -> {
                    val mv = Regex("""^(.+?)\s*(?:->|→|=>)\s*(.+)$""").find(arg) ?: Regex("""^(\S+)\s+(\S+)$""").find(arg) ?: continue
                    ToolCall.Move(cleanPath(mv.groupValues[1]), cleanPath(mv.groupValues[2]))
                }
                "PLAY" -> ToolCall.Play(DebugKit.parsePlay(arg))
                "READ" -> RANGE_RE.find(arg)?.let {
                    ToolCall.Read(cleanPath(it.groupValues[1]), it.groupValues[2].toInt(), it.groupValues[3].toInt())
                } ?: ToolCall.Read(cleanPath(arg))
                "LIST" -> ToolCall.ListFiles(arg.ifEmpty { "." })
                "GREP" -> ToolCall.Grep(arg)
                "SEARCH" -> ToolCall.Search(arg)
                "RUN" -> ToolCall.Run(arg)
                "CONNECT" -> ToolCall.Connect(arg)
                "ANALYZE" -> ToolCall.Analyze(if (arg.isEmpty()) "" else cleanPath(arg))
                else -> {
                    val parts = arg.split(Regex("\\s+")).filter { it.isNotEmpty() }
                    ToolCall.Model((parts.firstOrNull() ?: "status").lowercase(), parts.drop(1).joinToString(" "))
                }
            }
            found += m.range.first to call
        }
        for (m in FILE_RE.findAll(text)) found += m.range.first to ToolCall.Write(cleanPath(m.groupValues[1]), m.groupValues[2])
        for (m in EDIT_RE.findAll(text)) {
            val blocks = parseSearchReplace(m.groupValues[2])
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
        for (m in IMAGE_RE.findAll(text)) {
            val fields = LinkedHashMap<String, String>()
            var last = ""
            for (line in m.groupValues[2].split('\n')) {
                val kv = Regex("""^\s*([a-zA-Z_]+)\s*:\s*(.*)$""").find(line)
                if (kv != null) { last = kv.groupValues[1].lowercase(); fields[last] = kv.groupValues[2].trim() }
                else if (last.isNotEmpty() && line.isNotBlank()) fields[last] = fields[last] + " " + line.trim()
            }
            found += m.range.first to ToolCall.Image(cleanPath(m.groupValues[1]), fields)
        }

        return found.filter { !insideOther(it.first) }.sortedBy { it.first }.map { it.second }
    }

    /** 채팅 표시용: 도구 블록 제거 + 스트리밍 중 미완성 블록 숨김. */
    fun stripToolBlocks(text: String): String {
        var out = normalizeToolText(text)
        for (re in listOf(FILE_RE, EDIT_RE, REMEMBER_RE, HARNESS_RE, IMAGE_RE, SIMPLE_RE)) out = re.replace(out, "")
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
            if (search.startsWith(FORMAT_MARK)) {
                failed += "EDIT 형식 오류: <<<<<<< SEARCH 다음에 ======= 와 >>>>>>> REPLACE 가 있어야 합니다 (블록마다)."
                continue
            }
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
                continue
            }
            // 빈 줄 차이 허용: 빈 줄을 뺀 줄들로 비교해 유일하게 맞으면 그 범위를 바꾼다
            val nonEmpty = lines.mapIndexedNotNull { i, l -> if (l.isBlank()) null else l.trim() to i }
            val need2 = needle.filter { it.isNotEmpty() }
            var hit2 = -1
            if (need2.size >= 2) {
                for (i in 0..(nonEmpty.size - need2.size)) {
                    if (need2.indices.all { j -> nonEmpty[i + j].first == need2[j] }) {
                        if (hit2 != -1) { hit2 = -2; break }
                        hit2 = i
                    }
                }
            }
            if (hit2 >= 0) {
                val from = nonEmpty[hit2].second
                val to = nonEmpty[hit2 + need2.size - 1].second
                repeat(to - from + 1) { lines.removeAt(from) }
                lines.addAll(from, replace.split("\n"))
                content = lines.joinToString("\n")
                applied++
                continue
            }
            failed += "SEARCH 블록을 파일에서 찾지 못했습니다${if (hit == -2 || hit2 == -2) " (여러 곳과 비슷함 — 앞뒤 줄을 더 넣어 고유하게)" else ""}:\n" +
                "${search.take(200)}\n${closestSnippet(lines, needle)}"
        }
        return EditResult(content, applied, failed)
    }

    /** SEARCH 가 안 맞을 때: 파일에서 가장 비슷한 부분을 줄 번호와 함께 (그 원문으로 EDIT 를 다시 하도록) */
    fun closestSnippet(lines: List<String>, needle: List<String>): String {
        val need = needle.filter { it.isNotEmpty() }
        if (need.isEmpty() || lines.isEmpty()) return ""
        val set = need.toHashSet()
        val win = maxOf(need.size, 1)
        var best = -1
        var bestScore = 0
        for (i in lines.indices) {
            var score = 0
            for (j in i until minOf(lines.size, i + win + 2)) if (lines[j].trim() in set) score++
            if (score > bestScore) { bestScore = score; best = i }
        }
        if (best < 0) return "(비슷한 부분 없음: 파일을 다시 READ 해서 실제 내용을 확인하세요)"
        val from = maxOf(0, best - 2)
        val to = minOf(lines.size, best + win + 4)
        return "파일에서 가장 비슷한 부분 (${from + 1}~${to}줄) — 이 원문을 그대로 SEARCH 에 넣어 EDIT 를 다시 하세요 (FILE 로 전체를 다시 쓰지 말 것):\n" +
            (from until to).joinToString("\n") { "${(it + 1).toString().padStart(4)}| ${lines[it]}" }
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

    /** 작업 로그용 한 줄 요약 (VS Code describeCall 과 동일). */
    fun describeCall(c: ToolCall): String {
        fun one(t: String, n: Int = 80): String { val l = t.lineSequence().first(); return if (l.length > n) l.take(n) + "…" else l }
        return when (c) {
            is ToolCall.Read -> "READ ${c.path}" + if (c.start != null) ":${c.start}-${c.end}" else ""
            is ToolCall.ListFiles -> "LIST ${c.pattern}"
            is ToolCall.Grep -> "GREP ${c.pattern}"
            is ToolCall.Search -> "SEARCH ${one(c.query)}"
            is ToolCall.Write -> "FILE ${c.path} (${c.content.split("\n").size}줄)"
            is ToolCall.Edit -> "EDIT ${c.path} (${c.blocks.size}블록)"
            is ToolCall.Run -> "RUN ${one(c.command, 120)}"
            is ToolCall.Remember -> "REMEMBER ${c.memKind} ${c.scope}${if (c.scopeValue.isNotEmpty()) ":" + c.scopeValue else ""} — ${one(c.text)}"
            is ToolCall.Harness -> "HARNESS ${one(c.task)}"
            is ToolCall.Model -> "MODEL ${c.action}${if (c.arg.isNotEmpty()) " " + c.arg else ""}"
            is ToolCall.Connect -> "CONNECT ${c.location}"
            is ToolCall.Analyze -> "ANALYZE ${c.path}".trim()
            is ToolCall.Image -> "IMAGE ${c.path}${c.fields["size"]?.let { " $it" } ?: ""}${(c.fields["prompt"] ?: c.fields["ops"])?.let { " — " + one(it, 60) } ?: ""}"
            is ToolCall.Check -> "CHECK"
            is ToolCall.Delete -> "DELETE ${c.path}"
            is ToolCall.Move -> "MOVE ${c.from} -> ${c.to}"
            is ToolCall.Mkdir -> "MKDIR ${c.path}"
            is ToolCall.Play -> "PLAY ${c.req.kind}${if (c.req.target.isNotEmpty()) " " + c.req.target else ""}${if (c.req.seconds > 0) " ${c.req.seconds}초" else ""}"
        }
    }
}
