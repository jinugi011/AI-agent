#!/usr/bin/env bash
# Yang Coding — Tailscale 로 내 기기에서만 원격 접속 (도메인 불필요 · 인터넷에 공개 안 됨)
#
#   tailscale.sh install      Tailscale 앱 설치 + 실행 (메뉴 막대에서 로그인)
#   tailscale.sh on           내 Tailscale 기기에서만 https://<맥이름>.<tailnet>.ts.net 으로 접속 허용
#   tailscale.sh off          접속 경로 닫기
#   tailscale.sh token [--rotate]   API 토큰 보기/재발급 (외부 PC 플러그인에 입력)
#   tailscale.sh status       상태 + 접속 주소 + 실제 접속/차단 확인 + 최근 원격 접속 기록
#
# 구조: 외부 PC(Tailscale) ─암호화 사설망─ 맥(Tailscale) → tailscale serve → 127.0.0.1:8010 (백엔드)
#       Funnel(공개 인터넷 노출)은 사용하지 않습니다. 같은 Tailscale 계정의 기기만 접근할 수 있고, API 토큰도 필요합니다.
set -euo pipefail

SELF="$(readlink "$0" 2>/dev/null || echo "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
STATE="$ROOT/backend/data/agent_state"
API_PORT="${API_PORT:-8010}"
mkdir -p "$STATE"

ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

TS="$(command -v tailscale || true)"
[[ -z "$TS" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
need_ts() {
  [[ -n "$TS" ]] || { bad "Tailscale 이 없습니다: $0 install"; exit 1; }
  # macOS 네트워크 확장 승인 전에는 CLI 가 응답 없이 멈추므로 먼저 확인
  if systemextensionsctl list 2>/dev/null | grep -i "tailscale" | grep -qi "waiting for user"; then
    bad "Tailscale 네트워크 확장 프로그램이 '사용자 승인 대기' 상태입니다."
    echo "    시스템 설정 → 일반 → 로그인 항목 및 확장 프로그램 → 네트워크 확장 프로그램(ⓘ) → Tailscale 켜기"
    echo "    (또는 시스템 설정 → 개인정보 보호 및 보안 → 'Tailscale 시스템 소프트웨어' 허용)"
    echo "    그다음 메뉴 막대의 Tailscale 아이콘 → Log in, 이후 다시: $0 ${1:-on}"
    exit 1
  fi
}

# Tailscale CLI 를 시간 제한(기본 10초)과 함께 실행 — 응답이 없으면 멈추지 않고 실패 처리
tsc() {
  local limit="${TS_TIMEOUT:-10}" out rc
  out="$(mktemp)"
  "$TS" "$@" > "$out" 2>&1 & local pid=$!
  ( sleep "$limit"; kill "$pid" 2>/dev/null ) & local killer=$!
  wait "$pid"; rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
  cat "$out"; rm -f "$out"
  return $rc
}

token() {
  (cd "$ROOT/backend" && .venv/bin/python -c "
from app import security
import sys
print(security.rotate_token() if '--rotate' in sys.argv else security.get_token())" "$@")
}

url() { # https://<맥이름>.<tailnet>.ts.net
  tsc status --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin); n=(d.get('Self') or {}).get('DNSName','').rstrip('.')
print('https://'+n if n else '')"
}

logged_in() { tsc status --json 2>/dev/null | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('BackendState')=='Running' else 1)" 2>/dev/null; }

case "${1:-status}" in
  install)
    if [[ -n "$TS" ]]; then ok "이미 설치됨"; else brew install --cask tailscale-app; fi
    open -a Tailscale || true
    echo "  → 메뉴 막대의 Tailscale 아이콘에서 로그인하세요 (Google/GitHub/Apple 계정 등)."
    echo "  → 외부 PC 에도 같은 계정으로 Tailscale 을 설치·로그인하세요: https://tailscale.com/download"
    echo "  → 로그인 후: $0 on"
    ;;

  on)
    need_ts on
    logged_in || { bad "Tailscale 에 로그인되어 있지 않습니다 (메뉴 막대 아이콘 → Log in)"; exit 1; }
    curl -s -m 3 "http://127.0.0.1:$API_PORT/api/health" >/dev/null || { bad "백엔드가 꺼져 있습니다: local-agent start (또는 scripts/server-mode.sh on)"; exit 1; }
    # 공개 인터넷 노출(Funnel)은 반드시 끔
    tsc funnel --https=443 off >/dev/null 2>&1 || true
    if ! TS_TIMEOUT=30 tsc serve --bg "http://127.0.0.1:$API_PORT"; then
      bad "tailscale serve 실패. 처음이면 위에 표시된 링크에서 'HTTPS 인증서'를 켜고 다시 실행하세요."
      echo "    (관리 콘솔: https://login.tailscale.com/admin/dns → MagicDNS 와 HTTPS Certificates 켜기)"
      exit 1
    fi
    U="$(url)"; echo "$U" > "$STATE/tailscale_url"
    ok "내 Tailscale 기기에서만 접속 가능: $U"
    echo "  API 토큰: $(token)"
    echo "  → 외부 PC 의 VS Code/IntelliJ 원격 설정에 위 주소와 토큰을 입력하세요."
    echo "  (설정은 재부팅 후에도 유지됩니다)"
    ;;

  off)
    need_ts off
    tsc serve --https=443 off >/dev/null 2>&1 || tsc serve reset
    ok "Tailscale 접속 경로를 닫았습니다"
    ;;

  token)
    shift
    echo "  API 토큰: $(token "$@")"
    echo "  → 유출되면 '$0 token --rotate' 로 바로 교체 (모든 PC 에 새 토큰 입력 필요)"
    ;;

  status)
    if [[ -z "$TS" ]]; then bad "Tailscale 미설치 ($0 install)"; exit 0; fi
    need_ts status
    logged_in && ok "Tailscale 연결됨 ($(tsc version | head -1))" || bad "Tailscale 로그인 필요 (메뉴 막대 아이콘 → Log in)"
    tsc funnel status 2>/dev/null | grep -qi "funnel on" && bad "Funnel 켜짐 — 공개 인터넷에 노출됨! ($TS funnel --https=443 off)" || ok "Funnel 꺼짐 (공개 인터넷 노출 없음)"
    curl -s -m 3 "http://127.0.0.1:$API_PORT/api/health" >/dev/null && ok "백엔드 :$API_PORT" || bad "백엔드 꺼짐"
    U="$(url)"
    if [[ -n "$U" ]] && tsc serve status 2>/dev/null | grep -q "127.0.0.1:$API_PORT"; then
      ok "접속 주소: $U"
      T="$(token)"
      c1=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H "Authorization: Bearer $T" "$U/api/health" || true)
      c2=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$U/api/health" || true)
      [[ "$c1" == 200 ]] && ok "토큰으로 접속 → 200" || bad "토큰으로 접속 실패 → $c1"
      [[ "$c2" == 401 ]] && ok "토큰 없는 접속 차단 → 401" || bad "토큰 없는 접속이 차단되지 않음 → $c2"
    else
      echo "  · 접속 경로 닫힘 ($0 on 으로 열기)"
    fi
    [[ -f "$STATE/remote_access.log" ]] && echo "  최근 원격 접속:" && tail -n 5 "$STATE/remote_access.log" | sed 's/^/    /'
    ;;

  *) sed -n '2,12p' "$SELF"; exit 1 ;;
esac
