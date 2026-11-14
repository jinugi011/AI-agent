package com.localagent

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

data class ChatMessage(val role: String, val content: String)
data class GenerateStats(val completionTokens: Int, val tokensPerSecond: Double)

class HttpError(val status: Int, message: String) : RuntimeException(message)

/** FastAPI 백엔드 / Rust 엔진 HTTP 클라이언트.
 *  로컬 모드: 백엔드·엔진에 직접. 원격 모드: Cloudflare Tunnel 주소(serverUrl)의 백엔드 하나로, LLM 도 백엔드가 중계. */
object Clients {
    @Volatile var lastBackendError: String = ""

    val remote: Boolean get() = AgentSettings.current.mode == "remote"
    private val backendBase: String get() = (if (remote) AgentSettings.current.serverUrl else AgentSettings.current.backendUrl).trimEnd('/')

    /** 원격 모드 인증 헤더 (토큰은 IntelliJ PasswordSafe = macOS 키체인에 보관) */
    private fun authHeaders(): Map<String, String> {
        if (!remote) return emptyMap()
        val h = mutableMapOf<String, String>()
        AgentSecrets.get(AgentSecrets.TOKEN)?.takeIf { it.isNotBlank() }?.let { h["Authorization"] = "Bearer $it" }
        val id = AgentSecrets.get(AgentSecrets.CF_ID)
        val sec = AgentSecrets.get(AgentSecrets.CF_SECRET)
        if (!id.isNullOrBlank() && !sec.isNullOrBlank()) { h["CF-Access-Client-Id"] = id; h["CF-Access-Client-Secret"] = sec }
        return h
    }
    val gson = Gson()
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .version(HttpClient.Version.HTTP_1_1)
        .build()

    private fun call(url: String, method: String, body: Any?, timeoutSec: Long, auth: Boolean = true): JsonObject {
        if (url.startsWith("/")) throw HttpError(0, "원격 서버 주소가 설정되지 않았습니다 (Settings → Tools → Yang Coding)")
        val builder = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(timeoutSec))
            .header("Content-Type", "application/json")
        if (auth) authHeaders().forEach { (k, v) -> builder.header(k, v) }
        val req = if (method == "POST") builder.POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body ?: emptyMap<String, Any>())))
        else builder.GET()
        val res = http.send(req.build(), HttpResponse.BodyHandlers.ofString())
        val json = try {
            if (res.body().isNullOrBlank()) JsonObject() else JsonParser.parseString(res.body()).asJsonObject
        } catch (e: Exception) {
            throw HttpError(res.statusCode(), if (res.statusCode() == 403 || "cloudflareaccess" in res.body())
                "Cloudflare Access 가 요청을 막았습니다 (서비스 토큰 확인)" else "JSON 이 아닌 응답 (HTTP ${res.statusCode()})")
        }
        if (res.statusCode() >= 400) {
            val detail = json.get("detail")?.let { if (it.isJsonPrimitive) it.asString else it.toString() }
                ?: json.get("error")?.asString ?: "HTTP ${res.statusCode()}"
            throw HttpError(res.statusCode(), detail)
        }
        return json
    }

    // ---- 백엔드 ----
    fun get(path: String, timeoutSec: Long = 30) = call(backendBase + path, "GET", null, timeoutSec)
    fun post(path: String, body: Any, timeoutSec: Long = 30) = call(backendBase + path, "POST", body, timeoutSec)
    fun backendAlive(): Boolean = runCatching { get("/api/health", if (remote) 8 else 2) }
        .onSuccess { lastBackendError = "" }
        .onFailure { lastBackendError = if ((it as? HttpError)?.status == 401) "API 토큰이 없거나 틀립니다" else (it.message ?: it.toString()) }
        .isSuccess

    // ---- 엔진 ----
    /** 모델 정보가 있는 응답만 엔진으로 인정 (같은 포트의 다른 서버를 착각하지 않도록). */
    fun engineHealth(): JsonObject? {
        if (remote) { // 원격: 엔진은 서버 localhost 에만 있으므로 백엔드에 상태를 묻는다
            val st = runCatching { get("/api/engine/status", 8) }.getOrNull() ?: return null
            val model = st.get("model")?.takeIf { it.isJsonObject }?.asJsonObject
            return if (st.get("online")?.asBoolean == true && model?.has("model_name") == true) JsonObject().apply { add("model", model) } else null
        }
        return runCatching { call(AgentSettings.current.engineUrl.trimEnd('/') + "/health", "GET", null, 2, auth = false) }.getOrNull()
            ?.takeIf { it.get("model")?.takeIf { m -> m.isJsonObject }?.asJsonObject?.has("model_name") == true }
    }

    /** 스트리밍 생성. cancel 핸들의 스트림을 닫으면 연결이 끊겨 엔진도 생성을 멈춘다. */
    fun stream(
        messages: List<ChatMessage>,
        maxTokens: Int,
        temperature: Double,
        cancel: AtomicReference<InputStream?>,
        isCancelled: () -> Boolean,
        onToken: (String) -> Unit,
    ): Pair<String, GenerateStats?> {
        val body = mapOf("messages" to messages, "max_tokens" to maxTokens, "temperature" to temperature, "stream" to true)
        val url = if (remote) "$backendBase/api/llm/generate" else AgentSettings.current.engineUrl.trimEnd('/') + "/generate"
        val rb = HttpRequest.newBuilder(URI.create(url))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body)))
        authHeaders().forEach { (k, v) -> rb.header(k, v) }
        val req = rb.build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofInputStream())
        if (res.statusCode() >= 400) throw HttpError(res.statusCode(), "엔진 오류: " + res.body().readAllBytes().decodeToString())
        val input = res.body()
        cancel.set(input)
        val text = StringBuilder()
        var stats: GenerateStats? = null
        try {
            input.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (line in lines) {
                    if (isCancelled()) break
                    if (line.isBlank()) continue
                    val ev = JsonParser.parseString(line).asJsonObject
                    when {
                        ev.has("token") -> { val t = ev.get("token").asString; text.append(t); onToken(t) }
                        ev.has("done") -> {
                            ev.get("error")?.let { throw RuntimeException(it.asString) }
                            stats = GenerateStats(ev.get("completion_tokens")?.asInt ?: 0, ev.get("tokens_per_second")?.asDouble ?: 0.0)
                        }
                    }
                }
            }
        } catch (e: java.io.IOException) {
            if (!isCancelled()) throw e
        } finally {
            cancel.set(null)
        }
        return text.toString() to stats
    }
}

/** 백엔드(FastAPI) 자동 실행: 설정 → 프로젝트 폴더 순으로 AI-agent 루트를 찾는다. */
object BackendLauncher {
    @Volatile private var process: Process? = null

    /** install.sh 가 기록한 설치 위치 (~/.config/local-agent/config.json). */
    private fun installedRoot(): String? = runCatching {
        val file = File(System.getProperty("user.home"), ".config/local-agent/config.json")
        JsonParser.parseString(file.readText()).asJsonObject.get("agentRoot")?.asString
    }.getOrNull()

    fun findAgentRoot(projectBase: String?): String? {
        fun isRoot(p: String) = File(p, "backend/app/main.py").exists() && File(p, "engine").isDirectory
        return listOfNotNull(AgentSettings.current.agentRoot.ifBlank { null }, installedRoot(), projectBase).firstOrNull { isRoot(it) }
    }

    /** @return null 이면 성공, 아니면 오류 메시지 */
    fun ensureRunning(projectBase: String?): String? {
        if (Clients.backendAlive()) return null
        if (Clients.remote) return "원격 서버에 연결할 수 없습니다: ${Clients.lastBackendError} (Settings → Tools → Yang Coding)"
        val root = findAgentRoot(projectBase)
            ?: return "백엔드가 꺼져 있고 AI-agent 폴더를 모릅니다. Settings → Tools → Yang Coding 에서 폴더를 지정하세요."
        val uvicorn = File(root, "backend/.venv/bin/uvicorn")
        if (!uvicorn.exists()) return "백엔드 가상환경이 없습니다: $uvicorn"
        val port = URI.create(AgentSettings.current.backendUrl).port.takeIf { it > 0 } ?: 8010
        synchronized(this) {
            if (process?.isAlive != true) {
                val log = File(root, "backend/data/agent_state/backend-intellij.log").apply { parentFile.mkdirs() }
                process = ProcessBuilder(uvicorn.path, "app.main:app", "--host", "127.0.0.1", "--port", port.toString())
                    .directory(File(root, "backend"))
                    .redirectErrorStream(true)
                    .redirectOutput(log)
                    .start()
            }
        }
        repeat(60) {
            TimeUnit.SECONDS.sleep(1)
            if (Clients.backendAlive()) return null
            if (process?.isAlive == false) return "백엔드가 시작 중 종료되었습니다. backend/data/agent_state/backend-intellij.log 확인"
        }
        return "백엔드 시작 시간 초과"
    }

    fun stop() {
        process?.destroy() // 플러그인이 직접 띄운 백엔드만 종료
    }
}
