/** 채팅 에이전트 루프: 사용자 메시지 → (모델 스트리밍 → 도구 실행 → 결과 피드백) 반복 → 최종 답변. */
import * as vscode from 'vscode';
import { backend, ChatMessage, engine } from './clients';
import { parseToolCalls, stripToolBlocks, TOOL_DOCS } from './protocol';
import { Checkpoint, executeTool, OriginalContentProvider, ToolHost, UiEvent } from './tools';

export type AgentEvent =
  | UiEvent
  | { type: 'assistant-start'; id: string }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'assistant-end'; id: string; stats?: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'turn-end'; changedFiles: number };

export interface EditorContext {
  file?: string;
  selection?: string;
  selectionRange?: string;
  openFiles: string[];
}

const READ_ONLY = new Set(['read', 'list', 'grep', 'search']);
const CONTEXT_CHAR_BUDGET = 70_000; // 32k 토큰 컨텍스트 중 응답 여유를 남긴 대략치

function systemPrompt(ctx: any, repoInfo: string, editor: EditorContext, tree: string): string {
  return `당신은 사용자의 VS Code 안에서 동작하는 로컬 코딩 에이전트입니다 (Claude Code 와 유사).
사용자의 자연어 요청을 이해해 코드를 읽고, 수정하고, 명령을 실행해 작업을 끝까지 완료합니다.

## 일하는 방식
- 추측하지 말고 먼저 READ/GREP/SEARCH 로 확인한 뒤 수정한다.
- 기존 코드의 스타일·구조·네이밍을 그대로 따른다. 아래 선호/제약은 반드시 지킨다.
- 수정 후에는 가능하면 RUN 으로 테스트/빌드를 실행해 검증한다.
- 사용자가 지정한 함수 이름·시그니처·동작은 절대 바꾸지 않는다 (예: total(prices) 를 total() 로 바꾸지 말 것).
- 테스트가 실패하면 테스트를 구현에 맞추지 말고, 요구사항에 맞게 구현을 고친다. 테스트 자체가 요구사항과
  모순될 때만 테스트를 고치고, 그 이유를 답변에 명시한다. 테스트를 약화시켜 통과시키는 것은 금지.
- 완료라고 말하기 전에 사용자 요청을 항목별로 다시 대조하고, 빠진 것이 있으면 계속 작업한다.
- 큰 기능(여러 파일, 명확한 요구사항)은 HARNESS 로 테스트 우선 구현을 수행해도 된다.
- 사용자가 "기억해", "앞으로는", "항상" 같은 말로 스타일/선호/제약을 알려주면 REMEMBER 로 저장한다.
- 사용자가 모델 다운로드/교체/엔진 관련 요청을 하면 MODEL 도구를 쓴다.
- 답변은 사용자의 언어(기본 한국어)로 간결하게. 완료 후에는 무엇을 바꿨는지 1~3줄로 요약한다.
- 도구 결과를 기다려야 하면 그 응답에서는 도구 블록까지만 쓰고 멈춘다. 파일을 READ 하기 전에는 EDIT 하지 않는다.

${TOOL_DOCS}

## 레포
${repoInfo}

## 사용자 선호 · 스타일 · 제약 (항상 준수)
${ctx?.preferences || '- (없음)'}

## 이 레포의 코딩 방법 (자동 추출)
${ctx?.methods || '(색인 전)'}

## 에디터 상태
현재 파일: ${editor.file ?? '(없음)'}
열린 파일: ${editor.openFiles.slice(0, 15).join(', ') || '(없음)'}
${editor.selection ? `선택 영역 (${editor.selectionRange}):\n\`\`\`\n${editor.selection.slice(0, 4000)}\n\`\`\`` : ''}

## 파일 목록 (일부)
${tree}`;
}

export class AgentSession {
  private history: ChatMessage[] = [];
  private abort?: AbortController;
  private approvalsAlways = new Set<'edit' | 'run'>();
  lastCheckpoint?: Checkpoint;
  repoName = '';

  constructor(
    private readonly emit: (ev: AgentEvent) => void,
    private readonly requestApproval: (kind: 'edit' | 'run', title: string, detail: string) => Promise<'allow' | 'always' | 'deny'>,
    private readonly diffProvider: OriginalContentProvider,
  ) {}

  get running() {
    return !!this.abort;
  }

  reset() {
    this.stop();
    this.history = [];
    this.approvalsAlways.clear();
  }

  stop() {
    this.abort?.abort();
  }

  private root(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private async approve(kind: 'edit' | 'run', title: string, detail: string): Promise<boolean> {
    const setting = vscode.workspace.getConfiguration('localAgent').get<string>(kind === 'edit' ? 'approveEdits' : 'approveCommands');
    if (setting === 'auto' || this.approvalsAlways.has(kind)) return true;
    const answer = await this.requestApproval(kind, title, detail);
    if (answer === 'always') this.approvalsAlways.add(kind);
    return answer !== 'deny';
  }

  private async fileTree(root: vscode.Uri): Promise<string> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*'),
      '**/{node_modules,.git,dist,build,target,.venv,venv,__pycache__,.next,Pods,.dart_tool,.gradle,models,out}/**',
      250,
    );
    const rel = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
    return rel.join('\n') + (rel.length >= 250 ? '\n…(더 있음: LIST 로 확인)' : '');
  }

  /** 오래된 도구 결과부터 요약해 컨텍스트 예산 안으로 줄인다. */
  private compact(messages: ChatMessage[]): ChatMessage[] {
    const size = () => messages.reduce((n, m) => n + m.content.length, 0);
    for (let i = 1; i < messages.length - 2 && size() > CONTEXT_CHAR_BUDGET; i++) {
      const m = messages[i];
      if (m.role === 'user' && m.content.startsWith('[도구 결과]') && m.content.length > 600) {
        messages[i] = { ...m, content: m.content.slice(0, 500) + '\n…(이전 도구 결과 생략: 필요하면 다시 READ)' };
      } else if (m.role === 'assistant' && m.content.length > 1500) {
        messages[i] = { ...m, content: stripToolBlocks(m.content).slice(0, 800) + '\n(이전 응답의 코드 블록 생략)' };
      }
    }
    while (size() > CONTEXT_CHAR_BUDGET && messages.length > 3) messages.splice(1, 1);
    return messages;
  }

  async send(userText: string, editor: EditorContext): Promise<void> {
    if (this.running) return;
    const root = this.root();
    const abort = (this.abort = new AbortController());
    const checkpoint = (this.lastCheckpoint = new Checkpoint());
    this.emit({ type: 'busy', busy: true });

    try {
      if (!root) {
        this.emit({ type: 'notice', level: 'warn', text: '폴더(워크스페이스)를 먼저 열어주세요.' });
        return;
      }
      if (!(await engine.health())) {
        await this.handleOffline(userText);
        return;
      }

      let ctx: any = null;
      try {
        ctx = await backend.post('/api/context', { query: userText, workspace_path: root.fsPath, top_k: 6 }, 600_000);
        this.repoName = ctx.repo?.name ?? '';
      } catch (e: any) {
        this.emit({ type: 'notice', level: 'warn', text: `백엔드 컨텍스트를 가져오지 못했습니다 (선호/벡터 검색 없이 진행): ${e.message}` });
      }
      const repoInfo = ctx?.repo
        ? `${ctx.repo.name} · ${ctx.repo.profile} · ${ctx.repo.language} · ${root.fsPath}`
        : `${root.fsPath} (미연결)`;
      const related = (ctx?.hits ?? []).slice(0, 4).map((h: any) => `--- ${h.source} ---\n${h.content}`).join('\n');

      this.history.push({ role: 'user', content: related ? `${userText}\n\n(참고: 벡터 검색으로 찾은 관련 코드)\n${related}` : userText });
      const system = systemPrompt(ctx, repoInfo, editor, await this.fileTree(root));
      const host: ToolHost = {
        root, repoName: this.repoName, signal: abort.signal, checkpoint,
        approve: (k, t, d) => this.approve(k, t, d),
        emit: (ev) => this.emit(ev),
      };
      const cfg = vscode.workspace.getConfiguration('localAgent');
      const maxSteps = cfg.get<number>('maxSteps', 16);

      for (let step = 0; step < maxSteps && !abort.signal.aborted; step++) {
        const id = `a${Date.now()}`;
        this.emit({ type: 'assistant-start', id });
        let raw = '';
        let lastShown = '';
        const messages = this.compact([{ role: 'system', content: system }, ...this.history]);
        const { text, stats } = await engine.stream(
          messages,
          { maxTokens: cfg.get<number>('maxTokens', 4096), temperature: cfg.get<number>('temperature', 0.2), signal: abort.signal },
          (tok) => {
            raw += tok;
            const shown = stripToolBlocks(raw);
            if (shown !== lastShown) {
              lastShown = shown;
              this.emit({ type: 'assistant-delta', id, text: shown });
            }
          },
        );
        this.emit({ type: 'assistant-end', id, stats: stats ? `${stats.completion_tokens} tok · ${stats.tokens_per_second.toFixed(1)} tok/s` : undefined });
        this.history.push({ role: 'assistant', content: text });

        let calls = parseToolCalls(text);
        if (calls.length === 0) break;
        // 결과를 보기 전에 수정·실행까지 몰아서 호출하는 것을 막는다:
        // 앞쪽에 조회 도구가 있으면 조회만 실행하고, 나머지는 결과를 본 뒤 다시 요청하게 한다.
        const firstAction = calls.findIndex((c) => !READ_ONLY.has(c.kind));
        const deferred = firstAction > 0 ? calls.length - firstAction : 0;
        if (deferred) calls = calls.slice(0, firstAction);
        const results: string[] = [];
        for (const call of calls) {
          if (abort.signal.aborted) break;
          results.push(await executeTool(call, host, this.diffProvider));
        }
        if (deferred) {
          results.push(`(주의: 같은 응답의 수정/실행 도구 ${deferred}개는 실행하지 않았습니다. 위 조회 결과를 확인한 뒤 필요한 수정만 다시 요청하세요.)`);
        }
        this.history.push({ role: 'user', content: `[도구 결과]\n${results.join('\n\n')}` });
        if (step === maxSteps - 1) {
          this.emit({ type: 'notice', level: 'warn', text: `최대 단계(${maxSteps})에 도달해 멈췄습니다. "계속"이라고 입력하면 이어서 진행합니다.` });
        }
      }
    } catch (e: any) {
      if (abort.signal.aborted) {
        this.emit({ type: 'notice', level: 'info', text: '중단했습니다.' });
      } else {
        this.emit({ type: 'notice', level: 'error', text: e?.message ?? String(e) });
      }
    } finally {
      this.abort = undefined;
      this.emit({ type: 'turn-end', changedFiles: checkpoint.originals.size });
      this.emit({ type: 'busy', busy: false });
    }
  }

  /** 엔진이 꺼져 있을 때: 모델 다운로드/시작 같은 설정 요청은 규칙 기반으로 처리한다. */
  private async handleOffline(text: string) {
    const t = text.toLowerCase();
    const host: ToolHost = {
      root: this.root()!, repoName: this.repoName, signal: this.abort!.signal, checkpoint: new Checkpoint(),
      approve: async () => true, emit: (ev) => this.emit(ev),
    };
    const key = /30b|qwen3/.test(t) ? 'qwen3-coder-30b' : /14b/.test(t) ? 'qwen2.5-coder-14b' : /7b/.test(t) ? 'qwen2.5-coder-7b' : '';
    const say = (s: string) => {
      const id = `a${Date.now()}`;
      this.emit({ type: 'assistant-start', id });
      this.emit({ type: 'assistant-delta', id, text: s });
      this.emit({ type: 'assistant-end', id });
    };
    if (!(await backend.alive())) {
      say('백엔드(FastAPI)가 꺼져 있습니다. 명령 팔레트에서 **Local Agent: 백엔드 시작**을 실행하거나 설정에서 `localAgent.agentRoot` 를 지정하세요.');
      return;
    }
    if (/(다운|받아|설치|download|install)/.test(t)) {
      await executeTool({ kind: 'model', action: 'download', arg: key || 'qwen3-coder-30b' }, host, this.diffProvider);
      say('다운로드를 시작했습니다. 위 설정 카드에서 진행률을 볼 수 있고, 끝나면 "엔진 시작해줘"라고 말해주세요.');
    } else if (/(시작|켜|실행|로드|start|run|load)/.test(t)) {
      const res = await executeTool({ kind: 'model', action: 'start', arg: key }, host, this.diffProvider);
      say(res.includes('오류') ? res : '엔진이 준비되었습니다. 이제 무엇을 만들지 말씀해 주세요.');
    } else if (/(상태|목록|status|list|모델)/.test(t)) {
      say(await executeTool({ kind: 'model', action: 'status', arg: '' }, host, this.diffProvider));
    } else {
      say('로컬 모델 엔진이 꺼져 있어 아직 코딩할 수 없습니다.\n- "30B 모델 다운로드해줘" → 권장 모델(18.6GB) 받기\n- "엔진 시작해줘" → 받아둔 모델로 엔진 실행\n- "모델 상태 알려줘"');
    }
  }
}
