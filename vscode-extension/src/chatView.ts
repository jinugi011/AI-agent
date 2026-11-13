/** 사이드바 채팅 웹뷰 ↔ 에이전트 세션 연결. */
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentEvent, AgentSession, EditorContext } from './agent';
import { backend, engine } from './clients';
import { parseToolCalls, ToolCall } from './protocol';
import { Checkpoint, executeTool, OriginalContentProvider } from './tools';

const HELP = `**사용법** — 자연어로 요청하면 됩니다. 예:
- "장바구니에 쿠폰 할인 기능 추가하고 테스트 돌려줘"
- "이 함수 왜 느린지 봐줘" (에디터에서 코드 선택 후)
- "앞으로 Python 은 ruff 규칙, 줄 길이 100 으로 해줘" → 선호로 영구 저장
- "30B 모델 다운로드해줘" / "엔진 시작해줘" / "모델 상태"

**슬래시 명령**
- \`/new\` 새 대화 · \`/stop\` 중단 · \`/undo\` 마지막 턴의 파일 변경 되돌리기
- \`/model [status|download <key>|start [key]|stop]\`
- \`/remember <style|preference|constraint> <global|language:x|profile:x|project> 내용\`
- \`/task 요구사항\` → 하네스(테스트 우선) 자동 구현 · \`/connect 경로|URL\` · \`/reindex\``;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly id = 'localAgent.chat';
  private view?: vscode.WebviewView;
  private session: AgentSession;
  private approvals = new Map<string, (a: 'allow' | 'always' | 'deny') => void>();
  private statusTimer?: NodeJS.Timeout;
  private pending: AgentEvent[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly diffProvider: OriginalContentProvider) {
    this.session = new AgentSession(
      (ev) => this.post(ev),
      (kind, title, detail) => this.askApproval(kind, title, detail),
      diffProvider,
    );
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => (view.visible ? this.startStatus() : this.stopStatus()));
    view.onDidDispose(() => this.stopStatus());
    this.startStatus();
    for (const ev of this.pending.splice(0)) this.post(ev);
  }

  private post(msg: any) {
    if (this.view) void this.view.webview.postMessage(msg);
    else if (msg.type !== 'status') this.pending.push(msg);
  }

  // ---- 상태 폴링 (엔진/모델/다운로드 진행률) --------------------------------------
  private startStatus() {
    this.stopStatus();
    const tick = async () => {
      const [backendUp, eng] = await Promise.all([backend.alive(), engine.health()]);
      let models: any = null;
      if (backendUp) models = await backend.get('/api/models', 3000).catch(() => null);
      this.post({
        type: 'status',
        backend: backendUp,
        engine: eng ? { name: eng.model?.model_name, ctx: eng.model?.n_ctx } : null,
        models: models?.catalog ?? [],
        repo: this.session.repoName,
        workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
      });
    };
    void tick();
    this.statusTimer = setInterval(tick, 4000);
  }

  private stopStatus() {
    if (this.statusTimer) clearInterval(this.statusTimer);
  }

  // ---- 승인 -------------------------------------------------------------------
  private askApproval(kind: 'edit' | 'run', title: string, detail: string): Promise<'allow' | 'always' | 'deny'> {
    const reqId = `ap${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    void vscode.commands.executeCommand('localAgent.chat.focus');
    this.post({ type: 'approval', reqId, kind, title, detail });
    return new Promise((resolve) => this.approvals.set(reqId, resolve));
  }

  // ---- 웹뷰 → 확장 메시지 ----------------------------------------------------------
  private async onMessage(m: any) {
    switch (m.type) {
      case 'send':
        return this.handleInput(String(m.text ?? ''));
      case 'stop':
        return this.session.stop();
      case 'new':
        return this.newChat();
      case 'approval': {
        const resolve = this.approvals.get(m.reqId);
        this.approvals.delete(m.reqId);
        return resolve?.(m.answer);
      }
      case 'undo':
        return this.undo();
      case 'openDiff':
        return this.openDiff(m.id, m.path);
      case 'openFile': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (root) await vscode.window.showTextDocument(vscode.Uri.joinPath(root, m.path));
        return;
      }
      case 'setup':
        return this.runDirect({ kind: 'model', action: m.action, arg: m.model ?? '' });
      case 'startBackend':
        return vscode.commands.executeCommand('localAgent.startBackend');
    }
  }

  newChat() {
    this.session.reset();
    for (const resolve of this.approvals.values()) resolve('deny');
    this.approvals.clear();
    this.post({ type: 'cleared' });
  }

  private async undo() {
    const cp = this.session.lastCheckpoint;
    if (!cp || cp.originals.size === 0) {
      this.post({ type: 'notice', level: 'info', text: '되돌릴 변경이 없습니다.' });
      return;
    }
    const files = await cp.revert();
    this.post({ type: 'notice', level: 'info', text: `${files.length}개 파일을 이전 상태로 되돌렸습니다.` });
  }

  private async openDiff(id: string, rel: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const right = vscode.Uri.joinPath(root, rel);
    const left = vscode.Uri.from({ scheme: OriginalContentProvider.scheme, path: right.path, query: id });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(rel)} (에이전트 변경 전 ↔ 후)`);
  }

  private async runDirect(call: ToolCall) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return this.post({ type: 'notice', level: 'warn', text: '폴더를 먼저 열어주세요.' });
    const ctrl = new AbortController();
    const result = await executeTool(call, {
      root, repoName: this.session.repoName, signal: ctrl.signal, checkpoint: new Checkpoint(),
      approve: async () => true, emit: (ev) => this.post(ev),
    }, this.diffProvider);
    this.post({ type: 'notice', level: result.includes('오류') ? 'error' : 'info', text: result.split('\n')[0] });
  }

  async handleInput(text: string, extraEditor?: Partial<EditorContext>) {
    text = text.trim();
    if (!text) return;
    this.post({ type: 'user', text });

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = rest.join(' ');
      switch (cmd) {
        case '/help': return this.post({ type: 'notice', level: 'info', text: HELP });
        case '/new': case '/clear': return this.newChat();
        case '/stop': return this.session.stop();
        case '/undo': return this.undo();
        case '/model': {
          const [action = 'status', ...a] = rest;
          return this.runDirect({ kind: 'model', action, arg: a.join(' ') });
        }
        case '/remember': {
          const calls = parseToolCalls(`<<<REMEMBER ${rest.slice(0, 2).join(' ')}\n${rest.slice(2).join(' ')}\nREMEMBER>>>`);
          return calls[0] ? this.runDirect(calls[0]) : undefined;
        }
        case '/connect': return this.runDirect({ kind: 'connect', location: arg });
        case '/task': return this.session.send(`다음 요구사항을 HARNESS 도구로 구현해줘:\n${arg}`, this.editorContext(extraEditor));
        case '/reindex':
          if (!this.session.repoName) return this.post({ type: 'notice', level: 'warn', text: '연결된 레포가 없습니다. 먼저 아무 요청이나 보내면 자동 연결됩니다.' });
          await backend.post(`/api/repos/${this.session.repoName}/reindex`, {}, 600_000);
          return this.post({ type: 'notice', level: 'info', text: `${this.session.repoName} 재색인 완료` });
        default:
          return this.post({ type: 'notice', level: 'warn', text: `알 수 없는 명령: ${cmd} (/help)` });
      }
    }
    await this.session.send(text, this.editorContext(extraEditor));
  }

  editorContext(extra?: Partial<EditorContext>): EditorContext {
    const ed = vscode.window.activeTextEditor;
    const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u, false);
    const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : undefined;
    return {
      file: ed ? rel(ed.document.uri) : undefined,
      selection: sel,
      selectionRange: ed && sel ? `${rel(ed.document.uri)}:${ed.selection.start.line + 1}-${ed.selection.end.line + 1}` : undefined,
      openFiles: vscode.window.tabGroups.all.flatMap((g) => g.tabs)
        .map((t) => (t.input instanceof vscode.TabInputText ? rel(t.input.uri) : ''))
        .filter(Boolean),
      ...extra,
    };
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
</head>
<body>
  <header id="status"><span class="dot"></span><span id="status-text">연결 확인 중…</span></header>
  <section id="setup" hidden></section>
  <main id="log" aria-live="polite"></main>
  <form id="composer">
    <textarea id="input" rows="3" placeholder="무엇을 만들까요? (Enter 전송 · Shift+Enter 줄바꿈 · /help)"></textarea>
    <div class="row">
      <span class="hint" id="hint"></span>
      <button type="button" id="stop" class="secondary" hidden>중단</button>
      <button type="submit" id="send">보내기</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
