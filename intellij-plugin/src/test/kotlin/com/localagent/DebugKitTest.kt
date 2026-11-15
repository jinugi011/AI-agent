package com.localagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** VS Code debugkit.test.ts 와 같은 사례 */
class DebugKitTest {
    private val files = listOf("main.py", "game/player.py", "index.html", "js/game.js", "lib/main.dart", "lib/src/enemy.dart",
        "Assets/Scripts/Player.cs", "scenes/player.gd", "src/main.rs", "assets/hero.png", "public/sfx/jump.wav")
    private val resolve = DebugKit.makeResolver("/proj", files)

    @Test fun `parsePlay 종류 대상 초 키 기대`() {
        assertEquals(PlayRequest(), DebugKit.parsePlay(""))
        assertEquals(PlayRequest("web", "index.html", 10.0), DebugKit.parsePlay("web index.html 10"))
        val p = DebugKit.parsePlay("cmd npm run dev 15 keys=Space,ArrowLeft expect=플레이어와 적이 보임")
        assertEquals(PlayRequest("cmd", "npm run dev", 15.0, listOf("Space", "ArrowLeft"), "플레이어와 적이 보임"), p)
        assertEquals(120.0, DebugKit.parsePlay("python main.py 999").seconds, 0.0)
    }

    @Test fun `파이썬 트레이스백은 마지막 프레임 우선`() {
        val tb = "Traceback (most recent call last):\n  File \"/proj/main.py\", line 40, in <module>\n  File \"/proj/game/player.py\", line 12, in update\nAttributeError: x"
        assertEquals(listOf(DebugKit.TraceLoc("game/player.py", 12), DebugKit.TraceLoc("main.py", 40)), DebugKit.traceLocations(tb, resolve))
    }

    @Test fun `브라우저 Dart Unity Godot Rust 스택`() {
        assertEquals(listOf(DebugKit.TraceLoc("js/game.js", 42)), DebugKit.traceLocations("at update (http://127.0.0.1:5321/js/game.js:42:13)", resolve))
        assertEquals(listOf(DebugKit.TraceLoc("lib/src/enemy.dart", 23)),
            DebugKit.traceLocations("#0 Enemy.move (package:mygame/src/enemy.dart:23:7)\n#1 (package:flutter/src/widgets/framework.dart:5000:1)", resolve))
        assertEquals(listOf(DebugKit.TraceLoc("Assets/Scripts/Player.cs", 17)), DebugKit.traceLocations("Assets/Scripts/Player.cs(17,9): error CS0103", resolve))
        assertEquals(listOf(DebugKit.TraceLoc("scenes/player.gd", 8)), DebugKit.traceLocations("   at: _process (res://scenes/player.gd:8)", resolve))
        assertEquals(listOf(DebugKit.TraceLoc("src/main.rs", 14)), DebugKit.traceLocations("thread 'main' panicked at src/main.rs:14:5:", resolve))
    }

    @Test fun `리소스 경로 오타 찾기`() {
        val code = "hero.src = 'assets/hero.png';\nload('assets/heroo.png');\n// 'assets/x.png'\nfetch(\"https://x.com/a.png\")\nnew Audio('sfx/jump.wav')"
        val refs = DebugKit.assetRefs("js/game.js", code)
        assertEquals(listOf("assets/hero.png", "assets/heroo.png", "sfx/jump.wav"), refs.map { it.ref })
        assertEquals(listOf("2:assets/heroo.png"), refs.filter { !DebugKit.assetExists(it, files.toSet()) }.map { "${it.line}:${it.ref}" })
    }

    @Test fun `CHECK PLAY 파싱`() {
        val calls = Protocol.parseToolCalls("확인\n<<<CHECK>>>\n<<<PLAY web index.html 8>>>\n<<<PLAY>>>")
        assertEquals(3, calls.size)
        assertTrue(calls[0] is ToolCall.Check)
        assertEquals("index.html", (calls[1] as ToolCall.Play).req.target)
        assertEquals("auto", (calls[2] as ToolCall.Play).req.kind)
        assertEquals(0, Protocol.parseToolCalls("<<<READ>>>").size)
    }

    @Test fun `IMAGE 블록 여러 줄 prompt`() {
        val calls = Protocol.parseToolCalls("그림\n<<<IMAGE assets/slime.png\nprompt: cute green slime,\n  big eyes\nsize: 64x64\nref: search:pixel art\nIMAGE>>>\n<<<CHECK>>>")
        assertEquals(2, calls.size)
        val c = calls[0] as ToolCall.Image
        assertEquals("assets/slime.png", c.path)
        assertEquals("cute green slime, big eyes", c.fields["prompt"])
        assertEquals("64x64", c.fields["size"])
        assertEquals("search:pixel art", c.fields["ref"])
    }

    @Test fun `DELETE MOVE MKDIR 파싱`() {
        val calls = Protocol.parseToolCalls("<<<DELETE assets/old.png>>>\n<<<MOVE src/a.js -> src/game/a.js>>>\n<<<MKDIR src/game>>>\n<<<DELETE>>>")
        assertEquals(listOf(ToolCall.Delete("assets/old.png"), ToolCall.Move("src/a.js", "src/game/a.js"), ToolCall.Mkdir("src/game")), calls)
    }
}
