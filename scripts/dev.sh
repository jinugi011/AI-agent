#!/usr/bin/env bash
# 로컬 코딩 에이전트 전체 기동: Qdrant → Rust 엔진 → FastAPI → Vite
# 사용법: scripts/dev.sh            (전부 실행)
#        scripts/dev.sh download   (모델만 내려받기)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_REPO="${MODEL_REPO:-unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF}"
MODEL_FILE="${MODEL_FILE:-Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf}"
export ENGINE_MODEL_PATH="${ENGINE_MODEL_PATH:-$ROOT/models/$MODEL_FILE}"
export ENGINE_PORT="${ENGINE_PORT:-18091}"
export ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:$ENGINE_PORT}"
API_PORT="${API_PORT:-8010}"

download_model() {
  if [[ ! -f "$ENGINE_MODEL_PATH" ]]; then
    echo "▶ 모델 다운로드: $MODEL_REPO/$MODEL_FILE"
    "$ROOT/backend/.venv/bin/hf" download "$MODEL_REPO" "$MODEL_FILE" --local-dir "$ROOT/models"
  fi
}

if [[ "${1:-}" == "download" ]]; then
  download_model
  exit 0
fi

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "▶ Qdrant"
docker compose -f "$ROOT/docker-compose.vector.yml" up -d qdrant

download_model

echo "▶ Rust 엔진 빌드/실행 (:$ENGINE_PORT)"
(cd "$ROOT/engine" && cargo build --release --quiet)
"$ROOT/engine/target/release/agent-engine" --model "$ENGINE_MODEL_PATH" --port "$ENGINE_PORT" &
pids+=($!)

echo "▶ FastAPI (:$API_PORT)"
(cd "$ROOT/backend" && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT") &
pids+=($!)

echo "▶ Frontend (:5173)"
(cd "$ROOT/frontend" && npm run dev) &
pids+=($!)

wait
