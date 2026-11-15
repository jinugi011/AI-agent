/**
 * 모델 ↔ 에이전트 도구 호출 프로토콜 (텍스트 블록 기반).
 * 로컬 모델은 JSON 이스케이프에 약하므로 코드가 그대로 들어가는 블록 형식을 쓴다.
 * vscode 의존성이 없어 단위 테스트 가능.
 */
import { parsePlay, PlayRequest, PLAY_DOC } from './debugkit';

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
  | { kind: 'connect'; location: string }
  | { kind: 'check' }
  | { kind: 'play'; req: PlayRequest }
  | { kind: 'image'; path: string; fields: Record<string, string> };

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
<<<CONNECT 경로 또는 git URL>>>      다른 레포 연결 + 벡터화
${PLAY_DOC}
<<<IMAGE 저장경로.png
prompt: 영어로 그림 설명 (예: cute pixel art knight, front view, full body)
size: 64x64                        최종 크기 (작은 스프라이트도 크게 그린 뒤 줄여 깨끗하게)
transparent: yes                   배경 제거 (캐릭터·아이템·아이콘)
pixel: 32                          픽셀아트로 변환 (가로 32칸, colors: 16 으로 색 수 제한)
ref: assets/concept.png            참고 이미지의 '스타일'을 따라 그림 (프로젝트 파일 | attachment:첨부이름 | search:무료 이미지 검색어)
strength: 0.4                      참고 이미지를 밑그림으로도 쓰는 정도 0~0.9 (기본 0 = 스타일만)
from: assets/old.png               기존 이미지를 고쳐 그리기 (prompt 와 함께) 또는 가공만 (prompt 없이)
join: a.png, b.png, c.png          여러 이미지를 스프라이트 시트로 합치기 (cols: 3)
ops: flip-x; rotate 90; tint #ff8800 0.3; crop x,y,w,h; resize WxH; remove-bg; trim; pixelate 32; grayscale; sheet-split 4x1
IMAGE>>>                           프로젝트용 그림을 맥의 이미지 모델(FLUX)로 생성·가공해 저장. 한 장에 15~40초.
                                   sheet-split 은 경로_0.png, 경로_1.png … 로 저장. 웹 참고 이미지는 CC0·퍼블릭 도메인만 쓰고 ASSET_CREDITS.md 에 기록.`;

const SIMPLE_RE = /^<<<(READ|LIST|GREP|SEARCH|RUN|MODEL|CONNECT|CHECK|PLAY)(?:[ \t]+([^\n]*?))?>>>[ \t]*$/gm;
const FILE_RE = /^<<<FILE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^FILE>>>/gm;
const EDIT_RE = /^<<<EDIT[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^EDIT>>>/gm;
const REMEMBER_RE = /^<<<REMEMBER[ \t]*([^\n]*)\n([\s\S]*?)\n?^REMEMBER>>>/gm;
const HARNESS_RE = /^<<<HARNESS[ \t]*\n([\s\S]*?)\n?^HARNESS>>>/gm;
const IMAGE_RE = /^<<<IMAGE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^IMAGE>>>/gm;
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
  for (const re of [FILE_RE, EDIT_RE, REMEMBER_RE, HARNESS_RE, IMAGE_RE]) {
    for (const m of text.matchAll(re)) bodies.push([m.index!, m.index! + m[0].length]);
  }
  const insideOther = (i: number) => bodies.some(([s, e]) => i > s && i < e);

  for (const m of text.matchAll(SIMPLE_RE)) {
    const [, tag, raw = ''] = m;
    const arg = raw.trim();
    if (!arg && !['CHECK', 'PLAY', 'MODEL', 'LIST'].includes(tag)) continue;
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
      case 'CHECK': push(m.index!, { kind: 'check' }); break;
      case 'PLAY': push(m.index!, { kind: 'play', req: parsePlay(arg) }); break;
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
  for (const m of text.matchAll(IMAGE_RE)) {
    const fields: Record<string, string> = {};
    let last = '';
    for (const line of m[2].split('\n')) {
      const kv = /^\s*([a-z_]+)\s*:\s*(.*)$/i.exec(line);
      if (kv) { last = kv[1].toLowerCase(); fields[last] = kv[2].trim(); }
      else if (last && line.trim()) fields[last] += ' ' + line.trim(); // 여러 줄 prompt
    }
    push(m.index!, { kind: 'image', path: cleanPath(m[1]), fields });
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
    .replace(IMAGE_RE, '')
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

/** 작업 로그용 한 줄 요약 (예: "READ shop/cart.py:10-20", "EDIT a.py (2블록)"). */
export function describeCall(c: ToolCall): string {
  const one = (s: string, n = 80) => {
    const line = s.split('\n')[0];
    return line.length > n ? line.slice(0, n) + '…' : line;
  };
  switch (c.kind) {
    case 'read': return `READ ${c.path}${c.start ? `:${c.start}-${c.end}` : ''}`;
    case 'list': return `LIST ${c.pattern}`;
    case 'grep': return `GREP ${c.pattern}`;
    case 'search': return `SEARCH ${one(c.query)}`;
    case 'write': return `FILE ${c.path} (${c.content.split('\n').length}줄)`;
    case 'edit': return `EDIT ${c.path} (${c.blocks.length}블록)`;
    case 'run': return `RUN ${one(c.command, 120)}`;
    case 'remember': return `REMEMBER ${c.memKind} ${c.scope}${c.scopeValue ? ':' + c.scopeValue : ''} — ${one(c.text)}`;
    case 'harness': return `HARNESS ${one(c.task)}`;
    case 'model': return `MODEL ${c.action}${c.arg ? ' ' + c.arg : ''}`;
    case 'connect': return `CONNECT ${c.location}`;
    case 'check': return 'CHECK';
    case 'image': return `IMAGE ${c.path}${c.fields.size ? ' ' + c.fields.size : ''}${c.fields.prompt ? ' — ' + one(c.fields.prompt, 60) : c.fields.ops ? ' — ' + one(c.fields.ops, 60) : ''}`;
    case 'play': return `PLAY ${c.req.kind}${c.req.target ? ' ' + c.req.target : ''}${c.req.seconds ? ' ' + c.req.seconds + '초' : ''}`;
  }
}
