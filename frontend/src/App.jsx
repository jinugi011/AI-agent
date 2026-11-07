import { useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8010';

const defaultPrompt = `쇼핑몰, 영상 교육 플랫폼, 모바일 앱을 통합할 수 있는 보안 중심 프로젝트를 설계해줘. Java, Python, Dart, Kotlin, PostgreSQL을 사용하고 관리자/사용자/운영 보안 흐름을 포함해.`;

const promptTemplates = [
  '쇼핑몰 관리자 + 사용자 인증 + 주문 관리 + 보안 강화 구조를 설계해줘.',
  '영상 교육 플랫폼에서 강의 생성, 수강, 결제, 관리자 대시보드를 구현해줘.',
  '모바일 앱 백엔드와 웹 관리자용 서비스 구조를 설계하고 보안 흐름을 포함해줘.',
  '실시간 알림, 결제, 검색, 관리자 운영 로그까지 포함한 통합 플랫폼을 만들어줘.',
];

const initialLogs = [
  { level: 'info', text: '로컬 모델 연결이 준비되었습니다.' },
  { level: 'info', text: 'YANGShopping 보안 패턴 컨텍스트를 로드했습니다.' },
  { level: 'info', text: '작업 폴더와 도메인 구성을 확인 중입니다.' },
];

function App() {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [projectType, setProjectType] = useState('ecommerce');
  const [stack, setStack] = useState(['Python', 'FastAPI', 'React', 'PostgreSQL']);
  const [mode, setMode] = useState('implement');
  const [workspace, setWorkspace] = useState('/Users/jinugi/Desktop/Project2026/AI-agent/generated_projects');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState(initialLogs);

  const appendLog = (level, text) => {
    setLogs((prev) => [{ level, text }, ...prev].slice(0, 6));
  };

  const handleGenerate = async () => {
    try {
      setLoading(true);
      setError('');
      appendLog('info', `${mode} 모드로 요구사항을 분석하고 있습니다.`);

      const response = await fetch(`${API_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          project_type: projectType,
          stack,
        }),
      });

      if (!response.ok) {
        throw new Error('백엔드 호출 실패');
      }

      const data = await response.json();
      setResult(data.result);
      appendLog('success', '프로젝트 초안 생성이 완료되었습니다.');
      appendLog('info', `다음 작업: ${data.result?.tasks?.[0]?.task ?? '핵심 구현 단계 준비'}`);
    } catch (err) {
      setError('백엔드 서버가 실행 중인지 확인해 주세요. 로컬 API가 준비되어 있어야 합니다.');
      appendLog('error', '에이전트 실행 중 문제가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-box">
          <span className="brand-badge">AI</span>
          <div>
            <h1>Coding Agent</h1>
            <small>Local Workspace</small>
          </div>
        </div>

        <div className="status-pill">
          <span className="status-dot" />
          qwen2.5-coder:7b
        </div>

        <label className="field">
          <span>프로젝트 유형</span>
          <select value={projectType} onChange={(e) => setProjectType(e.target.value)}>
            <option value="ecommerce">쇼핑몰</option>
            <option value="education">영상 교육</option>
            <option value="mobile">모바일 앱</option>
            <option value="platform">통합 플랫폼</option>
          </select>
        </label>

        <label className="field">
          <span>기술 스택</span>
          <input value={stack.join(', ')} onChange={(e) => setStack(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
        </label>

        <label className="field">
          <span>작업 경로</span>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        </label>

        <div className="sidebar-actions">
          <button onClick={handleGenerate} disabled={loading}>
            {loading ? '처리 중...' : '프로젝트 생성'}
          </button>
          <button className="secondary" type="button">
            코드 리뷰
          </button>
        </div>

        <div className="mini-card">
          <h3>Context Memory</h3>
          <ul>
            <li>YANGShopping 보안 패턴</li>
            <li>JWT + RBAC + PII 마스킹</li>
            <li>API / service / repo 구조</li>
            <li>React + PostgreSQL + Java/Python 혼합</li>
          </ul>
        </div>
      </aside>

      <main className="main-panel">
        <div className="topbar">
          <div className="mode-switch">
            {['implement', 'plan', 'review', 'debug'].map((item) => (
              <button
                key={item}
                type="button"
                className={mode === item ? 'mode-btn active' : 'mode-btn'}
                onClick={() => setMode(item)}
              >
                {item === 'implement' ? '구현' : item === 'plan' ? '기획' : item === 'review' ? '검토' : '디버그'}
              </button>
            ))}
          </div>
          <div className="workspace-status">상태: 준비 완료</div>
        </div>

        <div className="composer-panel">
          <label className="field">
            <span>작업 지시</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="구현할 기능과 요구사항을 입력하세요."
            />
          </label>

          <div className="template-row">
            {promptTemplates.map((template) => (
              <button key={template} type="button" className="template-btn" onClick={() => setPrompt(template)}>
                템플릿
              </button>
            ))}
          </div>

          <div className="action-row">
            <button onClick={handleGenerate} disabled={loading}>
              {loading ? '에이전트 실행 중...' : '코딩 에이전트 실행'}
            </button>
            <button type="button" className="ghost">
              작업 저장
            </button>
          </div>
        </div>

        <div className="metric-grid">
          <div className="metric-card">
            <span>Context</span>
            <strong>7 sources</strong>
          </div>
          <div className="metric-card">
            <span>Security</span>
            <strong>RBAC + JWT</strong>
          </div>
          <div className="metric-card">
            <span>Architecture</span>
            <strong>API / Service / UI</strong>
          </div>
          <div className="metric-card">
            <span>Delivery</span>
            <strong>3 phase plan</strong>
          </div>
        </div>

        <div className="content-grid">
          <section className="panel">
            <div className="panel-header">
              <h3>Agent Activity</h3>
              <span>Live</span>
            </div>
            <ul className="log-list">
              {logs.map((log, index) => (
                <li key={`${log.text}-${index}`} className={`log ${log.level}`}>
                  <span className="bullet" />
                  {log.text}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>Execution Plan</h3>
              <span>{result ? 'Ready' : 'Waiting'}</span>
            </div>

            {error && <div className="error-box">{error}</div>}

            {!result ? (
              <div className="empty-state">
                <p>요구사항을 입력하면 에이전트가 프로젝트 구조와 실행 계획을 생성합니다.</p>
              </div>
            ) : (
              <div className="result-box">
                <h2>{result.title}</h2>
                <p>{result.summary}</p>

                <div className="grid-2">
                  <div>
                    <h4>기술 스택</h4>
                    <ul>{result.stack?.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                  <div>
                    <h4>보안 핵심</h4>
                    <ul>{result.security?.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                </div>

                <div className="grid-2">
                  <div>
                    <h4>기능</h4>
                    <ul>{result.features?.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                  <div>
                    <h4>아키텍처</h4>
                    <ul>{result.architecture?.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                </div>

                <div>
                  <h4>실행 계획</h4>
                  <ul>{result.tasks?.map((task, index) => <li key={`${task.phase}-${index}`}>{task.phase}: {task.task}</li>)}</ul>
                </div>

                <div>
                  <h4>생성 파일</h4>
                  <ul>{result.generated_files?.map((file) => <li key={file.path}>{file.path} — {file.purpose}</li>)}</ul>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
