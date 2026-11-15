/**
 * 디버깅 강화용 순수 로직 (vscode 의존성 없음 → 단위 테스트 가능).
 * - PLAY 인자 해석, 프로젝트 종류 판별
 * - 스택 트레이스/오류 출력에서 파일:줄 위치 추출 (Python · JS/TS · Dart · C# · GDScript · Kotlin/Java · Rust · Go)
 * - 오류 줄 요약, 코드 발췌, 코드 안의 리소스 경로(이미지·사운드) 추출
 * - 디버그 모드 지시문
 */

export type PlayKind = 'auto' | 'web' | 'python' | 'flutter' | 'godot' | 'unity' | 'cmd';

export interface PlayRequest {
  kind: PlayKind;
  target: string;   // html 파일·URL / py 파일 / flutter 기기 / cmd 명령
  seconds: number;  // 0 = 종류별 기본값
  keys: string[];   // 실행 중 누를 키 (비우면 기본 시나리오)
  expect: string;   // 화면에 보여야 하는 것 (비전 모델 확인용)
}

const KINDS = new Set(['auto', 'web', 'python', 'flutter', 'godot', 'unity', 'cmd']);

export const DEFAULT_SECONDS: Record<PlayKind, number> = { auto: 8, web: 8, python: 8, flutter: 20, godot: 8, unity: 0, cmd: 10 };

/** 기본 입력 시나리오: 시작/점프/이동 키를 고루 눌러 게임 루프와 입력 처리를 실제로 실행시킨다. */
export const DEFAULT_KEYS = ['Enter', 'Space', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'Space', 'ArrowDown'];

/**
 * `<<<PLAY [종류] [대상] [초] [keys=A,B] [expect=설명]>>>`
 * 예) PLAY · PLAY web index.html 10 · PLAY python main.py · PLAY flutter 30 · PLAY cmd npm start 15
 */
export function parsePlay(arg: string): PlayRequest {
  let rest = arg.trim();
  let expect = '';
  const em = /\bexpect=(.*)$/i.exec(rest);
  if (em) {
    expect = em[1].trim().replace(/^["']|["']$/g, '');
    rest = rest.slice(0, em.index).trim();
  }
  let keys: string[] = [];
  rest = rest.replace(/\bkeys=(\S+)/i, (_m, k: string) => {
    keys = k.split(',').map((x) => x.trim()).filter(Boolean);
    return '';
  }).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  let kind: PlayKind = 'auto';
  if (tokens.length && KINDS.has(tokens[0].toLowerCase())) kind = tokens.shift()!.toLowerCase() as PlayKind;
  let seconds = 0;
  if (tokens.length && /^\d+(\.\d+)?s?$/.test(tokens[tokens.length - 1])) seconds = parseFloat(tokens.pop()!);
  seconds = Math.min(Math.max(seconds, 0), 120);
  return { kind, target: tokens.join(' '), seconds, keys, expect };
}

/** 워크스페이스 파일 목록(상대 경로)으로 프로젝트 종류 추정 */
export function detectPlayKind(files: string[], read: (rel: string) => string | null): Exclude<PlayKind, 'auto' | 'cmd'> | null {
  const has = (f: string) => files.includes(f);
  if (has('project.godot')) return 'godot';
  if (has('ProjectSettings/ProjectVersion.txt')) return 'unity';
  if (has('pubspec.yaml') && /\bflutter\s*:/.test(read('pubspec.yaml') ?? '')) return 'flutter';
  if (files.some((f) => /(^|\/)index\.html$/.test(f) && !f.includes('node_modules/'))) return 'web';
  if (has('package.json')) {
    const pkg = read('package.json') ?? '';
    if (/"(dev|start)"\s*:/.test(pkg) && /(vite|phaser|pixi|three|webpack|parcel|next)/.test(pkg)) return 'web';
  }
  const py = files.filter((f) => f.endsWith('.py') && !/(^|\/)(\.?venv|site-packages)\//.test(f));
  if (py.length) return 'python';
  return null;
}

/** 실행할 파이썬 진입 파일 */
export function pickPythonEntry(files: string[], read: (rel: string) => string | null): string | null {
  const py = files.filter((f) => f.endsWith('.py') && !/(^|\/)(\.?venv|site-packages|tests?)\//.test(f));
  for (const name of ['main.py', 'game.py', 'app.py', 'run.py', '__main__.py']) {
    const hit = py.find((f) => f === name) ?? py.find((f) => f.endsWith('/' + name));
    if (hit) return hit;
  }
  return py.find((f) => /pygame\.init\(|__name__\s*==\s*['"]__main__['"]/.test(read(f) ?? '')) ?? py[0] ?? null;
}

// ---- 스택 트레이스 → 파일:줄 ---------------------------------------------------------------
export interface TraceLoc { file: string; line: number }

const TRACE_PATTERNS: RegExp[] = [
  /File "([^"]+)", line (\d+)/g,                                                     // Python
  /\(?(?:https?:\/\/[^/\s)]+\/|file:\/\/\/?|webpack:\/\/\/?)?([\w@./\\-]+\.(?:m?jsx?|cjs|tsx?|vue|svelte)):(\d+)(?::\d+)?/g, // JS/TS (브라우저·Node)
  /(?:package:[\w]+\/|file:\/\/\/?)?((?:lib|test|bin|integration_test)\/[\w/.-]+\.dart):(\d+)(?::\d+)?/g, // Dart (lib/ 경로)
  /package:[\w]+\/([\w/.-]+\.dart):(\d+)(?::\d+)?/g,                                  // Dart package:앱이름/x.dart → lib/x.dart
  /([\w/\\.-]+\.cs)\((\d+),\d+\)/g,                                                  // C# 컴파일 오류 (Unity)
  /\(at ([\w/\\.-]+\.cs):(\d+)\)/g,                                                  // Unity 런타임 스택
  /res:\/\/([\w/.-]+\.gd):(\d+)/g,                                                   // Godot
  /\(([\w$]+\.(?:kt|java)):(\d+)\)/g,                                                // Kotlin/Java (파일명만)
  /(?:-->\s*)?((?:src|tests|examples)\/[\w/.-]+\.rs):(\d+)(?::\d+)?/g,               // Rust
  /([\w/.-]+\.(?:go|py|swift|c|cc|cpp|h|hpp|rb|php|lua)):(\d+)(?::\d+)?/g,            // 기타 path:line
];

/**
 * 출력에서 워크스페이스 안의 파일:줄 위치를 찾는다 (등장 순서, 중복 제거).
 * resolve: 후보 경로 → 워크스페이스 상대 경로 (없는 파일·라이브러리 경로면 null)
 */
export function traceLocations(text: string, resolve: (candidate: string) => string | null, max = 6): TraceLoc[] {
  const found: { index: number; loc: TraceLoc }[] = [];
  for (const re of TRACE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let cand = m[1].replace(/\\/g, '/');
      if (re === TRACE_PATTERNS[3]) cand = 'lib/' + cand;
      if (/(^|\/)(node_modules|site-packages|dist-packages|\.pub-cache|flutter\/packages|Library\/PackageCache)\//.test(cand)) continue;
      const file = resolve(cand);
      if (file) found.push({ index: m.index!, loc: { file, line: Number(m[2]) } });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: TraceLoc[] = [];
  for (const { loc } of found) {
    const key = `${loc.file}:${loc.line}`;
    if (seen.has(key) || loc.line <= 0) continue;
    seen.add(key);
    out.push(loc);
  }
  // 파이썬 트레이스백은 마지막 프레임이 실제 오류 위치 → 뒤쪽을 우선
  return (/Traceback \(most recent call last\)/.test(text) ? out.reverse() : out).slice(0, max);
}

/** 워크스페이스 경로 해석기: 절대/상대/파일명만 있는 경우 모두 처리 */
export function makeResolver(root: string, files: string[]): (cand: string) => string | null {
  const set = new Set(files);
  const rootNorm = root.replace(/\\/g, '/').replace(/\/$/, '');
  return (cand: string) => {
    let c = cand.replace(/\\/g, '/').replace(/^\.\//, '');
    if (c.startsWith(rootNorm + '/')) c = c.slice(rootNorm.length + 1);
    if (set.has(c)) return c;
    // http://127.0.0.1:1234/js/game.js → js/game.js 처럼 앞부분이 다른 경우: 뒤에서부터 일치
    const parts = c.split('/');
    for (let i = 1; i < parts.length; i++) {
      const tail = parts.slice(i).join('/');
      if (set.has(tail)) return tail;
    }
    if (!c.includes('/')) {
      const hits = files.filter((f) => f === c || f.endsWith('/' + c));
      if (hits.length === 1) return hits[0];
    }
    return null;
  };
}

/** 코드 발췌 (줄 번호 포함, 오류 줄에 ▶ 표시) */
export function excerpt(content: string, line: number, radius = 4): string {
  const lines = content.split('\n');
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const width = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${i === line ? '▶' : ' '}${String(i).padStart(width)} | ${lines[i - 1]}`);
  return out.join('\n');
}

// ---- 오류 줄 요약 ------------------------------------------------------------------------
const ERROR_LINE = /(error|exception|traceback|uncaught|fatal|panic|failed|failure|segmentation|abort|SCRIPT ERROR|Parse Error|E\/flutter|EXCEPTION CAUGHT|Unhandled|ReferenceError|TypeError|SyntaxError|NameError|AttributeError|KeyError|IndexError|ValueError|NullPointer|NoSuchMethod|LateInitializationError|RangeError|오류)/i;
const NOISE = /(0 errors?|no errors|errors?: 0|without errors|DeprecationWarning|DevTools listening|^\s*$)/i;

export function errorLines(output: string, max = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = output.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const l = lines[i].trimEnd();
    if (!ERROR_LINE.test(l) || NOISE.test(l)) continue;
    const key = l.replace(/\d+/g, '#').slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l.length > 300 ? l.slice(0, 300) + '…' : l);
  }
  return out;
}

// ---- 리소스 경로 검사 (게임에서 가장 흔한 "안 보임" 원인: 이미지·사운드 경로 오타) -------------
const ASSET_RE = /['"`]([^'"`\s${}()]+\.(?:png|jpe?g|gif|webp|bmp|svg|wav|mp3|ogg|m4a|ttf|otf|woff2?|json|tmx|tsx|atlas|fnt|glb|gltf|obj))['"`]/gi;

export interface AssetRef { file: string; line: number; ref: string }

/** 코드 파일 안의 로컬 리소스 경로 문자열 (URL·데이터 URI 제외) */
export function assetRefs(file: string, content: string): AssetRef[] {
  if (!/\.(m?jsx?|tsx?|py|dart|gd|cs|html?|lua|kt|java)$/i.test(file)) return [];
  const out: AssetRef[] = [];
  const lines = content.split('\n');
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|#|\*)/.test(l)) return; // 주석 줄
    for (const m of l.matchAll(ASSET_RE)) {
      const ref = m[1];
      if (/^(https?:|data:|blob:|\/\/)/i.test(ref) || ref.includes('*')) continue;
      out.push({ file, line: i + 1, ref });
    }
  });
  return out;
}

/** 리소스가 실제로 있는지: 파일 위치·프로젝트 루트·흔한 리소스 폴더 기준으로 찾는다 */
export function assetExists(ref: AssetRef, files: Set<string>): boolean {
  const clean = ref.ref.replace(/^res:\/\//, '').replace(/^\.\//, '').replace(/^\//, '');
  const dir = ref.file.includes('/') ? ref.file.slice(0, ref.file.lastIndexOf('/')) : '';
  const norm = (p: string) => {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  };
  const candidates = [
    norm(`${dir}/${ref.ref}`), norm(clean),
    ...['public', 'static', 'assets', 'src', 'web', 'resources', 'res', 'Assets/Resources'].map((d) => norm(`${d}/${clean}`)),
  ];
  if (candidates.some((c) => files.has(c))) return true;
  // 파일명만 같은 것이 어딘가 있으면 경로 문제일 가능성이 있지만 "없음"으로 단정하지는 않는다
  const base = clean.split('/').pop()!;
  return [...files].some((f) => f.endsWith('/' + base) || f === base);
}

// ---- 지시문 -----------------------------------------------------------------------------
export const DEBUG_RULES = `## 디버깅 원칙 (오류가 있거나 동작이 이상할 때)
- 추측으로 고치지 않는다. 먼저 PLAY(게임·앱 실행) 또는 RUN(테스트)으로 재현해 실제 오류·로그·화면을 본다.
- 오류 메시지와 스택 트레이스의 파일:줄을 READ 로 열어 원인 코드를 확인한 뒤 고친다.
- 한 번에 하나의 원인만 고치고, 고친 뒤 같은 방법으로 다시 실행해 확인한다.
- [자동 검사] 결과에 오류가 있으면 그것부터 고친다. 오류가 남은 채로 완료라고 말하지 않는다.
- 원인을 모르면 의심 지점에 임시 로그를 넣는다. 임시 로그 줄 끝에는 반드시 주석으로 YANG-DEBUG 를 붙이고, 끝나면 모두 지운다.
- "화면이 안 보인다/검다/멈춘다" 같은 문제는 PLAY 결과의 화면 분석·프레임 수·리소스 로드 실패를 먼저 본다.`;

export const PLAY_DOC = `<<<PLAY [종류] [대상] [초] [keys=Space,ArrowLeft] [expect=보여야 할 것]>>>
                                   게임·앱을 실제로 실행해 오류·콘솔 로그·리소스 로드 실패·프레임 수를 모으고
                                   마지막 화면을 캡처해 분석한다 (사용자 승인 필요). 종류: web|python|flutter|godot|unity|cmd
                                   예) <<<PLAY>>> (자동) · <<<PLAY web index.html 10>>> · <<<PLAY python main.py>>>
                                       <<<PLAY flutter 30>>> · <<<PLAY cmd npm start 15>>> · <<<PLAY web expect=플레이어와 적이 보임>>>
<<<CHECK>>>                         프로젝트 전체 정적 검사(문법·타입·분석기·IDE 오류·리소스 경로). 파일 수정 후에는 자동으로 실행된다.`;

export function debugPrompt(symptom: string): string {
  return `[디버그 모드] 증상: ${symptom || '(사용자가 증상을 적지 않음 — 먼저 실행해서 문제를 찾는다)'}

다음 순서를 반드시 지키세요:
1. 재현: PLAY(게임·앱) 또는 RUN(테스트)으로 먼저 실행해 실제 오류·로그·화면을 확인한다. 실행 전에 코드를 고치지 않는다.
2. 위치: 오류·스택 트레이스에 나온 파일:줄을 READ 로 열어 원인 코드를 확인한다. 오류가 없으면 증상과 관련된 코드를 GREP/READ 로 찾는다.
3. 가설: 원인 가설을 1~3개 짧게 적고, 가장 가능성 높은 것부터 확인한다.
4. 계측: 확인이 더 필요하면 의심 지점에 임시 로그를 넣는다 (줄 끝 주석에 YANG-DEBUG). 다시 PLAY/RUN 해서 값을 확인한다.
5. 수정: 원인을 고치는 최소한의 수정만 한다 (증상만 가리는 수정 금지: 예외 삼키기, 검사 끄기, 테스트 약화).
6. 검증: 1번과 같은 방법으로 다시 실행해 증상이 사라졌고 새 오류가 없는지 확인한다.
7. 정리: GREP YANG-DEBUG 로 임시 로그를 모두 지운다.
8. 보고: 원인 / 수정 내용 / 검증 결과를 3~5줄로.`;
}

/** 출력 크기 제한 (앞뒤 보존) */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.floor(max * 0.3))}\n…(${(s.length - max).toLocaleString()}자 생략)…\n${s.slice(-Math.floor(max * 0.7))}`;
}
