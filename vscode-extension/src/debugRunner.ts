/**
 * 디버깅 강화: 자동 검사(CHECK) · 실행 오류 수집(PLAY) · 화면 캡처 분석.
 *
 * CHECK: IDE 진단 + 언어별 빠른 검사(문법·타입·분석기) + 리소스 경로 검사. 고정된 분석 명령만 실행하므로 승인 없이 동작.
 * PLAY : 게임·앱을 N초 실행 → 오류·콘솔·리소스 로드 실패·프레임 수 수집 + 마지막 화면 캡처 → 서버 비전 모델로 화면 확인.
 *   web     Chrome 헤드리스 + DevTools 프로토콜 (정적 서버 또는 npm dev 서버), 키 입력 시나리오
 *   python  창 없이(SDL dummy) 실행, sitecustomize 로 pygame 화면 캡처·키 입력·프레임 수
 *   flutter flutter run (안드로이드 기기/에뮬레이터 > macOS > Chrome), adb 화면 캡처
 *   godot   --headless --quit-after, unity: 에디터 실행 중이면 Editor.log, 아니면 batchmode 컴파일
 *   cmd     임의 명령 N초 실행 (출력에 localhost 주소가 나오면 그 페이지도 web 처럼 검사)
 */
import { spawn, SpawnOptions } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { backend } from './clients';
import * as dk from './debugkit';

const EXCLUDE = '**/{node_modules,.git,dist,build,target,.venv,venv,__pycache__,.next,Pods,.dart_tool,.gradle,models,out,.idea,coverage,Library,Temp,obj,.godot,.yang}/**';
const CODE_EXT = /\.(py|m?jsx?|cjs|tsx?|dart|gd|cs|html?|json|kt|java|rs|go|lua|vue|svelte)$/i;

export interface Problem { file: string; line: number; col?: number; severity: 'error' | 'warning'; message: string; source: string }
export interface CheckReport { errors: number; warnings: number; text: string; problems: Problem[] }

// ---- 공통 유틸 -----------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function listFiles(root: vscode.Uri, limit = 8000): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, limit);
  return uris.map((u) => path.relative(root.fsPath, u.fsPath).replace(/\\/g, '/')).sort();
}

function readRel(root: string, rel: string): string | null {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

interface ProcResult { code: number | null; out: string; timedOut: boolean }

/** 프로세스 실행 (셸 없이). timeoutMs 가 지나면 종료. */
function proc(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...(opts.env ?? {}), FORCE_COLOR: '0', NO_COLOR: '1' } });
    const onData = (d: Buffer) => { out += d.toString(); if (out.length > 400_000) out = out.slice(-200_000); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs ?? 60_000);
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); opts.signal?.removeEventListener('abort', kill); resolve({ code, out, timedOut }); });
  });
}

/** 로그인 셸 기준 PATH 에서 명령 찾기 (VS Code 를 Dock 에서 띄우면 PATH 가 짧다) */
const whichCache = new Map<string, string | null>();
async function which(cmd: string): Promise<string | null> {
  if (whichCache.has(cmd)) return whichCache.get(cmd)!;
  let found: string | null = null;
  if (process.platform === 'win32') {
    const r = await proc('where', [cmd], { timeoutMs: 5000 });
    found = r.code === 0 ? r.out.split(/\r?\n/)[0].trim() : null;
  } else {
    const r = await proc('/bin/zsh', ['-lc', `command -v ${cmd}`], { timeoutMs: 8000 });
    found = r.code === 0 && r.out.trim().startsWith('/') ? r.out.trim().split('\n').pop()! : null;
  }
  whichCache.set(cmd, found);
  return found;
}

const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };

async function loginPathEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return {};
  const r = await proc('/bin/zsh', ['-lc', 'echo $PATH'], { timeoutMs: 8000 });
  return r.code === 0 ? { PATH: r.out.trim().split('\n').pop() } : {};
}

// ---- CHECK: IDE 진단 + 빠른 검사 --------------------------------------------------------------
async function ideDiagnostics(root: vscode.Uri, rels: string[] | null): Promise<Problem[]> {
  const uris = rels?.map((r) => vscode.Uri.joinPath(root, r));
  if (uris) {
    // 언어 서버는 열린 문서를 분석한다 → 문서를 열고, 진단이 안정될 때까지 잠깐 기다린다
    await Promise.all(uris.map((u) => vscode.workspace.openTextDocument(u).then(() => undefined, () => undefined)));
    let last = '';
    let stable = 0;
    for (let i = 0; i < 14 && stable < 3; i++) {
      await sleep(250);
      const snap = uris.map((u) => vscode.languages.getDiagnostics(u).length).join(',');
      stable = snap === last ? stable + 1 : 0;
      last = snap;
    }
  }
  const out: Problem[] = [];
  const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = uris
    ? uris.map((u) => [u, vscode.languages.getDiagnostics(u)])
    : vscode.languages.getDiagnostics().filter(([u]) => u.fsPath.startsWith(root.fsPath));
  for (const [u, diags] of entries) {
    const rel = path.relative(root.fsPath, u.fsPath).replace(/\\/g, '/');
    if (rel.startsWith('..') || /(^|\/)(node_modules|\.venv|build|dist)\//.test(rel)) continue;
    for (const d of diags) {
      if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) continue;
      out.push({
        file: rel, line: d.range.start.line + 1, col: d.range.start.character + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        message: d.message.split('\n')[0], source: `IDE${d.source ? ':' + d.source : ''}`,
      });
    }
  }
  return out;
}

async function pythonExe(root: string): Promise<string | null> {
  for (const p of ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe']) {
    if (exists(path.join(root, p))) return path.join(root, p);
  }
  return (await which('python3')) ?? (await which('python'));
}

// 문법 검사 + (pyflakes 가 없을 때) 정의되지 않은 이름 검사. 파일을 쓰지 않는다(py_compile 은 __pycache__ 를 만든다).
const PY_SYNTAX = `import sys, ast, builtins
use_flakes = sys.argv[1] == "1"
for f in sys.argv[2:]:
    try:
        src = open(f, encoding="utf-8").read()
        tree = compile(src, f, "exec", ast.PyCF_ONLY_AST)
    except SyntaxError as e:
        print(f"{f}:{e.lineno or 0}:{e.offset or 0}: error: SyntaxError: {e.msg}")
        continue
    except Exception:
        continue
    if use_flakes:
        continue
    if any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree)):
        continue
    bound = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__builtins__", "__spec__", "__path__", "__package__", "__loader__"}
    aug = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name):
            aug.add(id(n.target))
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)) and id(n) not in aug:
            bound.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(n.name)
        elif isinstance(n, ast.arg):
            bound.add(n.arg)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                bound.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            bound.update(n.names)
        elif hasattr(ast, "MatchAs") and isinstance(n, ast.MatchAs) and n.name:
            bound.add(n.name)
    seen = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and (isinstance(n.ctx, ast.Load) or id(n) in aug) and n.id not in bound and n.id not in seen:
            seen.add(n.id)
            print(f"{f}:{n.lineno}:{n.col_offset + 1}: error: 정의되지 않은 이름 '{n.id}' (오타이거나 먼저 값을 넣지 않음)")
`;

async function checkPython(root: string, files: string[]): Promise<Problem[]> {
  const py = await pythonExe(root);
  if (!py || !files.length) return [];
  const out: Problem[] = [];
  // pyflakes 가 있으면 그것으로(더 정확), 없으면 내장 검사로 정의되지 않은 이름을 찾는다
  const pf = await proc(py, ['-m', 'pyflakes', ...files], { cwd: root, timeoutMs: 30_000 });
  const hasFlakes = !/No module named pyflakes/.test(pf.out) && pf.code !== -1;
  const syn = await proc(py, ['-c', PY_SYNTAX, hasFlakes ? '1' : '0', ...files], { cwd: root, timeoutMs: 30_000 });
  for (const m of syn.out.matchAll(/^(.+?):(\d+):(\d+): error: (.+)$/gm)) {
    out.push({ file: m[1], line: +m[2], col: +m[3], severity: 'error', message: m[4], source: hasFlakes ? 'python' : 'python(내장 검사)' });
  }
  if (hasFlakes) {
    for (const m of pf.out.matchAll(/^(.+?):(\d+):(?:(\d+):?)?\s*(.+)$/gm)) {
      const msg = m[4].trim();
      const severe = /undefined name|referenced before assignment|unable to detect undefined|invalid syntax|import \*|redefinition of unused .* from line/.test(msg) && !/imported but unused/.test(msg);
      out.push({ file: m[1], line: +m[2], col: m[3] ? +m[3] : undefined, severity: severe ? 'error' : 'warning', message: msg, source: 'pyflakes' });
    }
  }
  return out;
}

/** JS 문법 검사: import/export 가 있으면 ES 모듈로. HTML 은 인라인 <script> 를 꺼내 검사. */
async function checkJs(root: string, files: string[]): Promise<Problem[]> {
  const node = await which('node');
  if (!node || !files.length) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yang-js-'));
  const out: Problem[] = [];
  try {
    const units: { file: string; code: string; offset: number; module: boolean }[] = [];
    for (const f of files) {
      const src = readRel(root, f);
      if (src === null) continue;
      if (/\.html?$/i.test(f)) {
        for (const m of src.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
          const attrs = m[1] ?? '';
          if (/\bsrc=/.test(attrs) || /type=["'](?!module|text\/javascript)/.test(attrs) || !m[2].trim()) continue;
          const offset = src.slice(0, m.index! + m[0].indexOf('>') + 1).split('\n').length - 1;
          units.push({ file: f, code: m[2], offset, module: /type=["']module/.test(attrs) });
        }
      } else {
        units.push({ file: f, code: src, offset: 0, module: f.endsWith('.mjs') || /^\s*(import|export)\s/m.test(src) });
      }
    }
    let i = 0;
    for (const u of units) {
      const tmpFile = path.join(tmp, `u${i++}${u.module ? '.mjs' : '.cjs'}`);
      fs.writeFileSync(tmpFile, u.code);
      const r = await proc(node, ['--check', tmpFile], { timeoutMs: 15_000 });
      if (r.code === 0) continue;
      const line = Number(new RegExp(`${tmpFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(r.out)?.[1] ?? 1);
      const msg = /^(\w*Error: .+)$/m.exec(r.out)?.[1] ?? r.out.trim().split('\n').pop() ?? '문법 오류';
      out.push({ file: u.file, line: line + u.offset, severity: 'error', message: msg, source: 'node --check' });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

async function checkTs(root: string): Promise<Problem[]> {
  const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (!exists(tsc) || !exists(path.join(root, 'tsconfig.json'))) return [];
  const r = await proc(tsc, ['--noEmit', '-p', root, '--pretty', 'false'], { cwd: root, timeoutMs: 120_000 });
  const out: Problem[] = [];
  for (const m of r.out.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+: .+)$/gm)) {
    out.push({ file: m[1].replace(/\\/g, '/'), line: +m[2], col: +m[3], severity: m[4] as 'error' | 'warning', message: m[5], source: 'tsc' });
  }
  return out;
}

async function checkDart(root: string, files: string[] | null): Promise<Problem[]> {
  const pubspec = readRel(root, 'pubspec.yaml');
  if (pubspec === null) return [];
  const isFlutter = /\bflutter\s*:/.test(pubspec);
  const bin = isFlutter ? await which('flutter') : await which('dart');
  if (!bin) return [];
  const targets = files?.length ? files : [];
  const args = isFlutter ? ['analyze', '--no-pub', '--no-fatal-infos', '--no-fatal-warnings', ...targets] : ['analyze', '--fatal-infos=false', ...targets];
  const r = await proc(bin, args, { cwd: root, timeoutMs: 180_000, env: await loginPathEnv() });
  const out: Problem[] = [];
  // flutter: "  error • 메시지 • lib/x.dart:12:5 • code"   dart: "  error - lib/x.dart:12:5 - 메시지 - code"
  for (const m of r.out.matchAll(/^\s*(error|warning)\s+[•-]\s+(.+?)\s+[•-]\s+(.+?\.dart):(\d+):(\d+)\s+[•-]/gm)) {
    out.push({ file: m[3], line: +m[4], col: +m[5], severity: m[1] as 'error' | 'warning', message: m[2], source: isFlutter ? 'flutter analyze' : 'dart analyze' });
  }
  for (const m of r.out.matchAll(/^\s*(error|warning)\s+-\s+(.+?\.dart):(\d+):(\d+)\s+-\s+(.+?)\s+-\s+\w+$/gm)) {
    out.push({ file: m[2], line: +m[3], col: +m[4], severity: m[1] as 'error' | 'warning', message: m[5], source: 'dart analyze' });
  }
  return out;
}

async function godotBin(): Promise<string | null> {
  for (const c of ['godot', 'godot4']) { const w = await which(c); if (w) return w; }
  for (const p of ['/Applications/Godot.app/Contents/MacOS/Godot', '/Applications/Godot_mono.app/Contents/MacOS/Godot']) if (exists(p)) return p;
  return null;
}

async function checkGodot(root: string, files: string[]): Promise<Problem[]> {
  const bin = await godotBin();
  if (!bin || !files.length || !exists(path.join(root, 'project.godot'))) return [];
  const out: Problem[] = [];
  for (const f of files.slice(0, 10)) {
    const r = await proc(bin, ['--headless', '--path', root, '--check-only', '--script', `res://${f}`], { cwd: root, timeoutMs: 60_000 });
    for (const m of r.out.matchAll(/(?:SCRIPT ERROR|Parse Error|ERROR):\s*(.+?)\n(?:.*?\n)?\s*at:.*?res:\/\/(.+?\.gd):(\d+)/g)) {
      out.push({ file: m[2], line: +m[3], severity: 'error', message: m[1], source: 'godot' });
    }
  }
  return out;
}

function checkJson(root: string, files: string[]): Problem[] {
  const out: Problem[] = [];
  for (const f of files) {
    const src = readRel(root, f);
    if (src === null || /(^|\/)(tsconfig|jsconfig)[^/]*\.json$|\.vscode\//.test(f)) continue; // 주석 허용 JSON 제외
    try { JSON.parse(src); } catch (e: any) {
      const pos = Number(/position (\d+)/.exec(e.message)?.[1] ?? 0);
      out.push({ file: f, line: src.slice(0, pos).split('\n').length, severity: 'error', message: `JSON 오류: ${e.message}`, source: 'json' });
    }
  }
  return out;
}

function checkAssets(root: string, files: string[], all: Set<string>): Problem[] {
  const out: Problem[] = [];
  for (const f of files) {
    const src = readRel(root, f);
    if (src === null) continue;
    for (const ref of dk.assetRefs(f, src)) {
      if (!dk.assetExists(ref, all)) {
        out.push({ file: f, line: ref.line, severity: 'warning', message: `리소스 파일을 찾을 수 없음: '${ref.ref}' (경로 오타·파일 누락이면 화면에 안 보임)`, source: 'assets' });
      }
    }
  }
  return out.slice(0, 15);
}

/**
 * 검사 실행. changed 가 있으면 그 파일 위주(수정 직후 자동 검사), null 이면 프로젝트 전체(CHECK 도구).
 */
export async function runCheck(root: vscode.Uri, changed: string[] | null): Promise<CheckReport> {
  const r = root.fsPath;
  const all = await listFiles(root);
  const allSet = new Set(all);
  const targets = (changed ?? all).filter((f) => CODE_EXT.test(f) && allSet.has(f)).slice(0, changed ? 50 : 400);
  const by = (re: RegExp) => targets.filter((f) => re.test(f));
  const results = await Promise.all([
    ideDiagnostics(root, changed ? targets : null),
    checkPython(r, by(/\.py$/)),
    checkJs(r, by(/\.(m?js|cjs|html?)$/i)),
    by(/\.tsx?$/).length ? checkTs(r) : Promise.resolve([]),
    by(/\.dart$/).length ? checkDart(r, changed ? by(/\.dart$/) : null) : Promise.resolve([]),
    checkGodot(r, by(/\.gd$/)),
    Promise.resolve(checkJson(r, by(/\.json$/))),
    Promise.resolve(checkAssets(r, targets, allSet)),
  ].map((p) => p.catch(() => [] as Problem[])));
  // 같은 위치·같은 내용은 하나로 (IDE 와 CLI 가 같은 오류를 둘 다 보고하는 경우)
  const seen = new Set<string>();
  const problems = results.flat().filter((p) => {
    const key = `${p.file}:${p.line}:${p.message.slice(0, 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !changed || targets.includes(p.file) || p.source === 'tsc';
  });
  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const scope = changed ? `변경 파일 ${targets.length}개` : `프로젝트 파일 ${targets.length}개`;
  if (!targets.length) return { errors: 0, warnings: 0, problems: [], text: `[자동 검사] 검사할 코드 파일 없음` };
  if (!problems.length) return { errors: 0, warnings: 0, problems, text: `[자동 검사] ${scope} · 오류 없음 ✓` };
  const lines: string[] = [`[자동 검사] ${scope} · 오류 ${errors.length}개 · 경고 ${warnings.length}개`];
  errors.slice(0, 8).forEach((p, i) => {
    lines.push(`- ${p.file}:${p.line}${p.col ? ':' + p.col : ''} 오류 (${p.source}): ${p.message}`);
    const src = i < 4 ? readRel(r, p.file) : null;
    if (src) lines.push(dk.excerpt(src, p.line, 2).split('\n').map((l) => '    ' + l).join('\n'));
  });
  if (errors.length > 8) lines.push(`- …오류 ${errors.length - 8}개 더`);
  warnings.slice(0, 6).forEach((p) => lines.push(`- ${p.file}:${p.line} 경고 (${p.source}): ${p.message}`));
  if (warnings.length > 6) lines.push(`- …경고 ${warnings.length - 6}개 더`);
  if (errors.length) lines.push('→ 위 오류를 먼저 고치세요. 오류가 남은 채로 끝내지 마세요.');
  return { errors: errors.length, warnings: warnings.length, problems, text: lines.join('\n') };
}

// ---- PLAY ---------------------------------------------------------------------------------
export interface PlayResult { text: string; screenshot?: Buffer; errors: number }

interface Collected {
  title: string;
  started: string[];   // 실행 정보
  errors: string[];    // 오류 (스택 포함)
  failed: string[];    // 리소스 로드 실패
  console: string[];   // 콘솔/표준출력 일부
  frames?: number;     // 게임 루프 프레임 수
  screenshot?: Buffer;
  notes: string[];
}

const newCollected = (title: string): Collected => ({ title, started: [], errors: [], failed: [], console: [], notes: [] });

/** 아주 작은 WebSocket 클라이언트 (DevTools 프로토콜용, 외부 의존성 없이 Node 20 에서도 동작) */
class MiniWs {
  private buf = Buffer.alloc(0);
  onmessage: (text: string) => void = () => undefined;
  private constructor(private sock: net.Socket) {
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
  }

  static connect(url: string): Promise<MiniWs> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
      req.on('upgrade', (_res, sock, head) => { const ws = new MiniWs(sock); if (head.length) { ws.buf = head; ws.drain(); } resolve(ws); });
      req.on('error', reject);
      req.on('response', (res) => reject(new Error(`WebSocket 연결 실패 HTTP ${res.statusCode}`)));
      req.end();
    });
  }

  send(text: string) {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  private frag: Buffer[] = [];
  private drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const data = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x1 || op === 0x0) {
        this.frag.push(Buffer.from(data));
        if (fin) { const text = Buffer.concat(this.frag).toString(); this.frag = []; this.onmessage(text); }
      }
    }
  }

  close() { try { this.sock.destroy(); } catch { /* 무시 */ } }
}

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers: ((method: string, params: any) => void)[] = [];
  constructor(private ws: MiniWs) {
    ws.onmessage = (text) => {
      const msg = JSON.parse(text);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) this.handlers.forEach((h) => h(msg.method, msg.params));
    };
  }
  on(h: (method: string, params: any) => void) { this.handlers.push(h); }
  send(method: string, params: any = {}, timeoutMs = 15_000): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} 응답 없음`)); }, timeoutMs);
    });
  }
  close() { this.ws.close(); }
}

function findChrome(): string | null {
  const cands = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return cands.find(exists) ?? null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

/** 프로젝트 폴더를 정적으로 서비스 (file:// 은 모듈·fetch 가 막혀 게임이 안 돌기 쉽다) */
function staticServer(root: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      let file = path.normalize(path.join(root, urlPath));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 없음 */ }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

const KEYMAP: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 }, Space: { key: ' ', code: 'Space', keyCode: 32 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};
function keyDef(name: string) {
  if (KEYMAP[name]) return KEYMAP[name];
  if (/^[a-z0-9]$/i.test(name)) {
    const ch = name.toLowerCase();
    return { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
  }
  return null;
}

/** Chrome 헤드리스로 페이지를 열어 N초 동안 오류·콘솔·리소스 실패·프레임을 모으고 화면을 캡처한다. */
async function webCapture(url: string, seconds: number, keys: string[], c: Collected, signal: AbortSignal): Promise<void> {
  const chrome = findChrome();
  if (!chrome) { c.notes.push('Chrome/Edge 를 찾지 못해 브라우저 실행 검사를 건너뜀 (설치하면 자동 사용)'); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yang-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800',
    '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', 'about:blank']);
  let cdp: Cdp | null = null;
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let err = '';
      const t = setTimeout(() => reject(new Error('Chrome 시작 시간 초과')), 20_000);
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.on('exit', () => reject(new Error('Chrome 이 바로 종료됨: ' + err.slice(-300))));
    });
    const port = new URL(wsUrl).port;
    const list: any[] = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome 페이지를 찾지 못함');
    cdp = new Cdp(await MiniWs.connect(page.webSocketDebuggerUrl));
    const reqUrls = new Map<string, string>();
    cdp.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        const msg = (d.exception?.description ?? d.text ?? '예외').split('\n')[0];
        const frames = (d.stackTrace?.callFrames ?? []).slice(0, 5).map((f: any) => `    at ${f.functionName || '(익명)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`);
        if (!frames.length && d.url) frames.push(`    at ${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}`);
        c.errors.push(`Uncaught ${msg}\n${frames.join('\n')}`);
      } else if (method === 'Runtime.consoleAPICalled') {
        const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
        const top = p.stackTrace?.callFrames?.[0];
        const where = top ? ` (${top.url}:${top.lineNumber + 1})` : '';
        if (p.type === 'error' || p.type === 'assert') c.errors.push(`console.error: ${text}${where}`);
        else c.console.push(`[${p.type}] ${text}${p.type === 'warning' ? where : ''}`);
      } else if (method === 'Log.entryAdded') {
        const e = p.entry;
        if (e.level === 'error' && !/favicon\.ico/.test(e.url ?? '')) c.errors.push(`${e.source}: ${e.text}${e.url ? ` (${e.url}${e.lineNumber != null ? ':' + (e.lineNumber + 1) : ''})` : ''}`);
      } else if (method === 'Network.requestWillBeSent') {
        reqUrls.set(p.requestId, p.request.url);
      } else if (method === 'Network.responseReceived') {
        if (p.response.status >= 400 && !/favicon\.ico/.test(p.response.url)) c.failed.push(`${p.response.status} ${p.response.url}`);
      } else if (method === 'Network.loadingFailed') {
        const u = reqUrls.get(p.requestId) ?? '';
        if (!p.canceled && !/favicon\.ico/.test(u)) c.failed.push(`${p.errorText} ${u}`);
      }
    });
    await Promise.all(['Runtime.enable', 'Log.enable', 'Page.enable', 'Network.enable'].map((m) => cdp!.send(m)));
    // 헤드리스 탭은 '보이지 않는 페이지'로 취급돼 프레임이 줄어든다 → 포커스·보이는 상태로 흉내
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
    // 게임 루프 확인: 페이지가 requestAnimationFrame 을 몇 번 부르는지 센다
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:
      `window.__yangRaf=0;(function(){const o=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){window.__yangRaf++;return o(cb);};})();` });
    const loaded = new Promise<void>((resolve) => { cdp!.on((m) => { if (m === 'Page.loadEventFired') resolve(); }); setTimeout(resolve, 15_000); });
    await cdp.send('Page.navigate', { url });
    await loaded;
    c.started.push(`브라우저: ${path.basename(chrome)} 헤드리스 · ${url}`);

    // 입력 시나리오: 화면 가운데 클릭(시작 버튼·포커스) → 키 순서대로 (각 0.25초 누름)
    const seq = keys.length ? keys : dk.DEFAULT_KEYS;
    const total = Math.max(seconds, 2) * 1000;
    const t0 = Date.now();
    await sleep(Math.min(800, total / 4));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: 640, y: 400, button: 'left', clickCount: 1 }).catch(() => undefined);
    }
    const gap = Math.max(250, (total - (Date.now() - t0) - 1200) / Math.max(seq.length, 1));
    for (const k of seq) {
      if (signal.aborted || Date.now() - t0 > total - 1000) break;
      const d = keyDef(k);
      if (!d) continue;
      const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: d.key.length === 1 ? d.key : undefined }).catch(() => undefined);
      await sleep(250);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }).catch(() => undefined);
      await sleep(Math.max(0, gap - 250));
    }
    c.started.push(`입력: 가운데 클릭 → ${seq.join(', ')}`);
    const rest = total - (Date.now() - t0);
    if (rest > 0) await sleep(rest);
    const ev = await cdp.send('Runtime.evaluate', { expression: 'window.__yangRaf', returnByValue: true }).catch(() => null);
    c.frames = typeof ev?.result?.value === 'number' ? ev.result.value : undefined;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot?.data) c.screenshot = Buffer.from(shot.data, 'base64');
  } catch (e: any) {
    c.notes.push(`브라우저 검사 실패: ${e.message}`);
  } finally {
    cdp?.close();
    try { child.kill('SIGKILL'); } catch { /* 무시 */ }
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1500);
  }
}

/** 오래 도는 프로세스: 시작 → (ready 패턴까지 대기) → N초 → 종료. 출력은 전부 모은다. */
function longRun(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; seconds: number; readyRe?: RegExp;
  readyTimeoutMs?: number; signal: AbortSignal; onReady?: (out: string) => Promise<void>; stdinQuit?: string }): Promise<{ out: string; code: number | null; exitedEarly: boolean; ready: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, shell: opts.shell, detached: process.platform !== 'win32' });
    let out = '';
    let done = false;
    let ready = !opts.readyRe;
    let stopping = false; // 우리가 종료시켰는지 (아니면 스스로 끝남 = 크래시 또는 바로 종료)
    let timer: NodeJS.Timeout | undefined;
    const killTree = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* 이미 종료 */ }
    };
    const stop = () => {
      stopping = true;
      if (opts.stdinQuit) { try { child.stdin?.write(opts.stdinQuit); } catch { /* 무시 */ } }
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGINT'); else child.kill('SIGINT'); } catch { /* 무시 */ }
      setTimeout(killTree, 2500);
    };
    const startCountdown = () => {
      timer = setTimeout(async () => {
        if (opts.onReady) await opts.onReady(out).catch(() => undefined);
        stop();
      }, opts.seconds * 1000);
    };
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
      if (!ready && opts.readyRe!.test(out)) { ready = true; startCountdown(); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    if (ready) startCountdown();
    else timer = setTimeout(() => { out += `\n[준비 시간 초과 ${(opts.readyTimeoutMs ?? 0) / 1000}s]`; stop(); }, opts.readyTimeoutMs ?? 240_000);
    opts.signal.addEventListener('abort', () => { stopping = true; killTree(); }, { once: true });
    child.on('error', (e) => { if (!done) { done = true; resolve({ out: out + String(e), code: -1, exitedEarly: true, ready }); } });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ out, code, exitedEarly: !stopping, ready });
    });
  });
}

// pygame 게임을 창 없이 실행하면서 화면 캡처·키 입력·프레임 수를 기록하는 훅 (sitecustomize 로 자동 로드)
const PY_HOOK = `import os, sys, time
_T0 = time.time()
def _yang_hook():
    import importlib.util
    if importlib.util.find_spec("pygame") is None:
        return
    import pygame
    shot, shot_at = os.environ.get("YANG_SHOT"), float(os.environ.get("YANG_SHOT_AT", "5"))
    keys = [k for k in os.environ.get("YANG_KEYS", "").split(",") if k]
    names = {"Enter": "K_RETURN", "Space": "K_SPACE", "ArrowLeft": "K_LEFT", "ArrowRight": "K_RIGHT", "ArrowUp": "K_UP",
             "ArrowDown": "K_DOWN", "Escape": "K_ESCAPE", "Shift": "K_LSHIFT"}
    span = max(shot_at - 1.5, 1.0)
    plan = [(1.0 + i * span / max(len(keys), 1), k) for i, k in enumerate(keys)]
    st = {"frames": 0, "shot": False, "up": [], "clicked": False}
    def _code(k):
        return getattr(pygame, names.get(k, "K_" + k.lower()), None)
    def _after():
        st["frames"] += 1
        t = time.time() - _T0
        try:
            for code in st["up"]:
                pygame.event.post(pygame.event.Event(pygame.KEYUP, key=code, mod=0, unicode="", scancode=0))
            st["up"] = []
            if not st["clicked"] and t > 0.8:
                st["clicked"] = True
                s = pygame.display.get_surface()
                pos = (s.get_width() // 2, s.get_height() // 2) if s else (0, 0)
                pygame.event.post(pygame.event.Event(pygame.MOUSEBUTTONDOWN, pos=pos, button=1))
                pygame.event.post(pygame.event.Event(pygame.MOUSEBUTTONUP, pos=pos, button=1))
            while plan and plan[0][0] <= t:
                _, k = plan.pop(0)
                code = _code(k)
                if code is not None:
                    pygame.event.post(pygame.event.Event(pygame.KEYDOWN, key=code, mod=0, unicode=" " if k == "Space" else "", scancode=0))
                    st["up"].append(code)
        except Exception:
            pass
        if shot and not st["shot"] and t >= shot_at:
            s = pygame.display.get_surface()
            if s is not None:
                pygame.image.save(s, shot)
                st["shot"] = True
                print(f"[yang] t={t:.1f}s frames={st['frames']} screenshot={s.get_width()}x{s.get_height()}", flush=True)
    for name in ("flip", "update"):
        orig = getattr(pygame.display, name)
        def wrap(*a, _o=orig, **k):
            r = _o(*a, **k)
            _after()
            return r
        setattr(pygame.display, name, wrap)
    import atexit
    def _bye():
        # 오류로 일찍 끝나도 마지막 화면은 남긴다
        try:
            s = pygame.display.get_surface()
            if shot and not st["shot"] and s is not None:
                pygame.image.save(s, shot)
        except Exception:
            pass
        print(f"[yang] exit t={time.time() - _T0:.1f}s frames={st['frames']}", flush=True)
    atexit.register(_bye)
try:
    _yang_hook()
except Exception as _e:
    print("[yang] hook 실패:", _e, file=sys.stderr)
`;

async function playPython(root: string, req: dk.PlayRequest, files: string[], c: Collected, signal: AbortSignal) {
  const py = await pythonExe(root);
  if (!py) { c.notes.push('파이썬을 찾지 못했습니다'); return; }
  const entry = req.target || dk.pickPythonEntry(files, (f) => readRel(root, f));
  if (!entry) { c.notes.push('실행할 .py 파일을 찾지 못했습니다 (PLAY python main.py 처럼 지정)'); return; }
  const seconds = req.seconds || dk.DEFAULT_SECONDS.python;
  const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yang-py-'));
  const shot = path.join(hookDir, 'shot.png');
  fs.writeFileSync(path.join(hookDir, 'sitecustomize.py'), PY_HOOK);
  const env = {
    PYTHONPATH: [hookDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONUNBUFFERED: '1', PYTHONFAULTHANDLER: '1',
    SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy',          // 창·소리 없이 실행
    YANG_SHOT: shot, YANG_SHOT_AT: String(Math.max(1, seconds - 0.7)),
    YANG_KEYS: (req.keys.length ? req.keys : dk.DEFAULT_KEYS).join(','),
  };
  c.started.push(`실행: ${path.basename(py)} ${entry} (창 없이 · ${seconds}초 · 입력 ${env.YANG_KEYS})`);
  const r = await longRun(py, [entry], { cwd: root, env, seconds, signal });
  // 시간이 다 돼 우리가 멈추며 생긴 KeyboardInterrupt 트레이스백은 출력에서 뺀다
  const outText = !r.exitedEarly && /KeyboardInterrupt\s*(\n\[yang\][^\n]*)?\s*$/.test(r.out) ? r.out.slice(0, r.out.lastIndexOf('Traceback (most recent call last)')) + r.out.slice(r.out.lastIndexOf('[yang] exit')) : r.out;
  c.console.push(...outText.split('\n').filter((l) => l.trim() && !/^pygame(-ce)? \d|Hello from the pygame community/.test(l)).slice(-40));
  const tbAt = r.out.lastIndexOf('Traceback (most recent call last)');
  const tb = tbAt >= 0 ? r.out.slice(tbAt).split('\n').filter((l) => !l.startsWith('[yang]')).slice(0, 40).join('\n').trim() : '';
  // 시간이 다 돼서 우리가 멈춘 것(KeyboardInterrupt)은 오류가 아니다
  if (tb && !(/KeyboardInterrupt\s*$/.test(tb) && !r.exitedEarly)) {
    c.errors.push(tb);
  } else if (r.exitedEarly && r.code !== 0) c.errors.push(`프로세스가 ${seconds}초 전에 종료됨 (exit ${r.code})`);
  else if (r.exitedEarly) c.notes.push(`프로그램이 ${seconds}초 전에 스스로 끝났습니다 (게임 루프가 바로 종료됐을 수 있음)`);
  const fm = [...r.out.matchAll(/\[yang\] .*?frames=(\d+)/g)].pop();
  if (fm) c.frames = Number(fm[1]);
  if (exists(shot)) c.screenshot = fs.readFileSync(shot);
  else if (!c.errors.length && /import pygame|from pygame/.test(readRel(root, entry) ?? '')) c.notes.push('pygame 화면을 캡처하지 못했습니다 (pygame.display.flip/update 가 한 번도 호출되지 않았을 수 있음)');
  fs.rmSync(hookDir, { recursive: true, force: true });
}

async function playWeb(root: string, req: dk.PlayRequest, files: string[], c: Collected, signal: AbortSignal) {
  const seconds = req.seconds || dk.DEFAULT_SECONDS.web;
  if (/^https?:\/\//.test(req.target)) { await webCapture(req.target, seconds, req.keys, c, signal); return; }
  const pkg = readRel(root, 'package.json');
  const html = req.target || ['index.html', 'public/index.html', 'src/index.html', 'web/index.html', 'www/index.html'].find((f) => files.includes(f))
    || files.find((f) => /(^|\/)index\.html$/.test(f));
  // 번들러(vite 등) 프로젝트는 dev 서버로 띄워야 TS·import 가 동작한다
  const devScript = pkg && /"dev"\s*:/.test(pkg) ? 'dev' : pkg && /"start"\s*:/.test(pkg) && /(vite|webpack|parcel|react-scripts|next)/.test(pkg) ? 'start' : '';
  if (devScript && (!req.target || req.target === 'index.html') && /(vite|webpack|parcel|react-scripts|next|phaser)/.test(pkg!)) {
    c.started.push(`dev 서버: npm run ${devScript}`);
    let pageUrl = '';
    const r = await longRun(process.platform === 'win32' ? 'npm.cmd' : '/bin/zsh', process.platform === 'win32' ? ['run', devScript] : ['-lc', `npm run ${devScript}`], {
      cwd: root, env: { BROWSER: 'none', CI: '1' }, seconds: 0.1, signal, readyTimeoutMs: 60_000,
      readyRe: /https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\/?/,
      onReady: async (out) => {
        pageUrl = (/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?\S*/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''))?.[0] ?? '').replace('[::1]', '127.0.0.1');
        if (pageUrl) await webCapture(pageUrl, seconds, req.keys, c, signal);
      },
    });
    const devErrors = dk.errorLines(r.out.replace(/\x1b\[[0-9;]*m/g, ''), 10);
    if (!pageUrl) c.errors.push(`dev 서버가 주소를 출력하지 않았습니다:\n${r.out.slice(-1500)}`);
    else if (devErrors.length) c.errors.push(`dev 서버 오류:\n${devErrors.join('\n')}`);
    return;
  }
  if (!html) { c.notes.push('index.html 을 찾지 못했습니다 (PLAY web 경로.html 또는 URL 로 지정)'); return; }
  const srv = await staticServer(root);
  try {
    await webCapture(`http://127.0.0.1:${srv.port}/${html.split('/').map(encodeURIComponent).join('/')}`, seconds, req.keys, c, signal);
  } finally { srv.close(); }
}

async function playFlutter(root: string, req: dk.PlayRequest, c: Collected, signal: AbortSignal) {
  const flutter = await which('flutter');
  if (!flutter) { c.notes.push('flutter 명령을 찾지 못했습니다'); return; }
  const env = await loginPathEnv();
  let device = req.target;
  if (!device) {
    const d = await proc(flutter, ['devices', '--machine'], { cwd: root, timeoutMs: 60_000, env });
    try {
      const list: any[] = JSON.parse(d.out.slice(d.out.indexOf('[')));
      const ok = list.filter((x) => x.isSupported !== false);
      device = (ok.find((x) => String(x.targetPlatform).startsWith('android')) ?? ok.find((x) => x.id === 'macos') ?? ok.find((x) => x.id === 'chrome') ?? ok[0])?.id ?? '';
    } catch { /* 기기 목록 해석 실패 */ }
  }
  if (!device) { c.notes.push('실행할 기기가 없습니다 (안드로이드 에뮬레이터를 켜거나 PLAY flutter <기기ID>)'); return; }
  const seconds = req.seconds || dk.DEFAULT_SECONDS.flutter;
  c.started.push(`flutter run -d ${device} (빌드 후 ${seconds}초 관찰)`);
  const adb = String(device).startsWith('emulator') || /^[\w-]{6,}$/.test(device) ? await which('adb') : null;
  const r = await longRun(flutter, ['run', '-d', device], {
    cwd: root, env, seconds, signal, readyTimeoutMs: 420_000, stdinQuit: 'q',
    readyRe: /(Flutter run key commands|To hot reload|A Dart VM Service|Dart DevTools debugger)/,
    onReady: async () => {
      if (adb) {
        await proc(adb, ['-s', device, 'shell', 'input', 'tap', '540', '1200'], { timeoutMs: 5000 });
        await sleep(1500);
        const s = await new Promise<Buffer | null>((resolve) => {
          const ch = spawn(adb, ['-s', device, 'exec-out', 'screencap', '-p']);
          const parts: Buffer[] = [];
          ch.stdout.on('data', (d) => parts.push(d));
          ch.on('close', (code) => resolve(code === 0 ? Buffer.concat(parts) : null));
          ch.on('error', () => resolve(null));
        });
        if (s && s.length > 1000) c.screenshot = s;
      }
    },
  });
  if (!r.ready) c.errors.push(`앱이 시작되지 않았습니다 (빌드 실패 가능):\n${dk.errorLines(r.out, 25).join('\n') || r.out.slice(-2500)}`);
  // 런타임 예외 블록(══╡ EXCEPTION CAUGHT … ════)과 E/flutter 줄
  for (const m of r.out.matchAll(/══╡ EXCEPTION CAUGHT[\s\S]*?(?=\n═{20,}|$)/g)) {
    // 프레임워크 내부 스택(package:flutter/, dart:)은 빼고 내 코드 줄만 남긴다
    const lines = m[0].split('\n').filter((l) => !/^#\d+\s+.*\((package:flutter\/|dart:)|^\.\.\.\s+Normal element|^\.\.\.\s+\w+ element/.test(l.trim()));
    c.errors.push(lines.slice(0, 30).join('\n'));
  }
  const ef = r.out.split('\n').filter((l) => /E\/flutter|Unhandled Exception|Another exception was thrown/.test(l));
  if (ef.length) c.errors.push(ef.slice(0, 15).join('\n'));
  c.console.push(...r.out.split('\n').filter((l) => /^(I\/flutter|flutter:)/.test(l.trim())).slice(-25));
  if (!c.screenshot && r.ready) c.notes.push(adb ? '화면 캡처 실패' : `이 기기(${device})는 화면 캡처를 지원하지 않아 화면 분석을 건너뜀 (안드로이드 에뮬레이터에서 가능)`);
}

async function playGodot(root: string, req: dk.PlayRequest, c: Collected, signal: AbortSignal) {
  const bin = await godotBin();
  if (!bin) { c.notes.push('Godot 실행 파일을 찾지 못했습니다 (PATH 의 godot 또는 /Applications/Godot.app)'); return; }
  const seconds = req.seconds || dk.DEFAULT_SECONDS.godot;
  const args = ['--headless', '--path', root, '--quit-after', String(Math.round(seconds * 60))];
  if (req.target) args.push(req.target.startsWith('res://') ? req.target : `res://${req.target}`);
  c.started.push(`godot ${args.join(' ')} (화면 없이)`);
  const r = await longRun(bin, args, { cwd: root, seconds: seconds + 20, signal });
  const blocks = [...r.out.matchAll(/(SCRIPT ERROR|Parse Error|ERROR|USER ERROR):[^\n]*(\n\s+at:[^\n]*)*/g)].map((m) => m[0]);
  c.errors.push(...[...new Set(blocks)].slice(0, 12));
  c.console.push(...r.out.split('\n').filter((l) => l.trim() && !/^Godot Engine v/.test(l)).slice(-30));
  c.notes.push('Godot 헤드리스 실행은 화면을 캡처하지 않습니다');
}

async function playUnity(root: string, c: Collected, signal: AbortSignal) {
  const ver = /m_EditorVersion:\s*(\S+)/.exec(readRel(root, 'ProjectSettings/ProjectVersion.txt') ?? '')?.[1];
  const editorLog = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Logs/Unity/Editor.log')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Unity/Editor/Editor.log') : path.join(os.homedir(), '.config/unity3d/Editor.log');
  if (exists(path.join(root, 'Temp/UnityLockfile')) && exists(editorLog)) {
    // 에디터가 열려 있으면 batchmode 를 쓸 수 없다 → 에디터 로그(Play 버튼으로 실행한 결과)에서 오류를 읽는다
    const log = fs.readFileSync(editorLog, 'utf8').split('\n').slice(-1500).join('\n');
    c.started.push(`Unity 에디터 실행 중 → Editor.log 최근 내용 분석 (${editorLog})`);
    const errs = [...log.matchAll(/^.*(error CS\d+|Exception|Error)[^\n]*(\n(?:UnityEngine\.|.*\(at Assets\/)[^\n]*)*/gm)].map((m) => m[0]);
    c.errors.push(...[...new Set(errs)].slice(-12));
    c.notes.push('Unity 에서 Play 를 눌러 재현한 뒤 다시 PLAY unity 를 실행하면 그 실행의 오류를 읽습니다');
    return;
  }
  const bin = process.platform === 'darwin' ? `/Applications/Unity/Hub/Editor/${ver}/Unity.app/Contents/MacOS/Unity`
    : process.platform === 'win32' ? `C:\\Program Files\\Unity\\Hub\\Editor\\${ver}\\Editor\\Unity.exe` : `${os.homedir()}/Unity/Hub/Editor/${ver}/Editor/Unity`;
  if (!ver || !exists(bin)) { c.notes.push(`Unity 에디터(${ver ?? '버전 모름'})를 찾지 못했습니다`); return; }
  c.started.push(`Unity ${ver} batchmode 로 스크립트 컴파일 검사 (수 분 걸릴 수 있음)`);
  const r = await proc(bin, ['-batchmode', '-nographics', '-quit', '-projectPath', root, '-logFile', '-'], { cwd: root, timeoutMs: 900_000, signal });
  const errs = [...new Set(r.out.split('\n').filter((l) => /error CS\d+|Scripts have compiler errors|Compilation failed/.test(l)))];
  c.errors.push(...errs.slice(0, 20));
  c.notes.push('Unity 는 batchmode 에서 게임을 실행하지 않습니다 (컴파일 오류만 검사). 런타임 오류는 에디터에서 Play 후 PLAY unity');
}

async function playCmd(root: string, req: dk.PlayRequest, c: Collected, signal: AbortSignal) {
  if (!req.target) { c.notes.push('실행할 명령이 없습니다 (PLAY cmd npm start 15)'); return; }
  const seconds = req.seconds || dk.DEFAULT_SECONDS.cmd;
  c.started.push(`명령: ${req.target} (${seconds}초)`);
  let pageUrl = '';
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh';
  const r = await longRun(shell, process.platform === 'win32' ? ['/c', req.target] : ['-lc', req.target], {
    cwd: root, env: { BROWSER: 'none', CI: '1' }, seconds, signal,
    onReady: async (out) => {
      // 출력에 로컬 주소가 나왔으면 그 페이지도 브라우저로 검사
      pageUrl = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?\S*/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''))?.[0] ?? '';
      if (pageUrl) await webCapture(pageUrl, Math.min(seconds, 10), req.keys, c, signal);
    },
  });
  const clean = r.out.replace(/\x1b\[[0-9;]*m/g, '');
  c.console.push(...clean.split('\n').filter((l) => l.trim()).slice(-30));
  const errs = dk.errorLines(clean, 15);
  if (errs.length) c.errors.push(errs.join('\n'));
  if (r.exitedEarly && r.code) c.errors.push(`명령이 ${seconds}초 전에 실패로 종료됨 (exit ${r.code})`);
}

/** 서버 비전 모델로 실행 화면 확인 (빈 화면·안 보이는 오브젝트·잘림·오류 표시 등) */
async function inspectScreen(png: Buffer, expect: string, kind: string): Promise<string> {
  try {
    const r: any = await backend.post('/api/vision/inspect', { image: png.toString('base64'), expect, context: kind }, 180_000);
    return r.text ?? '';
  } catch (e: any) {
    return `(화면 분석 실패: ${e.message})`;
  }
}

export async function runPlay(root: vscode.Uri, req: dk.PlayRequest, signal: AbortSignal, progress: (s: string) => void): Promise<PlayResult> {
  const r = root.fsPath;
  const files = await listFiles(root);
  const kind = req.kind === 'auto' ? (dk.detectPlayKind(files, (f) => readRel(r, f)) ?? 'cmd') : req.kind;
  const c = newCollected(kind);
  progress(`${kind} 실행 중…`);
  if (kind === 'web') await playWeb(r, req, files, c, signal);
  else if (kind === 'python') await playPython(r, req, files, c, signal);
  else if (kind === 'flutter') await playFlutter(r, req, c, signal);
  else if (kind === 'godot') await playGodot(r, req, c, signal);
  else if (kind === 'unity') await playUnity(r, c, signal);
  else await playCmd(r, req, c, signal);

  // 결과 정리: 오류 → 코드 위치 발췌 → 리소스 실패 → 프레임 → 콘솔 → 화면 분석
  const resolve = dk.makeResolver(r, files);
  const lines: string[] = [`[PLAY ${kind}${req.target ? ' ' + req.target : ''}]`, ...c.started.map((s) => `- ${s}`)];
  if (c.errors.length) {
    lines.push(`\n오류 ${c.errors.length}개:`);
    c.errors.slice(0, 10).forEach((e) => lines.push(dk.clip(e, 1500)));
  } else lines.push('\n오류: 없음');
  const locs = dk.traceLocations(c.errors.join('\n'), resolve, 4);
  if (locs.length) {
    lines.push('\n오류 위치 코드:');
    for (const l of locs) {
      const src = readRel(r, l.file);
      if (src) lines.push(`--- ${l.file}:${l.line} ---\n${dk.excerpt(src, l.line, 4)}`);
    }
  }
  if (c.failed.length) lines.push(`\n리소스 로드 실패 ${c.failed.length}개 (경로·파일명 확인):\n${[...new Set(c.failed)].slice(0, 10).map((f) => '- ' + f).join('\n')}`);
  if (c.frames !== undefined) {
    const secs = req.seconds || dk.DEFAULT_SECONDS[kind as dk.PlayKind] || 8;
    const note = c.frames === 0 ? ' ⚠ 게임 루프가 돌지 않음 (requestAnimationFrame/flip 호출 없음)'
      : c.errors.length ? ' — 오류가 난 시점에 루프가 멈췄을 수 있음 (위 오류부터 확인)'
      : c.frames / secs < 20 ? ` (약 ${Math.round(c.frames / secs)}fps ⚠ 느리거나 중간에 멈춤)` : ` (약 ${Math.round(c.frames / secs)}fps)`;
    lines.push(`\n프레임: ${c.frames}회${note}`);
  }
  if (c.console.length) lines.push(`\n콘솔·출력 (마지막 ${Math.min(c.console.length, 20)}줄):\n${c.console.slice(-20).map((l) => dk.clip(l, 300)).join('\n')}`);
  if (c.screenshot) {
    progress('실행 화면 분석 중 (비전 모델)…');
    lines.push(`\n화면 분석 (${req.expect ? '기대: ' + req.expect : '실행 마지막 화면'}):\n${await inspectScreen(c.screenshot, req.expect, kind)}`);
  }
  if (c.notes.length) lines.push(`\n참고:\n${c.notes.map((n) => '- ' + n).join('\n')}`);
  return { text: lines.join('\n'), screenshot: c.screenshot, errors: c.errors.length + c.failed.length };
}
