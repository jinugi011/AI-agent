/**
 * 모델 ↔ 에이전트 도구 호출 프로토콜 (텍스트 블록 기반).
 * 로컬 모델은 JSON 이스케이프에 약하므로 코드가 그대로 들어가는 블록 형식을 쓴다.
 * vscode 의존성이 없어 단위 테스트 가능.
 */

export type ToolCall =
  | { kind: 'read'; path: string; start?: number; end?: number }
  | { kind: 'list'; pattern: string }
  | { kind: 'grep'; pattern: string }
  | { kind: 'search'; query: string }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; blocks: { search: string; replace: string }[] }
  | { kind: 'run'; command: string }
  | { kind: 'remember'; memKind: string; scope: string; scopeValue: string; text: string }
  | { kind: 'harness'; task: string }
  | { kind: 'model'; action: string; arg: string }
  | { kind: 'connect'; location: string };

export const TOOL_DOCS = `## 도구 (필요할 때만, 한 응답에 여러 개 가능)
도구 블록은 줄 맨 앞에서 시작한다. 결과는 다음 메시지로 돌려준다. 도구 없이 답하면 대화 턴이 끝난다.

<<<READ path/to/file>>>            파일 읽기 (부분: <<<READ path:120-200>>>)
<<<LIST src/**/*.ts>>>             파일 목록 (glob)
<<<GREP 정규식>>>                    워크스페이스 텍스트 검색
<<<SEARCH 자연어 질의>>>             벡터 DB 에서 관련 코드·코딩 방법 검색
<<<FILE path/to/file
전체 파일 내용
FILE>>>                            파일 생성/전체 교체 (새 파일 또는 작은 파일)
<<<EDIT path/to/file
<<<<<<< SEARCH
기존 코드 (파일과 글자 그대로 일치, 고유해야 함)
=======
바꿀 코드
>>>>>>> REPLACE
EDIT>>>                            부분 수정 (큰 파일은 반드시 EDIT 사용, SEARCH/REPLACE 쌍 여러 개 가능)
<<<RUN 셸 명령>>>                    터미널 명령 실행 (테스트, 빌드, git 등. 사용자 승인 필요)
<<<REMEMBER 종류 범위
내용
REMEMBER>>>                        사용자 스타일/선호/제약을 영구 저장. 종류: style|preference|constraint,
                                   범위: global | language:python | profile:flutter | project
<<<HARNESS
요구사항
HARNESS>>>                         요구사항→테스트 하네스→구현→테스트 반복을 새 브랜치에서 자동 수행 (큰 기능 구현 시)
<<<MODEL list|status|download <key>|start [key]|stop>>>   로컬 모델 관리
<<<CONNECT 경로 또는 git URL>>>      다른 레포 연결 + 벡터화`;

const SIMPLE_RE = /^<<<(READ|LIST|GREP|SEARCH|RUN|MODEL|CONNECT)[ \t]+([^\n]*?)>>>[ \t]*$/gm;
const FILE_RE = /^<<<FILE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^FILE>>>/gm;
const EDIT_RE = /^<<<EDIT[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^EDIT>>>/gm;
const REMEMBER_RE = /^<<<REMEMBER[ \t]*([^\n]*)\n([\s\S]*?)\n?^REMEMBER>>>/gm;
const HARNESS_RE = /^<<<HARNESS[ \t]*\n([\s\S]*?)\n?^HARNESS>>>/gm;
const SR_RE = /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;

function cleanPath(p: string): string {
  return p.trim().replace(/^["'`]|["'`]$/g, '').replace(/^\.\//, '');
}

/** 응답 텍스트에서 도구 호출을 등장 순서대로 추출한다. */
export function parseToolCalls(text: string): ToolCall[] {
  const found: { index: number; call: ToolCall }[] = [];
  const push = (index: number, call: ToolCall) => found.push({ index, call });
  // 본문을 가지는 블록(FILE/EDIT/REMEMBER/HARNESS) 범위. 이 안의 텍스트는 도구 호출로 해석하지 않는다.
  const bodies: [number, number][] = [];
  for (const re of [FILE_RE, EDIT_RE, REMEMBER_RE, HARNESS_RE]) {
    for (const m of text.matchAll(re)) bodies.push([m.index!, m.index! + m[0].length]);
  }
  const insideOther = (i: number) => bodies.some(([s, e]) => i > s && i < e);

  for (const m of text.matchAll(SIMPLE_RE)) {
    const [, tag, raw] = m;
    const arg = raw.trim();
    switch (tag) {
      case 'READ': {
        const range = /^(.*?):(\d+)-(\d+)$/.exec(arg);
        push(m.index!, range
          ? { kind: 'read', path: cleanPath(range[1]), start: Number(range[2]), end: Number(range[3]) }
          : { kind: 'read', path: cleanPath(arg) });
        break;
      }
      case 'LIST': push(m.index!, { kind: 'list', pattern: arg || '**/*' }); break;
      case 'GREP': push(m.index!, { kind: 'grep', pattern: arg }); break;
      case 'SEARCH': push(m.index!, { kind: 'search', query: arg }); break;
      case 'RUN': push(m.index!, { kind: 'run', command: arg }); break;
      case 'CONNECT': push(m.index!, { kind: 'connect', location: arg }); break;
      case 'MODEL': {
        const [action = 'status', ...rest] = arg.split(/\s+/);
        push(m.index!, { kind: 'model', action: action.toLowerCase(), arg: rest.join(' ') });
        break;
      }
    }
  }
  for (const m of text.matchAll(FILE_RE)) {
    push(m.index!, { kind: 'write', path: cleanPath(m[1]), content: m[2] });
  }
  for (const m of text.matchAll(EDIT_RE)) {
    const blocks = [...m[2].matchAll(SR_RE)].map((b) => ({ search: b[1], replace: b[2] }));
    push(m.index!, { kind: 'edit', path: cleanPath(m[1]), blocks });
  }
  for (const m of text.matchAll(REMEMBER_RE)) {
    const [memKind = 'preference', scopeRaw = 'global'] = m[1].trim().split(/\s+/).filter(Boolean);
    const [scope, scopeValue = ''] = scopeRaw.split(':');
    push(m.index!, { kind: 'remember', memKind, scope, scopeValue, text: m[2].trim() });
  }
  for (const m of text.matchAll(HARNESS_RE)) {
    push(m.index!, { kind: 'harness', task: m[1].trim() });
  }
  return found
    .filter((f) => !insideOther(f.index))
    .sort((a, b) => a.index - b.index)
    .map((f) => f.call);
}

/**
 * 채팅 화면 표시용: 도구 블록을 제거한다. 스트리밍 중 아직 닫히지 않은 블록(<<<FILE … 진행 중)도 숨긴다.
 */
export function stripToolBlocks(text: string): string {
  let out = text
    .replace(FILE_RE, '')
    .replace(EDIT_RE, '')
    .replace(REMEMBER_RE, '')
    .replace(HARNESS_RE, '')
    .replace(SIMPLE_RE, '');
  const open = out.search(/^<<<[A-Z]*/m);
  if (open !== -1) out = out.slice(0, open);
  // 줄 끝의 미완성 "<", "<<" 도 숨김
  out = out.replace(/<{1,3}$/, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export interface EditResult {
  content: string;
  applied: number;
  failed: string[];
}

/** SEARCH/REPLACE 적용. 정확히 일치 → 공백 무시 줄 단위 일치 순으로 시도. */
export function applySearchReplace(original: string, blocks: { search: string; replace: string }[]): EditResult {
  let content = original;
  let applied = 0;
  const failed: string[] = [];
  for (const { search, replace } of blocks) {
    if (search === '') {
      content = content + (content.endsWith('\n') || content === '' ? '' : '\n') + replace + '\n';
      applied++;
      continue;
    }
    const idx = content.indexOf(search);
    if (idx !== -1) {
      if (content.indexOf(search, idx + 1) !== -1) {
        failed.push(`SEARCH 블록이 여러 곳과 일치합니다(고유하지 않음):\n${search.slice(0, 200)}`);
        continue;
      }
      content = content.slice(0, idx) + replace + content.slice(idx + search.length);
      applied++;
      continue;
    }
    // 들여쓰기/후행 공백 차이 허용: 줄 단위 trim 비교
    const lines = content.split('\n');
    const needle = search.split('\n').map((l) => l.trim());
    let hit = -1;
    for (let i = 0; i + needle.length <= lines.length; i++) {
      if (needle.every((n, j) => lines[i + j].trim() === n)) {
        if (hit !== -1) { hit = -2; break; }
        hit = i;
      }
    }
    if (hit >= 0) {
      lines.splice(hit, needle.length, ...replace.split('\n'));
      content = lines.join('\n');
      applied++;
    } else {
      failed.push(`SEARCH 블록을 파일에서 찾지 못했습니다:\n${search.slice(0, 200)}`);
    }
  }
  return { content, applied, failed };
}

export function lineDiffStats(before: string, after: string): { added: number; removed: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const count = new Map<string, number>();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = count.get(l) ?? 0;
    if (c > 0) { common++; count.set(l, c - 1); }
  }
  return { added: b.length - common, removed: a.length - common };
}
