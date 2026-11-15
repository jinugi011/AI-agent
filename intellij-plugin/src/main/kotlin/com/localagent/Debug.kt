package com.localagent

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.WebSocket
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.isDirectory

/**
 * 디버깅 강화 (VS Code debugkit.ts + debugRunner.ts 와 같은 동작).
 * CHECK: IDE 하이라이트 + 언어별 빠른 검사 + 리소스 경로 / PLAY: 게임·앱을 N초 실행해 오류·화면 수집.
 */
data class PlayRequest(val kind: String = "auto", val target: String = "", val seconds: Double = 0.0,
                       val keys: List<String> = emptyList(), val expect: String = "")

object DebugKit {
    private val KINDS = setOf("auto", "web", "python", "flutter", "godot", "unity", "cmd")
    val DEFAULT_SECONDS = mapOf("auto" to 8.0, "web" to 8.0, "python" to 8.0, "flutter" to 20.0, "godot" to 8.0, "unity" to 0.0, "cmd" to 10.0)
    val DEFAULT_KEYS = listOf("Enter", "Space", "ArrowRight", "ArrowRight", "ArrowLeft", "ArrowUp", "Space", "ArrowDown")

    fun parsePlay(arg: String): PlayRequest {
        var rest = arg.trim()
        var expect = ""
        Regex("""\bexpect=(.*)$""", RegexOption.IGNORE_CASE).find(rest)?.let {
            expect = it.groupValues[1].trim().trim('"', '\'')
            rest = rest.substring(0, it.range.first).trim()
        }
        var keys = emptyList<String>()
        Regex("""\bkeys=(\S+)""", RegexOption.IGNORE_CASE).find(rest)?.let {
            keys = it.groupValues[1].split(",").map { k -> k.trim() }.filter { k -> k.isNotEmpty() }
            rest = rest.removeRange(it.range).trim()
        }
        val tokens = rest.split(Regex("\\s+")).filter { it.isNotEmpty() }.toMutableList()
        var kind = "auto"
        if (tokens.isNotEmpty() && tokens[0].lowercase() in KINDS) kind = tokens.removeAt(0).lowercase()
        var seconds = 0.0
        if (tokens.isNotEmpty() && Regex("""^\d+(\.\d+)?s?$""").matches(tokens.last())) seconds = tokens.removeAt(tokens.size - 1).trimEnd('s').toDouble()
        return PlayRequest(kind, tokens.joinToString(" "), seconds.coerceIn(0.0, 120.0), keys, expect)
    }

    fun detectPlayKind(files: List<String>, read: (String) -> String?): String? {
        val has = { f: String -> f in files }
        if (has("project.godot")) return "godot"
        if (has("ProjectSettings/ProjectVersion.txt")) return "unity"
        if (has("pubspec.yaml") && Regex("""\bflutter\s*:""").containsMatchIn(read("pubspec.yaml") ?: "")) return "flutter"
        if (files.any { Regex("""(^|/)index\.html$""").containsMatchIn(it) && "node_modules/" !in it }) return "web"
        if (has("package.json")) {
            val pkg = read("package.json") ?: ""
            if (Regex(""""(dev|start)"\s*:""").containsMatchIn(pkg) && Regex("vite|phaser|pixi|three|webpack|parcel|next").containsMatchIn(pkg)) return "web"
        }
        if (files.any { it.endsWith(".py") && !Regex("""(^|/)(\.?venv|site-packages)/""").containsMatchIn(it) }) return "python"
        return null
    }

    fun pickPythonEntry(files: List<String>, read: (String) -> String?): String? {
        val py = files.filter { it.endsWith(".py") && !Regex("""(^|/)(\.?venv|site-packages|tests?)/""").containsMatchIn(it) }
        for (name in listOf("main.py", "game.py", "app.py", "run.py", "__main__.py")) {
            (py.firstOrNull { it == name } ?: py.firstOrNull { it.endsWith("/$name") })?.let { return it }
        }
        return py.firstOrNull { Regex("""pygame\.init\(|__name__\s*==\s*['"]__main__['"]""").containsMatchIn(read(it) ?: "") } ?: py.firstOrNull()
    }

    data class TraceLoc(val file: String, val line: Int)

    private val TRACE = listOf(
        Regex("""File "([^"]+)", line (\d+)"""),
        Regex("""\(?(?:https?://[^/\s)]+/|file:///?|webpack:///?)?([\w@./\\-]+\.(?:m?jsx?|cjs|tsx?|vue|svelte)):(\d+)(?::\d+)?"""),
        Regex("""(?:package:\w+/|file:///?)?((?:lib|test|bin|integration_test)/[\w/.-]+\.dart):(\d+)(?::\d+)?"""),
        Regex("""package:\w+/([\w/.-]+\.dart):(\d+)(?::\d+)?"""),
        Regex("""([\w/\\.-]+\.cs)\((\d+),\d+\)"""),
        Regex("""\(at ([\w/\\.-]+\.cs):(\d+)\)"""),
        Regex("""res://([\w/.-]+\.gd):(\d+)"""),
        Regex("""\(([\w$]+\.(?:kt|java)):(\d+)\)"""),
        Regex("""(?:-->\s*)?((?:src|tests|examples)/[\w/.-]+\.rs):(\d+)(?::\d+)?"""),
        Regex("""([\w/.-]+\.(?:go|py|swift|c|cc|cpp|h|hpp|rb|php|lua)):(\d+)(?::\d+)?"""),
    )
    private val LIB_PATH = Regex("""(^|/)(node_modules|site-packages|dist-packages|\.pub-cache|flutter/packages|Library/PackageCache)/""")

    fun traceLocations(text: String, resolve: (String) -> String?, max: Int = 6): List<TraceLoc> {
        val found = mutableListOf<Pair<Int, TraceLoc>>()
        TRACE.forEachIndexed { i, re ->
            for (m in re.findAll(text)) {
                var cand = m.groupValues[1].replace('\\', '/')
                if (i == 3) cand = "lib/$cand"
                if (LIB_PATH.containsMatchIn(cand)) continue
                val file = resolve(cand) ?: continue
                found += m.range.first to TraceLoc(file, m.groupValues[2].toInt())
            }
        }
        val out = found.sortedBy { it.first }.map { it.second }.filter { it.line > 0 }.distinct()
        return (if ("Traceback (most recent call last)" in text) out.reversed() else out).take(max)
    }

    fun makeResolver(root: String, files: List<String>): (String) -> String? {
        val set = files.toHashSet()
        val rootNorm = root.replace('\\', '/').trimEnd('/')
        return resolver@{ cand ->
            var c = cand.replace('\\', '/').removePrefix("./")
            if (c.startsWith("$rootNorm/")) c = c.substring(rootNorm.length + 1)
            if (c in set) return@resolver c
            val parts = c.split('/')
            for (i in 1 until parts.size) {
                val tail = parts.drop(i).joinToString("/")
                if (tail in set) return@resolver tail
            }
            if ('/' !in c) files.filter { it == c || it.endsWith("/$c") }.singleOrNull()?.let { return@resolver it }
            null
        }
    }

    fun excerpt(content: String, line: Int, radius: Int = 4): String {
        val lines = content.split('\n')
        val from = maxOf(1, line - radius)
        val to = minOf(lines.size, line + radius)
        val w = to.toString().length
        return (from..to).joinToString("\n") { i -> "${if (i == line) "▶" else " "}${i.toString().padStart(w)} | ${lines[i - 1]}" }
    }

    private val ERROR_LINE = Regex("""(error|exception|traceback|uncaught|fatal|panic|failed|failure|segmentation|abort|SCRIPT ERROR|Parse Error|E/flutter|EXCEPTION CAUGHT|Unhandled|ReferenceError|TypeError|SyntaxError|NameError|AttributeError|KeyError|IndexError|ValueError|NullPointer|NoSuchMethod|LateInitializationError|RangeError|오류)""", RegexOption.IGNORE_CASE)
    private val NOISE = Regex("""(0 errors?|no errors|errors?: 0|without errors|DeprecationWarning|DevTools listening|^\s*$)""", RegexOption.IGNORE_CASE)

    fun errorLines(output: String, max: Int = 20): List<String> {
        val out = mutableListOf<String>()
        val seen = HashSet<String>()
        for (raw in output.split('\n')) {
            if (out.size >= max) break
            val l = raw.trimEnd()
            if (!ERROR_LINE.containsMatchIn(l) || NOISE.containsMatchIn(l)) continue
            if (!seen.add(l.replace(Regex("\\d+"), "#").take(160))) continue
            out += if (l.length > 300) l.take(300) + "…" else l
        }
        return out
    }

    data class AssetRef(val file: String, val line: Int, val ref: String)
    private val ASSET_RE = Regex("""['"`]([^'"`\s${'$'}{}()]+\.(?:png|jpe?g|gif|webp|bmp|svg|wav|mp3|ogg|m4a|ttf|otf|woff2?|json|tmx|tsx|atlas|fnt|glb|gltf|obj))['"`]""", RegexOption.IGNORE_CASE)

    fun assetRefs(file: String, content: String): List<AssetRef> {
        if (!Regex("""\.(m?jsx?|tsx?|py|dart|gd|cs|html?|lua|kt|java)$""", RegexOption.IGNORE_CASE).containsMatchIn(file)) return emptyList()
        val out = mutableListOf<AssetRef>()
        content.split('\n').forEachIndexed { i, l ->
            if (Regex("""^\s*(//|#|\*)""").containsMatchIn(l)) return@forEachIndexed
            for (m in ASSET_RE.findAll(l)) {
                val ref = m.groupValues[1]
                if (Regex("""^(https?:|data:|blob:|//)""", RegexOption.IGNORE_CASE).containsMatchIn(ref) || '*' in ref) continue
                out += AssetRef(file, i + 1, ref)
            }
        }
        return out
    }

    fun assetExists(ref: AssetRef, files: Set<String>): Boolean {
        val clean = ref.ref.removePrefix("res://").removePrefix("./").removePrefix("/")
        val dir = ref.file.substringBeforeLast('/', "")
        fun norm(p: String): String {
            val out = ArrayDeque<String>()
            for (part in p.split('/')) when (part) { ".." -> out.removeLastOrNull(); "", "." -> {}; else -> out.addLast(part) }
            return out.joinToString("/")
        }
        val cands = listOf(norm("$dir/${ref.ref}"), norm(clean)) +
            listOf("public", "static", "assets", "src", "web", "resources", "res", "Assets/Resources").map { norm("$it/$clean") }
        if (cands.any { it in files }) return true
        val base = clean.substringAfterLast('/')
        return files.any { it == base || it.endsWith("/$base") }
    }

    val IMAGE_DOC = """<<<IMAGE 저장경로.png
prompt: 영어로 '무엇을' 그릴지 구체적으로 (대상·자세·방향·특징·색 등). 화풍은 프로젝트 아트 컨셉이 자동으로 붙음
kind: character                    종류: character|enemy|item|icon|tile|background|ui|effect|portrait (종류별 구도·투명 배경·기본 크기 자동)
size: 64x64                        최종 크기 (비우면 아트 컨셉의 종류별 크기)
transparent: yes                   배경 제거 (비우면 종류에 따라 자동)
verify: no                         생성 후 비전 모델이 컨셉과 대조해 낮으면 한 번 다시 그림 (기본 켬, 끄면 빠름)
pixel: 32                          픽셀아트로 변환 (가로 32칸, colors: 16 으로 색 수 제한)
ref: assets/concept.png            참고 이미지의 '스타일'을 따라 그림 (프로젝트 파일 | attachment:첨부이름 | search:무료 이미지 검색어)
strength: 0.4                      참고 이미지를 밑그림으로도 쓰는 정도 0~0.9 (기본 0 = 스타일만)
from: assets/old.png               기존 이미지를 고쳐 그리기 (prompt 와 함께) 또는 가공만 (prompt 없이)
join: a.png, b.png, c.png          여러 이미지를 스프라이트 시트로 합치기 (cols: 3)
ops: flip-x; rotate 90; tint #ff8800 0.3; crop x,y,w,h; resize WxH; remove-bg; trim; pixelate 32; grayscale; sheet-split 4x1
overwrite: yes                     같은 경로에 그림이 이미 있으면 기본은 다시 만들지 않음 (새로 그릴 때만 yes)
IMAGE>>>                           프로젝트용 그림을 맥의 이미지 모델(FLUX)로 생성·가공해 저장. 한 장에 15~40초.
                                   sheet-split 은 경로_0.png, 경로_1.png … 로 저장. 웹 참고 이미지는 CC0·퍼블릭 도메인만 쓰고 ASSET_CREDITS.md 에 기록."""

    val DEBUG_RULES = """## 디버깅 원칙 (오류가 있거나 동작이 이상할 때)
- 추측으로 고치지 않는다. 먼저 PLAY(게임·앱 실행) 또는 RUN(테스트)으로 재현해 실제 오류·로그·화면을 본다.
- 오류 메시지와 스택 트레이스의 파일:줄을 READ 로 열어 원인 코드를 확인한 뒤 고친다.
- 한 번에 하나의 원인만 고치고, 고친 뒤 같은 방법으로 다시 실행해 확인한다.
- [자동 검사] 결과에 오류가 있으면 그것부터 고친다. 오류가 남은 채로 완료라고 말하지 않는다.
- 원인을 모르면 의심 지점에 임시 로그를 넣는다. 임시 로그 줄 끝에는 반드시 주석으로 YANG-DEBUG 를 붙이고, 끝나면 모두 지운다.
- "화면이 안 보인다/검다/멈춘다" 같은 문제는 PLAY 결과의 화면 분석·프레임 수·리소스 로드 실패를 먼저 본다."""

    val PLAY_DOC = """<<<PLAY [종류] [대상] [초] [keys=Space,ArrowLeft] [expect=보여야 할 것]>>>
                                   게임·앱을 실제로 실행해 오류·콘솔 로그·리소스 로드 실패·프레임 수를 모으고
                                   마지막 화면을 캡처해 분석한다 (사용자 승인 필요). 종류: web|python|flutter|godot|unity|cmd
                                   예) <<<PLAY>>> (자동) · <<<PLAY web index.html 10>>> · <<<PLAY python main.py>>>
                                       <<<PLAY flutter 30>>> · <<<PLAY cmd npm start 15>>> · <<<PLAY web expect=플레이어와 적이 보임>>>
<<<CHECK>>>                         프로젝트 전체 정적 검사(문법·타입·분석기·IDE 오류·리소스 경로). 파일 수정 후에는 자동으로 실행된다."""

    fun debugPrompt(symptom: String) = """[디버그 모드] 증상: ${symptom.ifBlank { "(사용자가 증상을 적지 않음 — 먼저 실행해서 문제를 찾는다)" }}

다음 순서를 반드시 지키세요:
1. 재현: PLAY(게임·앱) 또는 RUN(테스트)으로 먼저 실행해 실제 오류·로그·화면을 확인한다. 실행 전에 코드를 고치지 않는다.
2. 위치: 오류·스택 트레이스에 나온 파일:줄을 READ 로 열어 원인 코드를 확인한다. 오류가 없으면 증상과 관련된 코드를 GREP/READ 로 찾는다.
3. 가설: 원인 가설을 1~3개 짧게 적고, 가장 가능성 높은 것부터 확인한다.
4. 계측: 확인이 더 필요하면 의심 지점에 임시 로그를 넣는다 (줄 끝 주석에 YANG-DEBUG). 다시 PLAY/RUN 해서 값을 확인한다.
5. 수정: 원인을 고치는 최소한의 수정만 한다 (증상만 가리는 수정 금지: 예외 삼키기, 검사 끄기, 테스트 약화).
6. 검증: 1번과 같은 방법으로 다시 실행해 증상이 사라졌고 새 오류가 없는지 확인한다.
7. 정리: GREP YANG-DEBUG 로 임시 로그를 모두 지운다.
8. 보고: 원인 / 수정 내용 / 검증 결과를 3~5줄로."""

    fun clip(s: String, max: Int): String =
        if (s.length <= max) s else s.take((max * 0.3).toInt()) + "\n…(${"%,d".format(s.length - max)}자 생략)…\n" + s.takeLast((max * 0.7).toInt())
}

// =============================================================================================
object DebugRunner {
    data class Problem(val file: String, val line: Int, val col: Int?, val severity: String, val message: String, val source: String)
    data class CheckReport(val errors: Int, val warnings: Int, val text: String)
    data class PlayResult(val text: String, val errors: Int)

    private val EXCLUDED = setOf("node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "Pods",
        ".dart_tool", ".gradle", "models", "out", ".idea", "coverage", "Library", "Temp", "obj", ".godot", ".yang")
    private val CODE_EXT = Regex("""\.(py|m?jsx?|cjs|tsx?|dart|gd|cs|html?|json|kt|java|rs|go|lua|vue|svelte)$""", RegexOption.IGNORE_CASE)

    fun listFiles(root: Path, limit: Int = 8000): List<String> {
        val out = mutableListOf<String>()
        fun walk(dir: File) {
            val children = dir.listFiles() ?: return
            for (f in children.sortedBy { it.name }) {
                if (out.size >= limit) return
                if (f.isDirectory) { if (f.name !in EXCLUDED) walk(f) }
                else out += root.relativize(f.toPath()).toString().replace('\\', '/')
            }
        }
        walk(root.toFile())
        return out
    }

    private fun readRel(root: Path, rel: String): String? = try { Files.readString(root.resolve(rel)) } catch (e: Exception) { null }

    data class ProcResult(val code: Int, val out: String, val timedOut: Boolean)

    @Volatile private var loginPath: String? = null
    /** 로그인 셸의 PATH (IDE 를 Dock 에서 띄우면 PATH 가 짧아 flutter·node 를 못 찾는다) */
    private fun envPath(): String {
        loginPath?.let { return it }
        if (Shell.isWindows) return (System.getenv("PATH") ?: "").also { loginPath = it }
        val p = try {
            val pr = ProcessBuilder("/bin/zsh", "-lc", "echo \$PATH").redirectErrorStream(true).start()
            pr.waitFor(8, TimeUnit.SECONDS)
            pr.inputStream.bufferedReader().readText().trim().lines().lastOrNull().orEmpty()
        } catch (e: Exception) { "" }
        return p.ifBlank { System.getenv("PATH") ?: "" }.also { loginPath = it }
    }

    private fun builder(cmd: List<String>, cwd: Path?, env: Map<String, String>): ProcessBuilder {
        val full = if (Shell.isWindows && Regex("""\.(cmd|bat)$""", RegexOption.IGNORE_CASE).containsMatchIn(cmd.first())) listOf("cmd.exe", "/c") + cmd else cmd
        val pb = ProcessBuilder(full).redirectErrorStream(true)
        cwd?.let { pb.directory(it.toFile()) }
        pb.environment()["PATH"] = envPath()
        pb.environment()["FORCE_COLOR"] = "0"
        pb.environment()["NO_COLOR"] = "1"
        pb.environment().putAll(env)
        return pb
    }

    fun proc(cmd: List<String>, cwd: Path? = null, env: Map<String, String> = emptyMap(), timeoutMs: Long = 60_000, cancelled: () -> Boolean = { false }): ProcResult {
        val p = try { builder(cmd, cwd, env).start() } catch (e: Exception) { return ProcResult(-1, e.toString(), false) }
        val out = StringBuilder()
        val reader = Thread { p.inputStream.bufferedReader().forEachLine { synchronized(out) { out.appendLine(it); if (out.length > 400_000) out.delete(0, 200_000) } } }
            .apply { isDaemon = true; start() }
        val deadline = System.currentTimeMillis() + timeoutMs
        var timedOut = false
        while (!p.waitFor(150, TimeUnit.MILLISECONDS)) {
            if (cancelled() || System.currentTimeMillis() > deadline) { timedOut = !cancelled(); p.descendants().forEach { it.destroyForcibly() }; p.destroyForcibly(); break }
        }
        reader.join(2000)
        return ProcResult(if (p.isAlive) -1 else p.exitValue(), synchronized(out) { out.toString() }, timedOut)
    }

    private val whichCache = ConcurrentHashMap<String, String>()
    fun which(cmd: String): String? {
        whichCache[cmd]?.let { return it.ifEmpty { null } }
        val found = if (Shell.isWindows) {
            val r = proc(listOf("where", cmd), timeoutMs = 5000)
            val hits = if (r.code == 0) r.out.lines().map { it.trim() }.filter { it.isNotEmpty() } else emptyList()
            hits.firstOrNull { Regex("""\.(exe|cmd|bat)$""", RegexOption.IGNORE_CASE).containsMatchIn(it) } ?: hits.firstOrNull() ?: ""
        } else {
            val r = proc(listOf("/bin/zsh", "-lc", "command -v $cmd"), timeoutMs = 8000)
            r.out.trim().lines().lastOrNull()?.takeIf { r.code == 0 && it.startsWith("/") } ?: ""
        }
        whichCache[cmd] = found
        return found.ifEmpty { null }
    }

    private fun exists(p: String) = File(p).exists()

    // ---- CHECK ----------------------------------------------------------------------------
    /** IntelliJ 가 이미 분석한 오류·경고 (에디터에 열린 파일 기준 → 변경 파일을 열고 분석을 잠깐 기다린다) */
    private fun ideProblems(project: Project, root: Path, rels: List<String>): List<Problem> {
        val vfs = rels.mapNotNull { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root.resolve(it))?.let { vf -> it to vf } }
        if (vfs.isEmpty()) return emptyList()
        ApplicationManager.getApplication().invokeAndWait {
            val fem = FileEditorManager.getInstance(project)
            vfs.forEach { (_, vf) -> if (!fem.isFileOpen(vf)) fem.openFile(vf, false) }
        }
        val out = mutableListOf<Problem>()
        var last = -1
        for (i in 0 until 8) {  // 분석이 안정될 때까지 (최대 약 1.6초 — 코딩 흐름을 막지 않게)
            Thread.sleep(200)
            out.clear()
            ReadAction.run<RuntimeException> {
                for ((rel, vf) in vfs) {
                    val doc = FileDocumentManager.getInstance().getDocument(vf) ?: continue
                    val infos = try { DaemonCodeAnalyzerImpl.getHighlights(doc, HighlightSeverity.WARNING, project) } catch (e: Throwable) { emptyList() }
                    for (h in infos) {
                        val msg = h.description ?: continue
                        val line = doc.getLineNumber(h.startOffset.coerceIn(0, doc.textLength)) + 1
                        val sev = if (h.severity.myVal >= HighlightSeverity.ERROR.myVal) "error" else "warning"
                        out += Problem(rel, line, null, sev, msg.lineSequence().first(), "IDE")
                    }
                }
            }
            if (i >= 3 && out.size == last) break
            last = out.size
        }
        return out.toList()
    }

    private fun pythonExe(root: Path): String? {
        for (p in listOf(".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe", "venv/Scripts/python.exe")) {
            if (Files.exists(root.resolve(p))) return root.resolve(p).toString()
        }
        return which("python3") ?: which("python") ?: if (Shell.isWindows) which("py") else null
    }

    private val PY_CHECK = """import sys, ast, builtins
use_flakes = sys.argv[1] == "1"
for f in sys.argv[2:]:
    try:
        src = open(f, encoding="utf-8").read()
        tree = compile(src, f, "exec", ast.PyCF_ONLY_AST)
    except SyntaxError as e:
        print(f"{f}:{e.lineno or 0}:{e.offset or 0}: error: SyntaxError: {e.msg}")
        continue
    except Exception:
        continue
    if use_flakes:
        continue
    if any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree)):
        continue
    bound = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__builtins__", "__spec__", "__path__", "__package__", "__loader__"}
    aug = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name):
            aug.add(id(n.target))
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)) and id(n) not in aug:
            bound.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(n.name)
        elif isinstance(n, ast.arg):
            bound.add(n.arg)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                bound.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            bound.update(n.names)
        elif hasattr(ast, "MatchAs") and isinstance(n, ast.MatchAs) and n.name:
            bound.add(n.name)
    seen = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and (isinstance(n.ctx, ast.Load) or id(n) in aug) and n.id not in bound and n.id not in seen:
            seen.add(n.id)
            print(f"{f}:{n.lineno}:{n.col_offset + 1}: error: 정의되지 않은 이름 '{n.id}' (오타이거나 먼저 값을 넣지 않음)")
"""

    private fun checkPython(root: Path, files: List<String>): List<Problem> {
        val py = pythonExe(root) ?: return emptyList()
        if (files.isEmpty()) return emptyList()
        val out = mutableListOf<Problem>()
        val pf = proc(listOf(py, "-m", "pyflakes") + files, root, timeoutMs = 30_000)
        val hasFlakes = "No module named pyflakes" !in pf.out && pf.code != -1
        val syn = proc(listOf(py, "-c", PY_CHECK, if (hasFlakes) "1" else "0") + files, root, timeoutMs = 30_000)
        for (m in Regex("""^(.+?):(\d+):(\d+): error: (.+)$""", RegexOption.MULTILINE).findAll(syn.out)) {
            out += Problem(m.groupValues[1], m.groupValues[2].toInt(), m.groupValues[3].toInt(), "error", m.groupValues[4], if (hasFlakes) "python" else "python(내장 검사)")
        }
        if (hasFlakes) {
            for (m in Regex("""^(.+?):(\d+):(?:(\d+):?)?\s*(.+)$""", RegexOption.MULTILINE).findAll(pf.out)) {
                val msg = m.groupValues[4].trim()
                val severe = Regex("undefined name|referenced before assignment|invalid syntax").containsMatchIn(msg)
                out += Problem(m.groupValues[1], m.groupValues[2].toInt(), m.groupValues[3].toIntOrNull(), if (severe) "error" else "warning", msg, "pyflakes")
            }
        }
        return out
    }

    private fun checkJs(root: Path, files: List<String>): List<Problem> {
        val node = which("node") ?: return emptyList()
        if (files.isEmpty()) return emptyList()
        val tmp = Files.createTempDirectory("yang-js-")
        val out = mutableListOf<Problem>()
        try {
            data class Unit(val file: String, val code: String, val offset: Int, val module: Boolean)
            val units = mutableListOf<Unit>()
            for (f in files) {
                val src = readRel(root, f) ?: continue
                if (Regex("""\.html?$""", RegexOption.IGNORE_CASE).containsMatchIn(f)) {
                    for (m in Regex("""<script(\s[^>]*)?>([\s\S]*?)</script>""", RegexOption.IGNORE_CASE).findAll(src)) {
                        val attrs = m.groupValues[1]
                        if ("src=" in attrs || m.groupValues[2].isBlank() || Regex("""type=["'](?!module|text/javascript)""").containsMatchIn(attrs)) continue
                        val offset = src.substring(0, m.range.first + m.value.indexOf('>') + 1).count { it == '\n' }
                        units += Unit(f, m.groupValues[2], offset, Regex("""type=["']module""").containsMatchIn(attrs))
                    }
                } else units += Unit(f, src, 0, f.endsWith(".mjs") || Regex("""^\s*(import|export)\s""", RegexOption.MULTILINE).containsMatchIn(src))
            }
            units.forEachIndexed { i, u ->
                val tf = tmp.resolve("u$i${if (u.module) ".mjs" else ".cjs"}")
                Files.writeString(tf, u.code)
                val r = proc(listOf(node, "--check", tf.toString()), timeoutMs = 15_000)
                if (r.code == 0) return@forEachIndexed
                val line = Regex(Regex.escape(tf.toString()) + """:(\d+)""").find(r.out)?.groupValues?.get(1)?.toInt() ?: 1
                val msg = Regex("""^(\w*Error: .+)$""", RegexOption.MULTILINE).find(r.out)?.groupValues?.get(1) ?: "문법 오류"
                out += Problem(u.file, line + u.offset, null, "error", msg, "node --check")
            }
        } finally { tmp.toFile().deleteRecursively() }
        return out
    }

    private fun checkTs(root: Path): List<Problem> {
        val tsc = root.resolve("node_modules/.bin/tsc")
        if (!Files.exists(tsc) || !Files.exists(root.resolve("tsconfig.json"))) return emptyList()
        val r = proc(listOf(tsc.toString(), "--noEmit", "-p", root.toString(), "--pretty", "false"), root, timeoutMs = 45_000)
        return Regex("""^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+: .+)$""", RegexOption.MULTILINE).findAll(r.out).map {
            Problem(it.groupValues[1].replace('\\', '/'), it.groupValues[2].toInt(), it.groupValues[3].toInt(), it.groupValues[4], it.groupValues[5], "tsc")
        }.toList()
    }

    private fun checkDart(root: Path, files: List<String>?): List<Problem> {
        val pubspec = readRel(root, "pubspec.yaml") ?: return emptyList()
        val isFlutter = Regex("""\bflutter\s*:""").containsMatchIn(pubspec)
        val bin = (if (isFlutter) which("flutter") else which("dart")) ?: return emptyList()
        val args = if (isFlutter) listOf("analyze", "--no-pub", "--no-fatal-infos", "--no-fatal-warnings") else listOf("analyze")
        val r = proc(listOf(bin) + args + (files ?: emptyList()), root, timeoutMs = 180_000)
        val out = mutableListOf<Problem>()
        for (m in Regex("""^\s*(error|warning)\s+[•-]\s+(.+?)\s+[•-]\s+(.+?\.dart):(\d+):(\d+)\s+[•-]""", RegexOption.MULTILINE).findAll(r.out)) {
            out += Problem(m.groupValues[3], m.groupValues[4].toInt(), m.groupValues[5].toInt(), m.groupValues[1], m.groupValues[2], if (isFlutter) "flutter analyze" else "dart analyze")
        }
        for (m in Regex("""^\s*(error|warning)\s+-\s+(.+?\.dart):(\d+):(\d+)\s+-\s+(.+?)\s+-\s+\w+$""", RegexOption.MULTILINE).findAll(r.out)) {
            out += Problem(m.groupValues[2], m.groupValues[3].toInt(), m.groupValues[4].toInt(), m.groupValues[1], m.groupValues[5], "dart analyze")
        }
        return out
    }

    private fun godotBin(): String? =
        which("godot") ?: which("godot4") ?: listOf("/Applications/Godot.app/Contents/MacOS/Godot", "/Applications/Godot_mono.app/Contents/MacOS/Godot").firstOrNull(::exists)

    private fun checkGodot(root: Path, files: List<String>): List<Problem> {
        val bin = godotBin() ?: return emptyList()
        if (files.isEmpty() || !Files.exists(root.resolve("project.godot"))) return emptyList()
        val out = mutableListOf<Problem>()
        for (f in files.take(10)) {
            val r = proc(listOf(bin, "--headless", "--path", root.toString(), "--check-only", "--script", "res://$f"), root, timeoutMs = 60_000)
            for (m in Regex("""(?:SCRIPT ERROR|Parse Error|ERROR):\s*(.+?)\n(?:.*?\n)?\s*at:.*?res://(.+?\.gd):(\d+)""").findAll(r.out)) {
                out += Problem(m.groupValues[2], m.groupValues[3].toInt(), null, "error", m.groupValues[1], "godot")
            }
        }
        return out
    }

    private fun checkJson(root: Path, files: List<String>): List<Problem> = files.mapNotNull { f ->
        val src = readRel(root, f) ?: return@mapNotNull null
        if (Regex("""(^|/)(tsconfig|jsconfig)[^/]*\.json$|\.vscode/""").containsMatchIn(f)) return@mapNotNull null
        try { JsonParser.parseString(src); null } catch (e: Exception) {
            Problem(f, 1, null, "error", "JSON 오류: ${e.message?.lineSequence()?.first()}", "json")
        }
    }

    private fun checkAssets(root: Path, files: List<String>, all: Set<String>): List<Problem> = files.flatMap { f ->
        val src = readRel(root, f) ?: return@flatMap emptyList()
        DebugKit.assetRefs(f, src).filter { !DebugKit.assetExists(it, all) }.map {
            Problem(f, it.line, null, "warning", "리소스 파일을 찾을 수 없음: '${it.ref}' (경로 오타·파일 누락이면 화면에 안 보임)", "assets")
        }
    }.take(15)

    /** changed 가 있으면 변경 파일 위주(수정 직후 자동 검사), null 이면 프로젝트 전체(CHECK 도구). */
    fun runCheck(project: Project, root: Path, changed: List<String>?): CheckReport {
        val all = listFiles(root)
        val allSet = all.toHashSet()
        val targets = (changed ?: all).filter { CODE_EXT.containsMatchIn(it) && it in allSet }.take(if (changed != null) 50 else 400)
        if (targets.isEmpty()) return CheckReport(0, 0, "[자동 검사] 검사할 코드 파일 없음")
        fun by(re: String) = targets.filter { Regex(re, RegexOption.IGNORE_CASE).containsMatchIn(it) }
        val jobs: List<() -> List<Problem>> = listOf(
            { if (changed != null) ideProblems(project, root, targets) else emptyList() },
            { checkPython(root, by("""\.py$""")) },
            { checkJs(root, by("""\.(m?js|cjs|html?)$""")) },
            { if (by("""\.tsx?$""").isNotEmpty()) checkTs(root) else emptyList() },
            { if (by("""\.dart$""").isNotEmpty()) checkDart(root, if (changed != null) by("""\.dart$""") else null) else emptyList() },
            { checkGodot(root, by("""\.gd$""")) },
            { checkJson(root, by("""\.json$""")) },
            { checkAssets(root, targets, allSet) },
        )
        val futures = jobs.map { job -> CompletableFuture.supplyAsync { try { job() } catch (e: Throwable) { emptyList() } } }
        val seen = HashSet<String>()
        val problems = futures.flatMap { it.get(200, TimeUnit.SECONDS) }
            .filter { seen.add("${it.file}:${it.line}:${it.message.take(40)}") && (changed == null || it.file in targets || it.source == "tsc") }
            .sortedBy { if (it.severity == "error") 0 else 1 }
        val errors = problems.filter { it.severity == "error" }
        val warnings = problems.filter { it.severity == "warning" }
        val scope = if (changed != null) "변경 파일 ${targets.size}개" else "프로젝트 파일 ${targets.size}개"
        if (problems.isEmpty()) return CheckReport(0, 0, "[자동 검사] $scope · 오류 없음 ✓")
        val lines = mutableListOf("[자동 검사] $scope · 오류 ${errors.size}개 · 경고 ${warnings.size}개")
        errors.take(8).forEachIndexed { i, p ->
            lines += "- ${p.file}:${p.line}${p.col?.let { ":$it" } ?: ""} 오류 (${p.source}): ${p.message}"
            if (i < 4) readRel(root, p.file)?.let { src -> lines += DebugKit.excerpt(src, p.line, 2).lines().joinToString("\n") { "    $it" } }
        }
        if (errors.size > 8) lines += "- …오류 ${errors.size - 8}개 더"
        warnings.take(6).forEach { lines += "- ${it.file}:${it.line} 경고 (${it.source}): ${it.message}" }
        if (warnings.size > 6) lines += "- …경고 ${warnings.size - 6}개 더"
        if (errors.isNotEmpty()) lines += "→ 위 오류를 먼저 고치세요. 오류가 남은 채로 끝내지 마세요."
        return CheckReport(errors.size, warnings.size, lines.joinToString("\n"))
    }

    // ---- PLAY -----------------------------------------------------------------------------
    private class Collected {
        val started = mutableListOf<String>()
        val errors = mutableListOf<String>()
        val failed = mutableListOf<String>()
        val console = mutableListOf<String>()
        val notes = mutableListOf<String>()
        var frames: Int? = null
        var screenshot: ByteArray? = null
    }

    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

    /** DevTools 프로토콜 클라이언트 (java.net.http.WebSocket) */
    private class Cdp(url: String) : WebSocket.Listener {
        private val id = AtomicInteger()
        private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
        val handlers = mutableListOf<(String, JsonObject) -> Unit>()
        private val buf = StringBuilder()
        val ws: WebSocket = http.newWebSocketBuilder().buildAsync(URI.create(url), this).get(10, TimeUnit.SECONDS)

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
            buf.append(data)
            if (last) {
                val msg = JsonParser.parseString(buf.toString()).asJsonObject
                buf.setLength(0)
                val mid = msg.get("id")?.asInt
                if (mid != null) pending.remove(mid)?.let { f ->
                    if (msg.has("error")) f.completeExceptionally(RuntimeException(msg.getAsJsonObject("error").get("message").asString))
                    else f.complete(msg.getAsJsonObject("result") ?: JsonObject())
                } else msg.get("method")?.asString?.let { m -> synchronized(handlers) { handlers.toList() }.forEach { h -> h(m, msg.getAsJsonObject("params") ?: JsonObject()) } }
            }
            webSocket.request(1)
            return null
        }

        fun send(method: String, params: Map<String, Any?> = emptyMap(), timeoutSec: Long = 15): JsonObject? {
            val i = id.incrementAndGet()
            val f = CompletableFuture<JsonObject>()
            pending[i] = f
            ws.sendText(Clients.gson.toJson(mapOf("id" to i, "method" to method, "params" to params)), true)
            return try { f.get(timeoutSec, TimeUnit.SECONDS) } catch (e: Exception) { pending.remove(i); null }
        }

        fun close() { try { ws.abort() } catch (e: Exception) { } }
    }

    private fun findChrome(): String? {
        val os = System.getProperty("os.name").lowercase()
        val cands = when {
            "mac" in os -> listOf("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")
            "win" in os -> listOf("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                "${System.getenv("LOCALAPPDATA")}\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe")
            else -> listOf("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium")
        }
        return cands.firstOrNull(::exists)
    }

    private val MIME = mapOf("html" to "text/html; charset=utf-8", "htm" to "text/html; charset=utf-8", "js" to "text/javascript", "mjs" to "text/javascript",
        "css" to "text/css", "json" to "application/json", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "gif" to "image/gif",
        "webp" to "image/webp", "svg" to "image/svg+xml", "wav" to "audio/wav", "mp3" to "audio/mpeg", "ogg" to "audio/ogg", "wasm" to "application/wasm",
        "ttf" to "font/ttf", "otf" to "font/otf", "woff" to "font/woff", "woff2" to "font/woff2")

    private fun staticServer(root: Path): com.sun.net.httpserver.HttpServer {
        val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            try {
                var file = root.resolve(java.net.URLDecoder.decode(ex.requestURI.path.trimStart('/'), "UTF-8")).normalize()
                if (!file.startsWith(root)) { ex.sendResponseHeaders(403, -1); return@createContext }
                if (file.isDirectory()) file = file.resolve("index.html")
                if (!Files.isRegularFile(file)) { ex.sendResponseHeaders(404, -1); return@createContext }
                val data = Files.readAllBytes(file)
                ex.responseHeaders.add("Content-Type", MIME[file.fileName.toString().substringAfterLast('.').lowercase()] ?: "application/octet-stream")
                ex.responseHeaders.add("Cache-Control", "no-store")
                ex.sendResponseHeaders(200, data.size.toLong())
                ex.responseBody.use { it.write(data) }
            } finally { ex.close() }
        }
        server.start()
        return server
    }

    private val KEYMAP = mapOf("Enter" to Triple("Enter", "Enter", 13), "Space" to Triple(" ", "Space", 32), "ArrowLeft" to Triple("ArrowLeft", "ArrowLeft", 37),
        "ArrowUp" to Triple("ArrowUp", "ArrowUp", 38), "ArrowRight" to Triple("ArrowRight", "ArrowRight", 39), "ArrowDown" to Triple("ArrowDown", "ArrowDown", 40),
        "Escape" to Triple("Escape", "Escape", 27), "Shift" to Triple("Shift", "ShiftLeft", 16))

    private fun keyDef(name: String): Triple<String, String, Int>? {
        KEYMAP[name]?.let { return it }
        if (Regex("^[a-zA-Z0-9]$").matches(name)) {
            val ch = name.lowercase()
            return Triple(ch, if (ch[0].isDigit()) "Digit$ch" else "Key${ch.uppercase()}", ch.uppercase()[0].code)
        }
        return null
    }

    private fun webCapture(url: String, seconds: Double, keys: List<String>, c: Collected, cancelled: () -> Boolean) {
        val chrome = findChrome() ?: run { c.notes += "Chrome/Edge 를 찾지 못해 브라우저 실행 검사를 건너뜀"; return }
        val profile = Files.createTempDirectory("yang-chrome-")
        val proc = builder(listOf(chrome, "--headless=new", "--remote-debugging-port=0", "--user-data-dir=$profile", "--no-first-run",
            "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800",
            "--enable-unsafe-swiftshader", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows", "about:blank"), null, emptyMap()).start()
        var cdp: Cdp? = null
        try {
            val wsUrl = CompletableFuture.supplyAsync {
                val r = proc.inputStream.bufferedReader()
                var found: String? = null
                while (found == null) {
                    val line = r.readLine() ?: break
                    found = Regex("""DevTools listening on (ws://\S+)""").find(line)?.groupValues?.get(1)
                }
                Thread { try { r.forEachLine { } } catch (e: Exception) { } }.apply { isDaemon = true; start() }
                found
            }.get(20, TimeUnit.SECONDS) ?: error("Chrome 시작 실패")
            val port = URI.create(wsUrl).port
            val list = JsonParser.parseString(http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port/json/list")).build(),
                HttpResponse.BodyHandlers.ofString()).body()).asJsonArray
            val page = list.map { it.asJsonObject }.firstOrNull { it.get("type").asString == "page" } ?: error("Chrome 페이지 없음")
            cdp = Cdp(page.get("webSocketDebuggerUrl").asString)
            val reqUrls = ConcurrentHashMap<String, String>()
            val loaded = CompletableFuture<Unit>()
            synchronized(cdp.handlers) {
                cdp.handlers += { m, p ->
                    when (m) {
                        "Page.loadEventFired" -> loaded.complete(Unit)
                        "Runtime.exceptionThrown" -> {
                            val d = p.getAsJsonObject("exceptionDetails")
                            val msg = (d.getAsJsonObject("exception")?.get("description")?.asString ?: d.get("text")?.asString ?: "예외").lineSequence().first()
                            val frames = d.getAsJsonObject("stackTrace")?.getAsJsonArray("callFrames")?.take(5)?.map {
                                val f = it.asJsonObject
                                "    at ${f.get("functionName").asString.ifEmpty { "(익명)" }} (${f.get("url").asString}:${f.get("lineNumber").asInt + 1}:${f.get("columnNumber").asInt + 1})"
                            } ?: emptyList()
                            synchronized(c) { c.errors += "Uncaught $msg\n${frames.joinToString("\n")}" }
                        }
                        "Runtime.consoleAPICalled" -> {
                            val type = p.get("type").asString
                            val text = p.getAsJsonArray("args")?.joinToString(" ") { a -> val o = a.asJsonObject; (o.get("value") ?: o.get("description") ?: o.get("unserializableValue"))?.let { v -> if (v.isJsonPrimitive) v.asString else v.toString() } ?: "" } ?: ""
                            val top = p.getAsJsonObject("stackTrace")?.getAsJsonArray("callFrames")?.firstOrNull()?.asJsonObject
                            val where = top?.let { " (${it.get("url").asString}:${it.get("lineNumber").asInt + 1})" } ?: ""
                            synchronized(c) { if (type == "error" || type == "assert") c.errors += "console.error: $text$where" else c.console += "[$type] $text" }
                        }
                        "Log.entryAdded" -> {
                            val e = p.getAsJsonObject("entry")
                            val u = e.get("url")?.asString ?: ""
                            if (e.get("level").asString == "error" && "favicon.ico" !in u) synchronized(c) { c.errors += "${e.get("source").asString}: ${e.get("text").asString}${if (u.isNotEmpty()) " ($u)" else ""}" }
                        }
                        "Network.requestWillBeSent" -> reqUrls[p.get("requestId").asString] = p.getAsJsonObject("request").get("url").asString
                        "Network.responseReceived" -> {
                            val r = p.getAsJsonObject("response")
                            if (r.get("status").asInt >= 400 && "favicon.ico" !in r.get("url").asString) synchronized(c) { c.failed += "${r.get("status").asInt} ${r.get("url").asString}" }
                        }
                        "Network.loadingFailed" -> {
                            val u = reqUrls[p.get("requestId").asString] ?: ""
                            if (p.get("canceled")?.asBoolean != true && "favicon.ico" !in u) synchronized(c) { c.failed += "${p.get("errorText").asString} $u" }
                        }
                    }
                }
            }
            listOf("Runtime.enable", "Log.enable", "Page.enable", "Network.enable").forEach { cdp.send(it) }
            cdp.send("Emulation.setFocusEmulationEnabled", mapOf("enabled" to true))
            cdp.send("Page.addScriptToEvaluateOnNewDocument", mapOf("source" to
                "window.__yangRaf=0;(function(){const o=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){window.__yangRaf++;return o(cb);};})();"))
            cdp.send("Page.navigate", mapOf("url" to url))
            try { loaded.get(15, TimeUnit.SECONDS) } catch (e: Exception) { }
            c.started += "브라우저: ${File(chrome).name} 헤드리스 · $url"
            val seq = keys.ifEmpty { DebugKit.DEFAULT_KEYS }
            val total = (maxOf(seconds, 2.0) * 1000).toLong()
            val t0 = System.currentTimeMillis()
            Thread.sleep(minOf(800L, total / 4))
            for (type in listOf("mousePressed", "mouseReleased")) cdp.send("Input.dispatchMouseEvent", mapOf("type" to type, "x" to 640, "y" to 400, "button" to "left", "clickCount" to 1))
            val gap = maxOf(250L, (total - (System.currentTimeMillis() - t0) - 1200) / maxOf(seq.size, 1))
            for (k in seq) {
                if (cancelled() || System.currentTimeMillis() - t0 > total - 1000) break
                val (key, code, kc) = keyDef(k) ?: continue
                val base = mapOf("key" to key, "code" to code, "windowsVirtualKeyCode" to kc, "nativeVirtualKeyCode" to kc)
                cdp.send("Input.dispatchKeyEvent", base + mapOf("type" to "keyDown", "text" to if (key.length == 1) key else null))
                Thread.sleep(250)
                cdp.send("Input.dispatchKeyEvent", base + mapOf("type" to "keyUp"))
                Thread.sleep(maxOf(0L, gap - 250))
            }
            c.started += "입력: 가운데 클릭 → ${seq.joinToString(", ")}"
            val rest = total - (System.currentTimeMillis() - t0)
            if (rest > 0) Thread.sleep(rest)
            c.frames = cdp.send("Runtime.evaluate", mapOf("expression" to "window.__yangRaf", "returnByValue" to true))
                ?.getAsJsonObject("result")?.get("value")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt
            cdp.send("Page.captureScreenshot", mapOf("format" to "png"))?.get("data")?.asString?.let { c.screenshot = Base64.getDecoder().decode(it) }
        } catch (e: Exception) {
            c.notes += "브라우저 검사 실패: ${e.message}"
        } finally {
            cdp?.close()
            proc.descendants().forEach { it.destroyForcibly() }
            proc.destroyForcibly()
            Thread { Thread.sleep(1500); profile.toFile().deleteRecursively() }.apply { isDaemon = true; start() }
        }
    }

    data class LongRun(val out: String, val code: Int?, val exitedEarly: Boolean, val ready: Boolean)

    /** 시작 → (ready 패턴까지 대기) → N초 → onReady → 종료. */
    private fun longRun(cmd: List<String>, cwd: Path, env: Map<String, String>, seconds: Double, cancelled: () -> Boolean,
                        readyRe: Regex? = null, readyTimeoutMs: Long = 240_000, stdinQuit: String? = null, onReady: ((String) -> Unit)? = null): LongRun {
        val p = try { builder(cmd, cwd, env).start() } catch (e: Exception) { return LongRun(e.toString(), -1, true, false) }
        val out = StringBuilder()
        Thread { try { p.inputStream.bufferedReader().forEachLine { synchronized(out) { out.appendLine(it); if (out.length > 400_000) out.delete(0, 200_000) } } } catch (e: Exception) { } }
            .apply { isDaemon = true; start() }
        fun text() = synchronized(out) { out.toString() }
        var ready = readyRe == null
        val readyDeadline = System.currentTimeMillis() + readyTimeoutMs
        while (!ready && p.isAlive && !cancelled()) {
            Thread.sleep(200)
            if (readyRe!!.containsMatchIn(text())) ready = true
            if (System.currentTimeMillis() > readyDeadline) { synchronized(out) { out.appendLine("[준비 시간 초과 ${readyTimeoutMs / 1000}s]") }; break }
        }
        var stopping = false
        if (ready && p.isAlive) {
            val end = System.currentTimeMillis() + (seconds * 1000).toLong()
            while (p.isAlive && !cancelled() && System.currentTimeMillis() < end) Thread.sleep(150)
            if (p.isAlive) { try { onReady?.invoke(text()) } catch (e: Exception) { } }
        }
        if (p.isAlive) {
            stopping = true
            stdinQuit?.let { try { p.outputStream.write(it.toByteArray()); p.outputStream.flush() } catch (e: Exception) { } }
            try {
                if (Shell.isWindows) p.descendants().forEach { it.destroy() }.also { p.destroy() }
                else ProcessBuilder("kill", "-INT", p.pid().toString()).start().waitFor(2, TimeUnit.SECONDS)
            } catch (e: Exception) { }
            if (!p.waitFor(2500, TimeUnit.MILLISECONDS)) { p.descendants().forEach { it.destroyForcibly() }; p.destroyForcibly(); p.waitFor(3, TimeUnit.SECONDS) }
        }
        Thread.sleep(200)
        return LongRun(text(), if (p.isAlive) null else p.exitValue(), !stopping, ready)
    }

    private val PY_HOOK = """import os, sys, time
_T0 = time.time()
def _yang_hook():
    import importlib.util
    if importlib.util.find_spec("pygame") is None:
        return
    import pygame
    shot, shot_at = os.environ.get("YANG_SHOT"), float(os.environ.get("YANG_SHOT_AT", "5"))
    keys = [k for k in os.environ.get("YANG_KEYS", "").split(",") if k]
    names = {"Enter": "K_RETURN", "Space": "K_SPACE", "ArrowLeft": "K_LEFT", "ArrowRight": "K_RIGHT", "ArrowUp": "K_UP",
             "ArrowDown": "K_DOWN", "Escape": "K_ESCAPE", "Shift": "K_LSHIFT"}
    span = max(shot_at - 1.5, 1.0)
    plan = [(1.0 + i * span / max(len(keys), 1), k) for i, k in enumerate(keys)]
    st = {"frames": 0, "shot": False, "up": [], "clicked": False}
    def _code(k):
        return getattr(pygame, names.get(k, "K_" + k.lower()), None)
    def _after():
        st["frames"] += 1
        t = time.time() - _T0
        try:
            for code in st["up"]:
                pygame.event.post(pygame.event.Event(pygame.KEYUP, key=code, mod=0, unicode="", scancode=0))
            st["up"] = []
            if not st["clicked"] and t > 0.8:
                st["clicked"] = True
                s = pygame.display.get_surface()
                pos = (s.get_width() // 2, s.get_height() // 2) if s else (0, 0)
                pygame.event.post(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=pos, button=1))
                pygame.event.post(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=pos, button=1))
            while plan and plan[0][0] <= t:
                _, k = plan.pop(0)
                code = _code(k)
                if code is not None:
                    pygame.event.post(pygame.event.Event(pygame.KEYDOWN, key=code, mod=0, unicode=" " if k == "Space" else "", scancode=0))
                    st["up"].append(code)
        except Exception:
            pass
        if shot and not st["shot"] and t >= shot_at:
            s = pygame.display.get_surface()
            if s is not None:
                pygame.image.save(s, shot)
                st["shot"] = True
                print(f"[yang] t={t:.1f}s frames={st['frames']} screenshot={s.get_width()}x{s.get_height()}", flush=True)
    for name in ("flip", "update"):
        orig = getattr(pygame.display, name)
        def wrap(*a, _o=orig, **k):
            r = _o(*a, **k)
            _after()
            return r
        setattr(pygame.display, name, wrap)
    import atexit
    def _bye():
        try:
            s = pygame.display.get_surface()
            if shot and not st["shot"] and s is not None:
                pygame.image.save(s, shot)
        except Exception:
            pass
        print(f"[yang] exit t={time.time() - _T0:.1f}s frames={st['frames']}", flush=True)
    atexit.register(_bye)
try:
    _yang_hook()
except Exception as _e:
    print("[yang] hook 실패:", _e, file=sys.stderr)
"""

    private fun playPython(root: Path, req: PlayRequest, files: List<String>, c: Collected, cancelled: () -> Boolean) {
        val py = pythonExe(root) ?: run { c.notes += "파이썬을 찾지 못했습니다"; return }
        val entry = req.target.ifBlank { DebugKit.pickPythonEntry(files) { readRel(root, it) } ?: "" }
        if (entry.isBlank()) { c.notes += "실행할 .py 파일을 찾지 못했습니다 (PLAY python main.py 처럼 지정)"; return }
        val seconds = if (req.seconds > 0) req.seconds else DebugKit.DEFAULT_SECONDS.getValue("python")
        val hookDir = Files.createTempDirectory("yang-py-")
        val shot = hookDir.resolve("shot.png")
        Files.writeString(hookDir.resolve("sitecustomize.py"), PY_HOOK)
        val keys = req.keys.ifEmpty { DebugKit.DEFAULT_KEYS }.joinToString(",")
        val env = mapOf("PYTHONPATH" to listOfNotNull(hookDir.toString(), System.getenv("PYTHONPATH")).joinToString(File.pathSeparator),
            "PYTHONUNBUFFERED" to "1", "PYTHONFAULTHANDLER" to "1", "SDL_VIDEODRIVER" to "dummy", "SDL_AUDIODRIVER" to "dummy",
            "YANG_SHOT" to shot.toString(), "YANG_SHOT_AT" to maxOf(1.0, seconds - 0.7).toString(), "YANG_KEYS" to keys)
        c.started += "실행: ${File(py).name} $entry (창 없이 · ${seconds}초 · 입력 $keys)"
        val r = longRun(listOf(py, entry), root, env, seconds, cancelled)
        val tbAt = r.out.lastIndexOf("Traceback (most recent call last)")
        val tb = if (tbAt >= 0) r.out.substring(tbAt).lines().filter { !it.startsWith("[yang]") }.take(40).joinToString("\n").trim() else ""
        val stoppedByUs = !r.exitedEarly && Regex("""KeyboardInterrupt\s*$""").containsMatchIn(tb)
        if (tb.isNotEmpty() && !stoppedByUs) c.errors += tb
        else if (r.exitedEarly && r.code != 0) c.errors += "프로세스가 ${seconds}초 전에 종료됨 (exit ${r.code})"
        else if (r.exitedEarly) c.notes += "프로그램이 ${seconds}초 전에 스스로 끝났습니다 (게임 루프가 바로 종료됐을 수 있음)"
        val outText = if (stoppedByUs && tbAt >= 0) r.out.substring(0, tbAt) + r.out.substring(maxOf(tbAt, r.out.lastIndexOf("[yang] exit"))) else r.out
        c.console += outText.lines().filter { it.isNotBlank() && !Regex("""^pygame(-ce)? \d|Hello from the pygame community""").containsMatchIn(it) }.takeLast(40)
        Regex("""\[yang] .*?frames=(\d+)""").findAll(r.out).lastOrNull()?.let { c.frames = it.groupValues[1].toInt() }
        if (Files.exists(shot)) c.screenshot = Files.readAllBytes(shot)
        else if (c.errors.isEmpty() && Regex("import pygame|from pygame").containsMatchIn(readRel(root, entry) ?: "")) c.notes += "pygame 화면을 캡처하지 못했습니다 (pygame.display.flip/update 가 호출되지 않았을 수 있음)"
        hookDir.toFile().deleteRecursively()
    }

    private fun playWeb(root: Path, req: PlayRequest, files: List<String>, c: Collected, cancelled: () -> Boolean) {
        val seconds = if (req.seconds > 0) req.seconds else DebugKit.DEFAULT_SECONDS.getValue("web")
        if (Regex("^https?://").containsMatchIn(req.target)) { webCapture(req.target, seconds, req.keys, c, cancelled); return }
        val pkg = readRel(root, "package.json")
        val bundler = pkg != null && Regex("vite|webpack|parcel|react-scripts|next|phaser").containsMatchIn(pkg)
        val devScript = when {
            pkg != null && Regex(""""dev"\s*:""").containsMatchIn(pkg) -> "dev"
            pkg != null && Regex(""""start"\s*:""").containsMatchIn(pkg) && bundler -> "start"
            else -> ""
        }
        if (devScript.isNotEmpty() && bundler && (req.target.isBlank() || req.target == "index.html")) {
            c.started += "dev 서버: npm run $devScript"
            var pageUrl = ""
            val r = longRun(Shell.command("npm run $devScript"), root, mapOf("BROWSER" to "none", "CI" to "1"), 0.1, cancelled,
                readyRe = Regex("""https?://(localhost|127\.0\.0\.1|\[::1]):\d+"""), readyTimeoutMs = 60_000) { out ->
                pageUrl = Regex("""https?://(?:localhost|127\.0\.0\.1|\[::1]):\d+/?\S*""").find(out.replace(Regex("\u001b\\[[0-9;]*m"), ""))?.value?.replace("[::1]", "127.0.0.1") ?: ""
                if (pageUrl.isNotEmpty()) webCapture(pageUrl, seconds, req.keys, c, cancelled)
            }
            val devErrors = DebugKit.errorLines(r.out.replace(Regex("\u001b\\[[0-9;]*m"), ""), 10)
            if (pageUrl.isEmpty()) c.errors += "dev 서버가 주소를 출력하지 않았습니다:\n${r.out.takeLast(1500)}"
            else if (devErrors.isNotEmpty()) c.errors += "dev 서버 오류:\n${devErrors.joinToString("\n")}"
            return
        }
        val html = req.target.ifBlank {
            listOf("index.html", "public/index.html", "src/index.html", "web/index.html", "www/index.html").firstOrNull { it in files }
                ?: files.firstOrNull { Regex("""(^|/)index\.html$""").containsMatchIn(it) } ?: ""
        }
        if (html.isBlank()) { c.notes += "index.html 을 찾지 못했습니다 (PLAY web 경로.html 또는 URL 로 지정)"; return }
        val srv = staticServer(root)
        try {
            webCapture("http://127.0.0.1:${srv.address.port}/${html.split('/').joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }}", seconds, req.keys, c, cancelled)
        } finally { srv.stop(0) }
    }

    private fun playFlutter(root: Path, req: PlayRequest, c: Collected, cancelled: () -> Boolean) {
        val flutter = which("flutter") ?: run { c.notes += "flutter 명령을 찾지 못했습니다"; return }
        var device = req.target
        if (device.isBlank()) {
            val d = proc(listOf(flutter, "devices", "--machine"), root, timeoutMs = 60_000)
            device = try {
                val ok = JsonParser.parseString(d.out.substring(d.out.indexOf('['))).asJsonArray.map { it.asJsonObject }.filter { it.get("isSupported")?.asBoolean != false }
                (ok.firstOrNull { it.get("targetPlatform").asString.startsWith("android") } ?: ok.firstOrNull { it.get("id").asString == "macos" }
                    ?: ok.firstOrNull { it.get("id").asString == "chrome" } ?: ok.firstOrNull())?.get("id")?.asString ?: ""
            } catch (e: Exception) { "" }
        }
        if (device.isBlank()) { c.notes += "실행할 기기가 없습니다 (안드로이드 에뮬레이터를 켜거나 PLAY flutter <기기ID>)"; return }
        val seconds = if (req.seconds > 0) req.seconds else DebugKit.DEFAULT_SECONDS.getValue("flutter")
        c.started += "flutter run -d $device (빌드 후 ${seconds}초 관찰)"
        val adb = if (device.startsWith("emulator") || (device !in setOf("macos", "chrome", "linux", "windows") && Regex("""^[\w-]{6,}$""").matches(device))) which("adb") else null
        val r = longRun(listOf(flutter, "run", "-d", device), root, emptyMap(), seconds, cancelled,
            readyRe = Regex("Flutter run key commands|To hot reload|A Dart VM Service|Dart DevTools debugger"), readyTimeoutMs = 420_000, stdinQuit = "q") {
            if (adb != null) {
                proc(listOf(adb, "-s", device, "shell", "input", "tap", "540", "1200"), timeoutMs = 5000)
                Thread.sleep(1500)
                try {
                    val pr = ProcessBuilder(adb, "-s", device, "exec-out", "screencap", "-p").start()
                    val bytes = pr.inputStream.readAllBytes()
                    if (pr.waitFor(10, TimeUnit.SECONDS) && bytes.size > 1000) c.screenshot = bytes
                } catch (e: Exception) { }
            }
        }
        if (!r.ready) c.errors += "앱이 시작되지 않았습니다 (빌드 실패 가능):\n${DebugKit.errorLines(r.out, 25).joinToString("\n").ifBlank { r.out.takeLast(2500) }}"
        for (m in Regex("""══╡ EXCEPTION CAUGHT[\s\S]*?(?=\n═{20,}|$)""").findAll(r.out)) {
            c.errors += m.value.lines().filter { !Regex("""^#\d+\s+.*\((package:flutter/|dart:)|^\.\.\.\s+\w+ element""").containsMatchIn(it.trim()) }.take(30).joinToString("\n")
        }
        r.out.lines().filter { Regex("E/flutter|Unhandled Exception|Another exception was thrown").containsMatchIn(it) }.takeIf { it.isNotEmpty() }?.let { c.errors += it.take(15).joinToString("\n") }
        c.console += r.out.lines().filter { Regex("""^(I/flutter|flutter:)""").containsMatchIn(it.trim()) }.takeLast(25)
        if (c.screenshot == null && r.ready) c.notes += if (adb != null) "화면 캡처 실패" else "이 기기($device)는 화면 캡처를 지원하지 않아 화면 분석을 건너뜀 (안드로이드 에뮬레이터에서 가능)"
    }

    private fun playGodot(root: Path, req: PlayRequest, c: Collected, cancelled: () -> Boolean) {
        val bin = godotBin() ?: run { c.notes += "Godot 실행 파일을 찾지 못했습니다 (PATH 의 godot 또는 /Applications/Godot.app)"; return }
        val seconds = if (req.seconds > 0) req.seconds else DebugKit.DEFAULT_SECONDS.getValue("godot")
        val args = mutableListOf(bin, "--headless", "--path", root.toString(), "--quit-after", (seconds * 60).toInt().toString())
        if (req.target.isNotBlank()) args += if (req.target.startsWith("res://")) req.target else "res://${req.target}"
        c.started += "godot ${args.drop(1).joinToString(" ")} (화면 없이)"
        val r = longRun(args, root, emptyMap(), seconds + 20, cancelled)
        c.errors += Regex("""(SCRIPT ERROR|Parse Error|ERROR|USER ERROR):[^\n]*(\n\s+at:[^\n]*)*""").findAll(r.out).map { it.value }.distinct().take(12)
        c.console += r.out.lines().filter { it.isNotBlank() && !it.startsWith("Godot Engine v") }.takeLast(30)
        c.notes += "Godot 헤드리스 실행은 화면을 캡처하지 않습니다"
    }

    private fun playUnity(root: Path, c: Collected, cancelled: () -> Boolean) {
        val ver = Regex("""m_EditorVersion:\s*(\S+)""").find(readRel(root, "ProjectSettings/ProjectVersion.txt") ?: "")?.groupValues?.get(1)
        val home = System.getProperty("user.home")
        val os = System.getProperty("os.name").lowercase()
        val editorLog = when { "mac" in os -> "$home/Library/Logs/Unity/Editor.log"; "win" in os -> "${System.getenv("LOCALAPPDATA")}/Unity/Editor/Editor.log"; else -> "$home/.config/unity3d/Editor.log" }
        if (Files.exists(root.resolve("Temp/UnityLockfile")) && exists(editorLog)) {
            val log = File(editorLog).readLines().takeLast(1500).joinToString("\n")
            c.started += "Unity 에디터 실행 중 → Editor.log 최근 내용 분석 ($editorLog)"
            c.errors += Regex("""^.*(error CS\d+|Exception|Error)[^\n]*(\n(?:UnityEngine\.|.*\(at Assets/)[^\n]*)*""", RegexOption.MULTILINE).findAll(log).map { it.value }.distinct().toList().takeLast(12)
            c.notes += "Unity 에서 Play 를 눌러 재현한 뒤 다시 PLAY unity 를 실행하면 그 실행의 오류를 읽습니다"
            return
        }
        val bin = when { "mac" in os -> "/Applications/Unity/Hub/Editor/$ver/Unity.app/Contents/MacOS/Unity"; "win" in os -> "C:\\Program Files\\Unity\\Hub\\Editor\\$ver\\Editor\\Unity.exe"; else -> "$home/Unity/Hub/Editor/$ver/Editor/Unity" }
        if (ver == null || !exists(bin)) { c.notes += "Unity 에디터(${ver ?: "버전 모름"})를 찾지 못했습니다"; return }
        c.started += "Unity $ver batchmode 로 스크립트 컴파일 검사 (수 분 걸릴 수 있음)"
        val r = proc(listOf(bin, "-batchmode", "-nographics", "-quit", "-projectPath", root.toString(), "-logFile", "-"), root, timeoutMs = 900_000, cancelled = cancelled)
        c.errors += r.out.lines().filter { Regex("error CS\\d+|Scripts have compiler errors|Compilation failed").containsMatchIn(it) }.distinct().take(20)
        c.notes += "Unity 는 batchmode 에서 게임을 실행하지 않습니다 (컴파일 오류만 검사). 런타임 오류는 에디터에서 Play 후 PLAY unity"
    }

    private fun playCmd(root: Path, req: PlayRequest, c: Collected, cancelled: () -> Boolean) {
        if (req.target.isBlank()) { c.notes += "실행할 명령이 없습니다 (PLAY cmd npm start 15)"; return }
        val seconds = if (req.seconds > 0) req.seconds else DebugKit.DEFAULT_SECONDS.getValue("cmd")
        c.started += "명령: ${req.target} (${seconds}초)"
        val r = longRun(Shell.command(req.target), root, mapOf("BROWSER" to "none", "CI" to "1"), seconds, cancelled) { out ->
            Regex("""https?://(?:localhost|127\.0\.0\.1):\d+/?\S*""").find(out.replace(Regex("\u001b\\[[0-9;]*m"), ""))?.value?.let { webCapture(it, minOf(seconds, 10.0), req.keys, c, cancelled) }
        }
        val clean = r.out.replace(Regex("\u001b\\[[0-9;]*m"), "")
        c.console += clean.lines().filter { it.isNotBlank() }.takeLast(30)
        DebugKit.errorLines(clean, 15).takeIf { it.isNotEmpty() }?.let { c.errors += it.joinToString("\n") }
        if (r.exitedEarly && r.code != null && r.code != 0) c.errors += "명령이 ${seconds}초 전에 실패로 종료됨 (exit ${r.code})"
    }

    private fun inspectScreen(png: ByteArray, expect: String, kind: String): String = try {
        Clients.post("/api/vision/inspect", mapOf("image" to Base64.getEncoder().encodeToString(png), "expect" to expect, "context" to kind), 180).get("text")?.asString ?: ""
    } catch (e: Exception) { "(화면 분석 실패: ${e.message})" }

    fun runPlay(root: Path, req: PlayRequest, cancelled: () -> Boolean, progress: (String) -> Unit): PlayResult {
        val files = listFiles(root)
        val kind = if (req.kind == "auto") DebugKit.detectPlayKind(files) { readRel(root, it) } ?: "cmd" else req.kind
        val c = Collected()
        progress("$kind 실행 중…")
        when (kind) {
            "web" -> playWeb(root, req, files, c, cancelled)
            "python" -> playPython(root, req, files, c, cancelled)
            "flutter" -> playFlutter(root, req, c, cancelled)
            "godot" -> playGodot(root, req, c, cancelled)
            "unity" -> playUnity(root, c, cancelled)
            else -> playCmd(root, req, c, cancelled)
        }
        val resolve = DebugKit.makeResolver(root.toString(), files)
        val lines = mutableListOf("[PLAY $kind${if (req.target.isNotBlank()) " " + req.target else ""}]")
        lines += c.started.map { "- $it" }
        if (c.errors.isNotEmpty()) {
            lines += "\n오류 ${c.errors.size}개:"
            c.errors.take(10).forEach { lines += DebugKit.clip(it, 1500) }
        } else lines += "\n오류: 없음"
        val locs = DebugKit.traceLocations(c.errors.joinToString("\n"), resolve, 4)
        if (locs.isNotEmpty()) {
            lines += "\n오류 위치 코드:"
            for (l in locs) readRel(root, l.file)?.let { lines += "--- ${l.file}:${l.line} ---\n${DebugKit.excerpt(it, l.line, 4)}" }
        }
        if (c.failed.isNotEmpty()) lines += "\n리소스 로드 실패 ${c.failed.size}개 (경로·파일명 확인):\n" + c.failed.distinct().take(10).joinToString("\n") { "- $it" }
        c.frames?.let { f ->
            val secs = if (req.seconds > 0) req.seconds else DebugKit.DEFAULT_SECONDS[kind] ?: 8.0
            val note = when {
                f == 0 -> " ⚠ 게임 루프가 돌지 않음 (requestAnimationFrame/flip 호출 없음)"
                c.errors.isNotEmpty() -> " — 오류가 난 시점에 루프가 멈췄을 수 있음 (위 오류부터 확인)"
                f / secs < 20 -> " (약 ${(f / secs).toInt()}fps ⚠ 느리거나 중간에 멈춤)"
                else -> " (약 ${(f / secs).toInt()}fps)"
            }
            lines += "\n프레임: ${f}회$note"
        }
        if (c.console.isNotEmpty()) lines += "\n콘솔·출력 (마지막 ${minOf(c.console.size, 20)}줄):\n" + c.console.takeLast(20).joinToString("\n") { DebugKit.clip(it, 300) }
        c.screenshot?.let {
            progress("실행 화면 분석 중 (비전 모델)…")
            lines += "\n화면 분석 (${if (req.expect.isNotBlank()) "기대: " + req.expect else "실행 마지막 화면"}):\n" + inspectScreen(it, req.expect, kind)
        }
        if (c.notes.isNotEmpty()) lines += "\n참고:\n" + c.notes.joinToString("\n") { "- $it" }
        return PlayResult(lines.joinToString("\n"), c.errors.size + c.failed.size)
    }
}
