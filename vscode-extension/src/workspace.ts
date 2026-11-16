/**
 * 작업 폴더 인식: 폴더 구조 · git 정보를 사용자 PC 에서 직접 읽어 에이전트에게 알려준다.
 * (원격 모드에서 서버(맥)는 이 PC 의 폴더를 볼 수 없으므로, 여기서 모아 프롬프트에 넣는다)
 */
import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { DirInfo, formatTree, SKIP_DIRS, summarizeStatus } from './wsinfo';

function git(cwd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 2_000_000 }, (err, stdout) => {
      resolve(err ? null : stdout.toString().trim());
    });
  });
}

/** 폴더 구조 (깊이 3, 폴더별 파일 수) */
export async function folderTree(root: vscode.Uri, maxDepth = 3): Promise<string> {
  const dirs: DirInfo[] = [];
  let rootFiles: string[] = [];
  const walk = async (uri: vscode.Uri, rel: string, depth: number) => {
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(uri); } catch { return; }
    const subdirs = entries.filter(([n, t]) => (t & vscode.FileType.Directory) && !SKIP_DIRS.has(n) && !(n.startsWith('.') && n !== '.github'));
    const files = entries.filter(([, t]) => (t & vscode.FileType.File) !== 0).map(([n]) => n);
    if (rel) dirs.push({ rel, files: files.length, dirs: subdirs.length });
    else rootFiles = files;
    if (depth >= maxDepth || dirs.length > 400) return;
    for (const [name] of subdirs.sort(([a], [b]) => a.localeCompare(b))) {
      await walk(vscode.Uri.joinPath(uri, name), rel ? `${rel}/${name}` : name, depth + 1);
    }
  };
  await walk(root, '', 0);
  return formatTree(dirs, rootFiles);
}

/** 대화 중 잘 안 바뀌는 git 정보 (시스템 프롬프트용) */
export async function gitStable(root: vscode.Uri): Promise<string> {
  const top = await git(root.fsPath, ['rev-parse', '--show-toplevel']);
  if (top === null) {
    const has = await git(root.fsPath, ['--version']);
    return has ? 'git 레포 아님 (필요하면 RUN git init)' : 'git 이 설치되어 있지 않거나 PATH 에 없음';
  }
  const remotes = (await git(root.fsPath, ['remote', '-v'])) ?? '';
  const origin = remotes.split('\n').filter((l) => l.endsWith('(fetch)')).map((l) => l.replace(/\s+\(fetch\)$/, '').replace(/\t/, ' → ')).join(', ');
  const sub = path.relative(top, root.fsPath);
  return `git 레포 루트: ${top}${sub ? ` (작업 폴더는 그 안의 ${sub.split(path.sep).join('/')})` : ''}\n원격: ${origin || '(없음)'}`;
}

/** 매 요청마다 바뀌는 git 상태 (사용자 메시지에 붙임) */
export async function gitNow(root: vscode.Uri): Promise<string> {
  const st = await git(root.fsPath, ['status', '--porcelain=v1', '-b']);
  if (st === null) return '';
  const s = summarizeStatus(st);
  const log = (await git(root.fsPath, ['log', '--oneline', '-5'])) ?? '';
  return `(git) ${s.branch || '브랜치 정보 없음'} · 변경 ${s.total}개` +
    (s.changes.length ? `\n${s.changes.join('\n')}${s.total > s.changes.length ? `\n…(${s.total - s.changes.length}개 더)` : ''}` : '') +
    (log ? `\n최근 커밋:\n${log}` : '');
}

/** LIST 폴더경로: 한 단계 항목 (폴더는 / 로 끝남) */
export async function listDir(root: vscode.Uri, rel: string): Promise<string[]> {
  const clean = rel.replace(/^\.?\/?/, '').replace(/\/$/, '');
  const uri = clean ? vscode.Uri.joinPath(root, ...clean.split('/')) : root;
  const entries = await vscode.workspace.fs.readDirectory(uri);
  return entries
    .sort(([a, ta], [b, tb]) => Number(!(ta & vscode.FileType.Directory)) - Number(!(tb & vscode.FileType.Directory)) || a.localeCompare(b))
    .map(([n, t]) => `${clean ? clean + '/' : ''}${n}${t & vscode.FileType.Directory ? '/' : ''}`);
}
