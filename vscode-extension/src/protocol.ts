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
  | { kind: 'analyze'; path: string }
  | { kind: 'check' }
  | { kind: 'play'; req: PlayRequest }
  | { kind: 'image'; path: string; fields: Record<string, string> }
  | { kind: 'delete'; path: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'mkdir'; path: string };

export const TOOL_DOCS = `## 도구 (필요할 때만, 한 응답에 여러 개 가능)
도구 블록은 줄 맨 앞에서 시작한다. 결과는 다음 메시지로 돌려준다. 도구 없이 답하면 대화 턴이 끝난다.

<<<READ path/to/file>>>            파일 읽기 (부분: <<<READ path:120-200>>>)
<<<LIST src/**/*.ts>>>             파일 찾기 (glob)
<<<LIST lib/screens>>>              폴더 한 단계 보기 (폴더는 / 로 끝남 · LIST . = 최상위)
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
<<<RUN 셸 명령>>>                    터미널 명령 실행 (테스트, 빌드, git 등. 사용자 승인 필요. Windows 는 PowerShell)
<<<DELETE path>>>                   파일·폴더 삭제 (승인 필요 · 파일은 /undo 로 복구, 폴더는 휴지통)
<<<MOVE 원래경로 -> 새경로>>>         파일·폴더 이동/이름 바꾸기 (승인 필요 · /undo 가능)
<<<MKDIR path>>>                    폴더 만들기
(파일 삭제·이동·폴더 생성은 RUN 의 rm/mv/mkdir 대신 위 도구를 쓴다: Windows·macOS 모두 동작)
<<<REMEMBER 종류 범위
내용
REMEMBER>>>                        사용자 스타일/선호/제약을 영구 저장. 종류: style|preference|constraint,
                                   범위: global | language:python | profile:flutter | project
<<<HARNESS
요구사항
HARNESS>>>                         요구사항→테스트 하네스→구현→테스트 반복을 새 브랜치에서 자동 수행 (큰 기능 구현 시)
<<<MODEL list|status|download <key>|start [key]|stop>>>   로컬 모델 관리
<<<ANALYZE>>>                       프로젝트 전체 분석: 코드·문서를 임베딩하고 코딩 스타일·아키텍처 문서를 새로 만든다 (승인 필요, 1~3분).
                                   구조를 모르거나 아키텍처 규칙이 없을 때, 큰 구조 변경 뒤에 쓴다. 결과로 아키텍처 문서를 돌려준다.
<<<CONNECT git URL 또는 다른 폴더>>>  작업 폴더 밖의 다른 레포를 벡터화 (작업 폴더는 이미 연결됨 → 쓰지 말 것)
${PLAY_DOC}
<<<IMAGE 저장경로.png
prompt: 영어로 '무엇을' 그릴지 구체적으로 (대상·자세·방향·특징·색 등). 화풍은 프로젝트 아트 컨셉이 자동으로 붙음
kind: character                    종류: character|enemy|item|icon|tile|background|ui|effect|portrait (종류별 구도·투명 배경·기본 크기 자동)
size: 64x64                        최종 크기 (비우면 아트 컨셉의 종류별 크기)
transparent: yes                   배경 제거 (비우면 종류에 따라 자동)
verify: no                         생성 후 비전 모델이 컨셉과 대조해 낮으면 한 번 다시 그림 (기본 켬, 끄면 빠름)
pixel: 32                          픽셀아트로 변환 (가로 32칸, colors: 16 으로 색 수 제한)
ref: assets/concept.png            참고 이미지의 '스타일'을 따라 그림 (프로젝트 파일 | attachment:첨부이름 | search:무료 이미지 검색어)
strength: 0.4                      참고 이미지를 밑그림으로도 쓰는 정도 0~0.9 (기본 0 = 스타일만)
from: assets/old.png               기존 이미지를 고쳐 그리기 (prompt 와 함께) 또는 가공만 (prompt 없이)
join: a.png, b.png, c.png          여러 이미지를 스프라이트 시트로 합치기 (cols: 3)
ops: flip-x; rotate 90; tint #ff8800 0.3; crop x,y,w,h; resize WxH; remove-bg; trim; pixelate 32; grayscale; sheet-split 4x1
overwrite: yes                     같은 경로에 그림이 이미 있으면 기본은 다시 만들지 않음 (새로 그릴 때만 yes)
IMAGE>>>                           프로젝트용 그림을 맥의 이미지 모델(FLUX)로 생성·가공해 저장. 한 장에 15~40초.
                                   sheet-split 은 경로_0.png, 경로_1.png … 로 저장. 웹 참고 이미지는 CC0·퍼블릭 도메인만 쓰고 ASSET_CREDITS.md 에 기록.`;

const SIMPLE_RE = /^<<<(READ|LIST|GREP|SEARCH|RUN|MODEL|CONNECT|ANALYZE|CHECK|PLAY|DELETE|MOVE|MKDIR)(?:[ \t]+([^\n]*?))?>>>[ \t]*$/gm;
const FILE_RE = /^<<<FILE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^FILE>>>/gm;
const EDIT_RE = /^<<<EDIT[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^EDIT>>>/gm;
const REMEMBER_RE = /^<<<REMEMBER[ \t]*([^\n]*)\n([\s\S]*?)\n?^REMEMBER>>>/gm;
const HARNESS_RE = /^<<<HARNESS[ \t]*\n([\s\S]*?)\n?^HARNESS>>>/gm;
const IMAGE_RE = /^<<<IMAGE[ \t]+([^\n>]+?)[ \t]*\n([\s\S]*?)\n?^IMAGE>>>/gm;
const SR_RE = /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;

/** 모델이 도구 블록을 엉뚱한 태그로 감싸는 경우 정리 (<tool_code> … </tool_code> 등) */
export function normalizeToolText(text: string): string {
  const t = text.replace(/<\/?tool_code>/g, '\n').replace(/<\/?tool_call>/g, '\n');
  return closeOpenEdits(t);
}

/**
 * 닫는 줄 EDIT>>> 를 빠뜨린 EDIT 블록을 닫아 준다 (다음 도구 시작 줄 앞 또는 끝에).
 * 안의 SEARCH/REPLACE 블록은 따로 검사하므로 안전하다. FILE 은 잘린 파일일 수 있어 닫아 주지 않는다.
 */
export function closeOpenEdits(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let open = false;
  for (const line of lines) {
    if (open && /^<<<[A-Z]/.test(line)) { out.push('EDIT>>>'); open = false; }
    if (/^<<<EDIT[ \t]+\S/.test(line)) open = true;
    else if (/^EDIT>>>\s*$/.test(line)) open = false;
    out.push(line);
  }
  if (open) out.push('EDIT>>>');
  return out.join('\n');
}

/**
 * EDIT 본문의 SEARCH/REPLACE 블록을 줄 단위로 읽는다. 흔한 형식 실수도 바르게 해석:
 *  - 블록 끝을 '>>>>>>> REPLACE' 대신 '=======' 로 닫음 · 마지막 블록의 REPLACE 줄 빠짐 · 표식 줄 앞뒤 공백
 * 해석할 수 없는 블록(구분선이 없는 SEARCH)은 search 에 표식을 남겨 적용 단계에서 실패하게 한다 (파일을 망가뜨리지 않음).
 */
export function parseSearchReplace(body: string): { search: string; replace: string }[] {
  const out: { search: string; replace: string }[] = [];
  let state: 'idle' | 'search' | 'replace' = 'idle';
  let sea: string[] = [];
  let rep: string[] = [];
  const close = () => { out.push({ search: sea.join('\n'), replace: rep.join('\n') }); sea = []; rep = []; state = 'idle'; };
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (/^<{5,9}\s*SEARCH$/.test(t)) {
      if (state === 'replace') close();
      else if (state === 'search') { out.push({ search: '\u0000FORMAT\u0000' + sea.join('\n'), replace: '' }); sea = []; }
      state = 'search';
      continue;
    }
    if (/^={5,9}$/.test(t)) {
      if (state === 'search') { state = 'replace'; continue; }
      if (state === 'replace') { close(); continue; } // REPLACE 대신 ======= 로 닫은 실수
    }
    if (/^>{5,9}\s*REPLACE$/.test(t)) {
      if (state === 'replace') close();
      continue;
    }
    if (state === 'search') sea.push(line);
    else if (state === 'replace') rep.push(line);
  }
  if (state === 'replace') close();
  else if (state === 'search') out.push({ search: '\u0000FORMAT\u0000' + sea.join('\n'), replace: '' });
  return out;
}

function cleanPath(p: string): string {
  return p.trim().replace(/^["'`]|["'`]$/g, '').replace(/^\.\//, '');
}

/** 응답 텍스트에서 도구 호출을 등장 순서대로 추출한다. */
export function parseToolCalls(text: string): ToolCall[] {
  text = normalizeToolText(text);
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
    if (!arg && !['CHECK', 'PLAY', 'MODEL', 'LIST', 'ANALYZE'].includes(tag)) continue;
    switch (tag) {
      case 'READ': {
        const range = /^(.*?):(\d+)-(\d+)$/.exec(arg);
        push(m.index!, range
          ? { kind: 'read', path: cleanPath(range[1]), start: Number(range[2]), end: Number(range[3]) }
          : { kind: 'read', path: cleanPath(arg) });
        break;
      }
      case 'LIST': push(m.index!, { kind: 'list', pattern: arg || '.' }); break;
      case 'GREP': push(m.index!, { kind: 'grep', pattern: arg }); break;
      case 'SEARCH': push(m.index!, { kind: 'search', query: arg }); break;
      case 'RUN': push(m.index!, { kind: 'run', command: arg }); break;
      case 'CONNECT': push(m.index!, { kind: 'connect', location: arg }); break;
      case 'ANALYZE': push(m.index!, { kind: 'analyze', path: arg ? cleanPath(arg) : '' }); break;
      case 'CHECK': push(m.index!, { kind: 'check' }); break;
      case 'DELETE': push(m.index!, { kind: 'delete', path: cleanPath(arg) }); break;
      case 'MKDIR': push(m.index!, { kind: 'mkdir', path: cleanPath(arg) }); break;
      case 'MOVE': {
        const mv = /^(.+?)\s*(?:->|→|=>)\s*(.+)$/.exec(arg) ?? /^(\S+)\s+(\S+)$/.exec(arg);
        if (mv) push(m.index!, { kind: 'move', from: cleanPath(mv[1]), to: cleanPath(mv[2]) });
        break;
      }
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
    const blocks = parseSearchReplace(m[2]);
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
  let out = normalizeToolText(text)
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
    if (search.startsWith('\u0000FORMAT\u0000')) {
      failed.push('EDIT 형식 오류: <<<<<<< SEARCH 다음에 ======= 와 >>>>>>> REPLACE 가 있어야 합니다 (블록마다).');
      continue;
    }
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
      continue;
    }
    // 빈 줄 차이 허용: 빈 줄을 뺀 줄들로 비교해 유일하게 맞으면 그 범위를 바꾼다
    const nonEmpty = lines.map((l, i) => [l.trim(), i] as [string, number]).filter(([t]) => t !== '');
    const need2 = needle.filter((n) => n !== '');
    let hit2 = -1;
    if (need2.length >= 2) {
      for (let i = 0; i + need2.length <= nonEmpty.length; i++) {
        if (need2.every((n, j) => nonEmpty[i + j][0] === n)) {
          if (hit2 !== -1) { hit2 = -2; break; }
          hit2 = i;
        }
      }
    }
    if (hit2 >= 0) {
      const from = nonEmpty[hit2][1];
      const to = nonEmpty[hit2 + need2.length - 1][1];
      lines.splice(from, to - from + 1, ...replace.split('\n'));
      content = lines.join('\n');
      applied++;
      continue;
    }
    failed.push(`SEARCH 블록을 파일에서 찾지 못했습니다${hit === -2 || hit2 === -2 ? ' (여러 곳과 비슷함 — 앞뒤 줄을 더 넣어 고유하게)' : ''}:\n` +
      `${search.slice(0, 200)}\n${closestSnippet(lines, needle)}`);
  }
  return { content, applied, failed };
}

/** SEARCH 가 안 맞을 때: 파일에서 가장 비슷한 부분을 줄 번호와 함께 보여 준다 (그 원문으로 EDIT 를 다시 하도록) */
export function closestSnippet(lines: string[], needle: string[]): string {
  const need = needle.filter((n) => n !== '');
  if (!need.length || !lines.length) return '';
  const set = new Set(need);
  let best = -1;
  let bestScore = 0;
  const win = Math.max(need.length, 1);
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (let j = i; j < Math.min(lines.length, i + win + 2); j++) if (set.has(lines[j].trim())) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore === 0) return '(비슷한 부분 없음: 파일을 다시 READ 해서 실제 내용을 확인하세요)';
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + win + 4);
  return `파일에서 가장 비슷한 부분 (${from + 1}~${to}줄) — 이 원문을 그대로 SEARCH 에 넣어 EDIT 를 다시 하세요 (FILE 로 전체를 다시 쓰지 말 것):\n` +
    lines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(4)}| ${l}`).join('\n');
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
    case 'analyze': return `ANALYZE ${c.path}`.trim();
    case 'check': return 'CHECK';
    case 'delete': return `DELETE ${c.path}`;
    case 'move': return `MOVE ${c.from} -> ${c.to}`;
    case 'mkdir': return `MKDIR ${c.path}`;
    case 'image': return `IMAGE ${c.path}${c.fields.size ? ' ' + c.fields.size : ''}${c.fields.prompt ? ' — ' + one(c.fields.prompt, 60) : c.fields.ops ? ' — ' + one(c.fields.ops, 60) : ''}`;
    case 'play': return `PLAY ${c.req.kind}${c.req.target ? ' ' + c.req.target : ''}${c.req.seconds ? ' ' + c.req.seconds + '초' : ''}`;
  }
}
