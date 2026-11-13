import { useEffect, useState } from 'react';
import AgentWorkbench from './AgentWorkbench';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8010';

const defaultPrompt = `쇼핑몰, 영상 교육 플랫폼, 모바일 앱을 통합할 수 있는 보안 중심 프로젝트를 설계해줘. Java, Python, Dart, Kotlin, PostgreSQL을 사용하고 관리자/사용자/운영 보안 흐름을 포함해.`;

const promptTemplates = [
  '쇼핑몰 관리자 + 사용자 인증 + 주문 관리 + 보안 강화 구조를 설계해줘.',
  '영상 교육 플랫폼에서 강의 생성, 수강, 결제, 관리자 대시보드를 구현해줘.',
  '모바일 앱 백엔드와 웹 관리자용 서비스 구조를 설계하고 보안 흐름을 포함해줘.',
  '실시간 알림, 결제, 검색, 관리자 운영 로그까지 포함한 통합 플랫폼을 만들어줘.',
];

const menuItems = [
  { id: 'agent', label: 'Coding Agent' },
  { id: 'overview', label: 'Overview' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'cicd', label: 'CI/CD' },
  { id: 'security', label: 'Security' },
];

const defaultDeploymentSummary = [
  { label: 'Production', value: 'healthy', status: 'online' },
  { label: 'Staging', value: 'deploying', status: 'warning' },
  { label: 'Preview', value: '4 branches', status: 'info' },
  { label: 'Uptime', value: '99.97%', status: 'success' },
];

const defaultPipelineStages = [
  { name: 'Lint', status: 'passed' },
  { name: 'Tests', status: 'passed' },
  { name: 'Build', status: 'passed' },
  { name: 'Security Scan', status: 'running' },
  { name: 'Deploy', status: 'queued' },
];

const defaultRecentDeployments = [
  { env: 'production', version: 'v2.8.1', time: '2 minutes ago', status: 'success' },
  { env: 'staging', version: 'v2.8.2', time: '15 minutes ago', status: 'warning' },
  { env: 'preview', version: 'v2.8.3-pr42', time: '1 hour ago', status: 'success' },
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
  const [selectedView, setSelectedView] = useState('agent');
  const [loading, setLoading] = useState(false);
  const [deployLoading, setDeployLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState(initialLogs);
  const [projects, setProjects] = useState([]);
  const [deploymentSummary, setDeploymentSummary] = useState(defaultDeploymentSummary);
  const [recentDeployments, setRecentDeployments] = useState(defaultRecentDeployments);
  const [pipelineStages, setPipelineStages] = useState(defaultPipelineStages);
  const [engineLabel, setEngineLabel] = useState('engine 확인 중…');

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/health`)
      .then((res) => res.json())
      .then((data) => setEngineLabel(data.engine?.online ? `${data.model} · Rust engine` : 'Rust engine 오프라인'))
      .catch(() => setEngineLabel('백엔드 오프라인'));
  }, []);

  const appendLog = (level, text) => {
    setLogs((prev) => [{ level, text }, ...prev].slice(0, 6));
  };

  const loadProjects = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/projects`);
      if (!response.ok) {
        throw new Error('projects fetch failed');
      }
      const data = await response.json();
      setProjects(data.projects || []);
    } catch (err) {
      appendLog('error', '생성된 프로젝트 목록을 불러오지 못했습니다.');
    }
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
      await loadProjects();
    } catch (err) {
      setError('백엔드 서버가 실행 중인지 확인해 주세요. 로컬 API가 준비되어 있어야 합니다.');
      appendLog('error', '에이전트 실행 중 문제가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
    loadDeploymentStatus();
    loadCICDStatus();
  }, []);

  const loadDeploymentStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/deploy/status`);
      if (!response.ok) {
        throw new Error('deploy status unavailable');
      }
      const data = await response.json();
      setDeploymentSummary(data.summary || defaultDeploymentSummary);
      setRecentDeployments(data.recent_deployments || defaultRecentDeployments);
    } catch (err) {
      appendLog('error', '배포 상태를 불러오지 못했습니다.');
    }
  };

  const loadCICDStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/cicd/status`);
      if (!response.ok) {
        throw new Error('pipeline status unavailable');
      }
      const data = await response.json();
      setPipelineStages(data.pipeline || defaultPipelineStages);
    } catch (err) {
      appendLog('error', 'CI/CD 상태를 불러오지 못했습니다.');
    }
  };

  const handleDeployAction = async (action) => {
    try {
      setDeployLoading(true);
      appendLog('info', `${action} 작업을 트리거했습니다.`);

      const response = await fetch(`${API_BASE_URL}/api/deploy/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, environment: 'production' }),
      });

      if (!response.ok) {
        throw new Error('배포 트리거 실패');
      }

      const data = await response.json();
      appendLog('success', data.message || `${action} 상태가 큐에 등록되었습니다.`);
      await loadDeploymentStatus();
      await loadCICDStatus();
    } catch (err) {
      appendLog('error', '배포 작업 실행 중 문제가 발생했습니다.');
    } finally {
      setDeployLoading(false);
    }
  };

  const renderOverview = () => (
    <>
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
    </>
  );

  const renderDeploy = () => (
    <div className="deploy-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Deployment Center</p>
          <h2>프로젝트 배포 관리</h2>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => handleDeployAction('Build')} disabled={deployLoading}>Build</button>
          <button type="button" className="secondary" onClick={() => handleDeployAction('Deploy')} disabled={deployLoading}>Deploy</button>
          <button type="button" className="ghost" onClick={() => handleDeployAction('Rollback')} disabled={deployLoading}>Rollback</button>
        </div>
      </div>

      <div className="deploy-grid">
        {deploymentSummary.map((item) => (
          <div key={item.label} className="deploy-card">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <em className={`state ${item.status}`}>{item.status}</em>
          </div>
        ))}
      </div>

      <div className="deploy-panels">
        <section className="panel">
          <div className="panel-header">
            <h3>Recent Deployments</h3>
            <span>Last 3 runs</span>
          </div>
          <ul className="deploy-list">
            {recentDeployments.map((entry) => (
              <li key={`${entry.env}-${entry.version}`}>
                <div>
                  <strong>{entry.env}</strong>
                  <small>{entry.version}</small>
                </div>
                <span>{entry.time}</span>
                <em className={`state ${entry.status}`}>{entry.status}</em>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Environment Settings</h3>
            <span>Production</span>
          </div>
          <div className="settings-list">
            <div><label>Domain</label><span>app.example.com</span></div>
            <div><label>Branch</label><span>main</span></div>
            <div><label>Trigger</label><span>GitHub push</span></div>
            <div><label>Runner</label><span>GitHub Actions</span></div>
          </div>
        </section>
      </div>
    </div>
  );

  const renderCICD = () => (
    <div className="deploy-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">CI / CD</p>
          <h2>배포 파이프라인</h2>
        </div>
        <button type="button" onClick={() => handleDeployAction('Pipeline run')} disabled={deployLoading}>Run Pipeline</button>
      </div>

      <div className="pipeline-box">
        {pipelineStages.map((stage) => (
          <div key={stage.name} className={`pipeline-stage ${stage.status}`}>
            <span className="stage-dot" />
            <div>
              <strong>{stage.name}</strong>
              <small>{stage.status === 'passed' ? 'completed' : stage.status === 'running' ? 'in progress' : 'queued'}</small>
            </div>
          </div>
        ))}
      </div>

      <section className="panel">
        <div className="panel-header">
          <h3>Pipeline Notes</h3>
          <span>latest</span>
        </div>
        <ul className="check-list">
          <li>Docker image build 자동화</li>
          <li>Qdrant + Ollama 의존성 검증</li>
          <li>보안 스캔 및 정적 분석</li>
          <li>Azure / Docker 배포 준비</li>
        </ul>
      </section>
    </div>
  );

  const renderSecurity = () => (
    <div className="deploy-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Security</p>
          <h2>보안 운영 대시보드</h2>
        </div>
      </div>

      <div className="security-grid">
        <div className="security-card good">
          <h3>RBAC</h3>
          <p>관리자/사용자/운영자 권한 분리됨</p>
        </div>
        <div className="security-card good">
          <h3>JWT</h3>
          <p>토큰 기반 인증과 재발급 정책 구성</p>
        </div>
        <div className="security-card warning">
          <h3>Secrets</h3>
          <p>환경 변수 및 .env 보관 검토 필요</p>
        </div>
      </div>
    </div>
  );

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
          {engineLabel}
        </div>

        <nav className="menu-list">
          {menuItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={selectedView === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setSelectedView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {selectedView === 'overview' && (
          <>
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
          </>
        )}

        <div className="mini-card">
          <h3>Recent Projects</h3>
          {projects.length === 0 ? (
            <ul>
              <li>아직 생성된 프로젝트가 없습니다.</li>
            </ul>
          ) : (
            <ul>
              {projects.slice(0, 5).map((project) => (
                <li key={project.name}>{project.name}</li>
              ))}
            </ul>
          )}
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

        {selectedView === 'agent' && <AgentWorkbench apiBase={API_BASE_URL} />}
        {selectedView === 'overview' && renderOverview()}
        {selectedView === 'deploy' && renderDeploy()}
        {selectedView === 'cicd' && renderCICD()}
        {selectedView === 'security' && renderSecurity()}
      </main>
    </div>
  );
}

export default App;
