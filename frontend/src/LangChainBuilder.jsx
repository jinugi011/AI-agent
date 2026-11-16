import { useEffect, useRef, useState } from 'react';
import RemoteDispatch from './RemoteDispatch';

const DRAFT_KEY = 'yang.langchain.draft.v1';
const RUN_KEY = 'yang.langchain.run.v1';
const DEFAULTS = { goal: '', project: '', retrieval: false, review: true, top_k: 4, max_tokens: 2048, temperature: 0.2, system_prompt: '', mode: 'harness', acceptance_criteria: '' };
const TEMPLATES = [
  { title: '프로젝트 기능 추가', tag: 'BUILD', goal: '관리자가 상품을 등록·수정·삭제하고 사용자는 상품을 검색할 수 있는 기능을 구현하고 싶습니다. 기존 프로젝트 구조를 따르고 입력 검증과 권한 검사, 테스트를 포함해 주세요.', retrieval: true },
  { title: '문서 기반 챗봇', tag: 'RAG', goal: '프로젝트 문서를 검색해 근거와 출처를 함께 답변하는 챗봇을 구현하고 싶습니다. 질문 입력 UI, 검색 API, 답변 생성, 검색 결과가 없을 때의 처리를 포함해 주세요.', retrieval: true },
  { title: '업무 자동화', tag: 'FLOW', goal: '사용자가 입력한 고객 문의를 요약하고 유형과 우선순위를 분류해 담당자에게 전달할 답변 초안을 만드는 기능을 구현하고 싶습니다. 결과를 검토·수정하는 화면과 테스트를 포함해 주세요.', retrieval: false },
];

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    return { ...DEFAULTS, ...Object.fromEntries(Object.keys(DEFAULTS).filter((k) => typeof saved?.[k] === typeof DEFAULTS[k]).map((k) => [k, saved[k]])) };
  } catch { return DEFAULTS; }
}

async function api(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `요청을 처리하지 못했습니다 (${res.status}). 입력값을 확인하세요.`);
  return data;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function LangChainBuilder({ apiBase, onImplement }) {
  const [form, setForm] = useState(loadDraft);
  const [service, setService] = useState(null);
  const [runId, setRunId] = useState(() => { try { return localStorage.getItem(RUN_KEY) || ''; } catch { return ''; } });
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [output, setOutput] = useState('');
  const [checking, setChecking] = useState(false);
  const sequence = useRef(0);
  const busy = starting || !!runId && (!job || ['queued', 'running'].includes(job.status));
  const change = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function refresh(signal) {
    setChecking(true);
    try {
      const data = await api(apiBase, '/api/langchain/status', { signal });
      setService(data);
      setForm((f) => ({ ...f, system_prompt: f.system_prompt || data.default_system_prompt }));
      setError('');
    } catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    finally { if (!signal?.aborted) setChecking(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [apiBase]);

  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form)); } catch { /* storage unavailable */ } }, [form]);

  useEffect(() => {
    if (!runId) return undefined;
    let stopped = false;
    let timer;
    const controller = new AbortController();
    async function poll() {
      try {
        const next = await api(apiBase, `/api/langchain/runs/${encodeURIComponent(runId)}`, { signal: controller.signal });
        if (stopped) return;
        setJob(next);
        if (next.status === 'done') { setOutput(next.result.output); return; }
        if (next.status === 'error') { setError(next.error); return; }
      } catch (e) {
        if (stopped) return;
        setError(e.message);
        if (e.message.includes('실행 기록이 없습니다')) { setRunId(''); try { localStorage.removeItem(RUN_KEY); } catch { /* ignore */ } return; }
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [apiBase, runId]);

  async function start(e) {
    e.preventDefault();
    if (busy) return;
    const request = ++sequence.current;
    setStarting(true); setError(''); setNotice('');
    try {
      const data = await api(apiBase, '/api/langchain/runs', { method: 'POST', body: JSON.stringify(form) });
      if (request !== sequence.current) return;
      setJob({ status: 'queued', events: [], config: { ...form } });
      setOutput(''); setRunId(data.id);
      try { localStorage.setItem(RUN_KEY, data.id); } catch { /* ignore */ }
    } catch (e) { setError(e.message); }
    finally { setStarting(false); }
  }

  const stages = [
    { key: 'input', label: '요구사항', detail: '원하는 기능과 제약' },
    { key: 'context', label: form.retrieval ? '코드 검색' : '입력 준비', detail: form.retrieval ? `프로젝트 코드 ${form.top_k}개 참고` : '요구사항을 바로 전달' },
    { key: 'generate', label: '로컬 모델', detail: '구현 명세 생성' },
    ...(form.review ? [{ key: 'review', label: '결과 검토', detail: '누락·검증 방법 보완' }] : []),
    { key: 'output', label: '결과', detail: '검토 후 구현으로 연결' },
  ];
  const events = job?.events || [];
  const statusText = busy ? (job?.status === 'queued' || starting ? '실행 대기 중' : events.at(-1)?.label || '실행 중') : job?.status === 'done' ? '실행 완료' : job?.status === 'error' ? '실행 실패' : '실행 준비';

  return (
    <div className="lc-page">
      <header className="page-header">
        <div><p className="eyebrow">REMOTE LANGCHAIN WORKSPACE</p><h2>원격 프로젝트를 자연어로 구현</h2><p className="lc-muted">서버의 LangChain으로 요구사항을 구성하고, 원격 PC의 에이전트에서 코드 수정과 테스트를 수행하세요.</p></div>
        <span className={`lc-badge ${service?.available ? 'ready' : ''}`}>{service ? service.available ? 'LangChain 연결됨' : 'LangChain 설치 필요' : '연결 확인 중'}</span>
      </header>

      {error && <div className="lc-alert error" role="alert">{error}</div>}
      {notice && <div className="lc-alert" role="status">{notice}</div>}
      {service && !service.available && <div className="lc-alert">백엔드 환경에서 <code>pip install -r requirements.txt</code>로 의존성을 설치한 후 <button type="button" className="secondary" disabled={checking} onClick={() => refresh()}>연결 다시 확인</button></div>}

      <div className="lc-templates" aria-label="시작 템플릿">
        {TEMPLATES.map((t) => <button key={t.tag} type="button" className="lc-template secondary" disabled={busy} onClick={() => { setForm((f) => ({ ...f, goal: t.goal, retrieval: t.retrieval })); setNotice(`${t.title} 템플릿을 불러왔습니다. 요구사항을 수정해 실행하세요.`); }}><span>{t.tag}</span><strong>{t.title}</strong><small>이 구성으로 시작 ↗</small></button>)}
      </div>

      <section className="panel lc-flow-panel" aria-label="실행 흐름">
        <div className="panel-header"><h3>실행 흐름</h3><span>서버 추론 → 원격 IDE 실행 · {form.review ? '모델 2회 호출' : '모델 1회 호출'}</span></div>
        <ol className="lc-flow">{stages.map((s, i) => <li key={s.key}><span className="lc-step-number">{String(i + 1).padStart(2, '0')}</span><strong>{s.label}</strong><small>{s.detail}</small></li>)}</ol>
      </section>

      <div className="lc-columns">
        <form className="panel lc-config" onSubmit={start}>
          <div className="panel-header"><h3>워크플로 구성</h3><span>이 브라우저에 자동 저장</span></div>
          <fieldset disabled={busy}>
            <label className="field"><span>작업 방식</span><select value={form.mode} onChange={(e) => change('mode', e.target.value)}><option value="harness">자연어 하네스 · 테스트 먼저 구현</option><option value="implementation">기능 구현 명세</option></select></label>
            <label className="field"><span>구현할 기능 <b className="lc-required">*</b></span><textarea required maxLength={12000} rows={6} value={form.goal} onChange={(e) => change('goal', e.target.value)} placeholder="예: 기존 쇼핑몰에 주문 취소와 환불 기능을 추가해줘. 관리자 승인과 테스트도 포함해줘." /></label>
            <label className="lc-toggle"><input type="checkbox" checked={form.retrieval} onChange={(e) => change('retrieval', e.target.checked)} /><span><strong>프로젝트 코드 검색</strong><small>선택한 프로젝트에서 관련 코드를 찾아 참고합니다.</small></span></label>
            <label className="field"><span>완료 조건 · 실패하면 안 되는 동작</span><textarea rows={4} maxLength={6000} value={form.acceptance_criteria} onChange={(e) => change('acceptance_criteria', e.target.value)} placeholder="예: 본인 주문만 취소할 수 있어야 해. 배송 중이면 취소를 막고, 재고는 한 번만 복구해. 기존 결제 테스트도 통과해야 해." /><small className="lc-muted">자연어를 요구사항별 수용 기준·테스트 항목으로 구성합니다.</small></label>
            <label className="field"><span>참고할 프로젝트 {form.retrieval && '*'}</span><select required={form.retrieval} value={form.project} onChange={(e) => change('project', e.target.value)}><option value="">프로젝트 선택</option>{form.project && !service?.projects?.includes(form.project) && <option value={form.project}>{form.project} (등록 상태 확인 필요)</option>}{service?.projects?.map((p) => <option key={p} value={p}>{p}</option>)}</select><small className="lc-muted">Yang Coding 메뉴에서 연결·색인한 프로젝트를 사용합니다.</small></label>
            <label className="lc-toggle"><input type="checkbox" checked={form.review} onChange={(e) => change('review', e.target.checked)} /><span><strong>생성 결과 한 번 더 검토</strong><small>요구사항 누락과 테스트 방법을 보완합니다. 모델을 한 번 더 호출합니다.</small></span></label>
            <details className="lc-advanced"><summary>프롬프트 및 모델 설정</summary>
              <label className="field"><span>시스템 프롬프트</span><textarea required maxLength={6000} rows={6} value={form.system_prompt} onChange={(e) => change('system_prompt', e.target.value)} /></label>
              <div className="lc-settings"><label className="field"><span>검색 결과 수</span><input type="number" min="1" max="8" required value={form.top_k} onChange={(e) => change('top_k', Number(e.target.value))} /></label><label className="field"><span>최대 출력 토큰</span><input type="number" min="256" max="8192" required value={form.max_tokens} onChange={(e) => change('max_tokens', Number(e.target.value))} /></label><label className="field"><span>온도</span><input type="number" min="0" max="1" step="0.1" required value={form.temperature} onChange={(e) => change('temperature', Number(e.target.value))} /></label></div>
            </details>
          </fieldset>
          <div className="lc-actions"><button type="submit" disabled={busy || !service?.available || !form.goal.trim() || !form.system_prompt.trim() || form.retrieval && !form.project}>{busy ? '워크플로 실행 중…' : '워크플로 실행 →'}</button><button type="button" className="secondary" onClick={() => download('langchain-workflow.json', JSON.stringify(form, null, 2), 'application/json')}>설정 내보내기</button></div>
          <p className="lc-muted lc-footnote">명세를 생성한 뒤 결과에서 원격 IDE를 선택해 전달하세요. 테스트는 선택한 PC의 프로젝트에서 실행합니다.</p>
        </form>

        <section className="panel lc-result" aria-busy={busy}>
          <div className="panel-header"><h3>실행 결과</h3><span className="lc-badge" role="status">{statusText}</span></div>
          {!job && !busy && <div className="lc-empty"><span>↗</span><h3>어떤 기능을 만들까요?</h3><p>템플릿을 선택하거나 요구사항을 입력하세요.<br />실행 단계와 구현 명세가 여기에 표시됩니다.</p></div>}
          {(events.length > 0 || busy) && <ol className="lc-events">{events.map((ev, i) => <li key={`${ev.stage}-${i}`}><span>{ev.label}</span><small>{ev.elapsed}s</small></li>)}{busy && <li className="lc-muted">{job?.status === 'queued' ? '사용 가능한 실행 슬롯을 기다립니다…' : '로컬 모델 응답을 기다립니다…'}</li>}</ol>}
          {job?.status === 'error' && <p className="lc-muted">구성을 조정하거나 엔진 상태를 확인한 뒤 다시 실행할 수 있습니다.</p>}
          {job?.result && <>
            {job.result.warnings.map((w, i) => <div key={i} className="lc-alert">{w}</div>)}
            <label className="field lc-output"><span>최종 구현 명세 · 전달 전에 수정할 수 있습니다</span><textarea rows={18} value={output} onChange={(e) => setOutput(e.target.value)} /></label>
            <RemoteDispatch key={job.id || runId} runId={job.id || runId} apiBase={apiBase} mode={job.config.mode || 'implementation'} task={`요구사항:\n${job.config.goal}\n완료 조건:\n${job.config.acceptance_criteria || '(명세 참고)'}\n\n${output}`} />
            <div className="lc-actions"><button className="secondary" type="button" onClick={() => download('implementation-plan.md', output, 'text/markdown;charset=utf-8')}>명세 다운로드</button></div>
            <details className="lc-advanced"><summary>서버에 있는 레포에서 작업할 때</summary><p className="lc-muted">원격 PC의 파일은 위의 원격 IDE 전달 기능을 사용하세요.</p><button type="button" className="secondary" disabled={!output.trim()} onClick={() => onImplement(`요구사항:\n${job.config.goal}\n\n${output}`)}>서버 Yang Coding으로 전달</button></details>
            {job.result.sources.length > 0 && <details className="lc-sources"><summary>참고한 코드 ({job.result.sources.length}개)</summary>{job.result.sources.map((s, i) => <div key={`${s.source}-${i}`}><strong>{s.source}</strong><pre>{s.content}</pre></div>)}</details>}
            <div className="lc-stats">{job.result.stats.map((s, i) => <span key={i}>{s.stage === 'review' ? '검토' : '생성'} · {s.completion_tokens} tok · {s.tokens_per_second.toFixed(1)} tok/s</span>)}</div>
          </>}
        </section>
      </div>
    </div>
  );
}
