import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { OutputAgentLog } from './agentLog';
import { ChatViewProvider } from './chatView';
import { backend, initClients, isRemote, SECRET_CF_ID, SECRET_CF_SECRET, SECRET_TOKEN, setSecret } from './clients';
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

async function configureRemote() {
  const c = vscode.workspace.getConfiguration('localAgent');
  const url = await vscode.window.showInputBox({
    title: '원격 접속 (1/3) 서버 주소',
    prompt: 'Cloudflare Tunnel 주소 (예: https://agent.example.com 또는 https://xxxx.trycloudflare.com)',
    value: c.get<string>('serverUrl', ''),
    ignoreFocusOut: true,
    validateInput: (v) => (/^https:\/\/[^\s/]+/.test(v.trim()) ? undefined : 'https:// 로 시작하는 주소를 입력하세요'),
  });
  if (!url) return;
  const token = await vscode.window.showInputBox({
    title: '원격 접속 (2/3) API 토큰', prompt: '서버(맥)에서 scripts/tunnel.sh token 으로 확인한 값',
    password: true, ignoreFocusOut: true,
  });
  if (token === undefined) return;
  const cfId = await vscode.window.showInputBox({
    title: '원격 접속 (3/3) Cloudflare Access 서비스 토큰 (선택)',
    prompt: 'Cloudflare Access 를 켰다면 Client ID 입력, 아니면 비워 두고 Enter', ignoreFocusOut: true,
  });
  let cfSecret = '';
  if (cfId) cfSecret = (await vscode.window.showInputBox({ title: 'Cloudflare Access Client Secret', password: true, ignoreFocusOut: true })) ?? '';

  await c.update('serverUrl', url.trim().replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
  if (token) await setSecret(SECRET_TOKEN, token.trim());
  await setSecret(SECRET_CF_ID, (cfId ?? '').trim());
  await setSecret(SECRET_CF_SECRET, cfSecret.trim());
  await c.update('mode', 'remote', vscode.ConfigurationTarget.Global);

  const ok = await backend.alive();
  const { lastBackendError } = await import('./clients');
  vscode.window.showInformationMessage(ok ? `원격 서버 연결 성공: ${url}` : `원격 서버 연결 실패: ${lastBackendError}`);
}

export async function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Yang Coding');
  await initClients(ctx.secrets);
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
}

export function deactivate() {
  backendProc?.kill('SIGTERM'); // 확장이 직접 띄운 백엔드만 종료
}
