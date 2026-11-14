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
        var mode: String = "local", // local | remote (Cloudflare Tunnel)
        var serverUrl: String = "",
        var backendUrl: String = "http://127.0.0.1:8010",
        var engineUrl: String = "http://127.0.0.1:18091",
        var agentRoot: String = "",
        var autoStartBackend: Boolean = true,
        var approveEdits: String = "auto",
        var approveCommands: String = "ask",
        var maxSteps: Int = 16,
        var maxTokens: Int = 4096,
        var temperature: Double = 0.2,
    )

    private var data = Data()
    override fun getState(): Data = data
    override fun loadState(state: Data) { data = state }

    companion object {
        val current: Data get() = ApplicationManager.getApplication().getService(AgentSettings::class.java).state
    }
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

class AgentConfigurable : Configurable {
    private val mode = ComboBox(arrayOf("local", "remote"))
    private val serverUrl = JTextField()
    private val apiToken = javax.swing.JPasswordField()
    private val cfId = JTextField()
    private val cfSecret = javax.swing.JPasswordField()
    private val testResult = javax.swing.JLabel(" ")
    private val backendUrl = JTextField()
    private val engineUrl = JTextField()
    private val agentRoot = JTextField()
    private val approveEdits = ComboBox(arrayOf("auto", "ask"))
    private val approveCommands = ComboBox(arrayOf("ask", "auto"))
    private val maxSteps = JTextField()
    private val maxTokens = JTextField()
    private val temperature = JTextField()
    private var panel: JPanel? = null

    override fun getDisplayName() = "Yang Coding"

    override fun createComponent(): JComponent {
        val testButton = javax.swing.JButton("원격 연결 테스트").apply {
            addActionListener {
                apply()
                testResult.text = "확인 중…"
                com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                    val ok = Clients.backendAlive()
                    val msg = if (ok) "연결 성공" + (Clients.engineHealth()?.getAsJsonObject("model")?.get("model_name")?.asString?.let { " · $it" } ?: " · 엔진 꺼짐")
                              else "연결 실패: ${Clients.lastBackendError}"
                    javax.swing.SwingUtilities.invokeLater { testResult.text = msg }
                }
            }
        }
        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent("접속 방식 (local: 이 PC / remote: Cloudflare Tunnel)", mode)
            .addLabeledComponent("원격 서버 주소 (https://…)", serverUrl)
            .addLabeledComponent("원격 API 토큰 (서버에서 tunnel.sh token)", apiToken)
            .addLabeledComponent("Cloudflare Access Client ID (선택)", cfId)
            .addLabeledComponent("Cloudflare Access Client Secret (선택)", cfSecret)
            .addComponent(testButton)
            .addComponent(testResult)
            .addSeparator()
            .addLabeledComponent("AI-agent 폴더 (백엔드 자동 실행)", agentRoot)
            .addLabeledComponent("백엔드 URL", backendUrl)
            .addLabeledComponent("엔진 URL", engineUrl)
            .addLabeledComponent("파일 수정 승인", approveEdits)
            .addLabeledComponent("명령 실행 승인", approveCommands)
            .addLabeledComponent("최대 도구 반복", maxSteps)
            .addLabeledComponent("응답 최대 토큰", maxTokens)
            .addLabeledComponent("온도", temperature)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        reset()
        return panel!!
    }

    override fun isModified(): Boolean {
        val s = AgentSettings.current
        return mode.item != s.mode || serverUrl.text != s.serverUrl ||
            String(apiToken.password) != (AgentSecrets.get(AgentSecrets.TOKEN) ?: "") ||
            cfId.text != (AgentSecrets.get(AgentSecrets.CF_ID) ?: "") ||
            String(cfSecret.password) != (AgentSecrets.get(AgentSecrets.CF_SECRET) ?: "") ||
            backendUrl.text != s.backendUrl || engineUrl.text != s.engineUrl || agentRoot.text != s.agentRoot ||
            approveEdits.item != s.approveEdits || approveCommands.item != s.approveCommands ||
            maxSteps.text != s.maxSteps.toString() || maxTokens.text != s.maxTokens.toString() ||
            temperature.text != s.temperature.toString()
    }

    override fun apply() {
        val s = AgentSettings.current
        s.mode = mode.item
        s.serverUrl = serverUrl.text.trim().trimEnd('/')
        AgentSecrets.set(AgentSecrets.TOKEN, String(apiToken.password).trim())
        AgentSecrets.set(AgentSecrets.CF_ID, cfId.text.trim())
        AgentSecrets.set(AgentSecrets.CF_SECRET, String(cfSecret.password).trim())
        s.backendUrl = backendUrl.text.trim().trimEnd('/')
        s.engineUrl = engineUrl.text.trim().trimEnd('/')
        s.agentRoot = agentRoot.text.trim()
        s.approveEdits = approveEdits.item
        s.approveCommands = approveCommands.item
        s.maxSteps = maxSteps.text.toIntOrNull() ?: s.maxSteps
        s.maxTokens = maxTokens.text.toIntOrNull() ?: s.maxTokens
        s.temperature = temperature.text.toDoubleOrNull() ?: s.temperature
    }

    override fun reset() {
        val s = AgentSettings.current
        mode.item = s.mode
        serverUrl.text = s.serverUrl
        apiToken.text = AgentSecrets.get(AgentSecrets.TOKEN) ?: ""
        cfId.text = AgentSecrets.get(AgentSecrets.CF_ID) ?: ""
        cfSecret.text = AgentSecrets.get(AgentSecrets.CF_SECRET) ?: ""
        backendUrl.text = s.backendUrl
        engineUrl.text = s.engineUrl
        agentRoot.text = s.agentRoot
        approveEdits.item = s.approveEdits
        approveCommands.item = s.approveCommands
        maxSteps.text = s.maxSteps.toString()
        maxTokens.text = s.maxTokens.toString()
        temperature.text = s.temperature.toString()
    }
}
