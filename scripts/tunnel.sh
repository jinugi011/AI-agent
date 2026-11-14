#!/usr/bin/env bash
# Cloudflare Tunnel 로 에이전트 백엔드(127.0.0.1:8010)를 외부에 안전하게 공개
#   공유기가 2중이어도 포트포워딩 불필요 (맥 → Cloudflare 로 나가는 연결만 사용)
#
#   tunnel.sh install                 cloudflared 설치
#   tunnel.sh token [--rotate]        원격 접속용 API 토큰 보기/재발급 (IDE 플러그인에 입력)
#   tunnel.sh quick                   임시 주소(*.trycloudflare.com)로 바로 시험 — 실행할 때마다 주소가 바뀜
#   tunnel.sh setup <호스트명>         내 도메인으로 고정 터널 생성 (예: agent.example.com, 도메인이 Cloudflare 에 있어야 함)
#   tunnel.sh service on|off          고정 터널을 로그인 시 자동 실행 (launchd)
#   tunnel.sh status                  상태 + 외부 주소로 실제 접속 확인
set -euo pipefail

SELF="$(readlink "$0" 2>/dev/null || echo "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
STATE="$ROOT/backend/data/agent_state"
CF_DIR="$HOME/.cloudflared"
CONF="$CF_DIR/local-agent.yml"            # 다른 cloudflared 설정과 섞이지 않게 별도 파일
NAME="local-agent"
LABEL="com.localagent.cloudflared"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
API_PORT="${API_PORT:-8010}"
mkdir -p "$STATE"

ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
need_cf() { command -v cloudflared >/dev/null || { bad "cloudflared 가 없습니다: $0 install"; exit 1; }; }

token() {
  (cd "$ROOT/backend" && .venv/bin/python -c "
from app import security
import sys
print(security.rotate_token() if '--rotate' in sys.argv else security.get_token())" "$@")
}

check_backend() {
  curl -s -m 3 "http://127.0.0.1:$API_PORT/api/health" >/dev/null || { bad "백엔드가 꺼져 있습니다: local-agent start"; exit 1; }
}

remote_check() { # remote_check <https://주소>
  local url="$1" t; t="$(token)"
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H "Authorization: Bearer $t" "$url/api/health" || echo 000)
  local noauth; noauth=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url/api/health" || echo 000)
  [[ "$code" == 200 ]] && ok "외부 접속 OK ($url, 토큰 있음 → 200)" || bad "외부 접속 실패 ($url → $code)"
  [[ "$noauth" == 401 || "$noauth" == 403 ]] && ok "토큰 없는 접속 차단됨 (→ $noauth)" || bad "토큰 없는 접속이 차단되지 않음 (→ $noauth) — 확인 필요"
}

case "${1:-}" in
  install)
    command -v cloudflared >/dev/null && ok "이미 설치됨: $(cloudflared --version | head -1)" || brew install cloudflared
    ;;

  token)
    shift
    t="$(token "$@")"
    echo "  API 토큰: $t"
    echo "  → IDE 플러그인의 '원격 접속 설정'에 입력하세요. 유출되면 '$0 token --rotate' 로 바로 교체."
    ;;

  quick)
    need_cf; check_backend
    echo "▶ 임시 터널 시작 (Ctrl+C 로 종료). 아래 https://….trycloudflare.com 주소를 IDE 에 입력하세요."
    echo "  API 토큰: $(token)"
    exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$API_PORT"
    ;;

  setup)
    need_cf
    HOST="${2:-}"; [[ -n "$HOST" ]] || { echo "사용법: $0 setup agent.example.com"; exit 1; }
    mkdir -p "$CF_DIR"
    if [[ ! -f "$CF_DIR/cert.pem" ]]; then
      echo "▶ Cloudflare 로그인 (브라우저에서 도메인 선택 후 Authorize)"
      cloudflared tunnel login
    fi
    if ! cloudflared tunnel info "$NAME" >/dev/null 2>&1; then
      cloudflared tunnel create "$NAME"
    fi
    TID="$(cloudflared tunnel list -o json | python3 -c "import json,sys; print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")"
    cat > "$CONF" <<EOF
# Yang Coding — Cloudflare Tunnel 설정 (tunnel.sh 가 생성)
tunnel: $TID
credentials-file: $CF_DIR/$TID.json
no-autoupdate: true
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$API_PORT
  - service: http_status:404
EOF
    cloudflared tunnel route dns "$NAME" "$HOST" || echo "  (DNS 레코드가 이미 있으면 무시해도 됩니다)"
    echo "$HOST" > "$STATE/tunnel_host"
    ok "터널 '$NAME' → https://$HOST (설정: $CONF)"
    echo "  다음: $0 service on   (로그인 시 자동 실행)"
    ;;

  service)
    need_cf
    case "${2:-}" in
      on)
        [[ -f "$CONF" ]] || { bad "먼저 $0 setup <호스트명>"; exit 1; }
        mkdir -p "$HOME/Library/LaunchAgents"
        cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v cloudflared)</string><string>tunnel</string><string>--config</string><string>$CONF</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE/cloudflared.log</string>
  <key>StandardErrorPath</key><string>$STATE/cloudflared.log</string>
</dict></plist>
EOF
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST"
        ok "터널 자동 실행 등록 ($LABEL)"
        ;;
      off)
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
        rm -f "$PLIST"; ok "터널 자동 실행 해제"
        ;;
      *) echo "사용법: $0 service on|off"; exit 1 ;;
    esac
    ;;

  status)
    command -v cloudflared >/dev/null && ok "cloudflared $(cloudflared --version | awk '{print $3}')" || bad "cloudflared 미설치"
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && ok "터널 서비스 실행 중 ($LABEL)" || echo "  · 터널 서비스 미등록/중지"
    curl -s -m 3 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && ok "백엔드 :$API_PORT" || bad "백엔드 꺼짐"
    if [[ -f "$STATE/tunnel_host" ]]; then remote_check "https://$(cat "$STATE/tunnel_host")"; fi
    [[ -f "$STATE/remote_access.log" ]] && echo "  최근 원격 접속:" && tail -n 5 "$STATE/remote_access.log" | sed 's/^/    /'
    ;;

  *) sed -n '2,12p' "$SELF"; exit 1 ;;
esac
