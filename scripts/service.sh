#!/bin/sh
# launchd 서비스 실행기: 관리 페이지 '서버 관리'에서 저장한 설정(agent.env)을 읽고 실제 프로그램을 exec 한다.
#   service.sh engine | backend
# (launchd 는 /bin/sh 로 이 파일을 실행 → ~/Desktop 같은 보호 폴더 문제(종료 코드 78)도 피한다)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${AGENT_STATE_DIR:-$ROOT/backend/data/agent_state}"
if [ -f "$STATE/agent.env" ]; then
  set -a
  . "$STATE/agent.env"
  set +a
fi

case "$1" in
  engine)
    # 받는 중인 파일인지 (curl 이 쓰는 중이면 아직 덜 받은 것)
    downloading() { pgrep -fl curl 2>/dev/null | grep -q "$(basename "$1")"; }
    MODEL="${ENGINE_MODEL_PATH:-}"
    if [ -z "$MODEL" ] || [ ! -f "$MODEL" ] || downloading "$MODEL"; then
      [ -n "$MODEL" ] && echo "[service] 선택한 모델을 쓸 수 없음 (없거나 다운로드 중): $MODEL → 다른 모델로 시작" >&2
      MODEL=""
      for f in Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf Qwen3.6-35B-A3B-UD-Q4_K_M.gguf Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf \
               Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf Qwen2.5-Coder-7B-Instruct-Q5_K_M.gguf; do
        if [ -f "$ROOT/models/$f" ] && ! downloading "$ROOT/models/$f"; then MODEL="$ROOT/models/$f"; break; fi
      done
    fi
    export ENGINE_MODEL_PATH="$MODEL"
    # 코딩 모델 자체가 그림을 볼 수 있으면(Qwen3.6 등 + 전용 mmproj) 별도 비전 모델(5GB+) 대신 같은 모델을 쓴다.
    # 같은 파일을 mmap 하므로 가중치 메모리를 공유 → 비전 사용 시 추가 메모리가 1~2GB 로 줄어든다.
    BASE="$(basename "$MODEL" .gguf | sed -E 's/-(UD-)?(I?Q[0-9]+_[A-Z0-9_]+|F16|BF16)$//')"
    MM="$(ls "$ROOT/models"/mmproj-"$BASE"*.gguf 2>/dev/null | head -1)"
    if [ -z "${ENGINE_VISION_MODEL:-}" ] && [ -n "$MM" ]; then
      export ENGINE_VISION_MODEL="$MODEL" ENGINE_VISION_MMPROJ="$MM"
    fi
    exec "$ROOT/engine/target/release/agent-engine" --model "$MODEL" --port "${ENGINE_PORT:-18091}"
    ;;
  backend)
    exec "$ROOT/backend/.venv/bin/uvicorn" app.main:app --app-dir "$ROOT/backend" --host 127.0.0.1 --port "${API_PORT:-8010}"
    ;;
  *)
    echo "사용법: $0 engine|backend" >&2
    exit 2
    ;;
esac
