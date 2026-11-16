/** 사이드바 채팅 웹뷰 ↔ 에이전트 세션 연결. */
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentEvent, AgentLog, AgentSession, Attachment, EditorContext } from './agent';
import { backend, engine, isRemote, lastBackendError, serverUrl, getDefaultServer } from './clients';
import { listFiles } from './debugRunner';
import { analyzeProject, ensureRemoteIndex, remoteProjectName } from './remoteIndex';
import { checklistProgress, detectTestCommand, harnessFromRequestPrompt, harnessName, harnessPrompt, HARNESS_DIR, isChecklist } from './harnesskit';
import { describeCall, parseToolCalls, ToolCall } from './protocol';
import { debugPrompt, parsePlay } from './debugkit';
import * as art from './art';
import { generateWorkflow, RemoteInbox } from './remoteWork';
import { workflowRequest, WorkflowMode } from './workflow';
import { Checkpoint, executeTool, OriginalContentProvider } from './tools';

const HELP = `**사용법** — 자연어로 요청하면 됩니다. 예:
- "장바구니에 쿠폰 할인 기능 추가하고 테스트 돌려줘"
- "이 함수 왜 느린지 봐줘" (에디터에서 코드 선택 후)
- "앞으로 Python 은 ruff 규칙, 줄 길이 100 으로 해줘" → 선호로 영구 저장
- "30B 모델 다운로드해줘" / "엔진 시작해줘" / "모델 상태"

**슬래시 명령**
- \`/new\` 새 대화 · \`/stop\` 중단 · \`/undo\` 마지막 턴의 파일 변경 되돌리기
- \`/model\` 모델 목록 · \`/model 코딩\` 평소 코딩 (Qwen3.6) · \`/model 이전\` 이전 모델 (Qwen3-Coder-30B)
- \`/remember <style|preference|constraint> <global|language:x|profile:x|project> 내용\`
- \`/task 요구사항\` → 하네스(테스트 우선) 자동 구현 · \`/connect 경로|URL\` · \`/reindex\`

**프로젝트 분석 · 같은 스타일로 코딩**
- \`/langchain 원하는 기능\` 서버 LangChain으로 명세 생성 → 이 PC에서 구현 · \`/langchain 하네스 목표와 완료 조건\` 테스트 우선 구현
- 입력창 작업 방식에서 **자연어 하네스**를 선택하면 문서 없이 목표·완료 조건을 입력할 수 있습니다.
- \`/arch 분석\` 코드·문서 임베딩 + 코딩 스타일 + 아키텍처 분석 (1~3분) · \`/arch\` 보기 · \`/arch 저장\` (.yang/architecture.md 를 고친 뒤)
- \`/harness 문서.md\` 요구사항 md → 체크리스트(.yang/harness) → 테스트 먼저 → 구현 → 통과까지 · \`/harness\` 목록·진행률
- 에이전트도 필요하면 스스로 ANALYZE(프로젝트 분석)를 요청합니다 (승인 창)

**디버깅**
- \`/debug 증상\` → 재현(실행) → 원인 위치 → 가설 → 임시 로그 → 수정 → 재검증 → 정리 순서로 버그 잡기
  예) \`/debug 점프하면 캐릭터가 사라짐\` · \`/debug\` (증상 없이: 실행해서 문제 찾기)
- \`/play [web|python|flutter|godot|unity|cmd] [대상] [초]\` → 게임·앱을 실행해 오류·콘솔·리소스 실패·프레임·화면 분석
- \`/check\` → 프로젝트 전체 정적 검사 (문법·타입·IDE 오류·리소스 경로)
- 파일을 고칠 때마다 자동 검사가 돌고, 오류가 남아 있으면 끝내지 않고 고칩니다 (설정에서 끌 수 있음)

**그림 (다운로드하지 않고 생성)**
- \`/image 설명\` → 맥의 이미지 모델(Z-Image)로 생성해 프로젝트에 저장 · 예) \`/image 64x64 투명 배경 픽셀아트 슬라임\`
- \`/art\` → 프로젝트(문서·코드·기존 그림·벡터 DB)를 분석해 **아트 컨셉** 만들기 → 모든 그림에 자동 적용 · \`/art 어두운 판타지 16비트 픽셀아트\` (직접 컨셉 지정) · \`/art 수정 …\` · \`/art 보기\`
- \`/assets\` → 코드가 쓰는데 파일이 없는 그림을 찾아 컨셉에 맞게 생성 (그림 하네스)
- 대화로도 가능: "주인공 스프라이트 만들어서 assets 에 넣어줘", "이 첨부 그림 스타일로 배경 그려줘", "무료 이미지 참고해서 아이콘 만들어줘"
- 가공: 배경 제거 · 픽셀아트 · 크기 · 자르기 · 뒤집기 · 색조 · 스프라이트 시트 나누기/합치기 · \`/undo\` 로 되돌리기`;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly id = 'localAgent.chat';
  private view?: vscode.WebviewView;
  private session: AgentSession;
  private approvals = new Map<string, (a: 'allow' | 'always' | 'deny') => void>();
  private statusTimer?: NodeJS.Timeout;
  private pending: AgentEvent[] = [];
  /** 이번 세션에서 올린 첨부 (id → 분석 결과) */
  private attached = new Map<string, Attachment>();
  private workflowAbort?: AbortController;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly diffProvider: OriginalContentProvider,
    private readonly log: AgentLog,
  ) {
    this.session = new AgentSession(
      (ev) => this.post(ev),
      (kind, title, detail) => this.askApproval(kind, title, detail),
      diffProvider,
      log,
    );
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root) ctx.subscriptions.push(new RemoteInbox({
      target: () => isRemote() && vscode.workspace.workspaceFolders?.[0]?.uri.fsPath === root.fsPath ? { project: remoteProjectName(root), workspace: root.fsPath } : undefined,
      busy: () => this.session.running || !!this.workflowAbort,
      approve: async (text, signal) => {
        await vscode.commands.executeCommand('localAgent.chat.focus');
        return (await this.askApproval('run', '웹에서 전달한 원격 작업', `${root.fsPath}\n\n${text}`, signal)) !== 'deny';
      },
      run: (text, mode) => this.runWorkflowTask(text, mode),
      cancel: () => {
        if (this.workflowAbort) {
          this.workflowAbort.abort();
          this.session.stop();
          for (const resolve of this.approvals.values()) resolve('deny');
          this.approvals.clear();
        }
      },
      notice: (text) => this.post({ type: 'notice', level: 'warn', text }),
    }));
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
        remote: isRemote(),
        server: isRemote() ? serverUrl() : '',
        defaultServer: getDefaultServer(),
        error: backendUp ? '' : lastBackendError,
      });
    };
    void tick();
    this.statusTimer = setInterval(tick, 4000);
  }

  private stopStatus() {
    if (this.statusTimer) clearInterval(this.statusTimer);
  }

  // ---- 승인 -------------------------------------------------------------------
  private askApproval(kind: 'edit' | 'run' | 'files' | 'index', title: string, detail: string, signal?: AbortSignal): Promise<'allow' | 'always' | 'deny'> {
    if (signal?.aborted) return Promise.resolve('deny');
    const reqId = `ap${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    void vscode.commands.executeCommand('localAgent.chat.focus');
    this.post({ type: 'approval', reqId, kind, title, detail });
    return new Promise((resolve) => {
      const finish = (answer: 'allow' | 'always' | 'deny') => {
        signal?.removeEventListener('abort', abort);
        this.approvals.delete(reqId);
        resolve(answer);
      };
      const abort = () => finish('deny');
      this.approvals.set(reqId, finish);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  // ---- 웹뷰 → 확장 메시지 ----------------------------------------------------------
  private async onMessage(m: any) {
    switch (m.type) {
      case 'send':
        return this.handleInput(String(m.text ?? ''), undefined, Array.isArray(m.attachments) ? m.attachments.map(String) : []);
      case 'pickFiles':
        return this.pickFiles();
      case 'attachData':
        return this.uploadAttachment(String(m.key), String(m.name), String(m.data ?? ''));
      case 'attachUris':
        return this.attachUris(Array.isArray(m.uris) ? m.uris.map(String) : []);
      case 'stop':
        this.workflowAbort?.abort();
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
      case 'configureRemote':
        return vscode.commands.executeCommand('localAgent.configureRemote');
    }
  }

  newChat() {
    this.workflowAbort?.abort();
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
    this.log.line(`▶ (직접 실행) ${describeCall(call)}`, 'tool');
    const result = await executeTool(call, {
      root, repoName: this.session.repoName, signal: ctrl.signal, checkpoint: new Checkpoint(),
      approve: async () => true, emit: (ev) => this.post(ev),
    }, this.diffProvider);
    this.log.line(result.split('\n').map((l) => '    ' + l).join('\n'), result.includes('오류') ? 'error' : 'result');
    this.post({ type: 'notice', level: result.includes('오류') ? 'error' : 'info', text: result.split('\n')[0] });
  }

  async handleInput(text: string, extraEditor?: Partial<EditorContext>, attachmentIds: string[] = []) {
    text = text.trim();
    if (!text) return;
    if ((this.workflowAbort || this.session.running) && !/^\/(stop|new|clear)$/.test(text)) return this.post({ type: 'notice', level: 'warn', text: '현재 작업이 끝나거나 중단된 뒤 요청하세요.' });
    const atts = attachmentIds.map((id) => this.attached.get(id)).filter((a): a is Attachment => !!a);
    this.post({ type: 'user', text, attachments: atts.map((a) => a.name) });

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = text.slice(cmd.length).trim();
      switch (cmd) {
        case '/help': return this.post({ type: 'notice', level: 'info', text: HELP });
        case '/new': case '/clear': return this.newChat();
        case '/stop': this.workflowAbort?.abort(); return this.session.stop();
        case '/undo': return this.undo();
        case '/log': return vscode.commands.executeCommand('localAgent.showLog');
        case '/model': {
          const [action = '', ...a] = rest;
          const preset = ({ '코딩': 'coder', coder: 'coder', '이전': 'coder-old', '30b': 'coder-old', 'coder-old': 'coder-old', } as Record<string, string>)[action.toLowerCase()];
          if (!action || preset) {
            try {
              if (!preset) {
                const r: any = await backend.get('/api/admin/models');
                const list = r.presets.map((m: any) => `- ${m.active ? '✅' : m.available ? '⬜' : '⏳'} **${m.label}** — ${m.help}${m.available ? '' : ' (아직 없음)'}`).join('\n');
                return this.post({ type: 'notice', level: 'info', text: `${list}\n\n\`/model 코딩\` · \`/model 이전\` 으로 바꿉니다 (엔진 재시작 20~60초).` });
              }
              const r: any = await backend.post('/api/admin/models', { preset });
              this.post({ type: 'notice', level: 'info', text: r.message });
              for (let i = 0; i < 60; i++) {
                await new Promise((res) => setTimeout(res, 3000));
                const st: any = await backend.get('/api/engine/status', 3000).catch(() => null);
                if (st?.online && i > 1) return this.post({ type: 'notice', level: 'info', text: `모델 준비 완료: ${st.model?.model_name ?? ''}` });
              }
              return this.post({ type: 'notice', level: 'warn', text: '엔진이 아직 준비되지 않았습니다. 관리 페이지 → 서버 관리에서 로그를 확인하세요.' });
            } catch (e: any) {
              return this.post({ type: 'notice', level: 'error', text: `모델 변경 실패: ${e.message}` });
            }
          }
          return this.runDirect({ kind: 'model', action, arg: a.join(' ') });
        }
        case '/remember': {
          const calls = parseToolCalls(`<<<REMEMBER ${rest.slice(0, 2).join(' ')}\n${rest.slice(2).join(' ')}\nREMEMBER>>>`);
          return calls[0] ? this.runDirect(calls[0]) : undefined;
        }
        case '/connect': return this.runDirect({ kind: 'connect', location: arg });
        case '/langchain': case '/chain': {
          const request = workflowRequest(arg);
          if (!request.goal) return this.post({ type: 'notice', level: 'info', text: '/langchain 원하는 기능 · /langchain 하네스 목표와 완료 조건' });
          return this.runWorkflowTask(request.goal, request.mode, true).catch(() => undefined);
        }
        case '/debug': return this.session.send(debugPrompt(arg), this.editorContext(extraEditor), atts, { debug: true });
        case '/check': return this.runDirect({ kind: 'check' });
        case '/play': return this.runDirect({ kind: 'play', req: parsePlay(arg) });
        case '/art': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (!root) return this.post({ type: 'notice', level: 'warn', text: '폴더를 먼저 여세요.' });
          const [sub, ...more] = arg.split(/\s+/);
          try {
            this.post({ type: 'notice', level: 'info', text: sub === '수정' ? '아트 컨셉 수정 중…' : sub === '보기' ? '아트 컨셉 불러오는 중…' : '프로젝트를 분석해 아트 컨셉을 만드는 중… (문서·코드·기존 그림·벡터 DB, 30초~1분)' });
            const md = sub === '보기' ? (await art.get(root)) ?? '아직 아트 컨셉이 없습니다. `/art` 로 분석하세요.'
              : sub === '수정' ? await art.revise(root, more.join(' '))
                : await art.analyze(root, arg.trim());
            return this.post({ type: 'notice', level: 'info', text: md + '\n\n(`/art 수정 더 어둡게, 보라색 위주` 로 고치기 · `/art 보기` · `.yang/art-style.md`)' });
          } catch (e: any) {
            return this.post({ type: 'notice', level: 'error', text: `아트 컨셉 오류: ${e.message}` });
          }
        }
        case '/assets': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (!root) return this.post({ type: 'notice', level: 'warn', text: '폴더를 먼저 여세요.' });
          const missing = await art.missingAssets(root);
          if (!missing.length) return this.post({ type: 'notice', level: 'info', text: '코드가 쓰는 그림 파일이 모두 있습니다 ✓' });
          const list = missing.slice(0, 20).map((m) => `- ${m.ref} (${m.file}:${m.line})`).join('\n');
          return this.session.send(`[그림 하네스] 코드가 쓰는데 파일이 없는 그림 ${missing.length}개:\n${list}\n\n` +
            '각 그림이 쓰이는 코드를 READ 로 확인해 용도(kind)와 크기를 정하고, 프로젝트 아트 컨셉에 맞게 IMAGE 로 그 경로에 생성하세요. ' +
            '한 응답에 최대 4개씩, 모두 만든 뒤 CHECK 로 경로 오류가 없는지 확인하세요.', this.editorContext(extraEditor), atts);
        }
        case '/image': return this.session.send(`다음 그림을 IMAGE 도구로 만들어 프로젝트에 추가하고, 필요하면 코드에서 불러오도록 연결해줘 (prompt 는 영어로):\n${arg}`, this.editorContext(extraEditor), atts);
        case '/task': case '/harness': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (!root) return this.post({ type: 'notice', level: 'warn', text: '폴더를 먼저 여세요.' });
          const files = await listFiles(root, 4000);
          const testCmd = detectTestCommand(files, process.platform === 'win32');
          const target = (n: string) => `${HARNESS_DIR}/${n}.md`;
          if (!arg.trim()) {
            const hs = files.filter((f) => f.startsWith(HARNESS_DIR + '/') && f.endsWith('.md'));
            const lines: string[] = [];
            for (const f of hs) {
              const t = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...f.split('/')))).toString('utf8');
              const p = checklistProgress(t);
              lines.push(`- \`${f}\` ${p.done}/${p.total} 완료`);
            }
            const docs = files.filter((f) => /\.(md|markdown)$/i.test(f) && !f.startsWith('.yang/') && !/node_modules|CHANGELOG|LICENSE/i.test(f)).slice(0, 15);
            return this.post({ type: 'notice', level: 'info', text:
              `**하네스** (요구사항 md → 테스트 우선 구현, 테스트 명령: \`${testCmd || '감지 못함'}\`)\n\n` +
              (lines.length ? `진행 중인 하네스:\n${lines.join('\n')}\n\n` : '') +
              `사용법: \`/harness docs/기능명세.md\` · \`/harness .yang/harness/x.md\` (이어서) · \`/harness 요구사항 문장\`` +
              (docs.length ? `\n\n프로젝트의 md 문서:\n${docs.map((d) => `- \`${d}\``).join('\n')}` : '') });
          }
          const mdPath = arg.trim();
          if (/\.(md|markdown|txt)$/i.test(mdPath)) {
            const uri = vscode.Uri.joinPath(root, ...mdPath.replace(/^\.?\//, '').split('/'));
            const text = await vscode.workspace.fs.readFile(uri).then((b) => Buffer.from(b).toString('utf8'), () => null);
            if (text === null) return this.post({ type: 'notice', level: 'warn', text: `파일이 없습니다: ${mdPath}` });
            const own = mdPath.replace(/^\.?\//, '').startsWith(HARNESS_DIR + '/') || isChecklist(text);
            const tgt = own ? mdPath.replace(/^\.?\//, '') : target(harnessName(mdPath));
            const resume = own || files.includes(tgt);
            this.post({ type: 'notice', level: 'info', text: `하네스 시작: ${mdPath} → \`${tgt}\`${resume ? ' (이어서)' : ''} · 테스트 \`${testCmd || '감지 못함'}\`` });
            return this.session.send(harnessPrompt({ source: mdPath, text, target: tgt, testCmd, resume }), this.editorContext(extraEditor), atts, { harness: true });
          }
          const tgt = target(harnessName(mdPath.split(/\s+/).slice(0, 4).join('-')));
          return this.session.send(harnessFromRequestPrompt(mdPath, tgt, testCmd), this.editorContext(extraEditor), atts, { harness: true });
        }
        case '/arch': {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (!root) return this.post({ type: 'notice', level: 'warn', text: '폴더를 먼저 여세요.' });
          const project = remoteProjectName(root);
          if (arg.trim() === '분석') {
            this.post({ type: 'notice', level: 'info', text: '프로젝트를 올려 분석합니다: 코드·문서 임베딩 → 코딩 스타일 → 아키텍처 (1~3분).' });
            try {
              const r = await analyzeProject(root, this.log, (p) => this.log.line(`[분석] ${p}`, 'info'));
              if (r.architecture) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, '.yang', 'architecture.md'), Buffer.from(r.architecture, 'utf8')).then(undefined, () => undefined);
              return this.post({ type: 'notice', level: 'info', text: `${r.summary}\n\n${r.architecture || '(아키텍처 문서 없음)'}` });
            } catch (e: any) {
              return this.post({ type: 'notice', level: 'error', text: `분석 실패: ${e.message}` });
            }
          }
          if (arg.trim() === '저장') {
            const md = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.yang', 'architecture.md')).then((b) => Buffer.from(b).toString('utf8'), () => '');
            if (!md.trim()) return this.post({ type: 'notice', level: 'warn', text: '.yang/architecture.md 가 없습니다. 먼저 `/arch` 로 받으세요.' });
            await backend.put(`/api/arch/${encodeURIComponent(project)}`, { markdown: md });
            return this.post({ type: 'notice', level: 'info', text: '아키텍처 규칙을 저장했습니다. 다음 요청부터 적용됩니다.' });
          }
          const r: any = await backend.get(`/api/arch/${encodeURIComponent(project)}`).catch((e: any) => ({ error: e.message }));
          if (r.markdown) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.yang')).then(undefined, () => undefined);
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, '.yang', 'architecture.md'), Buffer.from(r.markdown, 'utf8')).then(undefined, () => undefined);
          }
          const status = r.status === 'analyzing' ? '\n\n(지금 다시 분석 중…)' : r.status === 'error' ? `\n\n(최근 분석 실패: ${r.error})` : '';
          return this.post({ type: 'notice', level: 'info', text: (r.markdown ?? '아직 아키텍처 분석이 없습니다. `/arch 분석` 으로 시작하세요.') + status +
            '\n\n(`/arch 분석` 다시 분석 · `.yang/architecture.md` 를 고친 뒤 `/arch 저장` 하면 내 규칙으로 덮어씀)' });
        }
        case '/reindex':
          if (isRemote()) {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!root) return;
            await ensureRemoteIndex(root, this.log, true);
            return this.post({ type: 'notice', level: 'info', text: '원격 서버에서 재색인을 시작했습니다.' });
          }
          if (!this.session.repoName) return this.post({ type: 'notice', level: 'warn', text: '연결된 레포가 없습니다. 먼저 아무 요청이나 보내면 자동 연결됩니다.' });
          await backend.post(`/api/repos/${this.session.repoName}/reindex`, {}, 600_000);
          return this.post({ type: 'notice', level: 'info', text: `${this.session.repoName} 재색인 완료` });
        default:
          return this.post({ type: 'notice', level: 'warn', text: `알 수 없는 명령: ${cmd} (/help)` });
      }
    }
    await this.session.send(text, this.editorContext(extraEditor), atts);
  }

  private async runWorkflowTask(text: string, mode: WorkflowMode, generate = false): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || this.session.running || this.workflowAbort) throw new Error('프로젝트가 없거나 다른 작업이 실행 중입니다');
    const ctrl = this.workflowAbort = new AbortController();
    this.post({ type: 'busy', busy: true });
    try {
      const task = generate ? await generateWorkflow(text, remoteProjectName(root), mode, ctrl.signal,
        (s) => this.post({ type: 'notice', level: 'info', text: s })) : text;
      if (ctrl.signal.aborted) throw new Error('중단됨');
      const files = mode === 'harness' ? await listFiles(root, 4000) : [];
      const prompt = mode === 'harness' ? harnessFromRequestPrompt(task, `${HARNESS_DIR}/workflow-${Date.now()}.md`, detectTestCommand(files, process.platform === 'win32')) : task;
      await this.session.send(prompt, this.editorContext(), [], { harness: mode === 'harness' });
      if (ctrl.signal.aborted) throw new Error('사용자가 중단했습니다');
    } catch (e: any) {
      this.post({ type: 'notice', level: 'error', text: `워크플로 오류: ${e.message}` });
      throw e;
    } finally { this.workflowAbort = undefined; this.post({ type: 'busy', busy: false }); }
  }

  // ---- 첨부 파일 (이미지 · PDF · MD) → 서버에서 분석 ---------------------------------
  private async pickFiles() {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: '첨부',
      title: 'Yang Coding: 파일 첨부 (이미지 · PDF · MD)',
      filters: { '이미지 · PDF · 문서': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'pdf', 'md', 'markdown', 'txt'], '모든 파일': ['*'] },
    });
    for (const uri of picked ?? []) await this.attachUri(uri);
  }

  private async attachUris(list: string[]) {
    for (const raw of list) {
      const uri = raw.startsWith('/') ? vscode.Uri.file(raw) : vscode.Uri.parse(raw);
      await this.attachUri(uri);
    }
  }

  private async attachUri(uri: vscode.Uri) {
    const name = path.basename(uri.path);
    const key = `h${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 25 * 1024 * 1024) throw new Error('25MB 를 넘는 파일은 첨부할 수 없습니다');
      const bytes = await vscode.workspace.fs.readFile(uri);
      await this.uploadAttachment(key, name, Buffer.from(bytes).toString('base64'));
    } catch (e: any) {
      this.post({ type: 'attachment', key, name, status: 'error', detail: e.message });
    }
  }

  /** 첨부를 서버에 올려 분석 (이미지는 비전 모델 · PDF 는 텍스트 추출 + 스캔 페이지 분석) */
  private async uploadAttachment(key: string, name: string, data: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    this.post({ type: 'attachment', key, name, status: 'uploading' });
    this.log.line(`[첨부] ${name} 업로드 · 분석 시작 (${Math.round((data.length * 3) / 4 / 1024).toLocaleString()}KB)`, 'info');
    const started = Date.now();
    try {
      const r: any = await backend.post('/api/attachments', { name, data, project: root ? path.basename(root.fsPath) : '' }, 900_000);
      const a: Attachment = r.attachment;
      this.attached.set(a.id, a);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const pages = a.kind === 'pdf' ? ` · ${a.pages}쪽${a.vision_pages ? ` (이미지 분석 ${a.vision_pages}쪽)` : ''}` : '';
      const detail = `${a.chars.toLocaleString()}자${pages} · ${secs}초${a.notes?.length ? '\n' + a.notes.join('\n') : ''}`;
      this.post({ type: 'attachment', key, name: a.name, status: 'ready', id: a.id, kind: a.kind, detail });
      this.log.line(`[첨부] ${a.name} 분석 완료 · ${detail.replace(/\n/g, ' · ')}`, 'result');
    } catch (e: any) {
      this.post({ type: 'attachment', key, name, status: 'error', detail: e.message });
      this.post({ type: 'notice', level: 'warn', text: `첨부 실패 (${name}): ${e.message}` });
      this.log.line(`[첨부] ${name} 실패: ${e.message}`, 'error');
    }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';">
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
