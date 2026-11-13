/** 도구 실행기: 모델이 요청한 도구를 VS Code 안에서 실행하고, 결과 텍스트를 모델에게 돌려준다. */
import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { backend } from './clients';
import { applySearchReplace, lineDiffStats, ToolCall } from './protocol';

const EXCLUDE = '**/{node_modules,.git,dist,build,target,.venv,venv,__pycache__,.next,Pods,.dart_tool,.gradle,models}/**';
const MAX_READ = 60_000;
const MAX_OUT = 8_000;

export type UiEvent =
  | { type: 'tool'; id: string; title: string; status: 'running' | 'done' | 'error' | 'denied'; detail?: string; diff?: { path: string; added: number; removed: number } }
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

  record(uri: vscode.Uri, before: string | null) {
    if (!this.originals.has(uri.fsPath)) this.originals.set(uri.fsPath, before);
  }

  async revert(): Promise<string[]> {
    const reverted: string[] = [];
    for (const [fsPath, before] of this.originals) {
      const uri = vscode.Uri.file(fsPath);
      if (before === null) {
        await vscode.workspace.fs.delete(uri, { useTrash: true }).then(undefined, () => undefined);
      } else {
        await writeDocument(uri, before);
      }
      reverted.push(fsPath);
    }
    this.originals.clear();
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

function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs = 300_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-lc', command], { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
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
        const files = uris.map((u) => path.relative(host.root.fsPath, u.fsPath)).sort();
        emit(`List ${call.pattern}`, 'done', { detail: `${files.length}개` });
        return `[LIST ${call.pattern}] ${files.length}개\n${files.join('\n')}`;
      }

      case 'grep': {
        emit(`Grep ${call.pattern}`, 'running');
        const quoted = `'${call.pattern.replace(/'/g, `'\\''`)}'`;
        const res = await runShell(
          `git grep -n -I -E ${quoted} 2>/dev/null || grep -rnIE --exclude-dir={node_modules,.git,dist,build,target,.venv} ${quoted} .`,
          host.root.fsPath, host.signal, 30_000,
        );
        const lines = res.output.split('\n').filter(Boolean);
        emit(`Grep ${call.pattern}`, 'done', { detail: `${lines.length}건` });
        return `[GREP ${call.pattern}] ${lines.length}건\n${truncate(lines.slice(0, 200).join('\n'))}`;
      }

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
