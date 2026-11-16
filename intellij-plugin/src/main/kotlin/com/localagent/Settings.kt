package com.localagent

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.ComboBox
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextField

/** 플러그인 설정 (Settings → Tools → Yang Coding). VS Code 확장과 같은 항목. */
@State(name = "LocalAgentSettings", storages = [Storage("localAgent.xml")])
class AgentSettings : PersistentStateComponent<AgentSettings.Data> {
    data class Data(
        var mode: String = "local", // local | remote (Tailscale 또는 Cloudflare Tunnel)
        var serverUrl: String = "",
        var backendUrl: String = "http://127.0.0.1:8010",
        var engineUrl: String = "http://127.0.0.1:18091",
        var agentRoot: String = "",
        var autoStartBackend: Boolean = true,
        var approveEdits: String = "auto",
        var approveCommands: String = "ask",
        var approveFileOps: String = "ask",
        var maxSteps: Int = 16,
        var maxTokens: Int = 4096,
        var temperature: Double = 0.2,
        var autoCheck: Boolean = true,
        var verifyBeforeFinish: Boolean = false, // 기본 끔 (매 턴 모델 호출 +1 → 느림). /debug 에서는 항상 켬
    )

    private var data = Data()
    override fun getState(): Data = data
    override fun loadState(state: Data) { data = state }

    companion object {
        val current: Data get() = ApplicationManager.getApplication().getService(AgentSettings::class.java).state
    }
}

/** 설치 파일(server.json 리소스, 빌드 때 생성)에 들어 있는 고정 서버 주소 — 사용자는 토큰만 입력하면 된다 */
object DefaultServer {
    val url: String by lazy {
        try {
            DefaultServer::class.java.getResourceAsStream("/server.json")?.use { st ->
                com.google.gson.JsonParser.parseString(st.readBytes().toString(Charsets.UTF_8)).asJsonObject.get("url")?.asString
            }?.trim()?.trimEnd('/') ?: ""
        } catch (e: Exception) { "" }
    }

    /** 실제로 쓰는 원격 서버 주소: 설정값 > 기본 주소 */
    fun effective(): String = AgentSettings.current.serverUrl.trim().trimEnd('/').ifBlank { url }
}

/** 원격 토큰 보관: IntelliJ PasswordSafe (macOS 키체인). 설정 XML 에는 저장하지 않는다. */
object AgentSecrets {
    const val TOKEN = "apiToken"
    const val CF_ID = "cfAccessClientId"
    const val CF_SECRET = "cfAccessClientSecret"
    private val cache = java.util.concurrent.ConcurrentHashMap<String, String>()

    private fun attrs(key: String) = com.intellij.credentialStore.CredentialAttributes(
        com.intellij.credentialStore.generateServiceName("LocalCodingAgent", key))

    fun get(key: String): String? = cache[key] ?: com.intellij.ide.passwordSafe.PasswordSafe.instance.getPassword(attrs(key))?.also { cache[key] = it }

    fun set(key: String, value: String) {
        com.intellij.ide.passwordSafe.PasswordSafe.instance.setPassword(attrs(key), value.ifBlank { null })
        if (value.isBlank()) cache.remove(key) else cache[key] = value
    }
}

/** 콤보 상자 항목: 저장값(value) + 화면 표시(label) */
private class Opt(val value: String, val label: String) { override fun toString() = label }

private fun combo(vararg opts: Opt) = ComboBox(opts)
@Suppress("UNCHECKED_CAST")
private fun ComboBox<Opt>.value(): String = (selectedItem as Opt).value
private fun ComboBox<Opt>.select(v: String) {
    for (i in 0 until itemCount) if (getItemAt(i).value == v) { selectedIndex = i; return }
}

/**
 * 설정 화면 (Settings → Tools → Yang Coding).
 * 접속은 간단하게(토큰 하나), 설정은 자세하게: 묶음별 제목 + 항목마다 설명.
 */
class AgentConfigurable : Configurable {
    // 접속
    private val mode = combo(
        Opt("local", "local — 이 맥에서 직접 실행 (백엔드·엔진이 이 컴퓨터에 있음)"),
        Opt("remote", "remote — 다른 PC에서 내 맥(서버)에 접속"),
    )
    private val serverUrl = com.intellij.ui.components.JBTextField()
    private val apiToken = javax.swing.JPasswordField()
    private val tokenState = javax.swing.JLabel(" ")
    private val cfId = JTextField()
    private val cfSecret = javax.swing.JPasswordField()
    private val testResult = javax.swing.JLabel(" ")
    // 이 맥에서 실행 (local)
    private val agentRoot = JTextField()
    private val autoStartBackend = javax.swing.JCheckBox("백엔드가 꺼져 있으면 자동으로 실행")
    private val backendUrl = JTextField()
    private val engineUrl = JTextField()
    // 에이전트 동작
    private val approveEdits = combo(
        Opt("auto", "auto — 바로 수정 (대화별 되돌리기 가능)"),
        Opt("ask", "ask — 수정할 때마다 차이(diff)를 보여 주고 승인 받기"),
    )
    private val approveCommands = combo(
        Opt("ask", "ask — 터미널 명령마다 승인 받기 (권장)"),
        Opt("auto", "auto — 승인 없이 바로 실행"),
    )
    private val approveFileOps = combo(
        Opt("ask", "ask — 파일·폴더 삭제/이동마다 승인 받기 (권장)"),
        Opt("auto", "auto — 승인 없이 바로 실행 (파일은 /undo 로 복구)"),
    )
    private val maxSteps = com.intellij.ui.JBIntSpinner(16, 1, 100)
    private val autoCheck = javax.swing.JCheckBox("파일을 고칠 때마다 자동 검사 (IDE 오류 + 문법·타입 검사 + 이미지·사운드 경로)")
    private val verifyBeforeFinish = javax.swing.JCheckBox("끝내기 전에 실행(RUN/PLAY)으로 확인하도록 한 번 요청")
    // 생성
    private val maxTokens = com.intellij.ui.JBIntSpinner(4096, 256, 32768, 256)
    private val temperature = JTextField()
    private var panel: JPanel? = null

    override fun getDisplayName() = "Yang Coding"

    private fun section(title: String) = com.intellij.ui.TitledSeparator(title)

    private fun refreshTokenState() {
        val t = String(apiToken.password).trim()
        tokenState.text = if (t.isEmpty()) "⚠ 토큰 없음 — 원격 접속하려면 입력하세요" else "✓ 저장됨 (${t.take(7)}…, 키체인에 보관)"
    }

    override fun createComponent(): JComponent {
        val testButton = javax.swing.JButton("연결 테스트").apply {
            addActionListener {
                apply()
                testResult.text = "확인 중…"
                ApplicationManager.getApplication().executeOnPooledThread {
                    val ok = Clients.backendAlive()
                    val msg = if (ok) "✓ 연결 성공" + (Clients.engineHealth()?.getAsJsonObject("model")?.get("model_name")?.asString?.let { " · 모델 $it" } ?: " · 엔진 꺼짐")
                              else "✗ 연결 실패: ${Clients.lastBackendError}"
                    javax.swing.SwingUtilities.invokeLater { testResult.text = msg }
                }
            }
        }
        val adminButton = javax.swing.JButton("관리 페이지 열기 (토큰 발급)").apply {
            addActionListener {
                val u = serverUrl.text.trim().trimEnd('/').ifBlank { DefaultServer.url }
                if (u.isNotBlank()) com.intellij.ide.BrowserUtil.browse(u) else testResult.text = "서버 주소가 없습니다"
            }
        }
        val buttons = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
            add(testButton); add(javax.swing.Box.createHorizontalStrut(8)); add(adminButton)
        }
        serverUrl.emptyText.text = DefaultServer.url.ifBlank { "http://내맥이름.tailXXXX.ts.net:18010" }
        apiToken.document.addDocumentListener(object : javax.swing.event.DocumentListener {
            override fun insertUpdate(e: javax.swing.event.DocumentEvent?) = refreshTokenState()
            override fun removeUpdate(e: javax.swing.event.DocumentEvent?) = refreshTokenState()
            override fun changedUpdate(e: javax.swing.event.DocumentEvent?) = refreshTokenState()
        })
        val defaultInfo = if (DefaultServer.url.isNotBlank()) "비워 두면 설치 파일의 기본 주소 사용: ${DefaultServer.url}"
                          else "예: http://내맥이름.tailXXXX.ts.net:18010 (Tailscale) 또는 https://… (Cloudflare)"

        panel = FormBuilder.createFormBuilder()
            .addComponent(section("접속"))
            .addLabeledComponent("접속 방식", mode)
            .addTooltip("다른 PC에서는 remote. 채팅 창의 '🔑 토큰 입력하고 접속' 버튼을 쓰면 자동으로 remote 로 바뀝니다.")
            .addLabeledComponent("원격 서버 주소", serverUrl)
            .addTooltip(defaultInfo)
            .addLabeledComponent("접속 토큰", apiToken)
            .addComponentToRightColumn(tokenState)
            .addTooltip("서버 주소를 브라우저로 열면 관리 페이지 → 접속 토큰에서 기기별로 발급. 기기를 잃어버리면 거기서 폐기하세요.")
            .addComponentToRightColumn(buttons)
            .addComponentToRightColumn(testResult)
            .addLabeledComponent("Cloudflare Access Client ID", cfId)
            .addLabeledComponent("Cloudflare Access Client Secret", cfSecret)
            .addTooltip("Cloudflare Tunnel + Access 를 쓸 때만 입력. Tailscale 이면 비워 두세요.")

            .addComponent(section("이 맥에서 실행 (local 모드)"))
            .addLabeledComponent("AI-agent 폴더", agentRoot)
            .addTooltip("백엔드를 자동 실행할 때 쓰는 프로젝트 폴더 (예: ~/AI-agent). remote 모드에서는 쓰지 않습니다.")
            .addComponentToRightColumn(autoStartBackend)
            .addLabeledComponent("백엔드 주소", backendUrl)
            .addTooltip("FastAPI 백엔드. 기본 http://127.0.0.1:8010")
            .addLabeledComponent("엔진 주소", engineUrl)
            .addTooltip("Rust 추론 엔진(llama.cpp). 기본 http://127.0.0.1:18091")

            .addComponent(section("에이전트 동작"))
            .addLabeledComponent("파일 수정 승인", approveEdits)
            .addLabeledComponent("명령 실행 승인", approveCommands)
            .addLabeledComponent("삭제·이동 승인", approveFileOps)
            .addLabeledComponent("최대 도구 반복", maxSteps)
            .addTooltip("요청 한 번에 파일 읽기·수정·실행 같은 도구를 최대 몇 번까지 쓸지 (1~100, 기본 16). 크면 큰 작업도 끝까지 하지만 오래 걸립니다.")
            .addComponentToRightColumn(autoCheck)
            .addTooltip("자동 검사 결과를 에이전트에게 바로 돌려줘 오류를 스스로 고치게 합니다. 고정된 분석 명령만 실행하므로 승인을 묻지 않습니다.")
            .addComponentToRightColumn(verifyBeforeFinish)
            .addTooltip("코드를 바꿨는데 실행해 보지 않았으면 한 번 더 확인을 요청합니다. 남은 오류·임시 디버그 로그(YANG-DEBUG)는 항상 확인합니다.")

            .addComponent(section("생성 옵션"))
            .addLabeledComponent("응답 최대 토큰", maxTokens)
            .addTooltip("모델이 한 번에 쓰는 최대 길이 (256~32768, 기본 4096). 긴 파일을 한 번에 쓰려면 늘리세요.")
            .addLabeledComponent("온도", temperature)
            .addTooltip("0.0~1.0, 기본 0.2. 낮을수록 일관된 코드, 높을수록 다양한 답.")
            .addComponentFillVertically(JPanel(), 0)
            .panel
        reset()
        return panel!!
    }

    private fun temp(): Double = temperature.text.trim().toDoubleOrNull()?.coerceIn(0.0, 1.0) ?: AgentSettings.current.temperature

    override fun isModified(): Boolean {
        val s = AgentSettings.current
        return mode.value() != s.mode || serverUrl.text.trim().trimEnd('/') != s.serverUrl ||
            String(apiToken.password).trim() != (AgentSecrets.get(AgentSecrets.TOKEN) ?: "") ||
            cfId.text.trim() != (AgentSecrets.get(AgentSecrets.CF_ID) ?: "") ||
            String(cfSecret.password).trim() != (AgentSecrets.get(AgentSecrets.CF_SECRET) ?: "") ||
            backendUrl.text != s.backendUrl || engineUrl.text != s.engineUrl || agentRoot.text != s.agentRoot ||
            autoStartBackend.isSelected != s.autoStartBackend ||
            approveEdits.value() != s.approveEdits || approveCommands.value() != s.approveCommands || approveFileOps.value() != s.approveFileOps ||
            maxSteps.number != s.maxSteps || autoCheck.isSelected != s.autoCheck || verifyBeforeFinish.isSelected != s.verifyBeforeFinish || maxTokens.number != s.maxTokens || temp() != s.temperature
    }

    override fun apply() {
        val s = AgentSettings.current
        s.mode = mode.value()
        s.serverUrl = serverUrl.text.trim().trimEnd('/')
        AgentSecrets.set(AgentSecrets.TOKEN, String(apiToken.password).trim())
        AgentSecrets.set(AgentSecrets.CF_ID, cfId.text.trim())
        AgentSecrets.set(AgentSecrets.CF_SECRET, String(cfSecret.password).trim())
        s.backendUrl = backendUrl.text.trim().trimEnd('/')
        s.engineUrl = engineUrl.text.trim().trimEnd('/')
        s.agentRoot = agentRoot.text.trim()
        s.autoStartBackend = autoStartBackend.isSelected
        s.approveEdits = approveEdits.value()
        s.approveCommands = approveCommands.value()
        s.approveFileOps = approveFileOps.value()
        s.maxSteps = maxSteps.number
        s.autoCheck = autoCheck.isSelected
        s.verifyBeforeFinish = verifyBeforeFinish.isSelected
        s.maxTokens = maxTokens.number
        s.temperature = temp()
    }

    override fun reset() {
        val s = AgentSettings.current
        mode.select(s.mode)
        serverUrl.text = s.serverUrl
        apiToken.text = AgentSecrets.get(AgentSecrets.TOKEN) ?: ""
        cfId.text = AgentSecrets.get(AgentSecrets.CF_ID) ?: ""
        cfSecret.text = AgentSecrets.get(AgentSecrets.CF_SECRET) ?: ""
        backendUrl.text = s.backendUrl
        engineUrl.text = s.engineUrl
        agentRoot.text = s.agentRoot
        autoStartBackend.isSelected = s.autoStartBackend
        approveEdits.select(s.approveEdits)
        approveCommands.select(s.approveCommands)
        approveFileOps.select(s.approveFileOps)
        maxSteps.number = s.maxSteps.coerceIn(1, 100)
        autoCheck.isSelected = s.autoCheck
        verifyBeforeFinish.isSelected = s.verifyBeforeFinish
        maxTokens.number = s.maxTokens.coerceIn(256, 32768)
        temperature.text = s.temperature.toString()
        refreshTokenState()
    }
}
