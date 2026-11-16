/**
 * 원격 E2E: 실제 agent.ts / tools.ts 를 Node 에서 돌려, 원격 PC 처럼 Tailscale 주소로 서버에 붙어 시나리오를 수행한다.
 *   node scripts/e2e/remote-e2e.js <서버URL> <템플릿 프로젝트> [시나리오...]
 * 결과: 시나리오별 PASS/FAIL + 근거. 로그는 stdout.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const shim = require('./vscode-shim');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'vscode') return require.resolve('./vscode-shim');
  return origResolve.call(this, req, ...rest);
};

const [, , SERVER, TEMPLATE, ...ONLY] = process.argv;
const OUT = path.resolve(__dirname, '../../out');
const work = fs.mkdtempSync('/tmp/yang-e2e-');
const PROJECT = `e2e-${Date.now().toString(36)}`; // 시험마다 새 프로젝트 (이전 시험 데이터 오염 방지)
const root = path.join(work, PROJECT);
execSync(`cp -R "${TEMPLATE}" "${root}"`);
if (fs.existsSync(path.join(root, 'pubspec.yaml'))) { fs.rmSync(path.join(root, '.dart_tool'), { recursive: true, force: true }); execSync('flutter pub get >/dev/null 2>&1', { cwd: root }); }
process.env.PATH = `/Users/jinugi/AI-agent/backend/.venv/bin:${process.env.PATH}`; // python -m pytest

shim.SHIM.root = root;
Object.assign(shim.SHIM.settings, {
  'localAgent.mode': 'remote', 'localAgent.serverUrl': SERVER, 'localAgent.approveEdits': 'auto',
  'localAgent.approveCommands': 'ask', 'localAgent.approveFileOps': 'ask', 'localAgent.autoCheck': true,
  'localAgent.maxSteps': 20, 'localAgent.maxTokens': 4096, 'localAgent.temperature': 0.2,
});

const { AgentSession } = require(path.join(OUT, 'agent.js'));
const { OriginalContentProvider } = require(path.join(OUT, 'tools.js'));
const hk = require(path.join(OUT, 'harnesskit.js'));

function newSession(rec) {
  const log = {
    line: (t, lv) => { if (lv !== 'result') console.log(`    ${t.split('\n')[0].slice(0, 200)}`); rec.log.push(t); },
    raw: (t) => { rec.raw = (rec.raw || '') + t; }, show: () => undefined,
  };
  const emit = (ev) => {
    if (ev.type === 'tool') { rec.tools.push(ev); }
    if (ev.type === 'assistant-delta') rec.text = ev.text;
    if (ev.type === 'assistant-end' && process.env.E2E_SHOW) { console.log('    [원문]\n' + (rec.raw || '').slice(-2500)); rec.raw = ''; }
    if (ev.type === 'notice') rec.notices.push(ev.text);
  };
  const approve = async (kind, title) => { rec.approvals.push({ kind, title }); return 'allow'; };
  return new AgentSession(emit, approve, new OriginalContentProvider(), log);
}
const editor = { openFiles: [] };
const exists = (p) => fs.existsSync(path.join(root, p));
const read = (p) => (exists(p) ? fs.readFileSync(path.join(root, p), 'utf8') : '');
const pytest = () => { try { return { ok: true, out: execSync('python -m pytest -q 2>&1', { cwd: root }).toString() }; } catch (e) { return { ok: false, out: e.stdout?.toString() ?? '' }; } };
const all = (dir) => execSync(`cd "${root}" && find ${dir} -type f -not -path '*/__pycache__/*' 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
const toolKinds = (rec) => rec.log.filter((l) => l.startsWith('▶ ')).map((l) => l.slice(2).split(' ')[0]);

const SCENARIOS = {
  async typo(rec) {
    // 실제 사용자 요청 (오타: 덱스트 = 텍스트). 기존 카운터 앱을 유지하고 Hello 텍스트 박스만 추가해야 한다
    const before = read('lib/main.dart');
    await newSession(rec).send('Hello 덱스트 박스를 만들어줘', editor);
    const after = read('lib/main.dart');
    const keptCounter = /_incrementCounter|_counter/.test(after);
    const noDex = !/Dex|DEX|swap|Swap/.test(after);
    const hello = /Hello/.test(after) && /(TextField|TextFormField|Text\(|Container|Card)/.test(after);
    const asked = rec.text.includes('?') && after === before;
    return { pass: (keptCounter && noDex && hello) || asked,
      why: `카운터 유지 ${keptCounter} · DEX 없음 ${noDex} · Hello 박스 ${hello} · 확인질문 ${asked} · 도구 ${toolKinds(rec).join(',')} · 답: ${rec.text.slice(0, 160).replace(/\n/g, ' ')}` };
  },
  async flutter(rec) {
    const before0 = read('lib/main.dart');
    await newSession(rec).send('카운터 화면 AppBar 에 리셋 버튼(아이콘 Icons.refresh, tooltip "리셋")을 추가해서 누르면 카운터가 0 이 되게 해줘. 위젯 테스트도 추가하고 flutter test 로 확인해줘.', editor);
    let analyze = '', test = '';
    try { analyze = execSync('flutter analyze 2>&1', { cwd: root }).toString(); } catch (e) { analyze = e.stdout?.toString() ?? 'FAIL'; }
    try { test = execSync('flutter test 2>&1', { cwd: root }).toString(); } catch (e) { test = 'FAIL ' + (e.stdout?.toString() ?? '').slice(-400); }
    const main = read('lib/main.dart');
    const ok = /Icons\.refresh/.test(main) && /tooltip:\s*'리셋'|tooltip:\s*"리셋"/.test(main) && /All tests passed/.test(test) && /No issues found/.test(analyze);
    const { keptRatio } = require(path.join(OUT, 'wsinfo.js'));
    const kept = Math.round(keptRatio(before0, main) * 100);
    const rewrote = rec.log.some((l) => /^▶ FILE lib\/main\.dart/.test(l));
    return { pass: ok && kept >= 80 && !rewrote, why: `기존 코드 유지 ${kept}% · main.dart 통째로 다시 쓰기 ${rewrote} · refresh ${/Icons\.refresh/.test(main)} · analyze ${/No issues found/.test(analyze) ? 'OK' : analyze.trim().split('\n').slice(-3).join(' ')} · test ${/All tests passed/.test(test) ? 'OK' : test.slice(-200)} · 도구 ${toolKinds(rec).join(',')}` };
  },
  async pending(rec) {
    // 웹에서 '원격 PC 경로'로 등록 (서버에는 아직 없는 경로) → PC(플러그인)가 찾아서 올림
    const pcPath = path.join(work, 'pc-registered-proj');
    const reg = await fetch(`${SERVER}/api/repos/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: pcPath, name: '', profile: '', language: '', init_if_missing: false }) }).then((x) => x.json());
    execSync(`cp -R "${TEMPLATE}" "${pcPath}"`);
    const { syncPendingProjects } = require(path.join(OUT, 'remoteIndex.js'));
    const done = await syncPendingProjects({ line: (t) => rec.log.push(t), raw() {}, show() {} });
    let st = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      st = (await fetch(`${SERVER}/api/remote/projects`).then((x) => x.json())).projects['pc-registered-proj'];
      if (st?.status === 'ready' && st.arch_status !== 'analyzing') break;
    }
    await fetch(`${SERVER}/api/remote/projects/pc-registered-proj`, { method: 'DELETE' });
    return { pass: !!reg.pending && done.includes('pc-registered-proj') && st?.status === 'ready' && st?.chunks > 0,
      why: `PC 대기 등록 ${!!reg.pending} · PC 가 올림 ${done.join(',')} · 상태 ${st?.status} · 청크 ${st?.chunks} · 아키텍처 ${st?.arch_status}` };
  },
  async analyze(rec) {
    await newSession(rec).send('이 프로젝트의 구조와 코딩 스타일, 아키텍처 규칙을 분석해서 정리해줘. 필요하면 ANALYZE 로 분석해.', editor);
    const asked = rec.approvals.some((a) => a.kind === 'index');
    const r = await fetch(`${SERVER}/api/arch/${PROJECT}`).then((x) => x.json());
    return { pass: asked && !!r.markdown, why: `분석 승인 요청 ${asked} · 아키텍처 문서 ${r.markdown ? r.markdown.length + '자' : '없음'} · 도구 ${toolKinds(rec).join(',')}` };
  },
  async fileops(rec) {
    await newSession(rec).send('legacy/old_util.py 파일을 삭제하고, utils_tmp/helpers.py 를 app/common/helpers.py 로 옮기고, 빈 utils_tmp 폴더도 지워줘. 그리고 app/report 폴더를 만들어줘.', editor);
    const ok = !exists('legacy/old_util.py') && exists('app/common/helpers.py') && !exists('utils_tmp') && exists('app/report');
    const fileApprovals = rec.approvals.filter((a) => a.kind === 'files').length;
    return { pass: ok && fileApprovals >= 2, why: `삭제 ${!exists('legacy/old_util.py')} · 이동 ${exists('app/common/helpers.py')} · 폴더삭제 ${!exists('utils_tmp')} · 생성 ${exists('app/report')} · 삭제/이동 승인 ${fileApprovals}회 · 도구 ${toolKinds(rec).join(',')}` };
  },
  async git(rec) {
    await newSession(rec).send('git 상태와 최근 커밋을 알려줘', editor);
    const ranGit = rec.log.some((l) => /^▶ RUN git/.test(l));
    const runApprovals = rec.approvals.filter((a) => a.kind === 'run').length;
    return { pass: ranGit && runApprovals === 0 && /초기 구조|커밋/.test(rec.text + rec.log.join('\n')), why: `git 실행 ${ranGit} · 실행 승인 요청 ${runApprovals}회 (0 이어야 함)` };
  },
  async style(rec) {
    await newSession(rec).send('사고 종료 기능을 추가해줘: IncidentService.close_incident(incident_id) — 조사중(INVESTIGATING) 상태에서만 종료(CLOSED) 가능, 아니면 오류. API 핸들러와 테스트도 추가하고 테스트를 돌려줘.', editor);
    const svc = read('app/service/incident_service.py');
    const api = read('app/api/incident_api.py');
    const enumOk = /CLOSED/.test(read('app/domain/incident.py'));
    const t = pytest();
    const style = /def close_incident\(self, incident_id: int\) -> Incident:\n\s+"""[^"]*[가-힣]/.test(svc) && /def handle_close_incident\(service: IncidentService, incident_id: int\) -> ApiResult/.test(api) && /except SafetyError/.test(api.split('handle_close_incident')[1] ?? '');
    return { pass: t.ok && style && enumOk, why: `pytest ${t.ok ? 'OK' : 'FAIL'} (${t.out.trim().split('\n').pop()}) · 스타일(타입힌트·한국어 docstring·ApiResult·SafetyError) ${style} · CLOSED ${enumOk}` };
  },
  async harness(rec) {
    const files = execSync(`cd "${root}" && git ls-files`).toString().split('\n');
    const prompt = hk.harnessPrompt({ source: 'docs/spec-audit.md', text: read('docs/spec-audit.md'), target: '.yang/harness/spec-audit.md', testCmd: hk.detectTestCommand(files), resume: false });
    await newSession(rec).send(prompt, editor, [], { harness: true });
    const h = read('.yang/harness/spec-audit.md');
    const prog = hk.checklistProgress(h);
    const t = pytest();
    const layers = ['app/domain/audit.py', 'app/repository/audit_repository.py', 'app/service/audit_service.py', 'app/api/audit_api.py', 'tests/test_audit_service.py'].filter(exists);
    const err = /AuditNotFoundError|AUDIT_NOT_FOUND/.test(read('app/common/errors.py'));
    return { pass: t.ok && prog.total >= 3 && prog.done === prog.total && layers.length >= 4 && err,
      why: `체크리스트 ${prog.done}/${prog.total} · pytest ${t.ok ? 'OK' : 'FAIL'} (${t.out.trim().split('\n').pop()}) · 레이어 파일 ${layers.length}/5 ${layers.join(',')} · 예외 errors.py ${err}` };
  },
};

(async () => {
  console.log(`서버 ${SERVER} · 작업 폴더 ${root}`);
  const names = ONLY.length ? ONLY : Object.keys(SCENARIOS);
  const results = [];
  for (const n of names) {
    const rec = { log: [], tools: [], text: '', notices: [], approvals: [] };
    const t0 = Date.now();
    console.log(`\n=== ${n} ===`);
    let r;
    try { r = await SCENARIOS[n](rec); } catch (e) { r = { pass: false, why: `예외: ${e.stack}` }; }
    r.seconds = Math.round((Date.now() - t0) / 1000);
    results.push([n, r]);
    console.log(`=== ${n}: ${r.pass ? 'PASS' : 'FAIL'} (${r.seconds}s) — ${r.why}`);
  }
  console.log('\n요약');
  for (const [n, r] of results) console.log(`  ${r.pass ? '✅' : '❌'} ${n} (${r.seconds}s) ${r.why}`);
  console.log(`작업 폴더: ${root}`);
  // 시험 데이터 정리 (서버의 프로젝트 등록·임베딩·작업 기록·아키텍처 문서)
  await fetch(`${SERVER}/api/remote/projects/${PROJECT}`, { method: 'DELETE' }).catch(() => undefined);
  for (const f of [`worklog/${PROJECT}.jsonl`, `arch/${PROJECT}.md`]) fs.rmSync(`/Users/jinugi/AI-agent/backend/data/agent_state/${f}`, { force: true });
  process.exit(0);
})();
