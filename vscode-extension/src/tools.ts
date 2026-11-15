/** 도구 실행기: 모델이 요청한 도구를 VS Code 안에서 실행하고, 결과 텍스트를 모델에게 돌려준다. */
import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { backend, isRemote } from './clients';
import { applySearchReplace, lineDiffStats, ToolCall } from './protocol';
import { runCheck, runPlay } from './debugRunner';
import * as art from './art';

const EXCLUDE = '**/{node_modules,.git,dist,build,target,.venv,venv,__pycache__,.next,Pods,.dart_tool,.gradle,models}/**';
const MAX_READ = 24_000; // 큰 파일 하나가 대화 예산을 다 쓰지 않게 (나머지는 줄 범위로)
const MAX_OUT = 8_000;

export type UiEvent =
  | { type: 'tool'; id: string; title: string; status: 'running' | 'done' | 'error' | 'denied'; detail?: string; diff?: { path: string; added: number; removed: number }; images?: string[] }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export interface ToolHost {
  root: vscode.Uri;
  repoName: string;
  signal: AbortSignal;
  approve(kind: 'edit' | 'run', title: string, detail: string): Promise<boolean>;
  emit(ev: UiEvent): void;
  checkpoint: Checkpoint;
}

/** 대화 턴 단위 변경 기록: 원본 스냅샷으로 diff 표시·되돌리기. */
export class Checkpoint {
  readonly originals = new Map<string, string | null>(); // fsPath → 원본(null = 새 파일)
  readonly binaries = new Map<string, Uint8Array>();     // 이미지 등 바이너리 원본
  readonly moves: [string, string][] = [];               // 이동 기록 [원래, 새] (되돌릴 때 역순으로)

  record(uri: vscode.Uri, before: string | null) {
    if (!this.originals.has(uri.fsPath)) this.originals.set(uri.fsPath, before);
  }

  /** 바이너리 파일(이미지) 원본 기록: null = 새 파일 */
  recordBinary(uri: vscode.Uri, before: Uint8Array | null) {
    if (this.originals.has(uri.fsPath)) return;
    this.originals.set(uri.fsPath, before === null ? null : '');
    if (before) this.binaries.set(uri.fsPath, before);
  }

  async revert(): Promise<string[]> {
    const reverted: string[] = [];
    for (const [from, to] of [...this.moves].reverse()) {
      await vscode.workspace.fs.rename(vscode.Uri.file(to), vscode.Uri.file(from), { overwrite: false }).then(undefined, () => undefined);
      reverted.push(from);
    }
    this.moves.length = 0;
    for (const [fsPath, before] of this.originals) {
      const uri = vscode.Uri.file(fsPath);
      if (before === null) {
        await vscode.workspace.fs.delete(uri, { useTrash: true }).then(undefined, () => undefined);
      } else if (this.binaries.has(fsPath)) {
        await vscode.workspace.fs.writeFile(uri, this.binaries.get(fsPath)!);
      } else {
        await writeDocument(uri, before);
      }
      reverted.push(fsPath);
    }
    this.originals.clear();
    this.binaries.clear();
    return reverted;
  }
}

/** 원본 내용 제공자 (diff 왼쪽): localagent-orig:/<fsPath>?<checkpointId> */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  static scheme = 'localagent-orig';
  private store = new Map<string, string>();

  put(key: string, content: string) {
    this.store.set(key, content);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.query) ?? '';
  }
}

export function resolveInRoot(root: vscode.Uri, rel: string): vscode.Uri {
  const abs = path.resolve(root.fsPath, rel);
  const relToRoot = path.relative(root.fsPath, abs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`워크스페이스 밖 경로는 사용할 수 없습니다: ${rel}`);
  }
  if (relToRoot.split(path.sep).includes('.git')) throw new Error('.git 내부는 수정할 수 없습니다');
  return vscode.Uri.file(abs);
}

export async function readText(uri: vscode.Uri): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText(); // 저장 안 된 편집 내용까지 포함
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}

async function writeDocument(uri: vscode.Uri, content: string): Promise<void> {
  const exists = (await readText(uri)) !== null;
  const edit = new vscode.WorkspaceEdit();
  if (!exists) {
    edit.createFile(uri, { overwrite: true, contents: new TextEncoder().encode(content) });
    await vscode.workspace.applyEdit(edit);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

function truncate(s: string, max = MAX_OUT): string {
  return s.length <= max ? s : `${s.slice(0, max / 2)}\n…(${s.length - max}자 생략)…\n${s.slice(-max / 2)}`;
}

/** 운영체제에 맞는 셸: Windows → PowerShell(UTF-8 출력), macOS/Linux → 로그인 셸 (PATH 를 제대로 잡기 위해) */
export function shellCommand(command: string): [string, string[]] {
  if (process.platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`]];
  }
  const sh = require('fs').existsSync('/bin/zsh') ? '/bin/zsh' : process.env.SHELL || '/bin/bash';
  return [sh, ['-lc', command]];
}

function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs = 300_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const [sh, args] = shellCommand(command);
    const child = spawn(sh, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, windowsHide: true });
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = () => child.kill('SIGTERM');
    const timer = setTimeout(() => {
      output += `\n[시간 초과 ${timeoutMs / 1000}s — 종료됨]`;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolve({ code, output });
    });
    child.on('error', (err) => resolve({ code: -1, output: String(err) }));
  });
}

let seq = 0;

export async function executeTool(call: ToolCall, host: ToolHost, diffProvider: OriginalContentProvider): Promise<string> {
  const id = `t${Date.now()}-${seq++}`;
  const emit = (title: string, status: 'running' | 'done' | 'error' | 'denied', extra: Partial<Extract<UiEvent, { type: 'tool' }>> = {}) =>
    host.emit({ type: 'tool', id, title, status, ...extra });

  // 원격 모드: 서버(맥)에서 코드를 실행하거나 서버 설정을 바꾸는 기능은 쓸 수 없다
  const serverSide = call.kind === 'harness' || call.kind === 'connect' ||
    (call.kind === 'model' && ['download', 'start', 'stop'].includes(call.action));
  if (isRemote() && serverSide) {
    emit(`${call.kind}`, 'denied', { detail: '원격 모드에서는 사용할 수 없음' });
    return `[${call.kind.toUpperCase()}] 원격 모드에서는 사용할 수 없습니다 (서버에서 코드를 실행/설정하는 기능은 보안상 차단). ` +
      '대신 이 PC 에서 READ/EDIT/RUN 으로 직접 구현·테스트하세요.';
  }
  try {
    switch (call.kind) {
      case 'read': {
        const uri = resolveInRoot(host.root, call.path);
        const text = await readText(uri);
        if (text === null) {
          emit(`Read ${call.path}`, 'error', { detail: '파일 없음' });
          return `[READ ${call.path}] 파일이 없습니다.`;
        }
        let body = text;
        if (call.start) {
          const lines = text.split('\n');
          body = lines.slice(call.start - 1, call.end).join('\n');
        }
        emit(`Read ${call.path}${call.start ? `:${call.start}-${call.end}` : ''}`, 'done', { detail: `${body.split('\n').length}줄` });
        return `[READ ${call.path}${call.start ? ` lines ${call.start}-${call.end}` : ''}]\n${body.length > MAX_READ ? body.slice(0, MAX_READ) + '\n…(잘림: 범위를 지정해 다시 READ 하세요)' : body}`;
      }

      case 'list': {
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(host.root, call.pattern), EXCLUDE, 400);
        const files = uris.map((u) => path.relative(host.root.fsPath, u.fsPath).replace(/\\/g, '/')).sort();
        emit(`List ${call.pattern}`, 'done', { detail: `${files.length}개` });
        return `[LIST ${call.pattern}] ${files.length}개\n${files.join('\n')}`;
      }

      case 'grep': {
        emit(`Grep ${call.pattern}`, 'running');
        const lines = await grepFiles(host.root, call.pattern, host.signal);
        emit(`Grep ${call.pattern}`, 'done', { detail: `${lines.length}건` });
        return `[GREP ${call.pattern}] ${lines.length}건${lines.length >= 200 ? ' (200건까지만)' : ''}\n${truncate(lines.join('\n'))}`;
      }

      case 'delete': case 'move': case 'mkdir':
        return await fileOp(call, host, emit);

      case 'search': {
        const res = await backend.post('/api/style/search', { query: call.query, top_k: 6, project: host.repoName || null });
        const hits = (res.hits ?? []) as any[];
        emit(`Search "${call.query}"`, 'done', { detail: hits.map((h) => h.source).join(', ') });
        return `[SEARCH ${call.query}]\n` + hits.map((h) => `--- ${h.source} (${h.kind}, ${h.score.toFixed(2)}) ---\n${h.content}`).join('\n');
      }

      case 'write':
      case 'edit': {
        const uri = resolveInRoot(host.root, call.path);
        const before = await readText(uri);
        let after: string;
        let warn = '';
        if (call.kind === 'write') {
          after = call.content.endsWith('\n') ? call.content : call.content + '\n';
        } else {
          if (before === null) {
            emit(`Edit ${call.path}`, 'error', { detail: '파일 없음' });
            return `[EDIT ${call.path}] 파일이 없습니다. 새 파일은 FILE 블록으로 만드세요.`;
          }
          if (call.blocks.length === 0) return `[EDIT ${call.path}] SEARCH/REPLACE 블록을 찾지 못했습니다. 형식을 확인하세요.`;
          const r = applySearchReplace(before, call.blocks);
          if (r.applied === 0) {
            emit(`Edit ${call.path}`, 'error', { detail: r.failed.join('\n') });
            return `[EDIT ${call.path}] 실패:\n${r.failed.join('\n')}\n파일을 다시 READ 한 뒤 정확한 원문으로 SEARCH 하세요.`;
          }
          after = r.content;
          if (r.failed.length) warn = `\n일부 블록 실패:\n${r.failed.join('\n')}`;
        }
        if (before === after) return `[${call.kind.toUpperCase()} ${call.path}] 변경 사항 없음`;

        const stats = lineDiffStats(before ?? '', after);
        const title = `${before === null ? 'Create' : 'Edit'} ${call.path}`;
        if (!(await host.approve('edit', title, `+${stats.added} −${stats.removed}`))) {
          emit(title, 'denied');
          return `[${title}] 사용자가 거부했습니다.`;
        }
        host.checkpoint.record(uri, before);
        diffProvider.put(id, before ?? '');
        await writeDocument(uri, after);
        emit(title, 'done', { diff: { path: call.path, ...stats }, detail: id });
        return `[${title}] 완료 (+${stats.added} −${stats.removed})${warn}`;
      }

      case 'run': {
        const title = `Run: ${call.command}`;
        if (!(await host.approve('run', title, call.command))) {
          emit(title, 'denied');
          return `[RUN ${call.command}] 사용자가 실행을 거부했습니다. 다른 방법을 제안하거나 이유를 물어보세요.`;
        }
        emit(title, 'running');
        const res = await runShell(call.command, host.root.fsPath, host.signal);
        const out = truncate(res.output.trim());
        emit(title, res.code === 0 ? 'done' : 'error', { detail: `exit ${res.code}\n${out.slice(-3000)}` });
        return `[RUN ${call.command}] exit code ${res.code}\n${out}`;
      }

      case 'image': return await runImage(call, host, emit);

      case 'check': {
        emit('Check (정적 검사)', 'running');
        const rep = await runCheck(host.root, null);
        emit('Check (정적 검사)', rep.errors ? 'error' : 'done', { detail: rep.text.slice(0, 3000) });
        return rep.text.replace('[자동 검사]', '[CHECK]');
      }

      case 'play': {
        const r = call.req;
        const title = `Play: ${r.kind}${r.target ? ' ' + r.target : ''}${r.seconds ? ` (${r.seconds}초)` : ''}`;
        if (!(await host.approve('run', title, `게임·앱을 실행해 오류와 화면을 확인합니다.\n${title}`))) {
          emit(title, 'denied');
          return `[PLAY] 사용자가 실행을 거부했습니다. CHECK 나 코드 확인으로 대신 진행하세요.`;
        }
        emit(title, 'running');
        const res = await runPlay(host.root, r, host.signal, (s) => emit(title, 'running', { detail: s }));
        emit(title, res.errors ? 'error' : 'done', { detail: res.text.slice(0, 4000) });
        return res.text;
      }

      case 'remember': {
        const scopeValue = call.scope === 'project' ? call.scopeValue || host.repoName : call.scopeValue;
        await backend.post('/api/preferences', { text: call.text, kind: call.memKind, scope: call.scope, scope_value: scopeValue });
        emit(`Remember (${call.memKind}/${call.scope}${scopeValue ? ':' + scopeValue : ''})`, 'done', { detail: call.text });
        return `[REMEMBER] 저장됨: ${call.text}`;
      }

      case 'harness': {
        if (!host.repoName) return '[HARNESS] 연결된 레포가 없습니다. 먼저 CONNECT 하세요.';
        const title = `Harness: ${call.task.split('\n')[0].slice(0, 60)}`;
        emit(title, 'running', { detail: '요구사항 → 테스트 → 구현 반복 시작' });
        const { job } = await backend.post('/api/agent/run', { repo: host.repoName, task: call.task });
        let current = job;
        while (['queued', 'running'].includes(current.status)) {
          if (host.signal.aborted) return '[HARNESS] 사용자가 중단했습니다 (백엔드 작업은 계속 진행될 수 있음).';
          await new Promise((r) => setTimeout(r, 2000));
          current = (await backend.get(`/api/agent/jobs/${job.id}`)).job;
          const last = current.logs[current.logs.length - 1];
          if (last) emit(title, 'running', { detail: `${last.step}: ${last.message}` });
        }
        const summary = current.logs.map((l: any) => `${l.step}: ${l.message}`).join('\n');
        emit(title, current.status === 'passed' ? 'done' : 'error', { detail: `${current.status} · ${current.branch} ${current.commit}\n${summary}` });
        return `[HARNESS] ${current.status} (브랜치 ${current.branch}, 커밋 ${current.commit || '없음'})\n` +
          `요구사항: ${JSON.stringify(current.harness?.requirements ?? []).slice(0, 2000)}\n` +
          `로그:\n${summary}\n마지막 테스트 출력:\n${truncate(current.last_test?.output ?? '', 3000)}`;
      }

      case 'model': {
        const a = call.action;
        if (a === 'list' || a === 'status') {
          const [models, eng] = await Promise.all([backend.get('/api/models'), backend.get('/api/engine/status')]);
          const lines = models.catalog.map((m: any) =>
            `- ${m.key}: ${m.label} ${m.size_gb}GB · ${m.downloaded ? '다운로드됨' : m.downloading ? `다운로드 중 ${(m.progress * 100).toFixed(0)}%` : '미설치'} · ${m.note}`);
          const engLine = eng.online ? `엔진 실행 중: ${eng.model?.model_name} (ctx ${eng.model?.n_ctx})` : '엔진 꺼짐';
          emit('Model status', 'done', { detail: `${engLine}\n${lines.join('\n')}` });
          return `[MODEL ${a}]\n${engLine}\n${lines.join('\n')}`;
        }
        if (a === 'download') {
          const res = await backend.post('/api/models/download', { model: call.arg || 'qwen3-coder-30b' });
          emit(`Model download ${res.model}`, 'done', { detail: res.status });
          host.emit({ type: 'notice', level: 'info', text: `모델 다운로드: ${res.model} (${res.status})` });
          return `[MODEL download] ${res.model}: ${res.status}`;
        }
        if (a === 'start') {
          emit('Engine start', 'running', { detail: '모델 로딩 중 (최대 3분)' });
          const res = await backend.post('/api/engine/start', { model: call.arg }, 240_000);
          emit('Engine start', 'done', { detail: `${res.status} ${res.model?.model_name ?? ''}` });
          return `[MODEL start] ${res.status} ${res.model?.model_name ?? res.message ?? ''}`;
        }
        if (a === 'stop') {
          const res = await backend.post('/api/engine/stop', {});
          emit('Engine stop', 'done', { detail: res.status });
          return `[MODEL stop] ${res.status}`;
        }
        return `[MODEL] 알 수 없는 동작: ${a}`;
      }

      case 'connect': {
        emit(`Connect ${call.location}`, 'running', { detail: '연결 + 벡터화 중' });
        const { repo } = await backend.post('/api/repos/connect', { location: call.location, init_if_missing: false }, 600_000);
        emit(`Connect ${repo.name}`, 'done', { detail: `${repo.profile} · ${repo.index_stats?.chunks} chunks` });
        return `[CONNECT] ${repo.name} (${repo.profile}) 연결됨, ${repo.index_stats?.chunks} 청크 벡터화`;
      }
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    emit(`${call.kind}`, 'error', { detail: msg });
    return `[${call.kind.toUpperCase()} 오류] ${msg}`;
  }
}


// ---- IMAGE: 맥의 이미지 모델로 생성·가공해 프로젝트에 저장 -----------------------------------------
async function readB64(host: ToolHost, rel: string): Promise<string> {
  const uri = resolveIn(host.root, rel);
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64');
}

function resolveIn(root: vscode.Uri, rel: string): vscode.Uri {
  const abs = path.resolve(root.fsPath, rel);
  if (!abs.startsWith(root.fsPath)) throw new Error(`워크스페이스 밖 경로: ${rel}`);
  return vscode.Uri.file(abs);
}

async function runImage(call: Extract<ToolCall, { kind: 'image' }>, host: ToolHost,
  emit: (title: string, status: 'running' | 'done' | 'error' | 'denied', extra?: Partial<Extract<UiEvent, { type: 'tool' }>>) => void): Promise<string> {
  const f = call.fields;
  const title = `Image: ${call.path}${f.size ? ` (${f.size})` : ''}`;
  if (!/\.(png|webp)$/i.test(call.path)) return `[IMAGE ${call.path}] 오류: 저장 경로는 .png (또는 .webp) 여야 합니다`;
  // 이미 있는 그림은 다시 만들지 않는다 (에이전트가 요청마다 같은 그림 세트를 또 만드는 것 방지)
  const yesOverwrite = /^(yes|true|y|1|예|네)$/i.test((f.overwrite ?? '').trim());
  if (f.prompt && !f.from && !yesOverwrite) {
    const exists = await vscode.workspace.fs.stat(resolveIn(host.root, call.path)).then(() => true, () => false);
    if (exists) {
      emit(title, 'done', { detail: '이미 있음 → 다시 만들지 않음' });
      return `[IMAGE ${call.path}] 이미 있어서 다시 만들지 않았습니다. 그대로 쓰세요 (꼭 새로 그려야 하면 overwrite: yes).`;
    }
  }
  if (!(await host.approve('edit', title, `${f.prompt ? '생성: ' + f.prompt : '가공: ' + (f.ops ?? '')}`))) {
    emit(title, 'denied');
    return `[IMAGE ${call.path}] 사용자가 거부했습니다`;
  }
  emit(title, 'running', { detail: f.prompt ? '이미지 생성 중 (15~40초)…' : '이미지 가공 중…' });
  const size = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(f.size ?? '');
  const yes = (v?: string) => /^(yes|true|y|1|예|네)$/i.test((v ?? '').trim());
  if (f.prompt) await art.ensure(host.root, (m) => emit(title, 'running', { detail: m })); // 프로젝트 아트 컨셉이 없으면 먼저 분석
  const no = (v?: string) => /^(no|false|n|0|아니오|아니)$/i.test((v ?? '').trim());
  const body: any = {
    prompt: f.prompt ?? '', width: size ? +size[1] : 0, height: size ? +size[2] : 0,
    project: art.projectName(host.root), kind: (f.kind ?? '').trim().toLowerCase(), verify: !no(f.verify),
    transparent: f.transparent === undefined ? undefined : yes(f.transparent), pixel: Number(f.pixel ?? 0) || 0, colors: Number(f.colors ?? 24) || 24,
    strength: Number(f.strength ?? 0) || 0, ops: f.ops ?? '', cols: Number(f.cols ?? 0) || 0, seed: f.seed ? Number(f.seed) : undefined,
  };
  try {
    const ref = (f.ref ?? '').trim();
    if (ref.startsWith('search:')) body.ref_search = ref.slice(7).trim();
    else if (ref.startsWith('attachment:')) body.ref_attachment = ref.slice(11).trim();
    else if (ref) body.refs = [await readB64(host, ref)];
    if (f.from) body.source = await readB64(host, f.from.trim());
    if (f.join) body.join = await Promise.all(f.join.split(',').map((x) => x.trim()).filter(Boolean).map((x) => readB64(host, x)));
  } catch (e: any) {
    emit(title, 'error', { detail: e.message });
    return `[IMAGE ${call.path}] 오류: 참고/원본 이미지를 읽을 수 없습니다 — ${e.message}`;
  }
  let res: any;
  try {
    res = await backend.post('/api/images/generate', body, 900_000);
  } catch (e: any) {
    emit(title, 'error', { detail: e.message });
    return `[IMAGE ${call.path}] 오류: ${e.message}`;
  }
  const images: string[] = res.images ?? [];
  const ext = path.extname(call.path);
  const targets = images.length === 1 ? [call.path] : images.map((_, i) => call.path.slice(0, -ext.length) + `_${i}` + ext);
  for (let i = 0; i < images.length; i++) {
    const uri = resolveIn(host.root, targets[i]);
    const before = await vscode.workspace.fs.readFile(uri).then((b) => b, () => null);
    host.checkpoint.recordBinary(uri, before);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(images[i], 'base64'));
  }
  // 웹 참고 이미지를 썼으면 출처 기록 (CC0·퍼블릭 도메인은 표기 의무는 없지만 추적용)
  if (res.credits?.length) {
    const credits = vscode.Uri.joinPath(host.root, 'ASSET_CREDITS.md');
    const before = await readText(credits);
    host.checkpoint.record(credits, before);
    const lines = res.credits.map((c: any) => `- \`${call.path}\` 스타일 참고: [${c.title || '제목 없음'}](${c.source}) — ${c.creator || '작성자 미상'} · ${c.license} ${c.license_url}`);
    await writeDocument(credits, (before ?? '# 에셋 출처\n\n프로젝트 그림은 FLUX.1-schnell(Apache-2.0)로 생성했습니다. 아래는 스타일 참고에 쓴 무료 이미지입니다.\n\n') + lines.join('\n') + '\n');
  }
  const t = res.timings ?? {};
  const sizes = (res.sizes ?? []).map((s: number[]) => s.join('x')).join(', ');
  const v = res.verify;
  const verifyText = v?.scores ? ` · 컨셉 일치 ${v.scores.join('→')}/10${v.scores.length > 1 ? ' (다시 그림)' : ''}${v.problems ? ` · 남은 문제: ${v.problems}` : ''}` : '';
  const summary = `${targets.join(', ')} 저장 (${sizes}) · ${t.total ?? '?'}초${verifyText}` +
    (t.generate ? ` (생성 ${t.generate}s${t.style ? ` · 스타일 분석 ${t.style}s` : ''}${t.process ? ` · 가공 ${t.process}s` : ''})` : '');
  emit(title, 'done', { detail: summary + (res.prompt_used ? `\n프롬프트: ${res.prompt_used}` : ''), images: images.slice(0, 4).map((b) => `data:image/png;base64,${b}`) });
  return `[IMAGE ${call.path}] 완료: ${summary}` +
    (res.prompt_used ? `\n사용한 프롬프트: ${res.prompt_used}` : '') +
    (res.style ? `\n참고 이미지 스타일: ${res.style}` : '') +
    (res.credits?.length ? `\n참고 출처를 ASSET_CREDITS.md 에 기록함` : '') +
    '\n(코드에서 이 경로로 불러오세요. 확인이 필요하면 PLAY 로 화면을 보세요.)';
}


// ---- GREP (셸 없이: Windows 에서도 동작) ---------------------------------------------------------
async function grepFiles(root: vscode.Uri, pattern: string, signal: AbortSignal): Promise<string[]> {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, 6000);
  const out: string[] = [];
  for (const u of uris) {
    if (signal.aborted || out.length >= 200) break;
    let bytes: Uint8Array;
    try { bytes = await vscode.workspace.fs.readFile(u); } catch { continue; }
    if (bytes.length > 1_000_000 || bytes.subarray(0, 4000).includes(0)) continue; // 큰 파일·바이너리 제외
    const rel = path.relative(root.fsPath, u.fsPath).replace(/\\/g, '/');
    const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < 200; i++) {
      if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i]}`);
    }
  }
  return out;
}

// ---- DELETE · MOVE · MKDIR (IDE 파일 API: Windows·macOS·Linux 모두 동작, 승인 필요, /undo 지원) -------------
async function fileOp(call: Extract<ToolCall, { kind: 'delete' | 'move' | 'mkdir' }>, host: ToolHost,
  emit: (title: string, status: 'running' | 'done' | 'error' | 'denied', extra?: Partial<Extract<UiEvent, { type: 'tool' }>>) => void): Promise<string> {
  const tag = call.kind.toUpperCase();
  const label = call.kind === 'move' ? `${call.from} -> ${call.to}` : call.path;
  const title = `${call.kind === 'delete' ? 'Delete' : call.kind === 'move' ? 'Move' : 'Mkdir'}: ${label}`;
  try {
    if (call.kind === 'mkdir') {
      const uri = resolveInRoot(host.root, call.path);
      await vscode.workspace.fs.createDirectory(uri);
      emit(title, 'done');
      return `[MKDIR ${call.path}] 완료`;
    }
    const src = resolveInRoot(host.root, call.kind === 'move' ? call.from : call.path);
    if (src.fsPath === host.root.fsPath) throw new Error('워크스페이스 폴더 자체는 삭제·이동할 수 없습니다');
    const stat = await vscode.workspace.fs.stat(src).then((st) => st, () => null);
    if (!stat) return `[${tag} ${label}] 오류: 파일이 없습니다`;
    const isDir = (stat.type & vscode.FileType.Directory) !== 0;
    if (!(await host.approve('edit', title, isDir ? '폴더 전체 (되돌리기 대신 휴지통에서 복구)' : '파일'))) {
      emit(title, 'denied');
      return `[${tag} ${label}] 사용자가 거부했습니다`;
    }
    if (call.kind === 'delete') {
      if (!isDir) {
        const bytes = await vscode.workspace.fs.readFile(src);
        const isText = !bytes.subarray(0, 4000).includes(0);
        if (isText) host.checkpoint.record(src, Buffer.from(bytes).toString('utf8'));
        else host.checkpoint.recordBinary(src, bytes);
      }
      await vscode.workspace.fs.delete(src, { recursive: true, useTrash: true });
      emit(title, 'done', { detail: isDir ? '폴더 → 휴지통' : '파일 삭제 (/undo 로 복구)' });
      return `[DELETE ${label}] 완료${isDir ? ' (폴더는 휴지통으로)' : ''}`;
    }
    const dst = resolveInRoot(host.root, call.to);
    if (await vscode.workspace.fs.stat(dst).then(() => true, () => false)) return `[MOVE ${label}] 오류: 대상이 이미 있습니다 (${call.to})`;
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(dst.fsPath)));
    await vscode.workspace.fs.rename(src, dst, { overwrite: false });
    host.checkpoint.moves.push([src.fsPath, dst.fsPath]);
    emit(title, 'done');
    return `[MOVE ${label}] 완료 (코드에서 옛 경로를 쓰는 곳이 있으면 GREP 으로 찾아 고치세요)`;
  } catch (e: any) {
    emit(title, 'error', { detail: e.message });
    return `[${tag} ${label}] 오류: ${e.message}`;
  }
}
