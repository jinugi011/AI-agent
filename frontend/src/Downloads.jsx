import { useEffect, useState } from 'react';

const STEPS = {
  vscode: [
    'VS Code → 확장(Cmd/Ctrl+Shift+X) → 오른쪽 위 … → "VSIX에서 설치…" → 받은 파일 선택',
    'Cmd/Ctrl+Shift+P → "Yang Coding: 원격 접속 설정" → 아래 서버 주소 → 접속 토큰 입력',
    '오른쪽 보조 사이드바의 Yang Coding 채팅에서 바로 사용',
  ],
  intellij: [
    'Settings → Plugins → ⚙ → "Install Plugin from Disk…" → 받은 zip 선택 → IDE 재시작',
    'Settings → Tools → Yang Coding → 접속 방식 remote → 서버 주소·접속 토큰 입력 → 원격 연결 테스트',
    '오른쪽 사이드바 Yang Coding 채팅, 하단 Yang Coding 로그 콘솔에서 사용',
  ],
};

const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1e3)}KB`);

/** IDE 플러그인 다운로드 + 설치/연결 안내 (이 맥 또는 내 Tailscale 계정으로만). */
export default function Downloads({ apiBase, onOpenTokens }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    fetch(`${apiBase}/api/downloads`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.detail || r.status); return d; })
      .then(setData)
      .catch((e) => setError(String(e.message || e)));
  }, [apiBase]);

  // 이 페이지를 Tailscale 주소로 열었다면 그 주소가 곧 플러그인에 넣을 서버 주소
  const here = window.location.origin;
  const viaTailscale = here.includes('.ts.net') || /^https?:\/\/100\./.test(here);
  const addresses = viaTailscale ? [here] : [data?.server?.https, data?.server?.http].filter(Boolean);

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 1500); } catch { /* 무시 */ }
  };

  return (
    <div className="aw-grid tm-grid">
      {error && <div className="aw-error" role="alert">{error.includes('403') ? '이 페이지는 이 맥이나 허용된 Tailscale 계정으로만 열 수 있습니다.' : error}</div>}

      <section className="panel aw-card aw-wide dl-wide">
        <div className="panel-header">
          <h3>플러그인 다운로드</h3>
          <span>외부 PC 에 설치해 원격으로 코딩</span>
        </div>
        <div className="dl-cards">
          {(data?.items ?? []).map((it) => (
            <div key={it.kind} className="dl-card">
              <div className="dl-head">
                <strong>{it.label}</strong>
                {it.version && <span className="aw-status passed">v{it.version}</span>}
              </div>
              {it.available ? (
                <>
                  <small>{it.filename} · {kb(it.size)} · {it.updated_at.replace('T', ' ')}</small>
                  <a className="dl-button" href={`${apiBase}${it.url}`} download={it.filename}>다운로드</a>
                </>
              ) : <p className="aw-empty">아직 빌드된 설치 파일이 없습니다.</p>}
              <ol className="dl-steps">{STEPS[it.kind].map((s) => <li key={s}>{s}</li>)}</ol>
            </div>
          ))}
          {!data && !error && <p className="aw-empty">불러오는 중…</p>}
        </div>
      </section>

      <section className="panel aw-card">
        <div className="panel-header">
          <h3>플러그인에 넣을 서버 주소</h3>
          <span>{viaTailscale ? '지금 연 주소' : 'Tailscale 주소'}</span>
        </div>
        {addresses.length ? (
          <ul className="aw-list">
            {addresses.map((a, i) => (
              <li key={a}>
                <div className="aw-link tm-row">
                  <strong>{a}</strong>
                  <small>{viaTailscale ? '이 기기에서 열린 주소' : i === 0 ? '1순위 (HTTPS)' : '2순위 (HTTPS 가 안 될 때)'}</small>
                </div>
                <button type="button" className="secondary aw-small" onClick={() => copy(a)}>{copied === a ? '복사됨' : '복사'}</button>
              </li>
            ))}
          </ul>
        ) : <p className="aw-empty">Tailscale 주소가 없습니다. 맥에서 scripts/tailscale.sh on 을 실행하세요.</p>}
        <p className="tm-help">외부 PC 에도 Tailscale 을 설치하고 같은 계정으로 로그인해야 이 주소에 접속됩니다.</p>
        <button type="button" onClick={onOpenTokens}>접속 토큰 발급하러 가기</button>
      </section>
    </div>
  );
}
