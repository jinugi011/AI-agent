package com.localagent

import java.net.InetAddress
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

object Workflow {
    fun request(text: String): Pair<String, Boolean> {
        val match = Regex("^(?:하네스|harness)(?:\\s+|$)([\\s\\S]*)", RegexOption.IGNORE_CASE).find(text.trim())
        return (match?.groupValues?.get(1) ?: text).trim() to (match != null)
    }

    fun generate(goal: String, project: String, harness: Boolean, cancelled: () -> Boolean, notice: (String) -> Unit): String {
        val run = Clients.post("/api/langchain/runs", mapOf("goal" to goal, "project" to project,
            "mode" to if (harness) "harness" else "implementation", "review" to true, "retrieval" to project.isNotBlank()))
        notice("서버에서 LangChain으로 요구사항을 구성합니다…")
        val deadline = System.currentTimeMillis() + 1800_000
        while (System.currentTimeMillis() < deadline) {
            if (cancelled()) error("중단됨 (서버의 명세 생성은 계속될 수 있습니다)")
            val job = Clients.get("/api/langchain/runs/${run.get("id").asString}")
            when (job.get("status").asString) {
                "error" -> error(job.get("error").asString)
                "done" -> {
                    job.getAsJsonObject("result").getAsJsonArray("warnings")?.forEach { notice(it.asString) }
                    return "사용자 요구사항:\n$goal\n\n아래 명세에 따라 현재 열린 프로젝트에서 구현하고 검증하세요.\n${job.getAsJsonObject("result").get("output").asString}"
                }
            }
            Thread.sleep(1500)
        }
        error("LangChain 응답 대기 시간이 초과되었습니다")
    }
}

class RemoteWorkInbox(
    private val root: Path,
    private val busy: () -> Boolean,
    private val approve: (String, () -> Boolean) -> Boolean,
    private val run: (String, Boolean) -> Unit,
    private val cancel: () -> Unit,
    private val notice: (String) -> Unit,
) : AutoCloseable {
    private val id = UUID.randomUUID().toString().replace("-", "")
    private val key = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "")
    private val receiving = AtomicBoolean(false)
    private data class Execution(val id: String, val lease: String,
        @Volatile var lastResponse: Long = System.currentTimeMillis(),
        @Volatile var stopping: Boolean = false,
        @Volatile var executing: Boolean = false,
        @Volatile var report: Pair<String, String>? = null)
    @Volatile private var active: Execution? = null
    @Volatile private var closed = false
    private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "remote-work-heartbeat").apply { isDaemon = true } }

    init { timer.scheduleWithFixedDelay({ runCatching { tick() } }, 1, 10, TimeUnit.SECONDS) }

    private fun requestStop() {
        val current = active ?: return
        if (current.report != null || current.stopping) return
        current.stopping = true
        if (current.executing) cancel()
        notice("원격 작업을 중단합니다. 연결 복구 후에도 자동 재실행하지 않습니다.")
    }

    @Synchronized private fun maintainActive() {
        val current = active ?: return
        val path = "/api/remote/work/tasks/${current.id}"
        val credentials = mapOf("key" to key, "lease_token" to current.lease)
        try {
            val state = Clients.post("$path/heartbeat", credentials, 5)
            current.lastResponse = System.currentTimeMillis()
            val stop = state.get("should_stop").asBoolean
            if (stop) requestStop()
            current.report?.let { report ->
                val result = if (stop && state.get("status").asString !in setOf("completed", "failed", "rejected", "cancelled"))
                    "cancelled" to "이전 실행 루틴의 종료를 확인했습니다. 현재 파일 상태를 확인한 뒤 명시적으로 재개하세요." else report
                Clients.post(path, credentials + mapOf("status" to result.first, "detail" to result.second.take(2000)), 5)
                if (active === current) active = null
            }
        } catch (e: Exception) {
            val fenced = (e as? HttpError)?.status in setOf(403, 404, 409)
            if (fenced || System.currentTimeMillis() - current.lastResponse >= 60_000) requestStop()
            if (current.report != null && fenced && active === current) {
                active = null
                notice("이전 실행의 결과 보고를 종료했습니다. 서버 작업 상태를 확인하세요.")
            }
        }
    }

    private fun tick() {
        if (closed) return
        if (!Clients.remote) { requestStop(); maintainActive(); return }
        runCatching { Clients.post("/api/remote/work/agents", mapOf("id" to id, "key" to key,
            "project" to RemoteIndex.projectName(root), "workspace" to root.toString(),
            "protocol_version" to 2,
            "label" to "JetBrains · ${runCatching { InetAddress.getLocalHost().hostName }.getOrDefault("PC")}"), 5) }
        maintainActive()
        if (active != null || busy() || !receiving.compareAndSet(false, true)) return
        Thread({
            try {
                val item = Clients.post("/api/remote/work/agents/$id/claim", mapOf("key" to key), 5).get("task")
                if (item == null || item.isJsonNull) return@Thread
                val task = item.asJsonObject
                val current = Execution(task.get("id").asString, task.get("lease_token").asString)
                active = current
                fun report(status: String, detail: String) { current.report = status to detail.take(2000) }
                try {
                    if (closed || !approve(task.get("task").asString, { closed || current.stopping })) { report(if (current.stopping) "cancelled" else "rejected", "원격 IDE에서 작업 시작을 취소했습니다"); return@Thread }
                    if (closed || current.stopping || busy()) { report("cancelled", "작업을 시작하지 않았습니다"); return@Thread }
                    Clients.post("/api/remote/work/tasks/${current.id}", mapOf("key" to key, "lease_token" to current.lease, "status" to "running", "detail" to "선택한 원격 PC에서 에이전트 실행 중"), 5)
                    if (closed || current.stopping) { report("cancelled", "실행 시작 전 중단했습니다"); return@Thread }
                    val original = task.get("task").asString
                    val text = if (task.get("attempt").asInt > 0) "[명시적 재개] 먼저 현재 파일·git diff·.yang/harness 진행률을 읽고 이미 완료한 변경이나 외부 명령을 무조건 반복하지 마세요. 남은 작업부터 이어서 수행하세요.\n\n$original" else original
                    current.executing = true
                    run(text, task.get("mode").asString == "harness")
                    report(if (current.stopping) "cancelled" else "completed", if (current.stopping) "중단 요청 후 에이전트 실행 루틴이 종료되었습니다" else "에이전트 응답 종료. 테스트 통과 여부는 IDE 작업 로그에서 확인하세요.")
                } catch (e: Exception) { report(if (current.stopping) "cancelled" else "failed", e.message ?: "실행 실패") }
                finally { current.executing = false; maintainActive() }
            } catch (e: Exception) { if (!closed) notice("원격 작업 연결 오류: ${e.message}") }
            finally { receiving.set(false) }
        }, "remote-work-receive").apply { isDaemon = true }.start()
    }

    override fun close() { closed = true; requestStop(); timer.shutdownNow() }
}
