#!/usr/bin/env bash
# Yang Coding 관리 명령 (install.sh 가 ~/.local/bin/local-agent 로 연결)
#   local-agent start [모델키]  Qdrant + Rust 엔진 + 백엔드 실행 (백그라운드)
#   local-agent stop            엔진·백엔드 종료 (이 명령으로 띄운 것만)
#   local-agent status          상태 확인
#   local-agent logs            엔진·백엔드 로그 보기
#   local-agent update          최신 소스 받고 재설치 (모델은 유지)
set -euo pipefail

SELF="$(readlink "$0" 2>/dev/null || echo "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
STATE="$ROOT/backend/data/agent_state"
mkdir -p "$STATE"
ENGINE_PORT="${ENGINE_PORT:-18091}"
API_PORT="${API_PORT:-8010}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

alive() { [[ -f "$STATE/$1.pid" ]] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
up()    { curl -s -m 2 "$1" >/dev/null 2>&1; }
engine_up() { curl -s -m 2 "http://127.0.0.1:$ENGINE_PORT/health" 2>/dev/null | grep -q '"model_name"'; }

pick_model() { # 인자 키 > 받아둔 모델 중 큰 것 순
  local key="${1:-}"
  local files=(Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf Qwen2.5-Coder-7B-Instruct-Q5_K_M.gguf)
  case "$key" in 30b) files=("${files[0]}") ;; 14b) files=("${files[1]}") ;; 7b) files=("${files[2]}") ;; esac
  for f in "${files[@]}"; do [[ -f "$ROOT/models/$f" ]] && { echo "$ROOT/models/$f"; return; }; done
  ls "$ROOT"/models/*.gguf 2>/dev/null | head -1
}

start() {
  echo "▶ 시작 ($ROOT)"
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    docker compose -f "$ROOT/docker-compose.vector.yml" up -d qdrant >/dev/null && ok "Qdrant :6333"
  else
    bad "Docker 가 꺼져 있음 → 벡터 DB 메모리 모드 (Docker 를 켜고 다시 start 권장)"
  fi

  if engine_up; then
    ok "엔진 이미 실행 중 :$ENGINE_PORT"
  elif up "http://127.0.0.1:$ENGINE_PORT/health" || lsof -nP -iTCP:"$ENGINE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    bad "포트 $ENGINE_PORT 를 다른 프로그램이 사용 중: $(lsof -nP -iTCP:"$ENGINE_PORT" -sTCP:LISTEN | awk 'NR==2{print $1" (PID "$2")"}')"
    echo "    ENGINE_PORT=다른번호 local-agent start 로 바꾸거나 해당 프로그램을 종료하세요."; exit 1
  else
    local model; model="$(pick_model "${1:-}")"
    [[ -n "$model" ]] || { bad "모델이 없습니다: ./install.sh --model 30b"; exit 1; }
    case "$(basename "$model")" in *30B*) CTX=32768 ;; *14B*) CTX=32768 ;; *) CTX=16384 ;; esac
    nohup "$ROOT/engine/target/release/agent-engine" --model "$model" --port "$ENGINE_PORT" --ctx "$CTX" \
      < /dev/null > "$STATE/engine.log" 2>&1 &
    echo $! > "$STATE/engine.pid"
    printf '  모델 로딩 중 (%s)' "$(basename "$model")"
    for _ in $(seq 1 120); do engine_up && break; alive engine || break; printf '.'; sleep 1; done
    echo
    engine_up && ok "엔진 :$ENGINE_PORT" || { bad "엔진 시작 실패 — local-agent logs"; exit 1; }
  fi

  if up "http://127.0.0.1:$API_PORT/api/health"; then
    ok "백엔드 이미 실행 중 :$API_PORT"
  else
    # 서버를 직접 백그라운드로 실행해야 $! 가 실제 서버 PID 가 된다 (감싸는 서브셸을 남기지 않음)
    pushd "$ROOT/backend" >/dev/null
    nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" < /dev/null > "$STATE/backend.log" 2>&1 &
    echo $! > "$STATE/backend.pid"
    popd >/dev/null
    for _ in $(seq 1 60); do up "http://127.0.0.1:$API_PORT/api/health" && break; sleep 1; done
    up "http://127.0.0.1:$API_PORT/api/health" && ok "백엔드 :$API_PORT" || { bad "백엔드 시작 실패 — local-agent logs"; exit 1; }
  fi
  echo "  → VS Code / IntelliJ 의 Yang Coding 채팅창에서 사용하세요."
}

launchd_on() { launchctl print "gui/$(id -u)/com.localagent.$1" >/dev/null 2>&1; }

stop() {
  if launchd_on engine || launchd_on backend; then
    echo "  서버 모드(launchd)로 관리 중입니다 → scripts/server-mode.sh off 로 해제하세요."
  fi
  for name in backend engine; do
    if alive "$name"; then kill "$(cat "$STATE/$name.pid")" && ok "$name 종료"; fi
    rm -f "$STATE/$name.pid"
  done
}

status() {
  up "http://127.0.0.1:6333" && ok "Qdrant :6333" || bad "Qdrant 꺼짐"
  if engine_up; then
    ok "엔진 :$ENGINE_PORT — $(curl -s "http://127.0.0.1:$ENGINE_PORT/health" | sed -E 's/.*"model_name":"([^"]+)".*/\1/')"
  else bad "엔진 꺼짐"; fi
  up "http://127.0.0.1:$API_PORT/api/health" && ok "백엔드 :$API_PORT" || bad "백엔드 꺼짐"
  echo "  모델: $(ls "$ROOT"/models/*.gguf 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
}

case "${1:-status}" in
  start) start "${2:-}" ;;
  stop) stop ;;
  restart) stop; start "${2:-}" ;;
  status) status ;;
  logs) tail -n 40 "$STATE/engine.log" "$STATE/backend.log" 2>/dev/null ;;
  update) exec "$ROOT/install.sh" --dir "$ROOT" --model none ;;
  *) sed -n '2,8p' "$SELF"; exit 1 ;;
esac
