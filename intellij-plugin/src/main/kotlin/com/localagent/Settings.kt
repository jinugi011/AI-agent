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

/** 플러그인 설정 (Settings → Tools → Local Coding Agent). VS Code 확장과 같은 항목. */
@State(name = "LocalAgentSettings", storages = [Storage("localAgent.xml")])
class AgentSettings : PersistentStateComponent<AgentSettings.Data> {
    data class Data(
        var backendUrl: String = "http://127.0.0.1:8010",
        var engineUrl: String = "http://127.0.0.1:8091",
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

class AgentConfigurable : Configurable {
    private val backendUrl = JTextField()
    private val engineUrl = JTextField()
    private val agentRoot = JTextField()
    private val approveEdits = ComboBox(arrayOf("auto", "ask"))
    private val approveCommands = ComboBox(arrayOf("ask", "auto"))
    private val maxSteps = JTextField()
    private val maxTokens = JTextField()
    private val temperature = JTextField()
    private var panel: JPanel? = null

    override fun getDisplayName() = "Local Coding Agent"

    override fun createComponent(): JComponent {
        panel = FormBuilder.createFormBuilder()
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
        return backendUrl.text != s.backendUrl || engineUrl.text != s.engineUrl || agentRoot.text != s.agentRoot ||
            approveEdits.item != s.approveEdits || approveCommands.item != s.approveCommands ||
            maxSteps.text != s.maxSteps.toString() || maxTokens.text != s.maxTokens.toString() ||
            temperature.text != s.temperature.toString()
    }

    override fun apply() {
        val s = AgentSettings.current
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
