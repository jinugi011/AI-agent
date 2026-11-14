import { useCallback, useEffect, useState } from 'react';

async function api(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `요청 실패 (${res.status})`);
  return data;
}

const fmt = (t) => (t ? t.replace('T', ' ').slice(0, 16) : '—');

/** 원격 접속 토큰 발급·폐기. 이 맥 또는 '내 Tailscale 계정'으로 열었을 때만 동작 (토큰으로는 접근 불가). */
export default function TokenManager({ apiBase }) {
  const [who, setWho] = useState(null);
  const [data, setData] = useState({ default: null, tokens: [] });
  const [name, setName] = useState('');
  const [issued, setIssued] = useState(null); // 방금 발급한 토큰 (한 번만 표시)
  const [shownDefault, setShownDefault] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [w, t] = await Promise.all([api(apiBase, '/api/admin/whoami'), api(apiBase, '/api/admin/tokens')]);
      setWho(w);
      setData(t);
      setError('');
    } catch (e) {
      setError(e.message.includes('403') || e.message.includes('원격')
        ? '이 페이지는 이 맥이나 허용된 Tailscale 계정으로만 열 수 있습니다.'
        : e.message);
    }
  }, [apiBase]);

  useEffect(() => { refresh(); }, [refresh]);

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopied('');
    }
  };

  const issue = async (e) => {
    e.preventDefault();
    try {
      const r = await api(apiBase, '/api/admin/tokens', { method: 'POST', body: JSON.stringify({ name }) });
      setIssued({ name: r.item.name, token: r.token });
      setName('');
      refresh();
    } catch (err) { setError(err.message); }
  };

  const revoke = async (t) => {
    if (!window.confirm(`'${t.name}' 토큰을 폐기할까요? 이 토큰을 쓰는 PC 는 바로 접속이 끊깁니다.`)) return;
    try { await api(apiBase, `/api/admin/tokens/${t.id}`, { method: 'DELETE' }); refresh(); } catch (err) { setError(err.message); }
  };

  const showDefault = async () => {
    try { setShownDefault((await api(apiBase, '/api/admin/tokens/default')).token); } catch (err) { setError(err.message); }
  };

  const rotateDefault = async () => {
    if (!window.confirm('기본 토큰을 재발급할까요? 기존 기본 토큰을 쓰는 모든 PC 의 접속이 끊깁니다.')) return;
    try { setShownDefault((await api(apiBase, '/api/admin/tokens/default/rotate', { method: 'POST' })).token); refresh(); } catch (err) { setError(err.message); }
  };

  return (
    <div className="aw-grid tm-grid">
      {error && <div className="aw-error" role="alert">{error}</div>}

      <section className="panel aw-card">
        <div className="panel-header">
          <h3>내 로그인 확인</h3>
          <span>토큰 관리는 본인만</span>
        </div>
        {who ? (
          <p className="tm-who">
            <span className={`aw-status ${who.via === 'tailscale' ? 'passed' : 'queued'}`}>{who.via === 'tailscale' ? 'Tailscale' : '로컬'}</span>
            <strong>{who.user}</strong>
          </p>
        ) : <p className="aw-empty">확인 중…</p>}
        <p className="tm-help">
          이 페이지는 <b>이 맥</b> 또는 <b>허용된 Tailscale 계정</b>으로 열었을 때만 동작합니다.
          토큰으로 접속한 요청은 토큰을 만들거나 볼 수 없습니다.
        </p>

        <form className="aw-form" onSubmit={issue}>
          <label className="field">
            <span>새 토큰 발급 — 사용할 기기 이름</span>
            <input required maxLength={60} placeholder="예) 회사 노트북, 집 데스크톱" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit">토큰 발급</button>
        </form>

        {issued && (
          <div className="tm-issued">
            <p><b>{issued.name}</b> 토큰이 발급되었습니다. <b>지금 한 번만</b> 표시됩니다 — 복사해서 그 PC 의 플러그인에 입력하세요.</p>
            <code>{issued.token}</code>
            <div className="tm-actions">
              <button type="button" onClick={() => copy(issued.token, 'issued')}>{copied === 'issued' ? '복사됨' : '복사'}</button>
              <button type="button" className="secondary" onClick={() => setIssued(null)}>닫기</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel aw-card aw-wide">
        <div className="panel-header">
          <h3>발급된 토큰</h3>
          <span>기기별로 폐기 가능</span>
        </div>
        <ul className="aw-list">
          {data.tokens.map((t) => (
            <li key={t.id}>
              <div className="aw-link tm-row">
                <strong>{t.name}</strong>
                <small>{t.prefix}… · 발급 {fmt(t.created_at)} · 마지막 사용 {fmt(t.last_used)}</small>
              </div>
              <button type="button" className="secondary aw-small" onClick={() => revoke(t)}>폐기</button>
            </li>
          ))}
          {data.tokens.length === 0 && <li className="aw-empty">아직 발급한 기기별 토큰이 없습니다.</li>}
        </ul>

        <div className="panel-header tm-default-head">
          <h3>기본 토큰</h3>
          <span>tailscale.sh token 으로 보던 토큰</span>
        </div>
        {data.default?.exists ? (
          <div className="tm-default">
            <code>{shownDefault || `${data.default.prefix}••••••••••••••••`}</code>
            <div className="tm-actions">
              {shownDefault
                ? <button type="button" onClick={() => copy(shownDefault, 'default')}>{copied === 'default' ? '복사됨' : '복사'}</button>
                : <button type="button" className="secondary" onClick={showDefault}>보기</button>}
              <button type="button" className="secondary" onClick={rotateDefault}>재발급</button>
            </div>
          </div>
        ) : <p className="aw-empty">기본 토큰이 없습니다. 기기별 토큰을 발급해 쓰세요.</p>}
      </section>
    </div>
  );
}
