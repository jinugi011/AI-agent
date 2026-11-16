import { useCallback, useEffect, useRef, useState } from 'react';

async function api(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `요청 실패 (${res.status})`);
  return data;
}

const LOGS = [
  { id: 'engine', label: '엔진' },
  { id: 'backend', label: '백엔드' },
  { id: 'imagegen', label: '이미지' },
  { id: 'access', label: '원격 접속' },
];

function Dot({ ok, warn }) {
  return <span className={`sa-dot ${ok ? 'ok' : warn ? 'warn' : 'off'}`} />;
}

/** 서버 관리: 원격에서 상태 확인 · 재시작 · 설정 · 로그 (이 맥 또는 내 Tailscale 계정만) */
export default function ServerAdmin({ apiBase }) {
  const [st, setSt] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [models, setModels] = useState([]);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [logName, setLogName] = useState('engine');
  const [logGrep, setLogGrep] = useState('');
  const [logLines, setLogLines] = useState([]);
  const [follow, setFollow] = useState(true);
  const logRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setSt(await api(apiBase, '/api/admin/system'));
      api(apiBase, '/api/admin/models').then((r) => setModels(r.presets)).catch(() => undefined);
      setError('');
    } catch (e) {
      setError(e.message.includes('원격') || e.message.includes('403')
        ? '이 페이지는 이 맥이나 허용된 Tailscale 계정으로만 열 수 있습니다.'
        : `서버에 연결할 수 없습니다 (재시작 중이면 잠시 뒤 자동으로 다시 연결됩니다): ${e.message}`);
    }
  }, [apiBase]);

  const loadConfig = useCallback(async () => {
    try {
      const c = await api(apiBase, '/api/admin/config');
      setCfg(c);
      setDraft(Object.fromEntries(c.fields.map((f) => [f.key, f.value])));
    } catch { /* 상태 쪽 오류로 표시 */ }
  }, [apiBase]);

  const loadLogs = useCallback(async () => {
    try {
      const r = await api(apiBase, `/api/admin/logs/${logName}?lines=300&grep=${encodeURIComponent(logGrep)}`);
      setLogLines(r.lines);
    } catch { /* 무시 */ }
  }, [apiBase, logName, logGrep]);

  useEffect(() => { refresh(); loadConfig(); }, [refresh, loadConfig]);
  useEffect(() => { const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    loadLogs();
    if (!follow) return undefined;
    const t = setInterval(loadLogs, 3000);
    return () => clearInterval(t);
  }, [loadLogs, follow]);
  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logLines, follow]);

  const act = async (name, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(name);
    setMsg('');
    try {
      const r = await api(apiBase, `/api/admin/system/${name}`, { method: 'POST' });
      setMsg(r.message);
      setTimeout(refresh, 1500);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const switchModel = async (m) => {
    if (!window.confirm(`${m.label} 로 바꿀까요? 엔진을 다시 시작합니다 (20~60초, 진행 중인 응답은 끊김).`)) return;
    setBusy('model');
    setMsg('');
    try {
      const r = await api(apiBase, '/api/admin/models', { method: 'POST', body: JSON.stringify({ preset: m.id }) });
      setMsg(r.message);
      await loadConfig();
      setTimeout(refresh, 2000);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const save = async (restart) => {
    setBusy('save');
    setMsg('');
    try {
      const r = await api(apiBase, '/api/admin/config', { method: 'PUT', body: JSON.stringify({ values: draft }) });
      await loadConfig();
      if (!r.changed.length) { setMsg('바뀐 설정이 없습니다.'); return; }
      if (r.restart_needed.includes('engine') && restart) {
        const a = await api(apiBase, '/api/admin/system/restart-engine', { method: 'POST' });
        setMsg(`저장했습니다 (${r.changed.join(', ')}). ${a.message}`);
      } else {
        setMsg(`저장했습니다 (${r.changed.join(', ')}).` + (r.restart_needed.length ? ' 엔진을 다시 시작하면 적용됩니다.' : ' 바로 적용됩니다.'));
      }
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const dirty = cfg && cfg.fields.some((f) => draft[f.key] !== f.value);
  const needsEngine = cfg && cfg.fields.some((f) => draft[f.key] !== f.value && f.service === 'engine');
  const e = st?.engine;
  const mem = st?.memory;

  return (
    <div className="aw-grid sa-grid">
      {error && <div className="aw-error" role="alert">{error}</div>}
      {msg && <div className="sa-msg">{msg}</div>}

      <section className="panel aw-card">
        <div className="panel-header"><div><p className="eyebrow">상태</p><h3>서비스</h3></div>
          <button type="button" className="secondary aw-small" onClick={refresh}>새로고침</button></div>
        {!st ? <p className="aw-empty">확인 중…</p> : (
          <ul className="sa-services">
            <li>
              <div><Dot ok={e.online && e.coder_loaded} warn={e.online && !e.coder_loaded} /><strong>코딩 엔진</strong>
                <small>{e.online ? (e.coder_loaded ? '모델 올라감' : '대기 (메모리에서 내림)') : '꺼짐'}</small></div>
              <small>{e.model?.model_name || '—'} · ctx {e.model?.n_ctx || '—'} · {e.rss_mb ? `${(e.rss_mb / 1024).toFixed(1)}GB` : '—'} · 실행 {e.uptime || '—'}</small>
              <small>비전: {e.vision?.available ? (e.vision.loaded ? '올라감' : '대기') : '없음'}</small>
            </li>
            <li>
              <div><Dot ok={st.backend.online} /><strong>백엔드</strong><small>pid {st.backend.pid} · 실행 {st.backend.uptime || '—'}</small></div>
            </li>
            <li>
              <div><Dot ok={st.imagegen.online} warn={false} /><strong>이미지 모델</strong>
                <small>{st.imagegen.online ? `${st.imagegen.family} ${st.imagegen.loaded ? '로드됨' : '대기'}` : '꺼짐 (요청 때 자동 시작)'}</small></div>
              {st.imagegen.rss_mb ? <small>{(st.imagegen.rss_mb / 1024).toFixed(1)}GB</small> : null}
            </li>
          </ul>
        )}
        {mem && (
          <div className="sa-mem">
            <div className="sa-bar"><span style={{ width: `${Math.min(100, (mem.used_gb / mem.total_gb) * 100)}%` }} /></div>
            <small>메모리 {mem.used_gb} / {mem.total_gb}GB 사용 · 여유 {mem.available_gb}GB · 디스크 여유 {st.disk_free_gb}GB</small>
          </div>
        )}
        <div className="sa-actions">
          <button type="button" disabled={!!busy} onClick={() => act('restart-engine', '코딩 엔진을 다시 시작할까요? 진행 중인 응답은 끊깁니다.')}>
            {busy === 'restart-engine' ? '…' : '엔진 재시작'}</button>
          <button type="button" disabled={!!busy} onClick={() => act('restart-backend', '백엔드를 다시 시작할까요? 5~10초 동안 접속이 끊깁니다.')}>
            {busy === 'restart-backend' ? '…' : '백엔드 재시작'}</button>
          <button type="button" disabled={!!busy} onClick={() => act('restart-all', '엔진·백엔드·이미지 모델을 모두 다시 시작할까요? (약 1분)')}>
            {busy === 'restart-all' ? '…' : '전체 재시작'}</button>
        </div>
        <div className="sa-actions">
          <button type="button" className="secondary" disabled={!!busy} onClick={() => act('stop-imagegen')}>이미지 모델 끄기</button>
          <button type="button" className="secondary" disabled={!!busy} onClick={() => act('vision-unload')}>비전 모델 내리기</button>
          <button type="button" className="secondary" disabled={!!busy} onClick={() => act('engine-sleep', '코딩·비전 모델을 메모리에서 내릴까요? 다음 요청 때 10~20초 걸려 다시 올립니다.')}>모델 메모리 비우기</button>
        </div>
        <p className="tm-help">멈췄을 때: 먼저 <b>엔진 재시작</b> → 그래도 안 되면 <b>전체 재시작</b>. 재시작 중에도 이 페이지는 자동으로 다시 연결됩니다.</p>
      </section>

      <section className="panel aw-card aw-wide">
        <div className="panel-header"><div><p className="eyebrow">모델</p><h3>모델 선택</h3></div></div>
        <div className="sa-models">
          {models.map((m) => (
            <div key={m.id} className={`sa-model ${m.active ? 'active' : ''}`}>
              <div><strong>{m.label}</strong>{m.active && <em className="sa-tag now">사용 중</em>}</div>
              <small>{m.help}</small>
              <small>{m.file}{!m.available && ' · 아직 없음 (다운로드 중이거나 설치 전)'}</small>
              <button type="button" disabled={!m.available || m.active || !!busy} onClick={() => switchModel(m)}>
                {m.active ? '사용 중' : busy === 'model' ? '바꾸는 중…' : '이 모델로 바꾸기'}</button>
            </div>
          ))}
        </div>
        <p className="tm-help">평소엔 <b>코딩</b> 모델(Qwen3.6)을 씁니다. IDE 채팅에서 <code>/model 코딩</code> · <code>/model 이전</code> 으로도 바꿀 수 있습니다.</p>
      </section>

      <section className="panel aw-card">
        <div className="panel-header"><div><p className="eyebrow">설정</p><h3>서버 설정</h3></div></div>
        {!cfg ? <p className="aw-empty">불러오는 중…</p> : (
          <>
            {!cfg.launchd && <p className="aw-error">서비스 실행기가 아직 예전 방식입니다. 맥에서 <code>./scripts/server-mode.sh on</code> 을 한 번 실행해야 엔진 설정이 적용됩니다.</p>}
            <div className="sa-fields">
              {cfg.fields.map((f) => (
                <label key={f.key} className="field">
                  <span>{f.label}{f.service === 'engine' ? <em className="sa-tag">엔진 재시작</em> : <em className="sa-tag now">바로 적용</em>}</span>
                  {f.type === 'select' ? (
                    <select value={draft[f.key] ?? ''} onChange={(ev) => setDraft({ ...draft, [f.key]: ev.target.value })}>
                      {f.options.map((o, i) => <option key={o} value={o}>{f.labels?.[i] ?? o}</option>)}
                    </select>
                  ) : (
                    <input type="number" min={f.min} max={f.max} value={draft[f.key] ?? ''} onChange={(ev) => setDraft({ ...draft, [f.key]: ev.target.value })} />
                  )}
                  <small>{f.help}</small>
                </label>
              ))}
            </div>
            <div className="sa-actions">
              <button type="button" disabled={!dirty || !!busy} onClick={() => save(true)}>{needsEngine ? '저장 + 엔진 재시작' : '저장'}</button>
              {needsEngine && <button type="button" className="secondary" disabled={!!busy} onClick={() => save(false)}>저장만 (나중에 재시작)</button>}
              <button type="button" className="secondary" disabled={!dirty || !!busy} onClick={() => setDraft(Object.fromEntries(cfg.fields.map((f) => [f.key, f.value])))}>되돌리기</button>
            </div>
          </>
        )}
      </section>

      <section className="panel aw-card aw-wide">
        <div className="panel-header"><div><p className="eyebrow">로그</p><h3>실시간 로그</h3></div>
          <div className="sa-logbar">
            {LOGS.map((l) => (
              <button key={l.id} type="button" className={logName === l.id ? '' : 'secondary'} onClick={() => setLogName(l.id)}>{l.label}</button>
            ))}
            <input placeholder="필터 (예: error, 재사용)" value={logGrep} onChange={(ev) => setLogGrep(ev.target.value)} />
            <label className="sa-follow"><input type="checkbox" checked={follow} onChange={(ev) => setFollow(ev.target.checked)} /> 자동 갱신</label>
          </div>
        </div>
        <pre className="sa-log" ref={logRef}>{logLines.join('\n') || '(비어 있음)'}</pre>
      </section>
    </div>
  );
}
