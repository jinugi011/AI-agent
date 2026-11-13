package com.localagent

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory

class ChatToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = ChatPanel(project)
        val content = ContentFactory.getInstance().createContent(panel.component, "", false)
        Disposer.register(content, panel)
        toolWindow.contentManager.addContent(content)
        toolWindow.setTitleActions(listOf(object : AnAction("새 대화", "대화 기록을 지우고 새로 시작", com.intellij.icons.AllIcons.General.Add), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = panel.newChat()
        }))
    }
}

/** 에디터 우클릭 → "선택 영역에 대해 묻기" (Cmd+Shift+L). 선택이 없으면 채팅창만 연다. */
class AskSelectionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hasSelection = e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
        val window = ToolWindowManager.getInstance(project).getToolWindow("Local Agent") ?: return
        window.activate {
            if (!hasSelection) return@activate
            val q = Messages.showInputDialog(project, "선택한 코드에 대해 무엇을 할까요?", "Local Agent", null,
                "", null) ?: return@activate
            ChatPanel.instances[project]?.handleInput(q)
        }
    }
}
