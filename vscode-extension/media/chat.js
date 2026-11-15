// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const log = $('log');
  const input = /** @type {HTMLTextAreaElement} */ ($('input'));
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const setup = $('setup');
  const statusText = $('status-text');
  const statusDot = /** @type {HTMLElement} */ (document.querySelector('#status .dot'));
  const assistants = new Map();
  const tools = new Map();
  let busy = false;

  // ---- 렌더링 유틸 ------------------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function markdown(src) {
    const parts = String(src).split(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g);
    let html = '';
    for (let i = 0; i < parts.length; i += 3) {
      html += inline(parts[i]);
      if (i + 2 < parts.length) html += `<pre><code data-lang="${esc(parts[i + 1])}">${esc(parts[i + 2])}</code></pre>`;
    }
    return html;
  }

  function inline(text) {
    return esc(text)
      .split('\n')
      .map((line) => {
        let l = line
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        if (/^#{1,4} /.test(line)) return `<p class="h">${l.replace(/^#{1,4} /, '')}</p>`;
        if (/^\s*[-*] /.test(line)) return `<p class="li">• ${l.replace(/^\s*[-*] /, '')}</p>`;
        return l ? `<p>${l}</p>` : '';
      })
      .join('');
  }

  function add(el) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.appendChild(el);
    if (nearBottom) log.scrollTop = log.scrollHeight;
    return el;
  }

  function div(cls, html) {
    const el = document.createElement('div');
    el.className = cls;
    if (html !== undefined) el.innerHTML = html;
    return el;
  }

  function setBusy(b) {
    busy = b;
    stopBtn.hidden = !b;
    sendBtn.toggleAttribute('disabled', b);
    $('hint').textContent = b ? '작업 중… (중단 가능)' : '';
  }

  // ---- 상태 / 설정 카드 ---------------------------------------------------------
  function renderStatus(s) {
    if (s.remote) {
      const host = (s.server || '').replace(/^https?:\/\//, '');
      if (!s.backend) {
        statusDot.className = 'dot off';
        statusText.textContent = `원격 연결 실패 · ${host || '주소 없음'}`;
        setup.hidden = false;
        setup.innerHTML = `<p>원격 서버에 연결할 수 없습니다.<br><small>${esc(s.error || '')}</small></p><button data-act="configureRemote">🔑 토큰 다시 입력</button>`;
        return;
      }
      setup.hidden = true;
      if (s.engine) {
        statusDot.className = 'dot on';
        statusText.textContent = `🌐 ${s.engine.name} @ ${host}${s.repo ? ' · ' + s.repo : ''}`;
      } else {
        statusDot.className = 'dot warn';
        statusText.textContent = `🌐 서버 엔진 꺼짐 @ ${host}`;
      }
      return;
    }
    if (!s.backend) {
      statusDot.className = 'dot off';
      statusText.textContent = '백엔드 꺼짐';
      setup.hidden = false;
      setup.innerHTML = s.defaultServer
        ? `<p>Yang Coding 서버에 접속하려면 <b>접속 토큰</b>만 입력하세요.<br><small>서버: ${esc(s.defaultServer.replace(/^https?:\/\//, ''))}</small></p><button data-act="configureRemote">🔑 토큰 입력하고 접속</button> <button data-act="backend">이 PC에서 백엔드 시작</button>`
        : `<p>로컬 에이전트 백엔드가 실행되고 있지 않습니다.</p><button data-act="backend">백엔드 시작</button>`;
      return;
    }
    const repo = s.repo ? ` · ${s.repo}` : s.workspace ? ` · ${s.workspace}` : '';
    if (s.engine) {
      statusDot.className = 'dot on';
      statusText.textContent = `${s.engine.name} (ctx ${s.engine.ctx})${repo}`;
    } else {
      statusDot.className = 'dot warn';
      statusText.textContent = `엔진 꺼짐${repo}`;
    }
    const downloading = s.models.filter((m) => m.downloading && !m.downloaded);
    if (s.engine && downloading.length === 0) {
      setup.hidden = true;
      return;
    }
    setup.hidden = false;
    const rows = s.models
      .map((m) => {
        let action;
        if (m.downloaded) action = s.engine ? '<span class="ok">설치됨</span>' : `<button data-act="start" data-model="${esc(m.key)}">엔진 시작</button>`;
        else if (m.downloading) action = `<div class="bar"><span style="width:${(m.progress * 100).toFixed(1)}%"></span></div><small>${(m.progress * 100).toFixed(0)}%</small>`;
        else action = `<button class="secondary" data-act="download" data-model="${esc(m.key)}">다운로드 ${m.size_gb}GB</button>`;
        return `<li><div><strong>${esc(m.label)}</strong><small>${esc(m.note)}</small></div><div class="act">${action}</div></li>`;
      })
      .join('');
    setup.innerHTML = `<p>${s.engine ? '모델 다운로드 진행 중' : '코딩 모델을 선택해 엔진을 시작하세요. 채팅으로 "30B 모델 받아줘"라고 해도 됩니다.'}</p><ul>${rows}</ul>`;
  }

  setup.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'backend') vscode.postMessage({ type: 'startBackend' });
    else if (act === 'configureRemote') vscode.postMessage({ type: 'configureRemote' });
    else {
      btn.setAttribute('disabled', '');
      btn.textContent = act === 'start' ? '로딩 중…' : '시작 중…';
      vscode.postMessage({ type: 'setup', action: act, model: btn.dataset.model });
    }
  });

  // ---- 도구 카드 ----------------------------------------------------------------
  const ICON = { running: '◌', done: '✓', error: '✕', denied: '⊘' };

  function renderTool(ev) {
    let card = tools.get(ev.id);
    if (!card) {
      card = add(div('tool'));
      tools.set(ev.id, card);
    }
    card.className = `tool ${ev.status}`;
    let extra = '';
    if (ev.diff) {
      extra = ` <span class="diffstat"><span class="add">+${ev.diff.added}</span> <span class="del">−${ev.diff.removed}</span></span>
        <a href="#" data-diff="${esc(ev.detail)}" data-path="${esc(ev.diff.path)}">diff</a>
        <a href="#" data-open="${esc(ev.diff.path)}">열기</a>`;
    }
    const detail = ev.detail && !ev.diff ? `<details${ev.status === 'error' ? ' open' : ''}><summary></summary><pre>${esc(ev.detail)}</pre></details>` : '';
    // 생성한 이미지 미리보기 (data: URL 만 허용)
    const imgs = (ev.images || []).filter((u) => /^data:image\/(png|webp|jpeg);base64,/.test(u))
      .map((u) => `<img class="tool-img" src="${u}" alt="">`).join('');
    card.innerHTML = `<div class="tool-head"><span class="icon">${ICON[ev.status] || '•'}</span><span class="title">${esc(ev.title)}</span>${extra}</div>${imgs ? `<div class="tool-imgs">${imgs}</div>` : ''}${detail}`;
  }

  log.addEventListener('click', (e) => {
    const a = /** @type {HTMLElement} */ (e.target).closest('a,button');
    if (!a) return;
    if (a.dataset.diff !== undefined) { e.preventDefault(); vscode.postMessage({ type: 'openDiff', id: a.dataset.diff, path: a.dataset.path }); }
    else if (a.dataset.open !== undefined) { e.preventDefault(); vscode.postMessage({ type: 'openFile', path: a.dataset.open }); }
    else if (a.dataset.undo !== undefined) { vscode.postMessage({ type: 'undo' }); a.setAttribute('disabled', ''); }
    else if (a.dataset.answer) {
      const card = a.closest('.approval');
      vscode.postMessage({ type: 'approval', reqId: card.dataset.req, answer: a.dataset.answer });
      card.querySelector('.buttons').innerHTML = `<small>${{ allow: '허용함', always: '이 대화에서 항상 허용', deny: '거부함' }[a.dataset.answer]}</small>`;
    }
  });

  // ---- 확장 → 웹뷰 메시지 -----------------------------------------------------------
  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'status': return renderStatus(m);
      case 'user': {
        const files = (m.attachments || []).map((n) => `<span class="att-tag">📎 ${esc(n)}</span>`).join('');
        add(div('msg user', markdown(m.text) + (files ? `<div class="att-tags">${files}</div>` : '')));
        log.scrollTop = log.scrollHeight;
        return;
      }
      case 'attachment': return renderAttachment(m);
      case 'assistant-start': {
        const el = add(div('msg assistant streaming', '<span class="typing">생각 중…</span>'));
        assistants.set(m.id, el);
        return;
      }
      case 'assistant-delta': {
        const el = assistants.get(m.id);
        if (el) {
          const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
          el.innerHTML = markdown(m.text) || '<span class="typing">작업 준비 중…</span>';
          if (nearBottom) log.scrollTop = log.scrollHeight;
        }
        return;
      }
      case 'assistant-end': {
        const el = assistants.get(m.id);
        if (el) {
          el.classList.remove('streaming');
          if (!el.textContent.trim() || el.querySelector('.typing')) el.remove();
          else if (m.stats) el.appendChild(div('stats', esc(m.stats)));
        }
        return;
      }
      case 'tool': return renderTool(m);
      case 'approval': {
        const card = add(div('approval'));
        card.dataset.req = m.reqId;
        card.innerHTML = `<div><strong>${m.kind === 'run' ? '명령 실행 승인' : '파일 수정 승인'}</strong></div>
          <pre>${esc(m.kind === 'run' ? m.detail : `${m.title}  ${m.detail}`)}</pre>
          <div class="buttons"><button data-answer="allow">허용</button><button class="secondary" data-answer="always">항상 허용</button><button class="secondary" data-answer="deny">거부</button></div>`;
        log.scrollTop = log.scrollHeight;
        return;
      }
      case 'turn-end':
        if (m.changedFiles > 0) add(div('turn-end', `${m.changedFiles}개 파일 변경됨 <button class="link" data-undo>되돌리기</button>`));
        return;
      case 'notice': add(div(`notice ${m.level}`, markdown(m.text))); log.scrollTop = log.scrollHeight; return;
      case 'busy': return setBusy(m.busy);
      case 'cleared':
        log.innerHTML = '';
        assistants.clear();
        tools.clear();
        welcome();
        return;
    }
  });

  // ---- 첨부 파일 (이미지 · PDF · MD) ------------------------------------------------
  // 📎 버튼 → IDE 의 파일 선택 창 / 붙여넣기(이미지) / 끌어다 놓기 → IDE 가 서버로 올려 분석 → 칩으로 표시
  /** @type {Map<string, {key:string,name:string,status:string,id?:string,kind?:string,detail?:string}>} */
  const atts = new Map();
  const attBar = document.createElement('div');
  attBar.id = 'attachments';
  attBar.hidden = true;
  $('composer').insertBefore(attBar, input);
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.id = 'attach';
  attachBtn.className = 'secondary';
  attachBtn.title = '파일 첨부 (이미지 · PDF · MD) — 붙여넣기·끌어다 놓기도 가능';
  attachBtn.textContent = '📎';
  $('composer').querySelector('.row')?.insertBefore(attachBtn, $('hint'));
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));

  const KIND = { image: '이미지', pdf: 'PDF', text: '문서' };
  function renderAttachments() {
    attBar.hidden = atts.size === 0;
    attBar.innerHTML = [...atts.values()].map((a) => {
      const state = a.status === 'uploading' ? '<span class="spin"></span> 분석 중…'
        : a.status === 'error' ? '⚠ 실패' : `${KIND[a.kind] || a.kind || ''} ✓`;
      return `<span class="att ${a.status}" title="${esc(a.detail || '')}">📎 ${esc(a.name)} <small>${state}</small>` +
        `<button type="button" class="link" data-att-remove="${esc(a.key)}" title="첨부 취소">✕</button></span>`;
    }).join('');
    const pending = [...atts.values()].some((a) => a.status === 'uploading');
    if (!busy) $('hint').textContent = pending ? '첨부 분석 중… 끝나면 보낼 수 있습니다' : '';
  }
  function renderAttachment(m) {
    atts.set(m.key, { ...(atts.get(m.key) || {}), ...m });
    renderAttachments();
  }
  attBar.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const key = t.getAttribute('data-att-remove');
    if (key) { atts.delete(key); renderAttachments(); }
  });

  let seq = 0;
  /** 브라우저 쪽에서 받은 파일(붙여넣기·끌어다 놓기) → base64 로 IDE 에 넘김 */
  function attachFile(file) {
    if (file.size > 25 * 1024 * 1024) {
      add(div('notice warn', `<p>${esc(file.name)}: 25MB 를 넘는 파일은 첨부할 수 없습니다.</p>`));
      return;
    }
    const key = `w${Date.now()}-${seq++}`;
    const name = file.name && file.name !== 'image.png' ? file.name : `붙여넣은-이미지-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`;
    renderAttachment({ key, name, status: 'uploading' });
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).replace(/^data:[^,]*,/, '');
      vscode.postMessage({ type: 'attachData', key, name, data });
    };
    reader.onerror = () => renderAttachment({ key, name, status: 'error', detail: '파일을 읽을 수 없습니다' });
    reader.readAsDataURL(file);
  }
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); files.forEach(attachFile); }
  });
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) files.forEach(attachFile);
    else {
      // VS Code 탐색기에서 끌어온 경우: 파일 경로(uri 목록)만 넘어온다 → IDE 가 직접 읽음
      const uris = (e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '')
        .split(/\r?\n/).map((x) => x.trim()).filter((x) => /^(file|vscode-[\w-]+):/.test(x) || x.startsWith('/'));
      if (uris.length) vscode.postMessage({ type: 'attachUris', uris });
    }
  });

  // ---- 입력 ---------------------------------------------------------------------
  function send() {
    const text = input.value.trim();
    if (busy) return;
    const ready = [...atts.values()].filter((a) => a.status === 'ready' && a.id);
    if (!text && !ready.length) return;
    if ([...atts.values()].some((a) => a.status === 'uploading')) {
      $('hint').textContent = '첨부 분석이 끝나면 보낼 수 있습니다';
      return;
    }
    vscode.postMessage({
      type: 'send',
      text: text || '첨부한 파일을 분석해서 무엇을 만들 수 있는지 정리해 주세요.',
      attachments: ready.map((a) => a.id),
    });
    atts.clear();
    renderAttachments();
    input.value = '';
    autosize();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 240) + 'px';
  }

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  input.addEventListener('keydown', (e) => {
    // 한글 IME 조합 중 Enter 는 글자 확정이므로 전송하지 않는다
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', autosize);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

  function welcome() {
    add(div('welcome', `<p><strong>Yang Coding</strong></p>
      <p>현재 워크스페이스에서 자연어로 코딩합니다. 처음 요청 시 레포가 자동으로 연결·벡터화됩니다.</p>
      <p class="li">• "회원가입 API 만들고 테스트 돌려줘"</p>
      <p class="li">• "앞으로 커밋 메시지는 한국어로 해줘" (선호 저장)</p>
      <p class="li">• 📎 화면 캡처·디자인 시안·PDF·MD 를 첨부하고 "이대로 만들어줘" (붙여넣기·끌어다 놓기 가능)</p>
      <p class="li">• <code>/help</code> 명령 보기</p>`));
  }
  welcome();
  input.focus();
})();
