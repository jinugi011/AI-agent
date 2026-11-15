// 패키징 직전: 설치 파일에 넣을 고정 서버 주소(server.json)를 만든다.
// 우선순위: 환경변수 YANG_SERVER_URL > 서버(맥)의 Tailscale 주소(backend/data/agent_state/tailscale_url → http://…:18010)
// server.json 은 git 에 올리지 않는다 (.gitignore). 주소를 못 찾으면 빈 값 → 사용자가 직접 입력.
const fs = require('fs');
const path = require('path');
let url = (process.env.YANG_SERVER_URL || '').trim();
if (!url) {
  try {
    const ts = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'data', 'agent_state', 'tailscale_url'), 'utf8').trim();
    if (ts) url = ts.replace(/^https:/, 'http:').replace(/\/$/, '') + ':' + (process.env.TS_HTTP_PORT || '18010');
  } catch { /* 없음 */ }
}
fs.writeFileSync(path.join(__dirname, '..', 'server.json'), JSON.stringify({ url }, null, 2) + '\n');
console.log(`server.json: ${url || '(비어 있음 — 설치 후 직접 입력)'}`);
