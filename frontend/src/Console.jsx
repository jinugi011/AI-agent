import { useEffect, useRef, useState } from 'react';

const QUICK = [
  { label: '서비스 상태', cmd: './scripts/agent.sh status' },
  { label: 'git 상태', cmd: 'git status -sb && git log --oneline -5' },
  { label: '메모리', cmd: 'memory_pressure | tail -1; vm_stat | head -6' },
  { label: '모델 목록', cmd: 'ls -lh models' },
  { label: '엔진 로그', cmd: 'tail -40 backend/data/agent_state/engine.log' },
];

/** 명령 창: 이 맥의 셸에서 명령 실행 (소유자만). cd 는 다음 명령에도 이어진다. ↑↓ 이전 명령 */
export default function Console({ apiBase }) {
  const [entries, setEntries] = useState([]); // {cmd, cwd, out, exit}
  const [cmd, setCmd] = useState('');
  const [cwd, setCwd] = useState(() => localStorage.getItem('yang.console.cwd') || '');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState(() => JSON.parse(localStorage.getItem('yang.console.history') || '[]'));
  const [hi, setHi] = useState(-1);
  const ctrl = useRef(null);
  const outRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; }, [entries]);
  useEffect(() => { localStorage.setItem('yang.console.cwd', cwd); }, [cwd]);

  const run = async (command) => {
    const c = command.trim();
    if (!c || running) return;
    if (c === 'clear') { setEntries([]); setCmd(''); return; }
    const h = [c, ...history.filter((x) => x !== c)].slice(0, 100);
    setHistory(h);
    localStorage.setItem('yang.console.history', JSON.stringify(h));
    setHi(-1);
    setCmd('');
    const idx = entries.length;
    setEntries((e) => [...e, { cmd: c, cwd, out: '', exit: null }]);
    setRunning(true);
    const ac = new AbortController();
    ctrl.current = ac;
    const append = (patch) => setEntries((e) => e.map((x, i) => (i === idx ? { ...x, ...patch(x) } : x)));
    try {
      const res = await fetch(`${apiBase}/api/admin/shell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: c, cwd }), signal: ac.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || `요청 실패 (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.out) append((x) => ({ out: x.out + m.out }));
          if (m.exit !== undefined) { append(() => ({ exit: m.exit })); if (m.cwd) setCwd(m.cwd); }
        }
      }
    } catch (err) {
      append((x) => ({ out: x.out + (err.name === 'AbortError' ? '\n[중지됨]\n' : `\n[오류] ${err.message}\n`), exit: x.exit ?? -1 }));
    } finally {
      setRunning(false);
      ctrl.current = null;
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(cmd); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const n = Math.min(hi + 1, history.length - 1); if (n >= 0) { setHi(n); setCmd(history[n]); } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); const n = hi - 1; setHi(n); setCmd(n >= 0 ? history[n] : ''); }
    else if (e.key === 'c' && e.ctrlKey && running) { e.preventDefault(); ctrl.current?.abort(); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); setEntries([]); }
  };

  const shortCwd = (p) => (p ? p.replace(/^\/Users\/[^/]+/, '~') : '~/AI-agent');

  return (
    <div className="aw-grid cs-grid">
      <section className="panel aw-card aw-wide">
        <div className="panel-header">
          <div><p className="eyebrow">맥 서버</p><h3>명령 창</h3></div>
          <div className="sa-logbar">
            {QUICK.map((q) => <button key={q.label} type="button" className="secondary aw-small" disabled={running} onClick={() => run(q.cmd)}>{q.label}</button>)}
            <button type="button" className="secondary aw-small" onClick={() => setEntries([])}>지우기</button>
          </div>
        </div>
        <p className="tm-help">이 맥의 셸(zsh)에서 실행됩니다. <b>cd</b> 는 다음 명령에도 이어지고, ↑↓ 로 이전 명령, Ctrl+C 로 중지, Ctrl+L 로 화면 지우기.
          대화형 프로그램(vim, top 등)은 쓸 수 없고 명령 하나는 최대 10분까지 실행됩니다.</p>
        <div className="cs-term" ref={outRef} onClick={() => inputRef.current?.focus()}>
          {entries.map((e, i) => (
            <div key={i} className="cs-entry">
              <div className="cs-cmd"><span className="cs-cwd">{shortCwd(e.cwd)}</span> $ {e.cmd}</div>
              {e.out && <pre>{e.out}</pre>}
              {e.exit !== null && e.exit !== 0 && <div className="cs-exit">종료 코드 {e.exit}</div>}
            </div>
          ))}
          <div className="cs-input">
            <span className="cs-cwd">{shortCwd(cwd)}</span> $
            <input ref={inputRef} autoFocus spellCheck={false} autoComplete="off" value={cmd} disabled={running}
              placeholder={running ? '실행 중… (Ctrl+C 중지)' : '명령 입력 후 Enter'} onChange={(e) => setCmd(e.target.value)} onKeyDown={onKey} />
            {running && <button type="button" className="secondary aw-small" onClick={() => ctrl.current?.abort()}>중지</button>}
          </div>
        </div>
      </section>
    </div>
  );
}
