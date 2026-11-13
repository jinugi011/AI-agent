import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';
import { backend } from './clients';
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
    if (interactive) vscode.window.showInformationMessage('Local Agent 백엔드가 이미 실행 중입니다.');
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
  vscode.window.showErrorMessage('백엔드 시작 실패 — 출력 패널(Local Agent)을 확인하세요.');
  return false;
}

export function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Local Agent');
  const diffProvider = new OriginalContentProvider();
  const chat = new ChatViewProvider(ctx, diffProvider);

  ctx.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(OriginalContentProvider.scheme, diffProvider),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.id, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('localAgent.focus', () => vscode.commands.executeCommand('localAgent.chat.focus')),
    vscode.commands.registerCommand('localAgent.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('localAgent.startBackend', () => startBackend(ctx, true)),
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

  if (vscode.workspace.getConfiguration('localAgent').get<boolean>('autoStartBackend', true)) {
    void startBackend(ctx, false);
  }
}

export function deactivate() {
  backendProc?.kill('SIGTERM'); // 확장이 직접 띄운 백엔드만 종료
}
