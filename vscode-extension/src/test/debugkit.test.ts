import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as dk from '../debugkit';
import { parseToolCalls } from '../protocol';

const files = ['main.py', 'game/player.py', 'index.html', 'js/game.js', 'lib/main.dart', 'lib/src/enemy.dart',
  'Assets/Scripts/Player.cs', 'scenes/player.gd', 'src/main.rs', 'assets/hero.png', 'public/sfx/jump.wav'];
const resolve = dk.makeResolver('/proj', files);

test('parsePlay: 종류·대상·초·키·기대', () => {
  assert.deepEqual(dk.parsePlay(''), { kind: 'auto', target: '', seconds: 0, keys: [], expect: '' });
  assert.deepEqual(dk.parsePlay('web index.html 10'), { kind: 'web', target: 'index.html', seconds: 10, keys: [], expect: '' });
  const p = dk.parsePlay('cmd npm run dev 15 keys=Space,ArrowLeft expect=플레이어와 적이 보임');
  assert.equal(p.kind, 'cmd'); assert.equal(p.target, 'npm run dev'); assert.equal(p.seconds, 15);
  assert.deepEqual(p.keys, ['Space', 'ArrowLeft']); assert.equal(p.expect, '플레이어와 적이 보임');
  assert.equal(dk.parsePlay('python main.py 999').seconds, 120); // 상한
});

test('traceLocations: 파이썬은 마지막 프레임(실제 오류 위치) 우선', () => {
  const tb = `Traceback (most recent call last):
  File "/proj/main.py", line 40, in <module>
    run()
  File "/proj/game/player.py", line 12, in update
    self.x += self.speed
AttributeError: 'Player' object has no attribute 'speed'`;
  assert.deepEqual(dk.traceLocations(tb, resolve), [{ file: 'game/player.py', line: 12 }, { file: 'main.py', line: 40 }]);
});

test('traceLocations: 브라우저 스택 (서버 주소 제거)', () => {
  const e = `Uncaught TypeError: Cannot read properties of undefined (reading 'x')
    at update (http://127.0.0.1:53211/js/game.js:42:13)
    at loop (http://127.0.0.1:53211/js/game.js:88:5)`;
  assert.deepEqual(dk.traceLocations(e, resolve), [{ file: 'js/game.js', line: 42 }, { file: 'js/game.js', line: 88 }]);
});

test('traceLocations: Dart · Unity · Godot · Rust, 라이브러리 경로 제외', () => {
  assert.deepEqual(dk.traceLocations('#0 Enemy.move (package:mygame/src/enemy.dart:23:7)\n#1 (package:flutter/src/widgets/framework.dart:5000:1)', resolve),
    [{ file: 'lib/src/enemy.dart', line: 23 }]);
  assert.deepEqual(dk.traceLocations('Assets/Scripts/Player.cs(17,9): error CS0103: The name x does not exist', resolve),
    [{ file: 'Assets/Scripts/Player.cs', line: 17 }]);
  assert.deepEqual(dk.traceLocations('NullReferenceException\n  Player.Update () (at Assets/Scripts/Player.cs:31)', resolve),
    [{ file: 'Assets/Scripts/Player.cs', line: 31 }]);
  assert.deepEqual(dk.traceLocations('SCRIPT ERROR: Invalid get index\n   at: _process (res://scenes/player.gd:8)', resolve),
    [{ file: 'scenes/player.gd', line: 8 }]);
  assert.deepEqual(dk.traceLocations("thread 'main' panicked at src/main.rs:14:5:", resolve), [{ file: 'src/main.rs', line: 14 }]);
  assert.deepEqual(dk.traceLocations('at x (/proj/node_modules/phaser/dist/phaser.js:10:1)', resolve), []);
});

test('excerpt: 오류 줄 표시', () => {
  const src = 'a\nb\nc\nd\ne';
  assert.equal(dk.excerpt(src, 3, 1), ' 2 | b\n▶3 | c\n 4 | d');
});

test('assetRefs / assetExists: 경로 오타 찾기', () => {
  const code = `const hero = new Image(); hero.src = 'assets/hero.png';\nload('assets/heroo.png');\n// 'assets/commented.png'\nfetch("https://x.com/a.png")\nnew Audio('sfx/jump.wav')`;
  const refs = dk.assetRefs('js/game.js', code);
  assert.deepEqual(refs.map((r) => r.ref), ['assets/hero.png', 'assets/heroo.png', 'sfx/jump.wav']);
  const set = new Set(files);
  assert.deepEqual(refs.filter((r) => !dk.assetExists(r, set)).map((r) => `${r.line}:${r.ref}`), ['2:assets/heroo.png']);
});

test('detectPlayKind / pickPythonEntry', () => {
  const read = (f: string) => (f === 'pubspec.yaml' ? 'dependencies:\n  flutter:\n    sdk: flutter' : f === 'app.py' ? 'import pygame\npygame.init()' : '');
  assert.equal(dk.detectPlayKind(['project.godot', 'index.html'], read), 'godot');
  assert.equal(dk.detectPlayKind(['pubspec.yaml', 'lib/main.dart'], read), 'flutter');
  assert.equal(dk.detectPlayKind(['index.html', 'game.js'], read), 'web');
  assert.equal(dk.detectPlayKind(['util.py', 'app.py'], read), 'python');
  assert.equal(dk.pickPythonEntry(['util.py', 'app.py', 'tests/test_x.py'], read), 'app.py');
  assert.equal(dk.pickPythonEntry(['src/game/main.py', 'src/x.py'], read), 'src/game/main.py');
});

test('errorLines: 오류 줄만 · 중복 제거', () => {
  const out = 'ok\nTypeError: a is undefined\nTypeError: a is undefined\nFound 0 errors\nfoo\nE/flutter (123): boom';
  assert.deepEqual(dk.errorLines(out), ['TypeError: a is undefined', 'E/flutter (123): boom']);
});

test('parseToolCalls: CHECK / PLAY (인자 없이도)', () => {
  const calls = parseToolCalls('확인합니다\n<<<CHECK>>>\n<<<PLAY web index.html 8>>>\n<<<PLAY>>>');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { kind: 'check' });
  assert.equal(calls[1].kind === 'play' && calls[1].req.target, 'index.html');
  assert.equal(calls[2].kind === 'play' && calls[2].req.kind, 'auto');
  assert.equal(parseToolCalls('<<<READ>>>').length, 0); // 인자 필요한 도구는 빈 인자 무시
});

test('parseToolCalls: IMAGE 블록 (여러 줄 prompt · 본문 안 태그 무시)', () => {
  const calls = parseToolCalls(`그림을 만듭니다.
<<<IMAGE assets/slime.png
prompt: cute green slime monster,
  big eyes, game sprite
size: 64x64
transparent: yes
pixel: 32
ref: search:pixel art monster
ops: flip-x; tint #ff8800 0.3
IMAGE>>>
<<<CHECK>>>`);
  assert.equal(calls.length, 2);
  const c = calls[0];
  assert.ok(c.kind === 'image');
  if (c.kind === 'image') {
    assert.equal(c.path, 'assets/slime.png');
    assert.equal(c.fields.prompt, 'cute green slime monster, big eyes, game sprite');
    assert.equal(c.fields.size, '64x64');
    assert.equal(c.fields.ref, 'search:pixel art monster');
    assert.equal(c.fields.ops, 'flip-x; tint #ff8800 0.3');
  }
});

test('parseToolCalls: DELETE · MOVE · MKDIR (Windows 경로 포함)', () => {
  const calls = parseToolCalls('<<<DELETE assets/old.png>>>\n<<<MOVE src/a.js -> src/game/a.js>>>\n<<<MOVE "img\\\\x.png" → "img\\\\y.png">>>\n<<<MKDIR src/game>>>\n<<<DELETE>>>');
  assert.deepEqual(calls, [
    { kind: 'delete', path: 'assets/old.png' },
    { kind: 'move', from: 'src/a.js', to: 'src/game/a.js' },
    { kind: 'move', from: 'img\\\\x.png', to: 'img\\\\y.png' },
    { kind: 'mkdir', path: 'src/game' },
  ]);
});
