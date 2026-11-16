package com.localagent

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceInfoTest {
    @Test
    fun readOnlyGit() {
        for (c in listOf("git status", "git log --oneline -5", "git diff HEAD~1", "git branch -a", "git remote -v", "git stash list"))
            assertTrue(c, WorkspaceInfo.isReadOnlyGit(c))
        for (c in listOf("git commit -m x", "git push", "git branch -D x", "git remote add o u", "git status; rm -rf /", "git log > o", "git stash"))
            assertFalse(c, WorkspaceInfo.isReadOnlyGit(c))
    }

    @Test
    fun treeAndListAndWalkSkipUnreadable() {
        val root = Files.createTempDirectory("ws")
        Files.createDirectories(root.resolve("src/main"))
        Files.writeString(root.resolve("src/main/A.kt"), "x")
        Files.createDirectories(root.resolve("node_modules/x"))
        Files.writeString(root.resolve("node_modules/x/i.js"), "x")
        Files.writeString(root.resolve("build.gradle.kts"), "x")
        val locked = Files.createDirectories(root.resolve("locked"))
        Files.writeString(locked.resolve("s.txt"), "x")
        locked.toFile().setReadable(false); locked.toFile().setExecutable(false)
        try {
            val tree = WorkspaceInfo.folderTree(root)
            assertTrue(tree, tree.contains("src/ (1 dirs)\n  main/ (1 files)"))
            assertFalse(tree.contains("node_modules"))
            assertEquals(listOf("locked/", "node_modules/", "src/", "build.gradle.kts"), WorkspaceInfo.listDir(root, root))
            val files = WorkspaceInfo.walkFiles(root, 100).map { root.relativize(it).toString() }.sorted()
            assertEquals(listOf("build.gradle.kts", "src/main/A.kt"), files) // 권한 없는 폴더는 건너뛰고 계속
            assertEquals(".", Protocol.parseToolCalls("<<<LIST>>>").filterIsInstance<ToolCall.ListFiles>().single().pattern)
        } finally {
            locked.toFile().setReadable(true); locked.toFile().setExecutable(true)
            root.toFile().deleteRecursively()
        }
    }
}
