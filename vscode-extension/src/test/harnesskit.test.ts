import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as hk from '../harnesskit';
import { parseToolCalls } from '../protocol';

test('테스트 명령 감지', () => {
  assert.equal(hk.detectTestCommand(['pubspec.yaml', 'lib/main.dart']), 'flutter test');
  assert.equal(hk.detectTestCommand(['build.gradle.kts', 'gradlew', 'src/main/kotlin/A.kt']), './gradlew test');
  assert.equal(hk.detectTestCommand(['build.gradle.kts', 'gradlew.bat'], true), '.\\gradlew.bat test');
  assert.equal(hk.detectTestCommand(['pom.xml']), 'mvn test');
  assert.equal(hk.detectTestCommand(['app/x.py', 'tests/test_x.py']), 'python -m pytest -q');
  assert.equal(hk.detectTestCommand(['README.md']), '');
});

test('하네스 이름 · 체크리스트 판별 · 진행률', () => {
  assert.equal(hk.harnessName('docs/주문 취소 명세.md'), '주문-취소-명세');
  const md = '# x\n- [x] R1 a\n- [ ] R2 b\n  - [ ] R3 c\n';
  assert.equal(hk.isChecklist(md), true);
  assert.deepEqual(hk.checklistProgress(md), { done: 1, total: 3 });
  assert.equal(hk.isChecklist('# 기획\n- 항목'), false);
});

test('하네스 지시문: 처음/이어서', () => {
  const p = hk.harnessPrompt({ source: 'docs/a.md', text: '요구', target: '.yang/harness/a.md', testCmd: 'flutter test', resume: false });
  assert.match(p, /FILE 로 만든다/);
  assert.match(p, /테스트 명령: flutter test/);
  assert.match(hk.harnessPrompt({ source: 'x', text: '', target: 't', testCmd: '', resume: true }), /READ 해 \[ \] 로 남은 항목부터/);
});

test('ANALYZE 도구 파싱', () => {
  const calls = parseToolCalls('<<<ANALYZE>>>\n<<<ANALYZE backend>>>');
  assert.deepEqual(calls.map((c: any) => [c.kind, c.path]), [['analyze', ''], ['analyze', 'backend']]);
});
