export type WorkflowMode = 'implementation' | 'harness';

export function workflowRequest(text: string): { goal: string; mode: WorkflowMode } {
  const match = text.trim().match(/^(?:하네스|harness)(?:\s+|$)([\s\S]*)/i);
  return { goal: (match ? match[1] : text).trim(), mode: match ? 'harness' : 'implementation' };
}

export function workflowTask(goal: string, output: string): string {
  return `사용자 요구사항:\n${goal}\n\n아래 명세에 따라 현재 열린 프로젝트에서 구현하고 검증하세요.\n${output}`;
}
