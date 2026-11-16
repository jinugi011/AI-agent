/**
 * 하네스(테스트 우선 구현) — md 문서를 받아 사용자 PC 에서 직접 수행한다 (원격·로컬 공통).
 *   요구사항 문서(md) → .yang/harness/<이름>.md 체크리스트(요구사항 · 수용 기준 · 테스트 이름)
 *   → 프로젝트 스타일의 테스트 작성 → RUN(실패 확인) → 구현 → RUN(통과까지) → 체크리스트 갱신
 * vscode 의존 없음 (테스트 가능).
 */

export const HARNESS_DIR = '.yang/harness';

/** 프로젝트 파일 목록으로 테스트 명령 추정 */
export function detectTestCommand(files: string[], windows = false): string {
  const has = (re: RegExp) => files.some((f) => re.test(f));
  const gradlew = windows ? '.\\gradlew.bat' : './gradlew';
  if (has(/^pubspec\.yaml$/)) return 'flutter test';
  if (has(/^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/)) return has(/^gradlew(\.bat)?$/) ? `${gradlew} test` : 'gradle test';
  if (has(/^pom\.xml$/)) return has(/^mvnw(\.cmd)?$/) ? (windows ? '.\\mvnw.cmd test' : './mvnw test') : 'mvn test';
  if (has(/^package\.json$/)) return 'npm test';
  if (has(/^(pyproject\.toml|setup\.py|requirements\.txt|pytest\.ini)$/) || has(/(^|\/)test_[^/]+\.py$/)) return 'python -m pytest -q';
  if (has(/^Cargo\.toml$/)) return 'cargo test';
  if (has(/^go\.mod$/)) return 'go test ./...';
  return '';
}

export function harnessName(mdPath: string): string {
  const base = mdPath.split(/[\\/]/).pop() ?? 'harness';
  return base.replace(/\.(md|markdown|txt)$/i, '').replace(/[^\w가-힣.-]+/g, '-').slice(0, 60) || 'harness';
}

/** 이미 체크리스트 형식(- [ ] / - [x])인 하네스 문서인지 */
export function isChecklist(md: string): boolean {
  return (md.match(/^\s*[-*] \[[ xX]\]/gm) ?? []).length >= 2;
}

export function checklistProgress(md: string): { done: number; total: number } {
  const all = md.match(/^\s*[-*] \[[ xX]\]/gm) ?? [];
  return { done: all.filter((l) => /\[[xX]\]/.test(l)).length, total: all.length };
}

/** 에이전트에게 보낼 하네스 지시 */
export function harnessPrompt(opts: { source: string; text: string; target: string; testCmd: string; resume: boolean }): string {
  const { source, text, target, testCmd, resume } = opts;
  return `[하네스 모드] 아래 문서를 요구사항으로 삼아 **테스트 우선**으로 구현한다.
원본 문서: ${source}
하네스 체크리스트: ${target}
테스트 명령: ${testCmd || '(감지 못함 — 프로젝트를 보고 정한 뒤 체크리스트에 적는다)'}

진행 순서 (반드시 지킨다):
1. ${resume ? `${target} 를 READ 해 [ ] 로 남은 항목부터 이어서 한다.` : `${target} 를 FILE 로 만든다: 문서의 요구사항을 R1, R2… 로 나누고 각 항목에 수용 기준과 테스트 이름을 적은 체크리스트 (- [ ] R1 …). 맨 위에 테스트 명령을 적는다.`}
2. 자연어 목표와 완료 조건을 의미 단위로 나누고, 각 요구사항에 Given/When/Then 수용 기준·실패 및 경계 조건을 연결한다. 모호한 조건은 가정으로 명시한다. 아키텍처·코딩 규칙과 같은 레이어의 기존 코드·테스트를 READ 해서 기존 스타일·구조를 따른다.
3. 요구사항마다 테스트를 먼저 작성하고 RUN 으로 실패를 확인한다 (컴파일 오류가 아닌 '기대값 불일치' 실패).
4. 구현한 뒤 RUN 으로 통과할 때까지 고친다. 테스트를 약화시켜 통과시키지 않는다.
5. 통과한 항목은 체크리스트를 [x] 로 바꾸고 테스트 파일·통과 결과를 한 줄로 적는다 (EDIT).
6. 모든 항목이 끝나면 전체 테스트를 한 번 더 RUN 하고, 남은 문제·가정을 체크리스트 맨 아래 '메모' 에 적은 뒤 요약한다.

--- 요구사항 문서 (${source}) ---
${text.slice(0, 16000)}${text.length > 16000 ? '\n…(이하 생략: 필요하면 READ)' : ''}`;
}

/** 문서 없이 하네스를 만들 때: 아키텍처 문서·요청에서 요구사항을 뽑게 한다 */
export function harnessFromRequestPrompt(request: string, target: string, testCmd: string): string {
  return harnessPrompt({
    source: '사용자 요청 (+ 아키텍처 · 코딩 규칙)', text: request, target, testCmd, resume: false,
  });
}
