import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applySearchReplace, describeCall, lineDiffStats, parseToolCalls, stripToolBlocks } from '../protocol';

test('여러 도구를 등장 순서대로 파싱', () => {
  const text = `먼저 확인합니다.
<<<READ src/app.py:10-20>>>
<<<GREP def total>>>
<<<FILE src/new.py
print("<<<RUN rm -rf />>>")
FILE>>>
<<<EDIT src/app.py
<<<<<<< SEARCH
a = 1
=======
a = 2
>>>>>>> REPLACE
EDIT>>>
<<<RUN npm test>>>
<<<REMEMBER constraint language:python
pydantic v2 만 사용
REMEMBER>>>
<<<MODEL download 30b>>>`;
  const calls = parseToolCalls(text);
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'grep', 'write', 'edit', 'run', 'remember', 'model']);
  assert.deepEqual(calls[0], { kind: 'read', path: 'src/app.py', start: 10, end: 20 });
  // FILE 본문 안의 <<<RUN …>>> 은 실행되면 안 된다
  assert.equal(calls.filter((c) => c.kind === 'run').length, 1);
  assert.deepEqual(calls[3], { kind: 'edit', path: 'src/app.py', blocks: [{ search: 'a = 1', replace: 'a = 2' }] });
  assert.deepEqual(calls[5], { kind: 'remember', memKind: 'constraint', scope: 'language', scopeValue: 'python', text: 'pydantic v2 만 사용' });
  assert.deepEqual(calls[6], { kind: 'model', action: 'download', arg: '30b' });
});

test('도구가 없으면 빈 배열 (턴 종료)', () => {
  assert.deepEqual(parseToolCalls('완료했습니다. `<<<READ x>>>` 형식은 줄 맨 앞에서만 인식'), []);
});

test('스트리밍 중 미완성 블록 숨김', () => {
  assert.equal(stripToolBlocks('수정할게요.\n<<<FILE a.py\nprint(1)'), '수정할게요.');
  assert.equal(stripToolBlocks('확인\n<<<READ a.py>>>\n끝'), '확인\n\n끝'.replace('\n\n', '\n\n'));
  assert.equal(stripToolBlocks('보는 중 <<'), '보는 중');
});

test('SEARCH/REPLACE: 정확 일치, 들여쓰기 차이 허용, 중복/실패 보고', () => {
  const src = 'def f():\n    return 1\n\ndef g():\n    return 1\n';
  assert.equal(applySearchReplace(src, [{ search: 'def f():\n    return 1', replace: 'def f():\n    return 2' }]).content,
    'def f():\n    return 2\n\ndef g():\n    return 1\n');
  const dup = applySearchReplace(src, [{ search: '    return 1', replace: 'x' }]);
  assert.equal(dup.applied, 0);
  assert.match(dup.failed[0], /여러 곳/);
  const loose = applySearchReplace('  a = 1  \n', [{ search: 'a = 1', replace: 'a = 3' }]);
  assert.equal(loose.content, '  a = 3  \n'); // indexOf 로 정확 일치
  const ws = applySearchReplace('if x:\n\ty = 1\n', [{ search: 'if x:\n    y = 1', replace: 'if x:\n\ty = 2' }]);
  assert.equal(ws.content, 'if x:\n\ty = 2\n');
  assert.equal(applySearchReplace(src, [{ search: 'nope', replace: '' }]).failed.length, 1);
});

test('diff 통계', () => {
  assert.deepEqual(lineDiffStats('a\nb\nc', 'a\nB\nc\nd'), { added: 2, removed: 1 });
  assert.deepEqual(lineDiffStats('', 'x\ny'), { added: 2, removed: 0 });
});

test('작업 로그 요약', () => {
  assert.equal(describeCall({ kind: 'read', path: 'a.py', start: 3, end: 9 }), 'READ a.py:3-9');
  assert.equal(describeCall({ kind: 'edit', path: 'b.py', blocks: [{ search: 'x', replace: 'y' }] }), 'EDIT b.py (1블록)');
  assert.equal(describeCall({ kind: 'write', path: 'c.py', content: 'a\nb' }), 'FILE c.py (2줄)');
});
