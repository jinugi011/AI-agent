/** 작업 폴더·git 정보 (순수 함수: 테스트 가능, vscode 의존 없음) */

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', 'Pods', '.dart_tool',
  '.gradle', 'out', '.idea', 'coverage', '.yang', '.vscode', '.pub-cache', '.cxx', 'DerivedData', '.mypy_cache', '.pytest_cache',
]);

/** 승인 없이 실행해도 되는 읽기 전용 git 명령 (status · log · diff · branch 목록 · show · remote -v …) */
export function isReadOnlyGit(command: string): boolean {
  const c = command.trim();
  if (/[;&|`$<>]|\r|\n/.test(c)) return false; // 명령 연결·리다이렉트는 제외
  const m = /^git(?:\s+-C\s+\S+)?\s+(\S+)(.*)$/.exec(c);
  if (!m) return false;
  const [, sub, rest] = m;
  if (['status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse', 'ls-files', 'grep'].includes(sub)) return true;
  if (sub === 'branch') return !/\s-(d|D|m|M|c|C|f|u)\b|--(delete|move|copy|force|set-upstream)/.test(rest);
  if (sub === 'remote') return /^\s*(-v|show\b|get-url\b)?\s*\S*\s*$/.test(rest) && !/\b(add|remove|rm|rename|set-url|prune)\b/.test(rest);
  if (sub === 'stash') return /^\s*list\b/.test(rest);
  if (sub === 'tag') return /^\s*(-l\b|--list\b)?\s*$/.test(rest);
  return false;
}

export interface DirInfo { rel: string; files: number; dirs: number }

/** 폴더 구조 요약: "lib/ (12 files)" 처럼 폴더별 파일 수 · 루트 파일 목록 (항상 같은 순서 → 엔진 캐시 재사용) */
export function formatTree(dirs: DirInfo[], rootFiles: string[], maxDirs = 120): string {
  const sorted = [...dirs].sort((a, b) => a.rel.localeCompare(b.rel));
  const lines = sorted.slice(0, maxDirs).map((d) => {
    const depth = d.rel.split('/').length - 1;
    const name = d.rel.split('/').pop();
    const meta = [d.files ? `${d.files} files` : '', d.dirs ? `${d.dirs} dirs` : ''].filter(Boolean).join(', ');
    return `${'  '.repeat(depth)}${name}/${meta ? ` (${meta})` : ' (비어 있음)'}`;
  });
  if (sorted.length > maxDirs) lines.push(`…(폴더 ${sorted.length - maxDirs}개 더: LIST 폴더경로 로 확인)`);
  const files = [...rootFiles].sort();
  return [...lines, ...files.slice(0, 40), ...(files.length > 40 ? [`…(루트 파일 ${files.length - 40}개 더)`] : [])].join('\n');
}

/** git status --porcelain=v1 -b 출력 요약 */
export function summarizeStatus(porcelain: string, max = 25): { branch: string; changes: string[]; total: number } {
  const lines = porcelain.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  return { branch: head, changes: lines.slice(0, max), total: lines.length };
}

/** LIST 인자가 글롭이 아니라 폴더 경로인지 */
export function isDirListing(pattern: string): boolean {
  return !/[*?[\]{}]/.test(pattern);
}

/** 파일 이름의 역할 접미사: OrderController.kt → Controller · order_screen.dart → _screen */
export function roleSuffix(file: string): string {
  const base = file.split('/').pop()!.replace(/\.[^.]+$/, '');
  const snake = /(_[a-z]+)$/.exec(base);
  if (snake && base.includes('_')) return snake[1];
  const camel = /([A-Z][a-z0-9]+)$/.exec(base);
  return camel && camel.index > 0 ? camel[1] : '';
}

/**
 * 새 파일의 스타일 기준이 될 기존 파일 고르기: 같은 확장자, 같은 역할 접미사 우선 (같은 폴더 → 같은 레이어 폴더 이름).
 * candidates: 프로젝트 상대 경로들
 */
export function pickStyleSibling(newRel: string, candidates: string[]): string | null {
  const ext = /\.[^./]+$/.exec(newRel)?.[0];
  if (!ext || /\.(md|txt|json|ya?ml|png|jpe?g|svg|lock)$/i.test(newRel)) return null;
  const dir = newRel.includes('/') ? newRel.slice(0, newRel.lastIndexOf('/')) : '';
  const layer = dir.split('/').pop() ?? '';
  const suf = roleSuffix(newRel);
  const isTest = /(^|\/)(test|tests|__tests__|spec)\/|[._-](test|spec)\.|Test\.[^.]+$/.test(newRel);
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c === newRel || !c.endsWith(ext) || /\.(g|freezed|gr)\.dart$/.test(c)) continue;
    const cIsTest = /(^|\/)(test|tests|__tests__|spec)\/|[._-](test|spec)\.|Test\.[^.]+$/.test(c);
    if (cIsTest !== isTest) continue;
    const cDir = c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '';
    let score = 1;
    if (cDir === dir) score += 4;
    else if (layer && cDir.split('/').pop() === layer) score += 3;
    if (suf && roleSuffix(c) === suf) score += 5;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 4 ? best : null;
}

/** 새 내용에 기존 줄(공백 무시)이 얼마나 남아 있는지 0~1 (빈 줄·괄호만 있는 줄 제외) */
export function keptRatio(before: string, after: string): number {
  const norm = (t: string) => t.split('\n').map((l) => l.trim()).filter((l) => l.length > 2);
  const old = norm(before);
  if (!old.length) return 1;
  const now = new Set(norm(after));
  return old.filter((l) => now.has(l)).length / old.length;
}
