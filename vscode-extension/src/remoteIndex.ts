/** 원격 모드: 이 PC 의 워크스페이스 파일을 서버(맥)로 올려 벡터화 (요구사항 8: 프로젝트 연결 시 코딩 방법 벡터화). */
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentLog } from './agent';
import { backend } from './clients';

const EXCLUDE = '**/{node_modules,.git,dist,build,target,.venv,venv,__pycache__,.next,Pods,.dart_tool,.gradle,models,out,.idea,coverage}/**';
const CODE_EXT = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.kt', '.kts', '.dart', '.swift', '.go', '.rs', '.cpp', '.cc', '.hpp', '.h', '.c',
  '.sql', '.md', '.yaml', '.yml', '.json', '.toml', '.css',
]);
const CONFIG_FILES = new Set([
  '.editorconfig', '.prettierrc', '.prettierrc.json', '.eslintrc', '.eslintrc.json', 'eslint.config.js', 'ruff.toml', '.flake8',
  'pyproject.toml', 'rustfmt.toml', 'analysis_options.yaml', '.swiftlint.yml', 'detekt.yml', '.golangci.yml', 'tsconfig.json',
  // 프로필 감지용 마커
  'requirements.txt', 'setup.py', 'package.json', 'pubspec.yaml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Package.swift', 'app/build.gradle', 'app/build.gradle.kts', 'vite.config.js', 'vite.config.ts',
]);
const MAX_FILES = 2500;
const MAX_FILE = 200_000;
const MAX_TOTAL = 25_000_000;
const REINDEX_AFTER_MS = 6 * 3600_000;

const indexedAt = new Map<string, number>();

export function remoteProjectName(root: vscode.Uri): string {
  return path.basename(root.fsPath);
}

export async function ensureRemoteIndex(root: vscode.Uri, log: AgentLog, force = false): Promise<void> {
  const project = remoteProjectName(root);
  const last = indexedAt.get(project) ?? 0;
  if (!force && Date.now() - last < REINDEX_AFTER_MS) return;

  const t0 = Date.now();
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, 8000);
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const uri of uris) {
    const rel = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
    if (!CODE_EXT.has(path.extname(rel).toLowerCase()) && !CONFIG_FILES.has(rel)) continue;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE || total + stat.size > MAX_TOTAL) continue;
      const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      files.push({ path: rel, content });
      total += stat.size;
    } catch {
      continue;
    }
    if (files.length >= MAX_FILES) break;
  }
  log.line(`[원격 색인] ${project}: 파일 ${files.length}개 (${(total / 1e6).toFixed(1)}MB) 업로드 중…`, 'info');
  const res = await backend.post('/api/remote/index', { project, files }, 180_000);
  indexedAt.set(project, Date.now());
  log.line(`[원격 색인] 서버에서 벡터화 시작 · 프로필 ${res.project?.profile || '감지 안 됨'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'info');
}
