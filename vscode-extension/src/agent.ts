/** 채팅 에이전트 루프: 사용자 메시지 → (모델 스트리밍 → 도구 실행 → 결과 피드백) 반복 → 최종 답변. */
import * as vscode from 'vscode';
import { backend, ChatMessage, engine, isRemote } from './clients';
import { ensureRemoteIndex, remoteProjectName } from './remoteIndex';
import { describeCall, parseToolCalls, stripToolBlocks, TOOL_DOCS } from './protocol';
import { DEBUG_RULES } from './debugkit';
import { runCheck } from './debugRunner';
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

/** 서버가 분석한 첨부 파일 (이미지 · PDF · MD) */
export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'pdf' | 'text' | string;
  content: string;
  chars: number;
  pages?: number;
  vision_pages?: number;
  notes?: string[];
}

const ATT_PER_FILE = 12_000;  // 첨부 하나를 대화에 넣는 최대 글자 수
const ATT_TOTAL = 24_000;     // 한 요청의 첨부 합계 최대 글자 수 (나머지는 .yang/attachments 파일을 READ)
const ATT_DIR = '.yang/attachments';

/** 첨부 분석 결과를 프로젝트의 .yang/attachments/ 에 저장 (에이전트가 READ/GREP 로 전체를 볼 수 있게, git 에는 안 올라감) */
async function saveAttachments(root: vscode.Uri, atts: Attachment[]): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const dir = vscode.Uri.joinPath(root, ...ATT_DIR.split('/'));
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, '.yang', '.gitignore'), Buffer.from('*\n'));
    for (const a of atts) {
      const file = `${a.id}-${a.name.replace(/[^\w.가-힣-]/g, '_')}.md`;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, file), Buffer.from(a.content, 'utf8'));
      paths.set(a.id, `${ATT_DIR}/${file}`);
    }
  } catch { /* 저장 실패해도 대화에 넣은 내용으로 진행 */ }
  return paths;
}

function attachmentBlock(atts: Attachment[], paths: Map<string, string>): string {
  if (!atts.length) return '';
  let budget = ATT_TOTAL;
  const KIND: Record<string, string> = { image: '이미지 (비전 모델 분석 결과)', pdf: 'PDF', text: '문서' };
  const parts = atts.map((a) => {
    const limit = Math.max(1500, Math.min(ATT_PER_FILE, budget));
    const body = a.content.length > limit ? a.content.slice(0, limit) + `\n…(이하 ${(a.content.length - limit).toLocaleString()}자 생략)` : a.content;
    budget -= Math.min(a.content.length, limit);
    const where = paths.get(a.id);
    const full = where ? ` · 전체: ${where}${a.content.length > limit ? ' (READ 로 나머지 확인)' : ''}` : '';
    return `### 📎 ${a.name} — ${KIND[a.kind] ?? a.kind}${full}\n${body}`;
  });
  return `\n\n[첨부 파일 ${atts.length}개] 사용자가 첨부한 자료입니다. 요청을 처리할 때 이 내용을 근거로 사용하세요.` +
    ` 이미지는 비전 모델이 글로 풀어 쓴 것이므로 수치(색·간격)는 추정일 수 있습니다.\n\n${parts.join('\n\n')}`;
}

const READ_ONLY = new Set(['read', 'list', 'grep', 'search', 'check']);
const CONTEXT_CHAR_BUDGET = 45_000; // ~13k 토큰. 문맥이 길면 생성이 느려지고(1만→2만 토큰: 49→25 tok/s) 캐시를 놓칠 때 재계산이 길어진다
const COMPACT_TARGET = 0.6;          // 넘치면 예산의 60% 까지 한 번에 줄인다 (자주 조금씩 줄이면 엔진 KV 재사용이 깨짐)
const MAX_IMAGES_PER_STEP = 4;       // 한 응답에서 그림은 최대 4장 (장당 10~40초 → 몇 분씩 멈춘 것처럼 보이지 않게)

// 시스템 프롬프트는 대화 중 바뀌지 않는 내용만 담는다 → 엔진 KV 캐시 재사용으로 다음 요청이 빨라짐.
// 자주 바뀌는 에디터 상태·관련 코드는 사용자 메시지에 붙인다(editorBlock).
function systemPrompt(ctx: any, repoInfo: string, tree: string): string {
  return `당신은 "Yang Coding" — 사용자의 VS Code 안에서 동작하는 로컬 코딩 에이전트입니다 (Claude Code 와 유사). 이름을 물으면 Yang Coding 이라고 답한다.
사용자 PC 운영체제: ${process.platform === 'win32' ? 'Windows (RUN 은 PowerShell 로 실행됨: rm/mv 대신 DELETE/MOVE 도구, 경로 구분은 / 로 써도 됨)' : process.platform === 'darwin' ? 'macOS' : 'Linux'}
사용자의 자연어 요청을 이해해 코드를 읽고, 수정하고, 명령을 실행해 작업을 끝까지 완료합니다.

## 일하는 방식
- 추측하지 말고 먼저 READ/GREP/SEARCH 로 확인한 뒤 수정한다.
- 기존 코드의 스타일·구조·네이밍을 그대로 따른다. 아래 선호/제약은 반드시 지킨다.
- 파일을 고치면 [자동 검사] 결과(문법·타입·IDE 오류·리소스 경로)가 도구 결과에 붙는다. 오류가 있으면 먼저 고친다.
- 수정 후에는 RUN(테스트·빌드) 또는 PLAY(게임·앱 실행)로 실제 동작을 확인한다. 확인하지 못했으면 그 사실을 답변에 적는다.
- 사용자가 지정한 함수 이름·시그니처·동작은 절대 바꾸지 않는다 (예: total(prices) 를 total() 로 바꾸지 말 것).
- 테스트가 실패하면 테스트를 구현에 맞추지 말고, 요구사항에 맞게 구현을 고친다. 테스트 자체가 요구사항과
  모순될 때만 테스트를 고치고, 그 이유를 답변에 명시한다. 테스트를 약화시켜 통과시키는 것은 금지.
- 완료라고 말하기 전에 사용자 요청을 항목별로 다시 대조하고, 빠진 것이 있으면 계속 작업한다.
- 큰 기능(여러 파일, 명확한 요구사항)은 HARNESS 로 테스트 우선 구현을 수행해도 된다.
- 사용자가 "기억해", "앞으로는", "항상" 같은 말로 스타일/선호/제약을 알려주면 REMEMBER 로 저장한다.
- 사용자가 모델 다운로드/교체/엔진 관련 요청을 하면 MODEL 도구를 쓴다.
- 프로젝트에 필요한 그림(캐릭터·배경·아이콘·UI)은 인터넷에서 받지 말고 IMAGE 로 생성한다. prompt 는 영어로 쓴다. 생성한 경로를 코드에서 정확히 불러온다.
- 이미 있는 그림은 다시 만들지 않는다 (LIST 로 먼저 확인). 한 응답에 IMAGE 는 최대 4개, 꼭 필요한 그림만.
- IMAGE 에는 kind 를 꼭 쓰고, prompt 는 프로젝트 아트 컨셉·캐릭터 설명에 맞춰 무엇을 그릴지 구체적으로 쓴다.
- 답변은 사용자의 언어(기본 한국어)로 간결하게. 완료 후에는 무엇을 바꿨는지 1~3줄로 요약한다.
- 도구 결과를 기다려야 하면 그 응답에서는 도구 블록까지만 쓰고 멈춘다. 파일을 READ 하기 전에는 EDIT 하지 않는다.

${DEBUG_RULES}

${TOOL_DOCS}

## 레포
${repoInfo}

${ctx?.art ? `## 프로젝트 아트 컨셉 (그림을 만들 때 이 컨셉에 맞게 · IMAGE 에 자동 적용됨)\n${ctx.art}\n\n` : ''}## 사용자 선호 · 스타일 · 제약 (항상 준수)
${ctx?.preferences || '- (없음)'}

## 이 레포의 코딩 방법 (자동 추출)
${ctx?.methods || '(색인 전)'}

## 파일 목록 (일부)
${tree}`;
}

/** 작업 로그 콘솔 (VS Code: 출력 패널, IntelliJ: 하단 콘솔). */
export interface AgentLog {
  line(text: string, level?: 'info' | 'head' | 'tool' | 'result' | 'error'): void;
  raw(text: string): void; // 모델 토큰 스트림 (줄바꿈 없이 이어 붙임)
  show(): void; // 포커스를 뺏지 않고 콘솔 표시
}

const clock = () => new Date().toTimeString().slice(0, 8);
const indent = (s: string, max = 40) => {
  const lines = s.trim().split('\n');
  const shown = lines.slice(0, max).map((l) => '    ' + l).join('\n');
  return lines.length > max ? `${shown}\n    …(${lines.length - max}줄 더)` : shown;
};

function editorBlock(editor: EditorContext): string {
  return `(에디터 상태) 현재 파일: ${editor.file ?? '없음'} · 열린 파일: ${editor.openFiles.slice(0, 15).join(', ') || '없음'}` +
    (editor.selection ? `\n선택 영역 (${editor.selectionRange}):\n\`\`\`\n${editor.selection.slice(0, 4000)}\n\`\`\`` : '');
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
    private readonly log: AgentLog,
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
    this.log.line(`[승인 대기] ${title}`, 'info');
    const answer = await this.requestApproval(kind, title, detail);
    this.log.line(`[승인] ${{ allow: '허용', always: '항상 허용', deny: '거부' }[answer]}`, answer === 'deny' ? 'error' : 'info');
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
  /**
   * 대화 기록 압축: 예산을 넘었을 때만, 기록 자체를 예산의 60% 까지 한 번에 줄인다.
   * 매 단계 복사본을 조금씩 줄이면 앞부분이 계속 바뀌어 엔진의 프리픽스(KV) 재사용이 깨지고
   * 단계마다 2만 토큰을 다시 계산하게 된다 (20~50초씩 멈춘 것처럼 보임).
   */
  private compactHistory(systemLen: number): boolean {
    const size = () => systemLen + this.history.reduce((n, m) => n + m.content.length, 0);
    if (size() <= CONTEXT_CHAR_BUDGET) return false;
    const target = CONTEXT_CHAR_BUDGET * COMPACT_TARGET;
    for (let i = 0; i < this.history.length - 2 && size() > target; i++) {
      const m = this.history[i];
      if (m.role === 'user' && m.content.startsWith('[도구 결과]') && m.content.length > 600) {
        this.history[i] = { ...m, content: m.content.slice(0, 500) + '\n…(이전 도구 결과 생략: 필요하면 다시 READ)' };
      } else if (m.role === 'assistant' && m.content.length > 1500) {
        this.history[i] = { ...m, content: stripToolBlocks(m.content).slice(0, 800) + '\n(이전 응답의 코드 블록 생략)' };
      }
    }
    while (size() > target && this.history.length > 2) this.history.splice(0, 1);
    return true;
  }

  async send(userText: string, editor: EditorContext, attachments: Attachment[] = [], opts: { debug?: boolean } = {}): Promise<void> {
    if (this.running) return;
    const root = this.root();
    const abort = (this.abort = new AbortController());
    const checkpoint = (this.lastCheckpoint = new Checkpoint());
    this.emit({ type: 'busy', busy: true });
    const started = Date.now();
    let steps = 0;
    let outcome = '완료';
    this.log.show();
    this.log.line(`━━━━━━━━ [${clock()}] 요청 ━━━━━━━━`, 'head');
    this.log.line(userText.length > 500 ? userText.slice(0, 500) + '…' : userText, 'info');

    try {
      if (!root) {
        this.emit({ type: 'notice', level: 'warn', text: '폴더(워크스페이스)를 먼저 열어주세요.' });
        return;
      }
      if (!(await engine.health())) {
        this.log.line('[엔진] 꺼져 있음 → 설정 요청만 처리', 'info');
        await this.handleOffline(userText);
        return;
      }

      let ctx: any = null;
      try {
        if (isRemote()) {
          // 원격: 이 PC 의 파일을 서버로 올려 벡터화(처음/6시간마다) 후 프로젝트 이름으로 컨텍스트 조회
          await ensureRemoteIndex(root, this.log).catch((e) => this.log.line(`[원격 색인] 실패: ${e.message}`, 'error'));
          ctx = await backend.post('/api/context', { query: userText, project: remoteProjectName(root), attachment_project: remoteProjectName(root), top_k: 6 }, 60_000);
        } else {
          ctx = await backend.post('/api/context', { query: userText, workspace_path: root.fsPath, attachment_project: remoteProjectName(root), top_k: 6 }, 600_000);
        }
        this.repoName = ctx.repo?.name ?? '';
      } catch (e: any) {
        this.emit({ type: 'notice', level: 'warn', text: `백엔드 컨텍스트를 가져오지 못했습니다 (선호/벡터 검색 없이 진행): ${e.message}` });
        this.log.line(`[컨텍스트] 실패: ${e.message}`, 'error');
      }
      const repoInfo = ctx?.repo
        ? `${ctx.repo.name} · ${ctx.repo.profile} · ${ctx.repo.language} · ${root.fsPath}`
        : `${root.fsPath} (미연결)`;
      const related = (ctx?.hits ?? []).slice(0, 4).map((h: any) => `--- ${h.source} ---\n${h.content}`).join('\n');

      // 이번에 첨부한 파일은 내용을 직접 넣고, 예전에 올린 첨부는 질문과 관련된 부분만 (벡터 검색)
      const attPaths = await saveAttachments(root, attachments);
      const thisTurn = new Set(attachments.map((a) => a.id));
      const pastAtts = (ctx?.attachments ?? []).filter((h: any) => !thisTurn.has(h.attachment_id)).slice(0, 2)
        .map((h: any) => `--- 📎 ${h.source} ---\n${h.content}`).join('\n');
      if (attachments.length) {
        this.log.line(`[첨부] ${attachments.map((a) => `${a.name}(${a.chars.toLocaleString()}자)`).join(', ')} → 대화에 포함 · 전체는 ${ATT_DIR}/`, 'info');
      }
      this.history.push({
        role: 'user',
        content: `${userText}\n\n${editorBlock(editor)}` + attachmentBlock(attachments, attPaths) +
          (pastAtts ? `\n\n(참고: 이전에 첨부한 자료 중 관련 부분)\n${pastAtts}` : '') +
          (related ? `\n\n(참고: 벡터 검색으로 찾은 관련 코드)\n${related}` : ''),
      });
      // 같은 대화에서 시스템 프롬프트가 그대로면 엔진이 앞부분을 재사용한다
      const system = systemPrompt(ctx, repoInfo, await this.fileTree(root));
      const prefCount = (ctx?.preferences ?? '').split('\n').filter(Boolean).length;
      this.log.line(`[컨텍스트] 레포 ${repoInfo}`, 'info');
      this.log.line(`[컨텍스트] 선호·제약 ${prefCount}개 · 코딩 방법 ${ctx?.methods ? '있음' : '없음'} · 관련 코드 ${(ctx?.hits ?? []).map((h: any) => h.source).join(', ') || '없음'}`, 'info');
      this.log.line(`[컨텍스트] 현재 파일 ${editor.file ?? '-'}${editor.selectionRange ? ` · 선택 ${editor.selectionRange}` : ''} · 시스템 프롬프트 ${system.length.toLocaleString()}자`, 'info');
      let lastDetail = '';
      const host: ToolHost = {
        root, repoName: this.repoName, signal: abort.signal, checkpoint,
        approve: (k, t, d) => this.approve(k, t, d),
        emit: (ev) => {
          // 하네스 등 오래 걸리는 도구의 진행 상황을 콘솔에도 표시
          if (ev.type === 'tool' && ev.status === 'running' && ev.detail && ev.detail !== lastDetail) {
            lastDetail = ev.detail;
            this.log.line(`    … ${ev.detail.split('\n')[0]}`, 'result');
          }
          this.emit(ev);
        },
      };
      const cfg = vscode.workspace.getConfiguration('localAgent');
      // 디버그 모드는 재현 → 계측 → 수정 → 재검증으로 단계가 많아 두 배까지 허용
      const maxSteps = opts.debug ? Math.max(24, cfg.get<number>('maxSteps', 16) * 2) : cfg.get<number>('maxSteps', 16);
      const autoCheck = cfg.get<boolean>('autoCheck', true);
      const verify = cfg.get<boolean>('verifyBeforeFinish', false); // 기본 끔: 매 턴 모델 호출이 한 번 더 늘어 느려짐 (/debug 에서는 항상 켬)
      // 완료 관문 상태: 남은 오류 · 실행 확인 여부 · 같은 독촉을 반복하지 않기 위한 횟수
      const gate = { errors: 0, errorText: '', ran: false, codeChanged: false, nudges: { errors: 0, markers: 0, verify: 0 } };

      for (let step = 0; step < maxSteps && !abort.signal.aborted; step++) {
        steps = step + 1;
        const id = `a${Date.now()}`;
        this.emit({ type: 'assistant-start', id });
        let raw = '';
        let lastShown = '';
        if (this.compactHistory(system.length)) this.log.line(`[대화 압축] 기록이 길어 오래된 도구 결과·코드를 줄였습니다 (이번 단계만 전체 다시 계산)`, 'info');
        const messages: ChatMessage[] = [{ role: 'system', content: system }, ...this.history];
        const stepStart = Date.now();
        const chars = messages.reduce((n, m) => n + m.content.length, 0);
        this.log.line(`[모델 #${steps}] 생성 시작 · 메시지 ${messages.length}개 · ${chars.toLocaleString()}자`, 'head');
        const { text, stats } = await engine.stream(
          messages,
          { maxTokens: cfg.get<number>('maxTokens', 4096), temperature: cfg.get<number>('temperature', 0.2), signal: abort.signal },
          (tok) => {
            raw += tok;
            this.log.raw(tok);
            const shown = stripToolBlocks(raw);
            if (shown !== lastShown) {
              lastShown = shown;
              this.emit({ type: 'assistant-delta', id, text: shown });
            }
          },
        );
        this.emit({ type: 'assistant-end', id, stats: stats ? `${stats.completion_tokens} tok · ${stats.tokens_per_second.toFixed(1)} tok/s` : undefined });
        this.history.push({ role: 'assistant', content: text });
        this.log.raw('\n');
        this.log.line(`[모델 #${steps}] 완료 · ${stats?.completion_tokens ?? '?'} tok · ${stats?.tokens_per_second.toFixed(1) ?? '?'} tok/s · ${((Date.now() - stepStart) / 1000).toFixed(1)}s${stats?.finish_reason === 'length' ? ' · ⚠ 최대 토큰 도달' : ''}`, 'head');

        let calls = parseToolCalls(text);
        if (calls.length === 0) {
          const nudge = step < maxSteps - 1 ? await this.finishGate(root, checkpoint, gate, verify, !!opts.debug) : '';
          if (nudge) {
            this.log.line(`[완료 관문] ${nudge.split('\n')[0]}`, 'info');
            this.history.push({ role: 'user', content: nudge });
            continue;
          }
          this.log.line('[턴 종료] 도구 호출 없음 → 최종 답변', 'info');
          break;
        }
        // 결과를 보기 전에 수정·실행까지 몰아서 호출하는 것을 막는다:
        // 앞쪽에 조회 도구가 있으면 조회만 실행하고, 나머지는 결과를 본 뒤 다시 요청하게 한다.
        // 그림은 한 응답에 최대 MAX_IMAGES_PER_STEP 장: 나머지는 결과를 보고 다음 단계에서
        const imgIdx = calls.map((c, i) => (c.kind === 'image' ? i : -1)).filter((i) => i >= 0);
        const imgDeferred = imgIdx.length > MAX_IMAGES_PER_STEP ? imgIdx.length - MAX_IMAGES_PER_STEP : 0;
        if (imgDeferred) {
          const drop = new Set(imgIdx.slice(MAX_IMAGES_PER_STEP));
          calls = calls.filter((_, i) => !drop.has(i));
        }
        const firstAction = calls.findIndex((c) => !READ_ONLY.has(c.kind));
        const deferred = firstAction > 0 ? calls.length - firstAction : 0;
        if (deferred) calls = calls.slice(0, firstAction);
        this.log.line(`[도구 계획] ${calls.map(describeCall).join(' | ')}${deferred ? `  (+수정/실행 ${deferred}개 보류: 조회 결과 확인 후 재요청)` : ''}`, 'tool');
        const results: string[] = [];
        for (const call of calls) {
          if (abort.signal.aborted) break;
          const t0 = Date.now();
          this.log.line(`▶ ${describeCall(call)}`, 'tool');
          lastDetail = '';
          const result = await executeTool(call, host, this.diffProvider);
          results.push(result);
          const failed = /오류\]|실패|거부|exit code [1-9]/.test(result.split('\n')[0]);
          this.log.line(`${indent(result, call.kind === 'read' ? 3 : 40)}\n    (${((Date.now() - t0) / 1000).toFixed(1)}s)`, failed ? 'error' : 'result');
        }
        if (deferred) {
          results.push(`(주의: 같은 응답의 수정/실행 도구 ${deferred}개는 실행하지 않았습니다. 위 조회 결과를 확인한 뒤 필요한 수정만 다시 요청하세요.)`);
        }
        if (imgDeferred) {
          results.push(`(주의: 그림은 한 번에 최대 ${MAX_IMAGES_PER_STEP}장만 만듭니다. 남은 IMAGE ${imgDeferred}개는 실행하지 않았습니다. 필요한 것만 다음 응답에서 다시 요청하세요.)`);
        }
        // 실행으로 확인했는지 · CHECK 결과 기록
        calls.forEach((c, i) => {
          if (c.kind === 'run' || c.kind === 'play' || c.kind === 'harness') gate.ran = true;
          if (c.kind === 'check') {
            gate.errors = Number(/오류 (\d+)개/.exec(results[i] ?? '')?.[1] ?? 0);
            gate.errorText = gate.errors ? results[i] : '';
          }
        });
        // 수정 직후 자동 검사: 문법·타입·IDE 오류·리소스 경로를 바로 돌려줘 다음 단계에서 고치게 한다
        const changed = [...new Set(calls.filter((c) => c.kind === 'write' || c.kind === 'edit').map((c) => (c as any).path as string))];
        if (changed.length) {
          gate.codeChanged ||= changed.some((f) => /\.(py|m?jsx?|cjs|tsx?|dart|gd|cs|html?|kt|java|rs|go|lua|vue|svelte)$/i.test(f));
          if (autoCheck && !abort.signal.aborted) {
            const t0 = Date.now();
            const rep = await runCheck(root, changed).catch((e) => ({ errors: 0, warnings: 0, problems: [], text: `[자동 검사] 실패: ${e.message}` }));
            gate.errors = rep.errors;
            gate.errorText = rep.errors ? rep.text : '';
            results.push(rep.text);
            this.log.line(`${indent(rep.text, 30)}\n    (${((Date.now() - t0) / 1000).toFixed(1)}s)`, rep.errors ? 'error' : 'result');
            if (rep.errors || rep.warnings) this.emit({ type: 'tool', id: `chk${Date.now()}`, title: `자동 검사: 오류 ${rep.errors} · 경고 ${rep.warnings}`, status: rep.errors ? 'error' : 'done', detail: rep.text.slice(0, 3000) });
          }
        }
        this.history.push({ role: 'user', content: `[도구 결과]\n${results.join('\n\n')}` });
        if (step === maxSteps - 1) {
          this.emit({ type: 'notice', level: 'warn', text: `최대 단계(${maxSteps})에 도달해 멈췄습니다. "계속"이라고 입력하면 이어서 진행합니다.` });
        }
      }
    } catch (e: any) {
      if (abort.signal.aborted) {
        outcome = '중단';
        this.emit({ type: 'notice', level: 'info', text: '중단했습니다.' });
      } else {
        outcome = '오류';
        this.log.line(`[오류] ${e?.stack ?? e}`, 'error');
        this.emit({ type: 'notice', level: 'error', text: e?.message ?? String(e) });
      }
    } finally {
      if (abort.signal.aborted) outcome = '중단';
      this.log.line(`━━━━━━━━ ${outcome} · ${steps}단계 · 변경 파일 ${checkpoint.originals.size}개 · ${((Date.now() - started) / 1000).toFixed(1)}s ━━━━━━━━\n`, outcome === '오류' ? 'error' : 'head');
      this.abort = undefined;
      this.emit({ type: 'turn-end', changedFiles: checkpoint.originals.size });
      this.emit({ type: 'busy', busy: false });
    }
  }

  /**
   * 완료 관문: 모델이 끝내려 할 때 남은 오류·임시 로그·미검증을 확인해 한 번 더 일하게 한다.
   * 같은 독촉은 정해진 횟수까지만 (무한 반복 방지). 돌려줄 말이 없으면 '' → 정상 종료.
   */
  private async finishGate(root: vscode.Uri, checkpoint: Checkpoint, gate: { errors: number; errorText: string; ran: boolean; codeChanged: boolean;
    nudges: { errors: number; markers: number; verify: number } }, verify: boolean, debug: boolean): Promise<string> {
    if (gate.errors > 0 && gate.nudges.errors < 2) {
      gate.nudges.errors++;
      return `[완료 관문] 아직 오류 ${gate.errors}개가 남아 있습니다. 고친 뒤 끝내세요. 고칠 수 없거나 의도된 것이면 이유를 설명하고 끝내세요.\n\n${gate.errorText.slice(0, 3000)}`;
    }
    if (gate.nudges.markers < 1) {
      const left: string[] = [];
      for (const fsPath of checkpoint.originals.keys()) {
        try {
          const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString('utf8');
          text.split('\n').forEach((l, i) => { if (l.includes('YANG-DEBUG')) left.push(`${vscode.workspace.asRelativePath(fsPath)}:${i + 1}: ${l.trim()}`); });
        } catch { /* 삭제된 파일 */ }
      }
      if (left.length) {
        gate.nudges.markers++;
        return `[완료 관문] 임시 디버그 로그(YANG-DEBUG)가 남아 있습니다. 모두 지운 뒤 끝내세요:\n${left.slice(0, 15).join('\n')}`;
      }
    }
    if ((verify || debug) && gate.codeChanged && !gate.ran && gate.nudges.verify < 1) {
      gate.nudges.verify++;
      return '[완료 관문] 코드를 바꿨지만 실행으로 확인하지 않았습니다. 테스트가 있으면 RUN, 게임·앱이면 PLAY 로 실제 동작을 확인하세요. ' +
        '실행할 수 없는 상황이면(필요한 도구·기기 없음 등) 그 이유를 한 줄로 말하고 끝내세요.';
    }
    return '';
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
    if (isRemote()) {
      say((await backend.alive())
        ? '원격 서버(맥)의 코딩 엔진이 꺼져 있습니다. 서버에서 `local-agent start` 를 실행하거나 서버 모드(`scripts/server-mode.sh on`)를 켜 두세요.'
        : '원격 서버에 연결할 수 없습니다. 명령 팔레트의 **Yang Coding: 원격 접속 설정**에서 주소와 토큰을 확인하세요.');
      return;
    }
    if (!(await backend.alive())) {
      say('백엔드(FastAPI)가 꺼져 있습니다. 명령 팔레트에서 **Yang Coding: 백엔드 시작**을 실행하거나 설정에서 `localAgent.agentRoot` 를 지정하세요.');
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
