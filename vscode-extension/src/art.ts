/**
 * 프로젝트 아트 컨셉: 프로젝트를 분석해 그림 스타일을 정하고(서버의 /api/art), 모든 IMAGE 생성에 자동 적용.
 * 분석 재료(문서·코드 힌트·기존 그림)는 이 PC 에서 모아 보낸다 → 로컬·원격 모두 동작.
 * /assets: 코드가 쓰는데 파일이 없는 그림 목록 (그림 하네스).
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { backend } from './clients';
import * as dk from './debugkit';
import { listFiles } from './debugRunner';

const DOC_RE = /(^|\/)(readme[^/]*|design[^/]*|gdd[^/]*|concept[^/]*|story[^/]*|기획[^/]*|컨셉[^/]*)\.(md|txt)$/i;
const IMG_RE = /\.(png|jpe?g|webp)$/i;
const HINT_RE = /\b(width|height|tile_?size|tileSize|sprite_?size|canvas|screen_?(w|h|width|height)|resolution|SCALE|FPS|title|game_?name)\b\s*[:=]/i;

async function readText(root: vscode.Uri, rel: string, max: number): Promise<string> {
  try {
    const b = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...rel.split('/')));
    return Buffer.from(b).toString('utf8').slice(0, max);
  } catch { return ''; }
}

export const projectName = (root: vscode.Uri) => path.basename(root.fsPath);

/** 분석 재료 모으기: 문서 · 코드 힌트 · 기존 그림(최대 4장) */
export async function collect(root: vscode.Uri, userConcept = ''): Promise<any> {
  const files = await listFiles(root, 4000);
  const docs: Record<string, string> = {};
  for (const f of files.filter((x) => DOC_RE.test(x)).slice(0, 6)) docs[f] = await readText(root, f, 2500);
  const hints: string[] = [];
  for (const f of files.filter((x) => /\.(py|m?jsx?|tsx?|dart|gd|cs|lua|json|ya?ml|toml)$/i.test(x) && !/package-lock|node_modules/.test(x)).slice(0, 300)) {
    if (hints.length >= 60) break;
    const text = await readText(root, f, 60_000);
    text.split('\n').forEach((l, i) => { if (hints.length < 60 && HINT_RE.test(l) && l.length < 200) hints.push(`${f}:${i + 1}: ${l.trim()}`); });
  }
  // 기존 그림: 리소스 폴더 우선, 너무 작거나 큰 것 제외
  const imgs = files.filter((f) => IMG_RE.test(f) && !/(^|\/)(\.yang|build|dist|node_modules)\//.test(f))
    .sort((a, b) => Number(/(assets|sprites?|images?|art|textures?)\//i.test(b)) - Number(/(assets|sprites?|images?|art|textures?)\//i.test(a)));
  const images: { path: string; data: string }[] = [];
  for (const f of imgs) {
    if (images.length >= 4) break;
    try {
      const uri = vscode.Uri.joinPath(root, ...f.split('/'));
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size < 300 || st.size > 3_000_000) continue;
      images.push({ path: f, data: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64') });
    } catch { /* 건너뜀 */ }
  }
  return { project: projectName(root), files: files.slice(0, 400), docs, code_hints: hints.join('\n'), images, user_concept: userConcept };
}

/** 아트 컨셉을 .yang/art-style.md 에도 남겨 사람이 읽고, 에이전트가 READ 할 수 있게 */
async function writeLocal(root: vscode.Uri, markdown: string) {
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.yang'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, '.yang', '.gitignore'), Buffer.from('*\n'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, '.yang', 'art-style.md'), Buffer.from(markdown, 'utf8'));
  } catch { /* 무시 */ }
}

export async function analyze(root: vscode.Uri, userConcept = ''): Promise<string> {
  const payload = await collect(root, userConcept);
  const r: any = await backend.post('/api/art/analyze', payload, 300_000);
  await writeLocal(root, r.markdown);
  return r.markdown;
}

export async function revise(root: vscode.Uri, instruction: string): Promise<string> {
  const r: any = await backend.put(`/api/art/${encodeURIComponent(projectName(root))}`, { instruction }, 300_000);
  await writeLocal(root, r.markdown);
  return r.markdown;
}

export async function get(root: vscode.Uri): Promise<string | null> {
  try {
    const r: any = await backend.get(`/api/art/${encodeURIComponent(projectName(root))}`);
    return r.markdown;
  } catch { return null; }
}

const analyzed = new Set<string>();
/** IMAGE 생성 전에 한 번: 아트 컨셉이 없으면 자동 분석 */
export async function ensure(root: vscode.Uri, log?: (s: string) => void): Promise<void> {
  const key = root.fsPath;
  if (analyzed.has(key)) return;
  analyzed.add(key);
  if (await get(root)) return;
  log?.('[아트 컨셉] 없음 → 프로젝트를 분석해 만드는 중…');
  try { await analyze(root); log?.('[아트 컨셉] 저장함 (.yang/art-style.md)'); } catch (e: any) { log?.(`[아트 컨셉] 분석 실패: ${e.message}`); }
}

/** 그림 하네스: 코드가 쓰는데 파일이 없는 그림·사운드 경로 */
export async function missingAssets(root: vscode.Uri): Promise<dk.AssetRef[]> {
  const files = await listFiles(root, 8000);
  const set = new Set(files);
  const out: dk.AssetRef[] = [];
  for (const f of files.filter((x) => /\.(m?jsx?|tsx?|py|dart|gd|cs|html?|lua|kt|java)$/i.test(x)).slice(0, 600)) {
    const text = await readText(root, f, 200_000);
    for (const ref of dk.assetRefs(f, text)) if (/\.(png|jpe?g|webp|gif)$/i.test(ref.ref) && !dk.assetExists(ref, set)) out.push(ref);
  }
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(r.ref) && seen.add(r.ref));
}
