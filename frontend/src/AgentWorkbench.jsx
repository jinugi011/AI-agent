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

const CONNECT_MODES = [
  { id: 'remote', label: '원격 PC 경로', field: '원격 PC 의 프로젝트 폴더 경로',
    placeholder: '/Users/me/work/gehs  ·  C:\\work\\gehs',
    help: '회사 PC 등 원격 PC 의 폴더 경로를 등록합니다. 그 PC 의 IDE(Yang Coding 플러그인)가 켜질 때·10분마다·요청할 때 경로를 찾아 파일을 올리고, 코드·문서 임베딩 → 코딩 스타일 → 아키텍처 분석을 합니다.' },
  { id: 'upload', label: '원격 PC 폴더 올리기', field: '',
    placeholder: '', help: '지금 이 브라우저가 열린 PC 의 폴더를 바로 골라 올립니다 (IDE 없이도 등록 · 코드 파일만, 최대 2,500개).' },
  { id: 'server', label: '이 맥 경로', field: '서버(맥)의 폴더 경로',
    placeholder: '/Users/jinugi/projects/shop', help: '서버 맥에 있는 폴더를 연결합니다 (서버에서 직접 읽고 색인).' },
  { id: 'git', label: 'git URL', field: 'git 원격 주소',
    placeholder: 'https://github.com/me/app.git', help: '서버 맥에 clone 해서 연결합니다.' },
];

export default function AgentWorkbench({ apiBase, initialTask = '' }) {
  const [profiles, setProfiles] = useState([]);
  const [repos, setRepos] = useState([]);
  const [prefs, setPrefs] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectMode, setConnectMode] = useState('remote');
  const [remoteProjects, setRemoteProjects] = useState({});
  const [archView, setArchView] = useState(null);
  const [busy, setBusy] = useState('');

  const [connectForm, setConnectForm] = useState({ location: '', name: '', profile: '', language: '', init_if_missing: false });
  const [task, setTask] = useState(initialTask);
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
      api(apiBase, '/api/remote/projects').then((x) => setRemoteProjects(x.projects || {})).catch(() => undefined);
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
      const data = await api(apiBase, '/api/repos/connect', { method: 'POST', body: JSON.stringify({ ...connectForm, target: connectMode === 'remote' ? 'remote' : 'server' }) });
      if (data.pending) {
        setNotice(data.message);
        setConnectForm((f) => ({ ...f, location: '', name: '' }));
        await refresh();
        return;
      }
      setSelectedRepo(data.repo.name);
      setConnectForm((f) => ({ ...f, location: '', name: '' }));
      await refresh();
    });
  };

  // 브라우저에서 고른 폴더를 그대로 올려 원격 프로젝트로 등록 (코드 임베딩 · 코딩 스타일 · 아키텍처 분석)
  const uploadFolder = (e) => {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (!list.length) return;
    run('upload', async () => {
      const skip = /(^|\/)(node_modules|\.git|dist|build|target|\.venv|venv|__pycache__|\.next|Pods|\.dart_tool|\.gradle|out|\.idea|coverage)\//;
      const ok = /\.(py|js|jsx|ts|tsx|java|kt|kts|dart|swift|go|rs|cpp|cc|hpp|h|c|sql|md|ya?ml|json|toml|css|adoc|rst|gradle|properties)$|Mapper\.xml$|(^|\/)(mapper|mappers|sqlmap|mybatis)\/.*\.xml$|(^|\/)pom\.xml$/;
      const top = list[0].webkitRelativePath.split('/')[0];
      const files = [];
      let total = 0;
      for (const f of list) {
        const rel = f.webkitRelativePath.split('/').slice(1).join('/');
        if (!rel || skip.test(rel) || !ok.test(rel) || f.size > 200000 || total + f.size > 25000000) continue;
        files.push({ path: rel, content: await f.text() });
        total += f.size;
        if (files.length >= 2500) break;
      }
      if (!files.length) throw new Error('올릴 코드 파일이 없습니다');
      setNotice(`${top}: 파일 ${files.length}개 (${(total / 1e6).toFixed(1)}MB) 올리는 중…`);
      const r = await api(apiBase, '/api/remote/index', { method: 'POST', body: JSON.stringify({ project: connectForm.name || top, files, arch: 'force' }) });
      setNotice(`'${r.project?.name || top}' 등록 완료 · 임베딩 → 코딩 스타일 → 아키텍처 분석이 백그라운드로 진행됩니다 (1~3분).`);
      await refresh();
    });
  };

  const openArch = (name) => run('arch', async () => {
    const r = await api(apiBase, `/api/arch/${encodeURIComponent(name)}`);
    setArchView({ name, markdown: r.markdown });
  });

  const removeRemote = (name) => {
    if (!window.confirm(`'${name}' 원격 프로젝트 등록을 지울까요? (PC 의 파일은 그대로)`)) return;
    run('remove', async () => { await api(apiBase, `/api/remote/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }); await refresh(); });
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
        <div className="aw-tabs" role="tablist">
          {CONNECT_MODES.map((m) => (
            <button key={m.id} type="button" role="tab" className={connectMode === m.id ? 'active' : ''}
              onClick={() => { setConnectMode(m.id); setNotice(''); }}>{m.label}</button>
          ))}
        </div>
        <p className="aw-help">{CONNECT_MODES.find((m) => m.id === connectMode).help}</p>

        {connectMode === 'upload' ? (
          <div className="aw-form">
            <label className="field">
              <span>프로젝트 이름 (선택 · 비우면 폴더 이름)</span>
              <input value={connectForm.name} onChange={(e) => setConnectForm({ ...connectForm, name: e.target.value })} />
            </label>
            <label className={`aw-filebtn big ${busy === 'upload' ? 'disabled' : ''}`}>
              {busy === 'upload' ? '올리는 중…' : '폴더 선택해서 올리기'}
              <input type="file" webkitdirectory="" directory="" multiple hidden disabled={busy === 'upload'} onChange={uploadFolder} />
            </label>
          </div>
        ) : (
          <form className="aw-form" onSubmit={connectRepo}>
            <label className="field">
              <span>{CONNECT_MODES.find((m) => m.id === connectMode).field}</span>
              <input
                required
                placeholder={CONNECT_MODES.find((m) => m.id === connectMode).placeholder}
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
                <input placeholder="kotlin, dart, python…" value={connectForm.language} onChange={(e) => setConnectForm({ ...connectForm, language: e.target.value })} />
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
            {connectMode === 'server' && (
              <label className="aw-check">
                <input type="checkbox" checked={connectForm.init_if_missing} onChange={(e) => setConnectForm({ ...connectForm, init_if_missing: e.target.checked })} />
                새 프로젝트 (폴더·git init 생성)
              </label>
            )}
            <button type="submit" disabled={busy === 'connect'}>
              {busy === 'connect' ? '연결 중…' : connectMode === 'remote' ? '원격 PC 프로젝트로 등록' : '연결 · 벡터화'}
            </button>
          </form>
        )}
        {notice && <p className="aw-notice">{notice}</p>}

        <h4 className="aw-subhead">원격 PC 프로젝트</h4>
        <ul className="aw-list">
          {Object.values(remoteProjects).map((p) => (
            <li key={p.name}>
              <button type="button" className="aw-link" onClick={() => openArch(p.name)}>
                <strong>{p.name}</strong>
                <small>
                  {p.status === 'waiting-pc' ? `PC 대기 · ${p.client_path}` : `${p.profile || '?'} · 파일 ${p.files ?? '?'} · ${p.chunks ?? 0} chunks · ${p.status}`}
                  {p.arch_status ? ` · 아키텍처 ${p.arch_status === 'ready' ? '분석됨' : p.arch_status}` : ''}
                </small>
              </button>
              <button type="button" className="secondary aw-small" onClick={() => removeRemote(p.name)}>삭제</button>
            </li>
          ))}
          {Object.keys(remoteProjects).length === 0 && <li className="aw-empty">원격 PC 프로젝트가 없습니다.</li>}
        </ul>
        {archView && (
          <div className="aw-arch">
            <div className="aw-arch-head"><strong>{archView.name} 아키텍처 · 코딩 규칙</strong><button type="button" className="secondary aw-small" onClick={() => setArchView(null)}>닫기</button></div>
            <pre>{archView.markdown || '아직 분석 전입니다. IDE 에서 /arch 분석 을 실행하세요.'}</pre>
          </div>
        )}

        <h4 className="aw-subhead">이 맥의 레포</h4>
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
