import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 이미지 스튜디오: 올리기 → 나누기(자동·격자) → 원하는 대로 가공(버튼·영역 선택·말로 가공) → 생성 → 내려받기(PNG·ZIP).
 * 가공은 서버(맥)에서: 배경 제거만 AI(rembg), 나머지는 즉시 처리. 생성은 FLUX.1-schnell.
 */
async function api(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `요청 실패 (${res.status})`);
  return data;
}

const dataUrl = (b64) => `data:image/png;base64,${b64}`;
let seq = 0;
const newId = () => `i${Date.now()}-${seq++}`;

function measure(b64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => resolve([0, 0]);
    img.src = dataUrl(b64);
  });
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const baseName = (name) => name.replace(/\.[^.]+$/, '');

// 한 번 누르면 바로 적용되는 가공 버튼
const QUICK = [
  { label: '배경 제거 (AI)', ops: [{ op: 'remove_bg' }, { op: 'trim' }], slow: true },
  { label: '여백 정리', ops: [{ op: 'trim' }] },
  { label: '정사각형', ops: [{ op: 'pad_square' }] },
  { label: '좌우 반전', ops: [{ op: 'flip', axis: 'x' }] },
  { label: '상하 반전', ops: [{ op: 'flip', axis: 'y' }] },
  { label: '90° 회전', ops: [{ op: 'rotate', deg: 90 }] },
  { label: '흑백', ops: [{ op: 'grayscale' }] },
  { label: '색 반전', ops: [{ op: 'invert' }] },
  { label: '2배 (픽셀)', ops: [{ op: 'scale', factor: 2, pixel: true }] },
  { label: '½ 축소', ops: [{ op: 'scale', factor: 0.5 }] },
];

export default function ImageStudio({ apiBase }) {
  const [items, setItems] = useState([]);           // {id, name, b64, w, h, history, future, checked}
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [tab, setTab] = useState('split');          // split | edit | generate
  const [zoom, setZoom] = useState(0);              // 0 = 화면에 맞춤
  const [boxes, setBoxes] = useState([]);           // 나누기 결과 테두리 (원본 위)
  const [sel, setSel] = useState(null);             // 영역 선택 {x,y,w,h} (원본 좌표)
  const drag = useRef(null);
  const stageRef = useRef(null);
  const fileRef = useRef(null);

  // 나누기 설정
  const [split, setSplit] = useState({ mode: 'auto', cols: 4, rows: 4, gap: 6, min_size: 8, padding: 2, tolerance: 24, transparent: true, skip_empty: true, trim_cells: false });
  // 가공 설정
  const [ed, setEd] = useState({ w: 64, h: 64, mode: 'fit', cells: 32, colors: 24, deg: 45, tint: '#ff8800', tintAmount: 0.3, bright: 1.2, contrast: 1.2, sat: 1.3, outline: '#000000', outlineW: 1, clear: '#ffffff', instruction: '' });
  // 생성 설정
  const [gen, setGen] = useState({ prompt: '', w: 512, h: 512, transparent: true, pixel: 0, ref: '', count: 1, project: '', kind: '', verify: true, useSize: true });
  // 프로젝트 아트 컨셉 (IDE 에서 /art 로 분석한 것)
  const [arts, setArts] = useState([]);
  const [artMd, setArtMd] = useState('');
  const [artEdit, setArtEdit] = useState('');
  useEffect(() => { api(apiBase, '/api/art').then((r) => setArts(r.projects || [])).catch(() => undefined); }, [apiBase]);
  useEffect(() => {
    if (!gen.project) { setArtMd(''); return; }
    api(apiBase, `/api/art/${encodeURIComponent(gen.project)}`).then((r) => setArtMd(r.markdown)).catch(() => setArtMd(''));
  }, [apiBase, gen.project]);
  const reviseArt = () => gen.project && artEdit.trim() && run('아트 컨셉 수정 중…', async () => {
    const res = await fetch(`${apiBase}/api/art/${encodeURIComponent(gen.project)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: artEdit }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.detail || '수정 실패');
    setArtMd(d.markdown);
    setArtEdit('');
  });

  const selected = items.find((i) => i.id === selectedId) || null;
  // 미리보기 영역의 실제 크기 (맞춤 배율 계산용)
  const [stageSize, setStageSize] = useState([640, 520]);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setStageSize([el.clientWidth - 24, Math.max(320, el.clientHeight - 24)]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const addItems = useCallback(async (list, select = true) => {
    const made = [];
    for (const it of list) {
      const [w, h] = it.w ? [it.w, it.h] : await measure(it.b64);
      made.push({ id: newId(), name: it.name, b64: it.b64, w, h, history: [], future: [], checked: true });
    }
    setItems((prev) => [...prev, ...made]);
    if (select && made[0]) setSelectedId(made[0].id);
    return made;
  }, []);

  const run = async (label, fn) => {
    setBusy(label);
    setError('');
    setNote('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  // ---- 올리기 (파일 선택 · 끌어다 놓기 · 붙여넣기) -----------------------------------------
  const upload = async (files) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    await run('불러오는 중…', async () => {
      await addItems(await Promise.all(imgs.map(async (f) => ({ name: baseName(f.name) || '붙여넣은 이미지', b64: await fileToB64(f) }))));
      setBoxes([]);
      setSel(null);
    });
  };

  useEffect(() => {
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); upload(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  // ---- 이미지 바꾸기 (되돌리기 기록) -----------------------------------------------------------
  const replace = async (id, b64, size) => {
    const [w, h] = size || (await measure(b64));
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, history: [...i.history, i.b64].slice(-30), future: [], b64, w, h } : i)));
    setBoxes([]);
    setSel(null);
  };

  const undo = () => selected?.history.length && setItems((prev) => prev.map((i) => (i.id === selected.id
    ? { ...i, b64: i.history[i.history.length - 1], history: i.history.slice(0, -1), future: [i.b64, ...i.future] } : i)));
  const redo = () => selected?.future.length && setItems((prev) => prev.map((i) => (i.id === selected.id
    ? { ...i, b64: i.future[0], future: i.future.slice(1), history: [...i.history, i.b64] } : i)));
  useEffect(() => { if (selected) measure(selected.b64).then(([w, h]) => (w !== selected.w || h !== selected.h) && setItems((p) => p.map((i) => (i.id === selected.id ? { ...i, w, h } : i)))); }, [selected?.b64]); // eslint-disable-line

  const applyOps = (ops, label = '가공 중…') => selected && run(label, async () => {
    const r = await api(apiBase, '/api/images/edit', { image: selected.b64, ops });
    await replace(selected.id, r.image, r.size);
  });

  const applyInstruction = () => selected && ed.instruction.trim() && run('말로 가공 중… (지시 해석 → 적용)', async () => {
    const r = await api(apiBase, '/api/images/edit', { image: selected.b64, instruction: ed.instruction });
    await replace(selected.id, r.image, r.size);
    setNote(`적용한 가공: ${r.ops.map((o) => Object.entries(o).map(([k, v]) => (k === 'op' ? v : `${k}=${v}`)).join(' ')).join(' → ')}`);
  });

  // ---- 나누기 --------------------------------------------------------------------------------
  const doSplit = () => selected && run('나누는 중…', async () => {
    const r = await api(apiBase, '/api/images/split', { image: selected.b64, ...split });
    setBoxes(r.pieces.map((p) => p.box));
    const base = selected.name;
    await addItems(r.pieces.map((p, i) => ({ name: `${base}_${String(i + 1).padStart(2, '0')}`, b64: p.image, w: p.size[0], h: p.size[1] })), false);
    setNote(`${r.pieces.length}개로 나눴습니다 (배경: ${r.background === 'transparent' ? '투명' : r.background}). 왼쪽 목록에 추가됨`);
  });

  // ---- 영역 선택 (드래그) --------------------------------------------------------------------
  const scale = () => {
    const img = stageRef.current?.querySelector('img');
    return img && selected ? img.clientWidth / selected.w : 1;
  };
  const toImage = (e) => {
    const rect = stageRef.current.querySelector('img').getBoundingClientRect();
    const s = scale();
    return [Math.max(0, Math.min(selected.w, Math.round((e.clientX - rect.left) / s))), Math.max(0, Math.min(selected.h, Math.round((e.clientY - rect.top) / s)))];
  };
  const onDown = (e) => { if (!selected || e.button !== 0) return; const p = toImage(e); drag.current = p; setSel({ x: p[0], y: p[1], w: 0, h: 0 }); };
  const onMove = (e) => {
    if (!drag.current) return;
    const [x0, y0] = drag.current;
    const [x1, y1] = toImage(e);
    setSel({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
  };
  const onUp = () => { drag.current = null; setSel((s) => (s && s.w > 1 && s.h > 1 ? s : null)); };

  const cropSel = (asNew) => selected && sel && run('자르는 중…', async () => {
    const r = await api(apiBase, '/api/images/edit', { image: selected.b64, ops: [{ op: 'crop', ...sel }] });
    if (asNew) await addItems([{ name: `${selected.name}_영역`, b64: r.image, w: r.size[0], h: r.size[1] }]);
    else await replace(selected.id, r.image, r.size);
  });

  // ---- 생성 ----------------------------------------------------------------------------------
  const doGenerate = () => gen.prompt.trim() && run(`생성 중… (한 장 15~40초${gen.count > 1 ? ` × ${gen.count}` : ''})`, async () => {
    for (let i = 0; i < gen.count; i++) {
      setBusy(`생성 중… ${i + 1}/${gen.count} (한 장 15~40초)`);
      const useArtSize = gen.project && gen.kind && gen.useSize;
      const r = await api(apiBase, '/api/images/generate', {
        prompt: gen.prompt, width: useArtSize ? 0 : gen.w, height: useArtSize ? 0 : gen.h, transparent: gen.kind ? undefined : gen.transparent,
        pixel: Number(gen.pixel) || 0, ref_search: gen.ref.trim(), translate: true, project: gen.project, kind: gen.kind, verify: gen.verify,
      });
      await addItems([{ name: `생성_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`, b64: r.images[0], w: r.sizes[0][0], h: r.sizes[0][1] }], i === 0);
      setNote(`${r.verify?.scores ? `컨셉 일치 ${r.verify.scores.join('→')}/10 · ` : ''}${r.model} · ${r.timings.total}초 · 프롬프트: ${r.prompt_used}${r.credits?.length ? ` · 참고: ${r.credits[0].title} (${r.credits[0].license})` : ''}`);
    }
  });

  // ---- 내려받기 ------------------------------------------------------------------------------
  const download = (it) => {
    const a = document.createElement('a');
    a.href = dataUrl(it.b64);
    a.download = `${it.name}.png`;
    a.click();
  };
  const downloadZip = (list) => list.length && run('ZIP 만드는 중…', async () => {
    const res = await fetch(`${apiBase}/api/images/zip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: list.map((i) => ({ name: i.name, data: i.b64 })) }),
    });
    if (!res.ok) throw new Error(`ZIP 실패 (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'images.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  const remove = (id) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (id === selectedId) { setSelectedId(''); setBoxes([]); setSel(null); }
  };
  const checked = items.filter((i) => i.checked);
  const setAll = (v) => setItems((prev) => prev.map((i) => ({ ...i, checked: v })));

  const num = (obj, set, key, props = {}) => (
    <input type="number" value={obj[key]} onChange={(e) => set({ ...obj, [key]: e.target.value === '' ? '' : Number(e.target.value) })} {...props} />
  );

  // 화면 맞춤 배율
  const fit = selected ? Math.min(1, stageSize[0] / Math.max(selected.w, 1), stageSize[1] / Math.max(selected.h, 1)) : 1;
  const view = zoom || (selected && Math.max(selected.w, selected.h) < 160 ? Math.max(1, Math.min(8, Math.floor(Math.min(320, stageSize[0]) / Math.max(selected.w, selected.h)))) : fit);

  return (
    <div className="is-wrap">
      {error && <div className="aw-error" role="alert">{error}</div>}

      {/* 작업 목록 */}
      <section className="panel is-list">
        <div className="panel-header">
          <h3>이미지 ({items.length})</h3>
          <button type="button" onClick={() => fileRef.current?.click()}>올리기</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        <div className="is-thumbs" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}>
          {!items.length && <p className="aw-empty">이미지를 끌어다 놓거나, 올리기 · 붙여넣기(⌘V)</p>}
          {items.map((it) => (
            <div key={it.id} className={`is-thumb${it.id === selectedId ? ' active' : ''}`} onClick={() => { setSelectedId(it.id); setBoxes([]); setSel(null); }}>
              <input type="checkbox" checked={it.checked} onClick={(e) => e.stopPropagation()}
                onChange={(e) => setItems((p) => p.map((i) => (i.id === it.id ? { ...i, checked: e.target.checked } : i)))} title="ZIP 에 포함" />
              <img src={dataUrl(it.b64)} alt="" />
              <div className="is-thumb-info">
                <input value={it.name} title={it.name} onClick={(e) => e.stopPropagation()} onChange={(e) => setItems((p) => p.map((i) => (i.id === it.id ? { ...i, name: e.target.value } : i)))} />
                <small>{it.w}×{it.h}</small>
              </div>
              <button type="button" className="link" title="삭제" onClick={(e) => { e.stopPropagation(); remove(it.id); }}>✕</button>
            </div>
          ))}
        </div>
        {items.length > 0 && (
          <div className="is-list-actions">
            <button type="button" className="secondary aw-small" onClick={() => setAll(!checked.length || checked.length < items.length)}>
              {checked.length === items.length ? '모두 해제' : '모두 선택'}
            </button>
            <button type="button" onClick={() => downloadZip(checked)} disabled={!checked.length || !!busy}>ZIP ({checked.length})</button>
          </div>
        )}
      </section>

      {/* 캔버스 */}
      <section className="panel is-stage-panel">
        <div className="panel-header">
          <h3>{selected ? `${selected.name} · ${selected.w}×${selected.h}` : '미리보기'}</h3>
          {selected && (
            <div className="is-stage-tools">
              <button type="button" className="secondary aw-small" onClick={undo} disabled={!selected.history.length || !!busy} title="되돌리기">↶</button>
              <button type="button" className="secondary aw-small" onClick={redo} disabled={!selected.future.length || !!busy} title="다시하기">↷</button>
              <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="확대">
                <option value={0}>맞춤</option>
                {[0.25, 0.5, 1, 2, 4, 8].map((z) => <option key={z} value={z}>{z * 100}%</option>)}
              </select>
              <button type="button" className="aw-small" onClick={() => download(selected)}>PNG</button>
            </div>
          )}
        </div>
        {busy && <div className="is-busy"><span className="is-spin" /> {busy}</div>}
        {note && !busy && <p className="is-note">{note}</p>}
        <div className="is-stage" ref={stageRef} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}>
          {selected ? (
            <div className="is-canvas" style={{ width: selected.w * view, height: selected.h * view }} onMouseDown={onDown}>
              <img src={dataUrl(selected.b64)} alt="" draggable={false} style={{ width: selected.w * view, height: selected.h * view, imageRendering: view >= 2 ? 'pixelated' : 'auto' }} />
              {boxes.map((b, i) => (
                <div key={i} className="is-box" style={{ left: b[0] * view, top: b[1] * view, width: b[2] * view, height: b[3] * view }}><span>{i + 1}</span></div>
              ))}
              {sel && <div className="is-sel" style={{ left: sel.x * view, top: sel.y * view, width: sel.w * view, height: sel.h * view }} />}
            </div>
          ) : (
            <div className="is-drop" onClick={() => fileRef.current?.click()}>
              <strong>이미지를 여기에 끌어다 놓으세요</strong>
              <span>여러 그림이 들어 있는 한 장 → 나누기 · 원하는 대로 가공 · AI 로 생성</span>
            </div>
          )}
        </div>
        {selected && sel && (
          <div className="is-sel-bar">
            <span>선택 영역 {sel.x},{sel.y} · {sel.w}×{sel.h}</span>
            <button type="button" className="aw-small" onClick={() => cropSel(false)} disabled={!!busy}>이 영역만 남기기</button>
            <button type="button" className="secondary aw-small" onClick={() => cropSel(true)} disabled={!!busy}>새 이미지로 복사</button>
            <button type="button" className="link" onClick={() => setSel(null)}>취소</button>
          </div>
        )}
        {selected && !sel && <p className="is-hint">이미지 위를 드래그하면 영역을 골라 자를 수 있습니다.</p>}
      </section>

      {/* 도구 */}
      <section className="panel is-tools">
        <div className="is-tabs">
          {[['split', '나누기'], ['edit', '가공'], ['generate', 'AI 생성']].map(([k, l]) => (
            <button key={k} type="button" className={tab === k ? 'active' : 'secondary'} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {tab === 'split' && (
          <div className="is-form">
            <div className="is-seg">
              <label><input type="radio" checked={split.mode === 'auto'} onChange={() => setSplit({ ...split, mode: 'auto' })} /> 자동 (그림마다)</label>
              <label><input type="radio" checked={split.mode === 'grid'} onChange={() => setSplit({ ...split, mode: 'grid' })} /> 격자 (칸으로)</label>
            </div>
            {split.mode === 'auto' ? (
              <>
                <p className="is-help">배경(투명이나 가장자리 색)으로 떨어져 있는 그림을 하나씩 잘라냅니다. 에셋 모음·아이콘 묶음에 알맞습니다.</p>
                <label>병합 간격 (px) {num(split, setSplit, 'gap', { min: 0, max: 64 })}<small>이 거리 안의 조각(눈·그림자)은 하나로</small></label>
                <label>최소 크기 (px) {num(split, setSplit, 'min_size', { min: 1 })}<small>이보다 작은 점은 버림</small></label>
                <label>여백 (px) {num(split, setSplit, 'padding', { min: 0, max: 64 })}</label>
              </>
            ) : (
              <>
                <p className="is-help">가로×세로 칸으로 똑같이 나눕니다. 스프라이트 시트·타일셋에 알맞습니다.</p>
                <div className="is-row">
                  <label>가로 칸 {num(split, setSplit, 'cols', { min: 1, max: 64 })}</label>
                  <label>세로 칸 {num(split, setSplit, 'rows', { min: 1, max: 64 })}</label>
                </div>
                <label className="is-check"><input type="checkbox" checked={split.skip_empty} onChange={(e) => setSplit({ ...split, skip_empty: e.target.checked })} /> 빈 칸 건너뛰기</label>
                <label className="is-check"><input type="checkbox" checked={split.trim_cells} onChange={(e) => setSplit({ ...split, trim_cells: e.target.checked })} /> 칸마다 여백 정리</label>
              </>
            )}
            <label>배경 허용 오차 {num(split, setSplit, 'tolerance', { min: 0, max: 128 })}<small>배경색과 이만큼 비슷하면 배경으로 봄</small></label>
            {split.mode === 'auto' && (
              <label className="is-check"><input type="checkbox" checked={split.transparent} onChange={(e) => setSplit({ ...split, transparent: e.target.checked })} /> 단색 배경을 투명하게</label>
            )}
            <button type="button" onClick={doSplit} disabled={!selected || !!busy}>나누기</button>
          </div>
        )}

        {tab === 'edit' && (
          <div className="is-form">
            <label>말로 가공
              <textarea rows={2} placeholder="예) 배경 지우고 64x64 픽셀아트로, 검은 외곽선 1px, 좌우 반전" value={ed.instruction}
                onChange={(e) => setEd({ ...ed, instruction: e.target.value })} />
            </label>
            <button type="button" onClick={applyInstruction} disabled={!selected || !ed.instruction.trim() || !!busy}>말로 가공 적용</button>

            <div className="is-quick">
              {QUICK.map((q) => (
                <button key={q.label} type="button" className="secondary aw-small" disabled={!selected || !!busy}
                  onClick={() => applyOps(q.ops, q.slow ? '배경 제거 중… (첫 사용은 모델 준비로 조금 더 걸림)' : '가공 중…')}>{q.label}</button>
              ))}
            </div>

            <fieldset><legend>크기</legend>
              <div className="is-row">
                <label>가로 {num(ed, setEd, 'w', { min: 0 })}</label>
                <label>세로 {num(ed, setEd, 'h', { min: 0 })}</label>
              </div>
              <select value={ed.mode} onChange={(e) => setEd({ ...ed, mode: e.target.value })}>
                <option value="fit">비율 유지 (남는 곳 투명)</option>
                <option value="cover">비율 유지 (꽉 채우고 자름)</option>
                <option value="stretch">늘려서 맞춤</option>
                <option value="nearest">픽셀 그대로 (계단 유지)</option>
              </select>
              <button type="button" className="aw-small" disabled={!selected || !!busy} onClick={() => applyOps([{ op: 'resize', w: ed.w || 0, h: ed.h || 0, mode: ed.mode }])}>크기 바꾸기</button>
            </fieldset>

            <fieldset><legend>픽셀아트</legend>
              <div className="is-row">
                <label>가로 칸 {num(ed, setEd, 'cells', { min: 4, max: 512 })}</label>
                <label>색 수 {num(ed, setEd, 'colors', { min: 2, max: 256 })}</label>
              </div>
              <button type="button" className="aw-small" disabled={!selected || !!busy} onClick={() => applyOps([{ op: 'pixelate', cells: ed.cells, colors: ed.colors }])}>픽셀아트로</button>
            </fieldset>

            <fieldset><legend>색</legend>
              <div className="is-row">
                <label>색조 <input type="color" value={ed.tint} onChange={(e) => setEd({ ...ed, tint: e.target.value })} /></label>
                <label>세기 {num(ed, setEd, 'tintAmount', { min: 0, max: 1, step: 0.05 })}</label>
                <button type="button" className="aw-small" disabled={!selected || !!busy} onClick={() => applyOps([{ op: 'tint', color: ed.tint, amount: ed.tintAmount }])}>적용</button>
              </div>
              <div className="is-row">
                <label>밝기 {num(ed, setEd, 'bright', { min: 0, max: 3, step: 0.1 })}</label>
                <label>대비 {num(ed, setEd, 'contrast', { min: 0, max: 3, step: 0.1 })}</label>
                <label>채도 {num(ed, setEd, 'sat', { min: 0, max: 3, step: 0.1 })}</label>
              </div>
              <button type="button" className="aw-small" disabled={!selected || !!busy}
                onClick={() => applyOps([{ op: 'brightness', amount: ed.bright }, { op: 'contrast', amount: ed.contrast }, { op: 'saturation', amount: ed.sat }])}>밝기·대비·채도 적용</button>
            </fieldset>

            <fieldset><legend>외곽선 · 배경색 지우기 · 회전</legend>
              <div className="is-row">
                <label>외곽선 <input type="color" value={ed.outline} onChange={(e) => setEd({ ...ed, outline: e.target.value })} /></label>
                <label>두께 {num(ed, setEd, 'outlineW', { min: 1, max: 16 })}</label>
                <button type="button" className="aw-small" disabled={!selected || !!busy} onClick={() => applyOps([{ op: 'outline', color: ed.outline, width: ed.outlineW }])}>외곽선</button>
              </div>
              <div className="is-row">
                <label>지울 색 <input type="color" value={ed.clear} onChange={(e) => setEd({ ...ed, clear: e.target.value })} /></label>
                <button type="button" className="aw-small" disabled={!selected || !!busy} onClick={() => applyOps([{ op: 'clear_color', color: ed.clear, tolerance: 24 }])}>바깥쪽 이 색 투명하게</button>
              </div>
              <div className="is-row">
                <label>각도 {num(ed, setEd, 'deg', { min: -360, max: 360 })}</label>
                <button type="button" className="aw-small" disabled={!selected || !!busy} onClick={() => applyOps([{ op: 'rotate', deg: ed.deg }])}>회전</button>
              </div>
            </fieldset>
          </div>
        )}

        {tab === 'generate' && (
          <div className="is-form">
            <label>프로젝트 아트 컨셉
              <select value={gen.project} onChange={(e) => setGen({ ...gen, project: e.target.value })}>
                <option value="">적용 안 함</option>
                {arts.map((a) => <option key={a.project} value={a.project}>{a.project}</option>)}
              </select>
              <small>{arts.length ? '고르면 그 프로젝트의 화풍·색·크기가 자동 적용됩니다' : 'IDE 채팅에서 /art 로 프로젝트를 분석하면 여기 나타납니다'}</small>
            </label>
            {artMd && (
              <details className="is-art">
                <summary>컨셉 보기 · 수정</summary>
                <pre>{artMd}</pre>
                <div className="is-row">
                  <input value={artEdit} placeholder="예) 더 밝게, 파스텔 톤으로" onChange={(e) => setArtEdit(e.target.value)} />
                  <button type="button" className="aw-small" onClick={reviseArt} disabled={!artEdit.trim() || !!busy}>수정</button>
                </div>
              </details>
            )}
            <label>종류
              <select value={gen.kind} onChange={(e) => setGen({ ...gen, kind: e.target.value })}>
                <option value="">지정 안 함</option>
                {[['character', '캐릭터'], ['enemy', '적'], ['item', '아이템'], ['icon', '아이콘'], ['tile', '타일'], ['background', '배경'], ['ui', 'UI'], ['effect', '이펙트'], ['portrait', '초상화']]
                  .map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {gen.project && gen.kind && (
              <label className="is-check"><input type="checkbox" checked={gen.useSize} onChange={(e) => setGen({ ...gen, useSize: e.target.checked })} /> 컨셉의 종류별 크기 사용</label>
            )}
            <label className="is-check"><input type="checkbox" checked={gen.verify} onChange={(e) => setGen({ ...gen, verify: e.target.checked })} /> 생성 후 컨셉과 대조해 낮으면 다시 그리기</label>
            <label>그림 설명 (한글 가능)
              <textarea rows={3} placeholder="예) 귀여운 초록 슬라임 몬스터, 큰 눈, 게임 캐릭터" value={gen.prompt} onChange={(e) => setGen({ ...gen, prompt: e.target.value })} />
            </label>
            <div className="is-row">
              <label>가로 {num(gen, setGen, 'w', { min: 16, max: 1536 })}</label>
              <label>세로 {num(gen, setGen, 'h', { min: 16, max: 1536 })}</label>
            </div>
            <div className="is-quick">
              {[[64, 64], [128, 128], [512, 512], [1024, 1024], [1024, 576], [576, 1024]].map(([w, h]) => (
                <button key={`${w}x${h}`} type="button" className="secondary aw-small" onClick={() => setGen({ ...gen, w, h })}>{w}×{h}</button>
              ))}
            </div>
            <label className="is-check"><input type="checkbox" checked={gen.transparent} onChange={(e) => setGen({ ...gen, transparent: e.target.checked })} /> 투명 배경 (캐릭터·아이템·아이콘)</label>
            <label>픽셀아트 칸 수 (0 = 끔) {num(gen, setGen, 'pixel', { min: 0, max: 256 })}</label>
            <label>참고할 무료 이미지 검색어 (선택)
              <input value={gen.ref} placeholder="예) pixel art monster — CC0·퍼블릭 도메인만, 스타일만 참고" onChange={(e) => setGen({ ...gen, ref: e.target.value })} />
            </label>
            <label>장 수 {num(gen, setGen, 'count', { min: 1, max: 4 })}</label>
            <button type="button" onClick={doGenerate} disabled={!gen.prompt.trim() || !!busy}>생성</button>
            <p className="is-help">맥의 Z-Image-Turbo(Apache-2.0)로 생성합니다. 생성하는 동안 코딩 모델을 잠시 내리고, 다음 코딩 요청 때 다시 올립니다(약 15초).</p>
          </div>
        )}
      </section>
    </div>
  );
}
