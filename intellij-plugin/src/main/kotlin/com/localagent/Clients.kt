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

/** FastAPI 백엔드 / Rust 엔진 HTTP 클라이언트. */
object Clients {
    val gson = Gson()
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .version(HttpClient.Version.HTTP_1_1)
        .build()

    private fun call(url: String, method: String, body: Any?, timeoutSec: Long): JsonObject {
        val builder = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(timeoutSec))
            .header("Content-Type", "application/json")
        val req = if (method == "POST") builder.POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body ?: emptyMap<String, Any>())))
        else builder.GET()
        val res = http.send(req.build(), HttpResponse.BodyHandlers.ofString())
        val json = if (res.body().isNullOrBlank()) JsonObject() else JsonParser.parseString(res.body()).asJsonObject
        if (res.statusCode() >= 400) {
            val detail = json.get("detail")?.let { if (it.isJsonPrimitive) it.asString else it.toString() }
                ?: json.get("error")?.asString ?: "HTTP ${res.statusCode()}"
            throw HttpError(res.statusCode(), detail)
        }
        return json
    }

    // ---- 백엔드 ----
    fun get(path: String, timeoutSec: Long = 30) = call(AgentSettings.current.backendUrl + path, "GET", null, timeoutSec)
    fun post(path: String, body: Any, timeoutSec: Long = 30) = call(AgentSettings.current.backendUrl + path, "POST", body, timeoutSec)
    fun backendAlive(): Boolean = runCatching { get("/api/health", 2) }.isSuccess

    // ---- 엔진 ----
    fun engineHealth(): JsonObject? = runCatching { call(AgentSettings.current.engineUrl + "/health", "GET", null, 2) }.getOrNull()

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
        val req = HttpRequest.newBuilder(URI.create(AgentSettings.current.engineUrl + "/generate"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body)))
            .build()
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
        val root = findAgentRoot(projectBase)
            ?: return "백엔드가 꺼져 있고 AI-agent 폴더를 모릅니다. Settings → Tools → Local Coding Agent 에서 폴더를 지정하세요."
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
