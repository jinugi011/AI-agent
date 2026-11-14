#!/usr/bin/env bash
# 맥북 클램쉘(덮개 닫음) 서버 모드
#   server-mode.sh on      잠자기 방지 + 엔진·백엔드를 launchd 로 자동 실행/자동 재시작 (sudo 비밀번호 필요)
#   server-mode.sh off     원래 전원 설정 복원 + 자동 실행 해제
#   server-mode.sh reload  서비스(launchd)만 다시 등록 (전원 설정은 그대로, 비밀번호 불필요)
#   server-mode.sh status  현재 상태
#
# 주의
#  - 반드시 전원 어댑터 연결 상태로 사용하세요. 덮개를 닫으면 발열이 커지니 세워 두거나 통풍을 확보하세요.
#  - FileVault 가 켜져 있으면 재부팅 후 '로그인 전'에는 서비스가 뜨지 않습니다(자동 로그인 불가).
#    계획된 재시작은 'sudo fdesetup authrestart' 를 쓰면 재부팅 후 잠금 해제 단계를 한 번 건너뜁니다.
set -euo pipefail

SELF="$(readlink "$0" 2>/dev/null || echo "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
STATE="$ROOT/backend/data/agent_state"
LA="$HOME/Library/LaunchAgents"
UIDN="$(id -u)"
ENGINE_PORT="${ENGINE_PORT:-18091}"
API_PORT="${API_PORT:-8010}"
mkdir -p "$STATE" "$LA"

ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

pick_model() {
  for f in Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf Qwen2.5-Coder-7B-Instruct-Q5_K_M.gguf; do
    [[ -f "$ROOT/models/$f" ]] && { echo "$ROOT/models/$f"; return; }
  done
}

write_plist() { # write_plist <label> <workdir> <log> <args...>
  local label="$1" wd="$2" log="$3"; shift 3
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo "<plist version=\"1.0\"><dict>"
    echo "  <key>Label</key><string>$label</string>"
    echo "  <key>WorkingDirectory</key><string>$wd</string>"
    echo "  <key>ProgramArguments</key><array>"
    # launchd 의 실행기(xpcproxy)는 ~/Desktop 같은 보호 폴더의 실행 파일·폴더에 접근하지 못한다(종료 코드 78).
    # 보호 폴더 밖의 /bin/sh 를 먼저 띄우고, 셸이 실제 프로그램을 exec 하게 한다.
    echo "    <string>/bin/sh</string>"
    echo "    <string>-c</string>"
    echo '    <string>exec "$0" "$@"</string>'
    for a in "$@"; do echo "    <string>$a</string>"; done
    echo "  </array>"
    echo "  <key>RunAtLoad</key><true/>"
    echo "  <key>KeepAlive</key><true/>"
    echo "  <key>ThrottleInterval</key><integer>10</integer>"
    echo "  <key>StandardOutPath</key><string>$log</string>"
    echo "  <key>StandardErrorPath</key><string>$log</string>"
    echo "</dict></plist>"
  } > "$LA/$label.plist"
}

load() { launchctl bootout "gui/$UIDN/$1" 2>/dev/null || true; launchctl bootstrap "gui/$UIDN" "$LA/$1.plist"; }

# 엔진·백엔드를 launchd 서비스로 등록.
# 주의: launchd 는 ~/Desktop·~/Documents 같은 보호 폴더를 작업 폴더로 쓰거나 그 안의 실행 파일을 직접 띄우지 못한다(종료 코드 78).
#       그래서 작업 폴더는 홈으로 두고 /bin/sh 를 거쳐 실행하며, 백엔드 코드 위치는 uvicorn --app-dir 로 지정한다.
install_services() {
  echo "▶ 서비스 자동 실행 (launchd)"
  "$ROOT/scripts/agent.sh" stop >/dev/null 2>&1 || true   # nohup 으로 띄운 것은 정리
  MODEL="$(pick_model)"; [[ -n "$MODEL" ]] || { bad "모델 없음: ./install.sh --model 30b"; exit 1; }
  write_plist com.localagent.engine "$HOME" "$STATE/engine.log" \
    "$ROOT/engine/target/release/agent-engine" --model "$MODEL" --port "$ENGINE_PORT" --ctx 32768
  write_plist com.localagent.backend "$HOME" "$STATE/backend.log" \
    "$ROOT/backend/.venv/bin/uvicorn" app.main:app --app-dir "$ROOT/backend" --host 127.0.0.1 --port "$API_PORT"
  load com.localagent.engine; load com.localagent.backend
  printf '  서비스 시작 확인 중'
  for _ in $(seq 1 120); do
    curl -s -m 2 "http://127.0.0.1:$ENGINE_PORT/health" 2>/dev/null | grep -q model_name \
      && curl -s -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && break
    printf '.'; sleep 1
  done
  echo
  local fail=0
  curl -s -m 2 "http://127.0.0.1:$ENGINE_PORT/health" 2>/dev/null | grep -q model_name && ok "엔진 :$ENGINE_PORT (launchd)" || { bad "엔진 시작 실패 — $STATE/engine.log"; fail=1; }
  curl -s -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && ok "백엔드 :$API_PORT (launchd)" || { bad "백엔드 시작 실패 — $STATE/backend.log"; fail=1; }
  if [[ $fail == 0 ]]; then ok "엔진·백엔드: 로그인 시 자동 실행, 죽으면 자동 재시작"; else
    echo "    상태: launchctl print gui/$UIDN/com.localagent.backend | grep 'last exit'"; return 1; fi
}

case "${1:-status}" in
  on)
    echo "▶ 전원 설정 (관리자 비밀번호 필요)"
    pmset -g custom > "$STATE/pmset.before" 2>/dev/null || true
    sudo pmset -c sleep 0            # 전원 연결 시 시스템 잠자기 안 함
    sudo pmset -c disksleep 0
    sudo pmset -c displaysleep 5     # 화면만 꺼짐
    sudo pmset -a disablesleep 1     # 덮개를 닫아도(외부 모니터 없이) 잠들지 않음
    sudo pmset -a womp 1             # 네트워크 요청으로 깨우기
    sudo pmset -a tcpkeepalive 1
    sudo pmset -a autorestart 1      # 정전 후 전원 복구 시 자동 재시작
    ok "잠자기 방지 (이전 설정 백업: $STATE/pmset.before)"

    install_services
    if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
      docker update --restart unless-stopped coding-agent-qdrant >/dev/null 2>&1 && ok "Qdrant 자동 재시작 설정" || true
    fi
    echo "  · Docker Desktop: Settings → General → 'Start Docker Desktop when you sign in' 를 켜 두세요."
    echo "  · 터널 자동 실행: scripts/tunnel.sh service on"
    ;;

  reload)
    install_services
    ;;

  off)
    for l in com.localagent.engine com.localagent.backend; do
      launchctl bootout "gui/$UIDN/$l" 2>/dev/null || true; rm -f "$LA/$l.plist"
    done
    ok "서비스 자동 실행 해제 (필요하면 local-agent start)"
    sudo pmset -a disablesleep 0
    sudo pmset -c sleep 1
    sudo pmset -c disksleep 10
    sudo pmset -c displaysleep 10
    ok "전원 설정 복원 (덮개를 닫으면 다시 잠듦)"
    ;;

  status)
    pmset -g | grep -qE "SleepDisabled\s+1" && ok "덮개 닫아도 잠들지 않음 (disablesleep 1)" || echo "  · 잠자기 방지 꺼짐 (덮개를 닫으면 잠듦)"
    pmset -g batt | grep -q "AC Power" && ok "전원 어댑터 연결" || bad "배터리 사용 중 — 서버 모드는 전원 연결 필요"
    for l in com.localagent.engine com.localagent.backend com.localagent.cloudflared; do
      launchctl print "gui/$UIDN/$l" >/dev/null 2>&1 && ok "$l (launchd)" || echo "  · $l 미등록"
    done
    fdesetup status 2>/dev/null | grep -q "On" && echo "  · FileVault 켜짐: 재부팅 후에는 직접 로그인해야 서비스가 시작됩니다."
    ;;

  *) sed -n '2,11p' "$SELF"; exit 1 ;;
esac
