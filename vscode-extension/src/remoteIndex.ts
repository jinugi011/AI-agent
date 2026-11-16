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
// MyBatis 매퍼 XML · Spring 설정 · Gradle 설정 (EHS 같은 Spring 백엔드의 구조 분석에 필요)
const EXTRA_RE = /(^|\/)docs?\/.*\.(txt|adoc|rst)$|\.(adoc|rst)$|(^|\/)(mapper|mappers|sqlmap|mybatis)\/.*\.xml$|Mapper\.xml$|(^|\/)pom\.xml$|(^|\/)(application|bootstrap)(-\w+)?\.(ya?ml|properties)$|(^|\/)(settings|build)\.gradle(\.kts)?$|(^|\/)gradle\.properties$/;
const MAX_FILES = 2500;
const MAX_FILE = 200_000;
const MAX_TOTAL = 25_000_000;
const REINDEX_AFTER_MS = 6 * 3600_000;

const indexedAt = new Map<string, number>();

export function remoteProjectName(root: vscode.Uri): string {
  return path.basename(root.fsPath);
}

export async function ensureRemoteIndex(root: vscode.Uri, log: AgentLog, force = false, arch: 'auto' | 'force' | 'off' = 'auto', name = ''): Promise<void> {
  const project = name || remoteProjectName(root);
  const last = indexedAt.get(project) ?? 0;
  if (!force && Date.now() - last < REINDEX_AFTER_MS) return;

  const t0 = Date.now();
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, 8000);
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const uri of uris) {
    const rel = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
    if (!CODE_EXT.has(path.extname(rel).toLowerCase()) && !CONFIG_FILES.has(rel) && !EXTRA_RE.test(rel)) continue;
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
  const res = await backend.post('/api/remote/index', { project, files, arch, client_path: root.fsPath }, 180_000);
  indexedAt.set(project, Date.now());
  log.line(`[원격 색인] 서버에서 벡터화 시작 · 프로필 ${res.project?.profile || '감지 안 됨'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'info');
}


/**
 * 웹 관리 페이지에서 '원격 PC 경로'로 등록한 프로젝트(PC 대기)를 이 PC 에서 찾아 올린다.
 * 확장이 켜질 때와 요청마다 확인 (가벼운 GET 하나).
 */
let syncing = false;
export async function syncPendingProjects(log: AgentLog): Promise<string[]> {
  if (syncing) return [];
  syncing = true;
  const done: string[] = [];
  try {
    const r: any = await backend.get('/api/remote/pending', 5000);
    for (const p of r.items ?? []) {
      const uri = vscode.Uri.file(p.client_path);
      const st = await vscode.workspace.fs.stat(uri).then((x) => x, () => null);
      if (!st || !(st.type & vscode.FileType.Directory)) continue; // 다른 PC 의 경로
      log.line(`[원격 등록] '${p.name}' (${p.client_path}) → 이 PC 에서 파일을 올려 분석합니다`, 'info');
      await ensureRemoteIndex(uri, log, true, 'auto', p.name);
      done.push(p.name);
    }
  } catch { /* 서버 연결 전 등 — 다음에 다시 */ } finally {
    syncing = false;
  }
  return done;
}

/**
 * 프로젝트 전체 분석 (ANALYZE 도구 · /arch 분석): 올려서 임베딩 → 코딩 스타일 → 아키텍처 문서가 나올 때까지 기다린다.
 * onProgress 로 진행 상황을 알린다. 결과: 요약 텍스트 + 아키텍처 문서.
 */
export async function analyzeProject(root: vscode.Uri, log: AgentLog, onProgress: (s: string) => void = () => undefined,
  signal?: AbortSignal, name = ''): Promise<{ summary: string; architecture: string }> {
  const project = name || remoteProjectName(root);
  onProgress('파일을 모아 서버로 올리는 중…');
  await ensureRemoteIndex(root, log, true, 'force', project);
  const t0 = Date.now();
  let rec: any = null;
  while (Date.now() - t0 < 420_000) {
    if (signal?.aborted) throw new Error('중단됨');
    await new Promise((r) => setTimeout(r, 3000));
    const r: any = await backend.get('/api/remote/projects', 10_000).catch(() => null);
    rec = r?.projects?.[project.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')] ?? r?.projects?.[project] ?? null;
    if (!rec) continue;
    if (rec.status === 'error') throw new Error(`임베딩 실패: ${rec.error ?? ''}`);
    if (rec.status === 'indexing') { onProgress(`코드·문서 임베딩 중… (${Math.round((Date.now() - t0) / 1000)}초)`); continue; }
    if (rec.arch_status === 'analyzing') { onProgress(`아키텍처 분석 중… (${Math.round((Date.now() - t0) / 1000)}초)`); continue; }
    if (rec.status === 'ready' && rec.arch_status !== 'analyzing') break;
  }
  const a: any = await backend.get(`/api/arch/${encodeURIComponent(project)}`).catch(() => ({}));
  const m = rec?.methods ?? {};
  const langs = Object.entries(m.languages ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const summary = `프로젝트 ${rec?.name ?? project} · 프로필 ${rec?.profile || '감지 안 됨'} · 파일 ${rec?.files ?? '?'}개 · 청크 ${rec?.chunks ?? '?'}개\n` +
    `언어: ${langs || '-'} · 들여쓰기 ${m.indentation ?? '-'} · 네이밍 ${m.naming ?? '-'} · 테스트 ${m.has_tests ? '있음' : '없음'}` +
    (rec?.arch_status === 'error' ? `\n아키텍처 분석 실패: ${rec.arch_error}` : '');
  return { summary, architecture: a.markdown ?? '' };
}
