import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { backend } from './clients';
import { WorkflowMode, workflowTask } from './workflow';

export async function generateWorkflow(goal: string, project: string, mode: WorkflowMode, signal: AbortSignal, notice: (s: string) => void): Promise<string> {
  const run = await backend.post('/api/langchain/runs', { goal, project, mode, review: true, retrieval: !!project });
  notice('서버에서 LangChain으로 요구사항을 구성합니다…');
  const deadline = Date.now() + 1800_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('중단됨 (서버의 명세 생성은 계속될 수 있습니다)');
    const job = await backend.get(`/api/langchain/runs/${run.id}`);
    if (job.status === 'error') throw new Error(job.error);
    if (job.status === 'done') {
      for (const warning of job.result.warnings ?? []) notice(warning);
      return workflowTask(goal, job.result.output);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('LangChain 응답 대기 시간이 초과되었습니다');
}

/** Session-scoped identity prevents another open project from claiming this IDE's task. */
export class RemoteInbox {
  private readonly id = randomBytes(16).toString('hex');
  private readonly key = randomBytes(32).toString('hex');
  private receiving = false;
  private active?: { id: string; lease_token: string; abort: AbortController; executing: boolean; stopRequested: boolean; lastResponse: number; report?: { status: string; detail: string } };
  private disposed = false;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly host: {
    target: () => { project: string; workspace: string } | undefined;
    busy: () => boolean;
    run: (text: string, mode: WorkflowMode) => Promise<void>;
    approve: (text: string, signal: AbortSignal) => Promise<boolean>;
    cancel: () => void;
    notice: (text: string) => void;
  }) {
    this.timer = setInterval(() => void this.tick(), 10_000);
    void this.tick();
  }
  dispose() { this.disposed = true; clearInterval(this.timer); if (this.active) this.requestStop(); }
  private requestStop() {
    if (this.active && !this.active.report && !this.active.stopRequested) {
      this.active.stopRequested = true;
      this.active.abort.abort();
      if (this.active.executing) this.host.cancel();
      this.host.notice('원격 작업을 중단합니다. 연결 복구 후에도 자동 재실행하지 않습니다.');
    }
  }
  private async maintainActive() {
    const active = this.active;
    if (!active) return;
    const path = `/api/remote/work/tasks/${active.id}`;
    const credentials = { key: this.key, lease_token: active.lease_token };
    try {
      const state = await backend.post(`${path}/heartbeat`, credentials, 5000);
      if (this.active !== active) return;
      active.lastResponse = Date.now();
      if (state.should_stop) this.requestStop();
      if (active.report) {
        const report = state.should_stop && !['completed', 'failed', 'rejected', 'cancelled'].includes(state.status)
          ? { status: 'cancelled', detail: '이전 실행 루틴의 종료를 확인했습니다. 현재 파일 상태를 확인한 뒤 명시적으로 재개하세요.' } : active.report;
        await backend.post(path, { ...credentials, ...report }, 5000);
        if (this.active === active) this.active = undefined;
      }
    } catch (e: any) {
      if (this.active !== active) return;
      if ([403, 404, 409].includes(e.status) || Date.now() - active.lastResponse >= 60_000) this.requestStop();
      if (active.report && [403, 404, 409].includes(e.status) && this.active === active) {
        this.active = undefined;
        this.host.notice('이전 실행의 결과 보고를 종료했습니다. 서버 작업 상태를 확인하세요.');
      }
    }
  }
  private async tick() {
    const target = this.host.target();
    if (this.disposed) return;
    if (!target) { this.requestStop(); await this.maintainActive(); return; }
    try {
      await backend.post('/api/remote/work/agents', { id: this.id, key: this.key, ...target, label: `VS Code · ${hostname()}`, protocol_version: 2 }, 5000);
    } catch { /* Still renew or stop the active execution when registration fails. */ }
    await this.maintainActive();
    try {
      if (this.receiving || this.active || this.host.busy() || this.disposed) return;
      this.receiving = true;
      try {
        const { task } = await backend.post(`/api/remote/work/agents/${this.id}/claim`, { key: this.key }, 5000);
        if (!task) return;
        const active: NonNullable<RemoteInbox['active']> = this.active = { id: task.id, lease_token: task.lease_token, abort: new AbortController(), executing: false, stopRequested: false, lastResponse: Date.now(), report: undefined as { status: string; detail: string } | undefined };
        const report = (status: string, detail: string) => { active.report = { status, detail: detail.slice(0, 2000) }; };
        try {
          if (this.disposed || this.host.target()?.workspace !== target.workspace || !await this.host.approve(task.task, active.abort.signal)) {
            report(active.stopRequested ? 'cancelled' : 'rejected', '원격 IDE에서 작업 시작을 취소했습니다'); return;
          }
          if (active.stopRequested || this.disposed || this.host.busy()) { report('cancelled', '작업을 시작하지 않았습니다'); return; }
          await backend.post(`/api/remote/work/tasks/${task.id}`, { key: this.key, lease_token: task.lease_token, status: 'running', detail: '선택한 원격 PC에서 에이전트 실행 중' }, 5000);
          if (active.stopRequested || this.disposed) { report('cancelled', '실행 시작 전 중단했습니다'); return; }
          const text = task.attempt > 0 ? `[명시적 재개] 먼저 현재 파일·git diff·.yang/harness 진행률을 읽고 이미 완료한 변경이나 외부 명령을 무조건 반복하지 마세요. 남은 작업부터 이어서 수행하세요.\n\n${task.task}` : task.task;
          active.executing = true;
          await this.host.run(text, task.mode);
          report(active.stopRequested ? 'cancelled' : 'completed', active.stopRequested ? '중단 요청 후 에이전트 실행 루틴이 종료되었습니다' : '에이전트 응답 종료. 테스트 통과 여부는 IDE 작업 로그에서 확인하세요.');
        } catch (e: any) { report(active.stopRequested ? 'cancelled' : 'failed', e.message || '실행 실패'); }
        finally { active.executing = false; await this.maintainActive(); }
      } catch (e: any) {
        this.host.notice(`원격 작업 연결 오류: ${e.message}`);
      } finally { this.receiving = false; }
    } catch { /* Offline or older server: heartbeat retries without starting local work. */ }
  }
}
