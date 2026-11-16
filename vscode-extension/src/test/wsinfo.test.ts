import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ws from '../wsinfo';
import { parseToolCalls } from '../protocol';

test('읽기 전용 git 명령만 승인 없이', () => {
  for (const c of ['git status', 'git log --oneline -5', 'git diff HEAD~1', 'git branch', 'git branch -a', 'git remote -v',
    'git show HEAD', 'git -C sub status', 'git stash list', 'git remote get-url origin']) assert.equal(ws.isReadOnlyGit(c), true, c);
  for (const c of ['git commit -m x', 'git push', 'git checkout main', 'git branch -D x', 'git reset --hard', 'git remote add o u',
    'git status; rm -rf /', 'git log > out.txt', 'git stash', 'gitk', 'git clean -fd', 'git tag v1']) assert.equal(ws.isReadOnlyGit(c), false, c);
});

test('폴더 구조 요약은 항상 같은 순서', () => {
  const dirs = [{ rel: 'lib/screens', files: 3, dirs: 0 }, { rel: 'lib', files: 2, dirs: 1 }, { rel: 'assets', files: 0, dirs: 0 }];
  const a = ws.formatTree(dirs, ['pubspec.yaml', 'README.md']);
  assert.equal(a, ws.formatTree([...dirs].reverse(), ['README.md', 'pubspec.yaml']));
  assert.match(a, /^assets\/ \(비어 있음\)\nlib\/ \(2 files, 1 dirs\)\n  screens\/ \(3 files\)/);
  assert.match(a, /README\.md\npubspec\.yaml$/);
});

test('git status 요약', () => {
  const s = ws.summarizeStatus('## main...origin/main [ahead 1]\n M lib/a.dart\n?? new.txt\n');
  assert.equal(s.branch, 'main...origin/main [ahead 1]');
  assert.deepEqual(s.changes, [' M lib/a.dart', '?? new.txt']);
});

test('LIST: 폴더 경로 vs 글롭, 빈 LIST 는 최상위', () => {
  assert.equal(ws.isDirListing('lib/screens'), true);
  assert.equal(ws.isDirListing('**/*.dart'), false);
  const calls = parseToolCalls('<<<LIST>>>\n<<<LIST lib>>>');
  assert.deepEqual(calls.map((c: any) => c.pattern), ['.', 'lib']);
});

test('새 파일의 스타일 기준 파일 고르기', () => {
  const files = ['src/main/kotlin/com/ehs/incident/controller/IncidentController.kt', 'src/main/kotlin/com/ehs/incident/service/IncidentService.kt',
    'src/main/kotlin/com/ehs/audit/controller/AuditController.kt', 'lib/features/report/report_screen.dart', 'lib/features/report/report_bloc.dart',
    'test/report_bloc_test.dart', 'src/test/kotlin/com/ehs/IncidentServiceTest.kt'];
  assert.equal(ws.pickStyleSibling('src/main/kotlin/com/ehs/order/controller/OrderController.kt', files), 'src/main/kotlin/com/ehs/incident/controller/IncidentController.kt');
  assert.equal(ws.pickStyleSibling('src/main/kotlin/com/ehs/incident/service/AuditLogService.kt', files), 'src/main/kotlin/com/ehs/incident/service/IncidentService.kt');
  assert.equal(ws.pickStyleSibling('lib/features/order/order_screen.dart', files), 'lib/features/report/report_screen.dart');
  assert.equal(ws.pickStyleSibling('test/order_bloc_test.dart', files), 'test/report_bloc_test.dart');
  assert.equal(ws.pickStyleSibling('README.md', files), null);
  assert.equal(ws.pickStyleSibling('tools/new_script.py', files), null);
});

test('기존 코드가 얼마나 남는지', () => {
  const before = Array.from({ length: 40 }, (_, i) => `  line${i}();`).join('\n');
  assert.equal(ws.keptRatio(before, before + '\n  extra();'), 1);
  assert.ok(ws.keptRatio(before, 'void main() {\n  runApp(DexApp());\n}') < 0.1);
});

import { applySearchReplace } from '../protocol';
test('EDIT: 빈 줄 차이 허용 · 실패 시 가장 비슷한 원문 제시', () => {
  const file = 'class A {\n  int a = 1;\n\n  void f() {\n    print(a);\n  }\n}\n';
  const ok = applySearchReplace(file, [{ search: '  int a = 1;\n  void f() {', replace: '  int a = 2;\n\n  void f() {' }]);
  assert.equal(ok.applied, 1);
  assert.match(ok.content, /int a = 2;/);
  const bad = applySearchReplace(file, [{ search: '  void f() {\n    print(b);\n  }', replace: 'x' }]);
  assert.equal(bad.applied, 0);
  assert.match(bad.failed[0], /가장 비슷한 부분 \(\d+~\d+줄\)/);
  assert.match(bad.failed[0], /print\(a\);/);
});

import { parseToolCalls as parse2 } from '../protocol';
test('EDIT 형식 실수도 바르게 해석 (실제 모델 출력)', () => {
  const out = `<tool_code>
<<<EDIT lib/main.dart
<<<<<<< SEARCH
  void a() {}
=======
  void a() {}
  void b() {}
=======
<<<<<<< SEARCH
    title: Text(x),
=======
    title: Text(x),
    actions: [],
>>>>>>> REPLACE
EDIT>>>
</tool_code>`;
  const calls: any[] = parse2(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].blocks.length, 2);
  assert.equal(calls[0].blocks[0].replace, '  void a() {}\n  void b() {}');
  assert.equal(calls[0].blocks[1].search, '    title: Text(x),');
  const r = applySearchReplace('class X {\n  void a() {}\n  Widget w() => AppBar(\n    title: Text(x),\n  );\n}', calls[0].blocks);
  assert.equal(r.applied, 2);
  assert.ok(!/=======|SEARCH|REPLACE/.test(r.content));
  // 구분선 없는 블록은 적용하지 않음
  const bad: any[] = parse2('<<<EDIT a.dart\n<<<<<<< SEARCH\nfoo\nEDIT>>>');
  assert.equal(applySearchReplace('foo', bad[0].blocks).applied, 0);
});

test('EDIT>>> 를 빠뜨린 블록도 적용 (실제 모델 출력)', () => {
  const out = '수정합니다.\n<<<EDIT lib/main.dart\n<<<<<<< SEARCH\n  int a = 1;\n=======\n  int a = 2;\n>>>>>>> REPLACE\n';
  const calls: any[] = parse2(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].blocks[0].replace, '  int a = 2;');
  const two: any[] = parse2('<<<EDIT a.dart\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n<<<RUN flutter test>>>');
  assert.deepEqual(two.map((c) => c.kind), ['edit', 'run']);
});
