package com.localagent

import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64

/**
 * 프로젝트 아트 컨셉 (VS Code art.ts 와 같은 동작): 문서·코드 힌트·기존 그림을 모아 서버(/api/art)에서 분석,
 * 모든 IMAGE 생성에 자동 적용. /assets: 코드가 쓰는데 파일이 없는 그림 (그림 하네스).
 */
object Art {
    private val DOC_RE = Regex("""(^|/)(readme[^/]*|design[^/]*|gdd[^/]*|concept[^/]*|story[^/]*|기획[^/]*|컨셉[^/]*)\.(md|txt)$""", RegexOption.IGNORE_CASE)
    private val IMG_RE = Regex("""\.(png|jpe?g|webp)$""", RegexOption.IGNORE_CASE)
    private val HINT_RE = Regex("""\b(width|height|tile_?size|tileSize|sprite_?size|canvas|screen_?(w|h|width|height)|resolution|SCALE|FPS|title|game_?name)\b\s*[:=]""", RegexOption.IGNORE_CASE)
    private val analyzed = HashSet<String>()

    fun projectName(root: Path) = root.fileName.toString()

    private fun read(root: Path, rel: String, max: Int) = try { Files.readString(root.resolve(rel)).take(max) } catch (e: Exception) { "" }

    fun collect(root: Path, userConcept: String = ""): Map<String, Any> {
        val files = DebugRunner.listFiles(root, 4000)
        val docs = files.filter { DOC_RE.containsMatchIn(it) }.take(6).associateWith { read(root, it, 2500) }
        val hints = mutableListOf<String>()
        for (f in files.filter { Regex("""\.(py|m?jsx?|tsx?|dart|gd|cs|lua|json|ya?ml|toml|kt|java)$""", RegexOption.IGNORE_CASE).containsMatchIn(it) && "package-lock" !in it }.take(300)) {
            if (hints.size >= 60) break
            read(root, f, 60_000).lines().forEachIndexed { i, l -> if (hints.size < 60 && l.length < 200 && HINT_RE.containsMatchIn(l)) hints += "$f:${i + 1}: ${l.trim()}" }
        }
        val imgs = files.filter { IMG_RE.containsMatchIn(it) && !Regex("""(^|/)(\.yang|build|dist|node_modules)/""").containsMatchIn(it) }
            .sortedByDescending { Regex("""(assets|sprites?|images?|art|textures?)/""", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        val images = mutableListOf<Map<String, String>>()
        for (f in imgs) {
            if (images.size >= 4) break
            val p = root.resolve(f)
            val size = try { Files.size(p) } catch (e: Exception) { continue }
            if (size < 300 || size > 3_000_000) continue
            images += mapOf("path" to f, "data" to Base64.getEncoder().encodeToString(Files.readAllBytes(p)))
        }
        return mapOf("project" to projectName(root), "files" to files.take(400), "docs" to docs, "code_hints" to hints.joinToString("\n"),
            "images" to images, "user_concept" to userConcept)
    }

    private fun writeLocal(root: Path, markdown: String) = try {
        Files.createDirectories(root.resolve(".yang"))
        Files.writeString(root.resolve(".yang/.gitignore"), "*\n")
        Files.writeString(root.resolve(".yang/art-style.md"), markdown)
    } catch (e: Exception) { null }

    fun analyze(root: Path, userConcept: String = ""): String {
        val md = Clients.post("/api/art/analyze", collect(root, userConcept), 300).get("markdown").asString
        writeLocal(root, md)
        return md
    }

    fun revise(root: Path, instruction: String): String {
        val md = Clients.put("/api/art/${java.net.URLEncoder.encode(projectName(root), "UTF-8").replace("+", "%20")}", mapOf("instruction" to instruction), 300).get("markdown").asString
        writeLocal(root, md)
        return md
    }

    fun get(root: Path): String? = try {
        Clients.get("/api/art/${java.net.URLEncoder.encode(projectName(root), "UTF-8").replace("+", "%20")}").get("markdown")?.asString
    } catch (e: Exception) { null }

    /** IMAGE 생성 전에 한 번: 아트 컨셉이 없으면 자동 분석 */
    fun ensure(root: Path, log: (String) -> Unit) {
        if (!analyzed.add(root.toString())) return
        if (get(root) != null) return
        log("[아트 컨셉] 없음 → 프로젝트를 분석해 만드는 중…")
        try { analyze(root); log("[아트 컨셉] 저장함 (.yang/art-style.md)") } catch (e: Exception) { log("[아트 컨셉] 분석 실패: ${e.message}") }
    }

    /** 그림 하네스: 코드가 쓰는데 파일이 없는 그림 경로 */
    fun missingAssets(root: Path): List<DebugKit.AssetRef> {
        val files = DebugRunner.listFiles(root, 8000)
        val set = files.toHashSet()
        return files.filter { Regex("""\.(m?jsx?|tsx?|py|dart|gd|cs|html?|lua|kt|java)$""", RegexOption.IGNORE_CASE).containsMatchIn(it) }.take(600)
            .flatMap { f -> DebugKit.assetRefs(f, read(root, f, 200_000)) }
            .filter { Regex("""\.(png|jpe?g|webp|gif)$""", RegexOption.IGNORE_CASE).containsMatchIn(it.ref) && !DebugKit.assetExists(it, set) }
            .distinctBy { it.ref }
    }
}
