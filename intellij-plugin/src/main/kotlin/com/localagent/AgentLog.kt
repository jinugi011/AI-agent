package com.localagent

import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory

/** 작업 로그 콘솔 (VS Code: 출력 패널, IntelliJ: 하단 "Yang Coding 로그"). */
interface AgentLog {
    fun line(text: String, level: String = "info") // info | head | tool | result | error
    fun raw(text: String) // 모델 토큰 스트림
    fun show()
}

const val LOG_TOOL_WINDOW_ID = "Yang Coding 로그"

/** 프로젝트별 콘솔. 툴 윈도우가 만들어지기 전에 쌓인 로그는 버퍼에 두었다가 붙인다. */
@Service(Service.Level.PROJECT)
class AgentLogService(private val project: Project) : AgentLog, Disposable {
    @Volatile private var console: ConsoleView? = null
    private val pending = mutableListOf<Pair<String, ConsoleViewContentType>>()
    @Volatile private var atLineStart = true

    private fun typeOf(level: String) = when (level) {
        "head" -> ConsoleViewContentType.SYSTEM_OUTPUT
        "tool" -> ConsoleViewContentType.USER_INPUT
        "result" -> ConsoleViewContentType.LOG_DEBUG_OUTPUT
        "error" -> ConsoleViewContentType.ERROR_OUTPUT
        else -> ConsoleViewContentType.NORMAL_OUTPUT
    }

    private fun print(text: String, type: ConsoleViewContentType) {
        val c = console
        if (c == null) synchronized(pending) { pending += text to type } else c.print(text, type)
    }

    override fun line(text: String, level: String) {
        if (!atLineStart) print("\n", ConsoleViewContentType.NORMAL_OUTPUT)
        print(text + "\n", typeOf(level))
        atLineStart = true
    }

    override fun raw(text: String) {
        if (text.isEmpty()) return
        print(text, ConsoleViewContentType.NORMAL_OUTPUT)
        atLineStart = text.endsWith("\n")
    }

    override fun show() {
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) ToolWindowManager.getInstance(project).getToolWindow(LOG_TOOL_WINDOW_ID)?.show() // 포커스는 옮기지 않음
        }
    }

    /** 툴 윈도우 팩토리에서 EDT 로 호출 */
    fun createConsole(): ConsoleView {
        console?.let { return it }
        val c = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
        Disposer.register(this, c)
        synchronized(pending) {
            pending.forEach { (t, type) -> c.print(t, type) }
            pending.clear()
            console = c
        }
        return c
    }

    override fun dispose() {
        console = null
    }

    companion object {
        fun of(project: Project): AgentLogService = project.getService(AgentLogService::class.java)
    }
}

class LogToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val console = AgentLogService.of(project).createConsole()
        val content = ContentFactory.getInstance().createContent(console.component, "작업 로그", false)
        toolWindow.contentManager.addContent(content)
        toolWindow.setTitleActions(listOf(object : com.intellij.openapi.actionSystem.AnAction(
            "지우기", "작업 로그 지우기", com.intellij.icons.AllIcons.Actions.GC,
        ), DumbAware {
            override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) = console.clear()
        }))
    }
}
