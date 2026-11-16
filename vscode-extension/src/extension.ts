import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { OutputAgentLog } from './agentLog';
import { syncPendingProjects } from './remoteIndex';
import { ChatViewProvider } from './chatView';
import { backend, getDefaultServer, initClients, isRemote, SECRET_CF_ID, SECRET_CF_SECRET, SECRET_TOKEN, serverUrl, setDefaultServer, setSecret } from './clients';
import { OriginalContentProvider } from './tools';

let backendProc: ChildProcess | undefined;
let output: vscode.OutputChannel;

/** install.sh 가 기록한 설치 위치 (~/.config/local-agent/config.json). */
function installedRoot(): string {
  try {
    const file = path.join(os.homedir(), '.config', 'local-agent', 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).agentRoot ?? '';
  } catch {
    return '';
  }
}

/** AI-agent 루트 찾기: 설정 → 설치 기록 → 확장 위치(개발 모드) → 워크스페이스. */
function findAgentRoot(ctx: vscode.ExtensionContext): string | undefined {
  const isRoot = (p: string) => fs.existsSync(path.join(p, 'backend', 'app', 'main.py')) && fs.existsSync(path.join(p, 'engine'));
  const candidates = [
    vscode.workspace.getConfiguration('localAgent').get<string>('agentRoot', ''),
    installedRoot(),
    path.resolve(ctx.extensionPath, '..'),
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  ].filter(Boolean) as string[];
  return candidates.find(isRoot);
}

async function startBackend(ctx: vscode.ExtensionContext, interactive: boolean): Promise<boolean> {
  if (await backend.alive()) {
    if (interactive) vscode.window.showInformationMessage('Yang Coding 백엔드가 이미 실행 중입니다.');
    return true;
  }
  let root = findAgentRoot(ctx);
  if (!root && interactive) {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, openLabel: 'AI-agent 폴더 선택' });
    if (picked?.[0]) {
      root = picked[0].fsPath;
      await vscode.workspace.getConfiguration('localAgent').update('agentRoot', root, vscode.ConfigurationTarget.Global);
    }
  }
  if (!root) return false;
  const uvicorn = path.join(root, 'backend', '.venv', 'bin', 'uvicorn');
  if (!fs.existsSync(uvicorn)) {
    vscode.window.showErrorMessage(`백엔드 가상환경이 없습니다: ${uvicorn}\n(cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)`);
    return false;
  }
  const port = new URL(vscode.workspace.getConfiguration('localAgent').get<string>('backendUrl', 'http://127.0.0.1:8010')).port || '8010';
  output.appendLine(`[backend] ${uvicorn} app.main:app --port ${port}`);
  backendProc = spawn(uvicorn, ['app.main:app', '--host', '127.0.0.1', '--port', port], { cwd: path.join(root, 'backend') });
  backendProc.stdout?.on('data', (d) => output.append(d.toString()));
  backendProc.stderr?.on('data', (d) => output.append(d.toString()));
  backendProc.on('exit', (code) => {
    output.appendLine(`[backend] 종료 (code ${code})`);
    backendProc = undefined;
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await backend.alive()) return true;
  }
  vscode.window.showErrorMessage('백엔드 시작 실패 — 출력 패널(Yang Coding)을 확인하세요.');
  return false;
}

const isTailscale = (u: string) =>
  /^https?:\/\/([\w-]+\.)+ts\.net(:\d+)?\/?$/.test(u) || /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+(:\d+)?\/?$/.test(u);

/** 서버 주소 입력 (기본 주소가 없거나, 주소를 바꾸고 싶을 때만) */
async function askServerUrl(current: string): Promise<string | undefined> {
  const url = await vscode.window.showInputBox({
    title: 'Yang Coding 서버 주소',
    prompt: 'Tailscale 주소 (예: http://맥이름.tailnet.ts.net:18010) 또는 Cloudflare https 주소',
    value: current, ignoreFocusOut: true,
    // https 필수. 단 Tailscale 사설망 주소(*.ts.net, 100.64.0.0/10)는 WireGuard 로 암호화되므로 http 도 허용
    validateInput: (v) => {
      const u = v.trim();
      if (/^https:\/\/[^\s/]+/.test(u) || isTailscale(u)) return undefined;
      return 'https:// 주소를 입력하세요 (Tailscale 주소 *.ts.net 은 http:// 도 가능)';
    },
  });
  return url?.trim().replace(/\/$/, '');
}

/** 원격 접속: 서버 주소는 설치 파일에 고정 → 토큰만 입력하면 바로 접속 */
async function configureRemote() {
  const c = vscode.workspace.getConfiguration('localAgent');
  let url = serverUrl();
  if (!url) {
    url = (await askServerUrl('')) ?? '';
    if (!url) return;
    await c.update('serverUrl', url, vscode.ConfigurationTarget.Global);
  }
  const token = await vscode.window.showInputBox({
    title: 'Yang Coding 접속 토큰',
    prompt: `서버: ${url.replace(/^https?:\/\//, '')}  ·  관리 페이지(서버 주소를 브라우저로 열기) → 접속 토큰에서 발급한 값을 붙여 넣으세요`,
    placeHolder: '접속 토큰', password: true, ignoreFocusOut: true,
  });
  if (!token?.trim()) return;
  await setSecret(SECRET_TOKEN, token.trim());

  // Cloudflare Access 는 Cloudflare 주소일 때만 묻는다 (Tailscale 은 불필요)
  if (!isTailscale(url)) {
    const cfId = await vscode.window.showInputBox({
      title: 'Cloudflare Access 서비스 토큰 (선택)',
      prompt: 'Cloudflare Access 를 켰다면 Client ID 입력, 아니면 비워 두고 Enter', ignoreFocusOut: true,
    });
    let cfSecret = '';
    if (cfId) cfSecret = (await vscode.window.showInputBox({ title: 'Cloudflare Access Client Secret', password: true, ignoreFocusOut: true })) ?? '';
    await setSecret(SECRET_CF_ID, (cfId ?? '').trim());
    await setSecret(SECRET_CF_SECRET, cfSecret.trim());
  }
  await c.update('mode', 'remote', vscode.ConfigurationTarget.Global);

  const ok = await backend.alive();
  const { lastBackendError } = await import('./clients');
  if (ok) vscode.window.showInformationMessage(`Yang Coding 서버 연결 성공: ${url}`);
  else vscode.window.showErrorMessage(`연결 실패: ${lastBackendError}`, '토큰 다시 입력', '서버 주소 변경').then((pick) => {
    if (pick === '토큰 다시 입력') configureRemote();
    else if (pick === '서버 주소 변경') changeServer();
  });
}

async function changeServer() {
  const c = vscode.workspace.getConfiguration('localAgent');
  const url = await askServerUrl(serverUrl());
  if (url === undefined) return;
  // 기본 주소와 같거나 비우면 설정을 지워 기본 주소를 따른다
  await c.update('serverUrl', url && url !== getDefaultServer() ? url : undefined, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`서버 주소: ${serverUrl() || '(없음)'}`);
}

/** 설치 파일에 들어 있는 고정 서버 주소 (vsix 의 server.json, 패키징 때 생성) */
function loadDefaultServer(ctx: vscode.ExtensionContext) {
  try {
    const fs = require('fs') as typeof import('fs');
    const raw = fs.readFileSync(require('path').join(ctx.extensionPath, 'server.json'), 'utf8');
    setDefaultServer(JSON.parse(raw).url ?? '');
  } catch { /* 없으면 직접 입력 */ }
}

export async function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Yang Coding');
  await initClients(ctx.secrets);
  loadDefaultServer(ctx);
  const diffProvider = new OriginalContentProvider();
  const agentLog = new OutputAgentLog();
  const chat = new ChatViewProvider(ctx, diffProvider, agentLog);

  ctx.subscriptions.push(
    output,
    agentLog,
    vscode.commands.registerCommand('localAgent.showLog', () => agentLog.channel.show(true)),
    vscode.workspace.registerTextDocumentContentProvider(OriginalContentProvider.scheme, diffProvider),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.id, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('localAgent.focus', () => vscode.commands.executeCommand('localAgent.chat.focus')),
    vscode.commands.registerCommand('localAgent.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('localAgent.startBackend', () =>
      isRemote() ? vscode.window.showWarningMessage('원격 모드입니다. 백엔드는 서버(맥)에서 실행됩니다.') : startBackend(ctx, true)),
    vscode.commands.registerCommand('localAgent.configureRemote', configureRemote),
    vscode.commands.registerCommand('localAgent.changeServer', changeServer),
    vscode.commands.registerCommand('localAgent.openAdmin', () => {
      const u = serverUrl() || vscode.workspace.getConfiguration('localAgent').get<string>('backendUrl', 'http://127.0.0.1:8010');
      return vscode.env.openExternal(vscode.Uri.parse(u));
    }),
    vscode.commands.registerCommand('localAgent.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.local-coding-agent')),
    vscode.commands.registerCommand('localAgent.useLocal', async () => {
      await vscode.workspace.getConfiguration('localAgent').update('mode', 'local', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('로컬 모드로 전환했습니다 (이 PC 의 백엔드·엔진 사용).');
    }),
    vscode.commands.registerCommand('localAgent.setAgentRoot', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, openLabel: 'AI-agent 폴더 선택' });
      if (picked?.[0]) await vscode.workspace.getConfiguration('localAgent').update('agentRoot', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('localAgent.askAboutSelection', async () => {
      const q = await vscode.window.showInputBox({ prompt: '선택한 코드에 대해 무엇을 할까요?', placeHolder: '예) 리팩터링해줘 / 버그 찾아줘 / 테스트 작성해줘' });
      if (!q) return;
      await vscode.commands.executeCommand('localAgent.chat.focus');
      await chat.handleInput(q);
    }),
  );

  if (!isRemote() && vscode.workspace.getConfiguration('localAgent').get<boolean>('autoStartBackend', true)) {
    void startBackend(ctx, false);
  }
  if (isRemote()) {
    // 웹 관리 페이지에서 '이 PC 의 경로'로 등록한 프로젝트를 찾아 올린다 (켜질 때 + 10분마다)
    const sync = () => syncPendingProjects(agentLog).then((done) => {
      if (done.length) vscode.window.showInformationMessage(`Yang Coding: 원격 등록 프로젝트를 올려 분석을 시작했습니다 (${done.join(', ')})`);
    });
    setTimeout(sync, 5000);
    const timer = setInterval(sync, 10 * 60_000);
    ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
}

export function deactivate() {
  backendProc?.kill('SIGTERM'); // 확장이 직접 띄운 백엔드만 종료
}
