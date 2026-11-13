import { useCallback, useEffect, useRef, useState } from 'react';

const KIND_LABELS = { constraint: '제약', style: '스타일', preference: '선호' };
const SCOPE_LABELS = { global: '전체', language: '언어', profile: '프로젝트 유형', project: '프로젝트' };
const ACTIVE = new Set(['queued', 'running']);

async function api(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `요청 실패 (${res.status})`);
  return data;
}

export default function AgentWorkbench({ apiBase }) {
  const [profiles, setProfiles] = useState([]);
  const [repos, setRepos] = useState([]);
  const [prefs, setPrefs] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [connectForm, setConnectForm] = useState({ location: '', name: '', profile: '', language: '', init_if_missing: false });
  const [task, setTask] = useState('');
  const [iterations, setIterations] = useState(4);
  const [prefForm, setPrefForm] = useState({ text: '', kind: 'constraint', scope: 'global', scope_value: '' });
  const pollRef = useRef(null);

  const run = useCallback(async (label, fn) => {
    setBusy(label);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy('');
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, r, pr, j] = await Promise.all([
        api(apiBase, '/api/profiles'),
        api(apiBase, '/api/repos'),
        api(apiBase, '/api/preferences'),
        api(apiBase, '/api/agent/jobs'),
      ]);
      setProfiles(p.profiles);
      setRepos(r.repos);
      setPrefs(pr.items);
      setJobs(j.jobs);
      setSelectedRepo((cur) => cur || r.repos[0]?.name || '');
    } catch (e) {
      setError(`백엔드 연결 실패: ${e.message}`);
    }
  }, [apiBase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadJob = useCallback(async (id) => {
    const data = await api(apiBase, `/api/agent/jobs/${id}`);
    setActiveJob(data.job);
    return data.job;
  }, [apiBase]);

  // 실행 중인 작업 폴링
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!activeJob || !ACTIVE.has(activeJob.status)) return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const job = await loadJob(activeJob.id);
        if (!ACTIVE.has(job.status)) refresh();
      } catch {
        /* 다음 주기에 재시도 */
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [activeJob, loadJob, refresh]);

  const connectRepo = (e) => {
    e.preventDefault();
    run('connect', async () => {
      const data = await api(apiBase, '/api/repos/connect', { method: 'POST', body: JSON.stringify(connectForm) });
      setSelectedRepo(data.repo.name);
      setConnectForm((f) => ({ ...f, location: '', name: '' }));
      await refresh();
    });
  };

  const reindex = (name) => run(`reindex:${name}`, async () => {
    await api(apiBase, `/api/repos/${name}/reindex`, { method: 'POST' });
    await refresh();
  });

  const startJob = (e) => {
    e.preventDefault();
    run('job', async () => {
      const data = await api(apiBase, '/api/agent/run', {
        method: 'POST',
        body: JSON.stringify({ repo: selectedRepo, task, max_iterations: Number(iterations) }),
      });
      setActiveJob(data.job);
      await refresh();
    });
  };

  const addPref = (e) => {
    e.preventDefault();
    run('pref', async () => {
      await api(apiBase, '/api/preferences', { method: 'POST', body: JSON.stringify(prefForm) });
      setPrefForm((f) => ({ ...f, text: '' }));
      await refresh();
    });
  };

  const deletePref = (id) => run('pref', async () => {
    await api(apiBase, `/api/preferences/${id}`, { method: 'DELETE' });
    await refresh();
  });

  const repo = repos.find((r) => r.name === selectedRepo);
  const methods = repo?.index_stats?.methods;

  return (
    <div className="aw-grid">
      {error && <div className="aw-error" role="alert">{error}</div>}

      <section className="panel aw-card">
        <div className="panel-header">
          <h3>1. 레포 연결</h3>
          <span>연결할 때마다 코딩 방법을 벡터화</span>
        </div>
        <form className="aw-form" onSubmit={connectRepo}>
          <label className="field">
            <span>로컬 경로 또는 git URL</span>
            <input
              required
              placeholder="/Users/me/projects/shop 또는 https://github.com/me/app.git"
              value={connectForm.location}
              onChange={(e) => setConnectForm({ ...connectForm, location: e.target.value })}
            />
          </label>
          <div className="aw-row">
            <label className="field">
              <span>이름 (선택)</span>
              <input value={connectForm.name} onChange={(e) => setConnectForm({ ...connectForm, name: e.target.value })} />
            </label>
            <label className="field">
              <span>언어</span>
              <input placeholder="python, dart, kotlin…" value={connectForm.language} onChange={(e) => setConnectForm({ ...connectForm, language: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>프로젝트 유형</span>
            <select value={connectForm.profile} onChange={(e) => setConnectForm({ ...connectForm, profile: e.target.value })}>
              <option value="">자동 감지</option>
              {['server', 'web', 'mobile'].map((cat) => (
                <optgroup key={cat} label={cat === 'server' ? '서버' : cat === 'web' ? '웹' : '모바일'}>
                  {profiles.filter((p) => p.category === cat).map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="aw-check">
            <input type="checkbox" checked={connectForm.init_if_missing} onChange={(e) => setConnectForm({ ...connectForm, init_if_missing: e.target.checked })} />
            새 프로젝트 (폴더·git init 생성)
          </label>
          <button type="submit" disabled={busy === 'connect'}>{busy === 'connect' ? '연결·벡터화 중…' : '연결'}</button>
        </form>

        <ul className="aw-list">
          {repos.map((r) => (
            <li key={r.name} className={r.name === selectedRepo ? 'selected' : ''}>
              <button type="button" className="aw-link" onClick={() => setSelectedRepo(r.name)}>
                <strong>{r.name}</strong>
                <small>{r.profile} · {r.index_stats?.chunks ?? 0} chunks</small>
              </button>
              <button type="button" className="secondary aw-small" onClick={() => reindex(r.name)} disabled={busy === `reindex:${r.name}`}>
                {busy === `reindex:${r.name}` ? '…' : '재색인'}
              </button>
            </li>
          ))}
          {repos.length === 0 && <li className="aw-empty">연결된 레포가 없습니다.</li>}
        </ul>

        {methods && (
          <details className="aw-methods">
            <summary>추출된 코딩 방법 ({repo.name})</summary>
            <dl>
              {Object.entries(methods).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </section>

      <section className="panel aw-card aw-wide">
        <div className="panel-header">
          <h3>2. 작업 지시</h3>
          <span>요구사항 → 하네스(테스트) → 구현 → 테스트 반복</span>
        </div>
        <form className="aw-form" onSubmit={startJob}>
          <label className="field">
            <span>대상 레포</span>
            <select value={selectedRepo} onChange={(e) => setSelectedRepo(e.target.value)} required>
              {repos.map((r) => <option key={r.name} value={r.name}>{r.name} ({r.profile})</option>)}
            </select>
          </label>
          <label className="field">
            <span>만들 기능 / 요구사항</span>
            <textarea
              required
              rows={6}
              placeholder="예) 회원가입 API 구현: 이메일 형식 검증, 비밀번호 8자 이상, 중복 이메일 409 반환"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          </label>
          <div className="aw-row aw-row-end">
            <label className="field">
              <span>최대 반복</span>
              <input type="number" min={1} max={10} value={iterations} onChange={(e) => setIterations(e.target.value)} />
            </label>
            <button type="submit" disabled={!selectedRepo || busy === 'job' || ACTIVE.has(activeJob?.status)}>
              {ACTIVE.has(activeJob?.status) ? '실행 중…' : '에이전트 실행'}
            </button>
          </div>
        </form>

        {activeJob && (
          <div className="aw-job">
            <div className="aw-job-head">
              <span className={`aw-status ${activeJob.status}`}>{activeJob.status}</span>
              <code>{activeJob.branch || activeJob.id}</code>
              {activeJob.commit && <code>commit {activeJob.commit}</code>}
              <small>반복 {activeJob.iterations}</small>
            </div>
            {activeJob.harness?.requirements?.length > 0 && (
              <ul className="aw-reqs">
                {activeJob.harness.requirements.map((r) => (
                  <li key={r.id}><b>{r.id}</b> {r.title}</li>
                ))}
              </ul>
            )}
            <ol className="aw-logs">
              {activeJob.logs.map((log, i) => (
                <li key={i} className={log.step}>
                  <span className="aw-ts">{log.ts}</span>
                  <span className="aw-step">{log.step}</span>
                  <span>{log.message}</span>
                  {log.output && <pre>{log.output}</pre>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {jobs.length > 0 && (
          <details className="aw-history">
            <summary>최근 작업 {jobs.length}건</summary>
            <ul className="aw-list">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button type="button" className="aw-link" onClick={() => loadJob(j.id)}>
                    <strong>{j.task.slice(0, 60)}</strong>
                    <small>{j.repo} · {j.status} · {j.created_at}</small>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="panel aw-card">
        <div className="panel-header">
          <h3>3. 스타일 · 선호 · 제약</h3>
          <span>항상 저장되고 모든 작업에 적용</span>
        </div>
        <form className="aw-form" onSubmit={addPref}>
          <label className="field">
            <span>내용</span>
            <input required placeholder="예) Python 은 ruff 규칙 준수, 줄 길이 100" value={prefForm.text} onChange={(e) => setPrefForm({ ...prefForm, text: e.target.value })} />
          </label>
          <div className="aw-row">
            <label className="field">
              <span>종류</span>
              <select value={prefForm.kind} onChange={(e) => setPrefForm({ ...prefForm, kind: e.target.value })}>
                {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field">
              <span>적용 범위</span>
              <select value={prefForm.scope} onChange={(e) => setPrefForm({ ...prefForm, scope: e.target.value, scope_value: '' })}>
                {Object.entries(SCOPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
          {prefForm.scope !== 'global' && (
            <label className="field">
              <span>{SCOPE_LABELS[prefForm.scope]} 값</span>
              {prefForm.scope === 'profile' ? (
                <select required value={prefForm.scope_value} onChange={(e) => setPrefForm({ ...prefForm, scope_value: e.target.value })}>
                  <option value="">선택</option>
                  {profiles.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              ) : prefForm.scope === 'project' ? (
                <select required value={prefForm.scope_value} onChange={(e) => setPrefForm({ ...prefForm, scope_value: e.target.value })}>
                  <option value="">선택</option>
                  {repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                </select>
              ) : (
                <input required placeholder="python" value={prefForm.scope_value} onChange={(e) => setPrefForm({ ...prefForm, scope_value: e.target.value })} />
              )}
            </label>
          )}
          <button type="submit" disabled={busy === 'pref'}>저장</button>
        </form>
        <ul className="aw-prefs">
          {prefs.map((p) => (
            <li key={p.id}>
              <span className={`aw-kind ${p.kind}`}>{KIND_LABELS[p.kind]}</span>
              <span className="aw-pref-text">
                {p.text}
                {p.scope !== 'global' && <small> · {SCOPE_LABELS[p.scope]}: {p.scope_value}</small>}
              </span>
              <button type="button" className="secondary aw-small" aria-label="삭제" onClick={() => deletePref(p.id)}>×</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
