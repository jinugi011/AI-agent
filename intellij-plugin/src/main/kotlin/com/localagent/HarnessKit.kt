package com.localagent

/** 하네스(테스트 우선 구현) — VS Code harnesskit.ts 와 같은 규칙. IntelliJ 의존 없음 (테스트 가능). */
object HarnessKit {
    const val DIR = ".yang/harness"

    fun detectTestCommand(files: List<String>, windows: Boolean = false): String {
        fun has(re: String) = files.any { Regex(re).containsMatchIn(it) }
        return when {
            has("^pubspec\\.yaml$") -> "flutter test"
            has("^(build\\.gradle(\\.kts)?|settings\\.gradle(\\.kts)?)$") ->
                if (has("^gradlew(\\.bat)?$")) (if (windows) ".\\gradlew.bat test" else "./gradlew test") else "gradle test"
            has("^pom\\.xml$") -> if (has("^mvnw(\\.cmd)?$")) (if (windows) ".\\mvnw.cmd test" else "./mvnw test") else "mvn test"
            has("^package\\.json$") -> "npm test"
            has("^(pyproject\\.toml|setup\\.py|requirements\\.txt|pytest\\.ini)$") || has("(^|/)test_[^/]+\\.py$") -> "python -m pytest -q"
            has("^Cargo\\.toml$") -> "cargo test"
            has("^go\\.mod$") -> "go test ./..."
            else -> ""
        }
    }

    fun name(mdPath: String): String =
        mdPath.split('/', '\\').last().replace(Regex("\\.(md|markdown|txt)$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("[^\\w가-힣.-]+"), "-").take(60).ifBlank { "harness" }

    fun isChecklist(md: String) = Regex("^\\s*[-*] \\[[ xX]\\]", RegexOption.MULTILINE).findAll(md).count() >= 2

    fun progress(md: String): Pair<Int, Int> {
        val all = Regex("^\\s*[-*] \\[([ xX])\\]", RegexOption.MULTILINE).findAll(md).toList()
        return all.count { it.groupValues[1].isNotBlank() } to all.size
    }

    fun prompt(source: String, text: String, target: String, testCmd: String, resume: Boolean): String = """[하네스 모드] 아래 문서를 요구사항으로 삼아 **테스트 우선**으로 구현한다.
원본 문서: $source
하네스 체크리스트: $target
테스트 명령: ${testCmd.ifBlank { "(감지 못함 — 프로젝트를 보고 정한 뒤 체크리스트에 적는다)" }}

진행 순서 (반드시 지킨다):
1. ${if (resume) "$target 를 READ 해 [ ] 로 남은 항목부터 이어서 한다." else "$target 를 FILE 로 만든다: 문서의 요구사항을 R1, R2… 로 나누고 각 항목에 수용 기준과 테스트 이름을 적은 체크리스트 (- [ ] R1 …). 맨 위에 테스트 명령을 적는다."}
2. 자연어 목표와 완료 조건을 의미 단위로 나누고 각 요구사항에 Given/When/Then 수용 기준·실패 및 경계 조건을 연결한다. 모호한 조건은 가정으로 명시한다. 기존 코드·테스트를 READ 해서 같은 스타일·구조를 따른다.
3. 요구사항마다 테스트를 먼저 작성하고 RUN 으로 실패를 확인한다 (컴파일 오류가 아닌 '기대값 불일치' 실패).
4. 구현한 뒤 RUN 으로 통과할 때까지 고친다. 테스트를 약화시켜 통과시키지 않는다.
5. 통과한 항목은 체크리스트를 [x] 로 바꾸고 테스트 파일·통과 결과를 한 줄로 적는다 (EDIT).
6. 모든 항목이 끝나면 전체 테스트를 한 번 더 RUN 하고, 남은 문제·가정을 체크리스트 맨 아래 '메모' 에 적은 뒤 요약한다.

--- 요구사항 문서 ($source) ---
${text.take(16000)}${if (text.length > 16000) "\n…(이하 생략: 필요하면 READ)" else ""}"""

    fun fromRequest(request: String, target: String, testCmd: String) =
        prompt("사용자 요청 (+ 아키텍처 · 코딩 규칙)", request, target, testCmd, false)
}
