import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { workflowRequest, workflowTask } from '../workflow';
import { harnessFromRequestPrompt } from '../harnesskit';

test('원격 LangChain 요청: 하네스 모드·자연어 줄바꿈 보존', () => {
  assert.deepEqual(workflowRequest('하네스 주문 취소\n배송 중 취소 불가'), { goal: '주문 취소\n배송 중 취소 불가', mode: 'harness' });
  assert.deepEqual(workflowRequest('로그인 기능'), { goal: '로그인 기능', mode: 'implementation' });
  assert.deepEqual(workflowRequest('harness'), { goal: '', mode: 'harness' });
  const task = workflowTask('주문 취소', '- [ ] R1 재고 복구');
  const prompt = harnessFromRequestPrompt(task, '.yang/harness/work.md', 'npm test');
  assert.match(prompt, /Given\/When\/Then/);
  assert.match(prompt, /재고 복구/);
  assert.match(prompt, /npm test/);
});
