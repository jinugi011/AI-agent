import { useEffect, useState } from 'react';

async function api(base, path, options = {}) {
  const response = await fetch(`${base}/api/remote/work${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(typeof data.detail === 'string' ? data.detail : `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function RemoteDispatch({ apiBase, task, mode, runId }) {
  const storageKey = `yang.remote.delivery.${runId}`;
  const [agents, setAgents] = useState([]);
  const [target, setTarget] = useState('');
  const [delivery, setDelivery] = useState(() => {
    try { const id = localStorage.getItem(storageKey); return id ? { id, status: 'pending', detail: '이전 원격 작업 상태 확인 중' } : null; } catch { return null; }
  });
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [previousStopped, setPreviousStopped] = useState(false);
  const active = sending || delivery && ['pending', 'offered', 'running', 'cancel_requested'].includes(delivery.status);
  const recoverable = delivery && ['disconnected', 'cancelled', 'failed'].includes(delivery.status);
  const compatible = selectedAgent => !!selectedAgent && (!recoverable || selectedAgent.project === delivery.project && selectedAgent.workspace === delivery.workspace);
  const selected = agents.find((a) => a.id === target);

  useEffect(() => { setPreviousStopped(false); }, [delivery?.id, delivery?.attempt, delivery?.status]);

  useEffect(() => {
    let stopped = false;
    let timer;
    const controller = new AbortController();
    async function refresh() {
      try {
        const data = await api(apiBase, '/agents', { signal: controller.signal });
        if (!stopped) setAgents(data.agents);
      } catch (e) { if (!stopped) setError(e.message); }
      if (!stopped) timer = setTimeout(refresh, 10000);
    }
    refresh();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [apiBase]);

  useEffect(() => {
    if (!delivery || !['pending', 'offered', 'running', 'cancel_requested', 'disconnected'].includes(delivery.status)) return undefined;
    let stopped = false;
    let timer;
    const controller = new AbortController();
    async function poll() {
      try {
        const data = await api(apiBase, `/tasks/${delivery.id}`, { signal: controller.signal });
        if (stopped) return;
        setDelivery(data);
        setTarget((cur) => cur || data.agent_id);
        if (!['pending', 'offered', 'running', 'cancel_requested', 'disconnected'].includes(data.status)) return;
      } catch (e) {
        if (stopped) return;
        setError(e.message);
        if (e.status === 404) { setDelivery({ ...delivery, status: 'missing', detail: e.message }); return; }
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [apiBase, delivery?.id, delivery?.status]);

  async function submit() {
    setSending(true); setError('');
    try {
      const data = await api(apiBase, '/tasks', { method: 'POST', body: JSON.stringify({ agent_id: target, task, mode }) });
      setDelivery(data);
      try { localStorage.setItem(storageKey, data.id); } catch { /* ignore */ }
    } catch (e) { setError(e.message); }
    finally { setSending(false); }
  }

  async function control(action) {
    if (!delivery || sending || typeof delivery.attempt !== 'number') return;
    setSending(true); setError('');
    try {
      const payload = { attempt: delivery.attempt, previous_execution_stopped: previousStopped, ...(action === 'resume' ? { agent_id: target } : {}) };
      setDelivery(await api(apiBase, `/tasks/${delivery.id}/${action}`, { method: 'POST', body: JSON.stringify(payload) }));
    } catch (e) { setError(e.message); }
    finally { setSending(false); }
  }

  return <section className="lc-remote">
    <h4>원격 PC에서 이어서 실행</h4>
    <p className="lc-muted">원격 IDE의 Yang Coding이 작업을 수신합니다. 그 PC에서 내용을 확인하면 코드 수정과 테스트를 시작합니다.</p>
    <label className="field"><span>작업할 PC · 열린 프로젝트</span><select disabled={!!active} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">원격 IDE 선택</option>{agents.map((a) => <option key={a.id} value={a.id} disabled={!a.online || a.protocol_version !== 2 || !compatible(a)}>{a.label} · {a.project}{!a.online ? ' (연결 끊김)' : a.protocol_version !== 2 ? ' (플러그인 업데이트 필요)' : !compatible(a) ? ' (다른 프로젝트·폴더)' : ''}</option>)}</select></label>
    {selected && <p className="lc-muted lc-workspace">대상 폴더: {selected.workspace}</p>}
    {!agents.some((a) => a.online) && <p className="lc-muted">원격 PC에서 최신 VS Code·IntelliJ·Android Studio 플러그인을 설치하고, 원격 모드로 프로젝트와 Yang Coding을 열어주세요. 목록은 10초마다 갱신됩니다.</p>}
    {!recoverable && <button type="button" disabled={!!active || !selected?.online || selected?.protocol_version !== 2 || !task.trim() || delivery?.status === 'missing' && !previousStopped} onClick={submit}>{active ? '원격 작업 진행 중…' : mode === 'harness' ? '원격 IDE에 하네스 전달 →' : '원격 IDE에 구현 전달 →'}</button>}
    {error && <p role="alert" className="lc-alert error">{error}</p>}
    {delivery && <div className="lc-alert" role="status"><strong>{{ pending: '수신 대기', offered: 'IDE에서 확인 대기', running: '원격 에이전트 실행 중', completed: '에이전트 응답 종료', failed: '실행 실패', rejected: '작업 거절됨', disconnected: '작업 연결 끊김', cancel_requested: 'IDE 중단 확인 대기', cancelled: '작업 취소됨', missing: '작업 기록 없음' }[delivery.status]}</strong><p>{delivery.detail}</p><small>마지막 작업 응답: {delivery.last_response_at ? new Date(delivery.last_response_at * 1000).toLocaleString('ko-KR') : '아직 없음'}</small></div>}
    {delivery && ['pending', 'offered', 'running', 'disconnected'].includes(delivery.status) && <button type="button" className="secondary" disabled={sending || typeof delivery.attempt !== 'number'} onClick={() => control('cancel')}>{previousStopped ? '중단 확인 후 취소 확정' : '작업 취소 요청'}</button>}
    {(recoverable || delivery?.status === 'missing') && <div>
      <p className="lc-muted">자동으로 다시 실행하지 않습니다. 이전 IDE 작업과 하위 명령이 중단됐는지 확인하세요. 같은 프로젝트·폴더의 IDE를 선택해 기존 변경과 체크리스트를 확인하며 이어서 진행합니다.</p>
      <label className="lc-toggle"><input type="checkbox" checked={previousStopped} onChange={(e) => setPreviousStopped(e.target.checked)} /><span>이전 실행과 하위 명령이 중단된 것을 확인했습니다.</span></label>
      {recoverable && <button type="button" disabled={sending || !previousStopped || !selected?.online || selected?.protocol_version !== 2 || !compatible(selected)} onClick={() => control('resume')}>확인한 IDE에서 명시적으로 재개</button>}
    </div>}
  </section>;
}
