#!/usr/bin/env bash
# =============================================================================
#  Yang Coding 설치 스크립트 (macOS, Apple Silicon 권장)
#
#  새 PC 에서:
#    curl -fsSL https://raw.githubusercontent.com/jinugi011/AI-agent/main/install.sh | bash
#  또는 레포를 받은 뒤:
#    ./install.sh
#
#  옵션:
#    --dir <경로>        설치 위치 (기본: ~/AI-agent, 레포 안에서 실행하면 그 레포)
#    --repo <URL>        git 레포 주소 (기본: https://github.com/jinugi011/AI-agent.git)
#    --branch <이름>     브랜치 (기본: main)
#    --model <키>        auto | 30b | 14b | 7b | none   (기본: auto = 메모리에 맞게 선택)
#    --skip-vscode       VS Code 확장 설치 생략
#    --skip-intellij     IntelliJ 플러그인 설치 생략
#    --skip-docker       Qdrant(Docker) 생략 → 벡터 DB 는 메모리 모드(재시작 시 초기화)
#    -y, --yes           모든 질문에 '예'
#
#  여러 번 실행해도 안전합니다 (이미 설치된 단계는 건너뜀).
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/jinugi011/AI-agent.git"
BRANCH="main"
INSTALL_DIR=""
MODEL="auto"
SKIP_VSCODE=0
SKIP_INTELLIJ=0
SKIP_DOCKER=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --skip-vscode) SKIP_VSCODE=1; shift ;;
    --skip-intellij) SKIP_INTELLIJ=1; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1 (--help 참고)"; exit 1 ;;
  esac
done

CONFIG_DIR="$HOME/.config/local-agent"
mkdir -p "$CONFIG_DIR"
LOG="$CONFIG_DIR/install.log"
exec > >(tee -a "$LOG") 2>&1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') 설치 시작 ====="

# ---- 출력 도우미 ---------------------------------------------------------------
step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARNINGS+=("$*"); }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*"; echo "로그: $LOG"; exit 1; }
WARNINGS=()

ask() { # ask "질문" → 0(예)/1(아니오)
  [[ $ASSUME_YES == 1 ]] && return 0
  local ans
  if [[ -r /dev/tty ]]; then read -r -p "  ? $1 [Y/n] " ans </dev/tty; else return 0; fi
  [[ -z "$ans" || "$ans" =~ ^[Yy] ]]
}

# ---- 0. 환경 확인 ---------------------------------------------------------------
step "환경 확인"
[[ "$(uname -s)" == "Darwin" ]] || die "현재는 macOS 만 지원합니다 (엔진이 Apple Metal GPU 를 사용)."
ARCH="$(uname -m)"
MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
ok "macOS $(sw_vers -productVersion) · $ARCH · 메모리 ${MEM_GB}GB"
[[ "$ARCH" == "arm64" ]] || warn "Intel Mac 은 GPU 가속이 없어 매우 느립니다. 7B 모델을 권장합니다."
FREE_GB=$(df -g "$HOME" | awk 'NR==2{print $4}')
ok "디스크 여유 ${FREE_GB}GB"

if ! xcode-select -p >/dev/null 2>&1; then
  step "Xcode Command Line Tools 설치"
  xcode-select --install || true
  die "Command Line Tools 설치 창이 떴습니다. 설치를 마친 뒤 이 스크립트를 다시 실행하세요."
fi
ok "Xcode Command Line Tools"

# ---- 1. Homebrew + 기본 도구 -------------------------------------------------------
step "Homebrew 와 기본 도구"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  ask "Homebrew 가 없습니다. 설치할까요? (관리자 비밀번호가 필요할 수 있음)" || die "Homebrew 가 필요합니다: https://brew.sh"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)"; done
fi
ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

NEED=()
command -v git >/dev/null || NEED+=(git)
brew list python@3.13 >/dev/null 2>&1 || NEED+=(python@3.13)
command -v node >/dev/null || NEED+=(node)
command -v cargo >/dev/null || NEED+=(rust)
command -v cmake >/dev/null || NEED+=(cmake)
if (( ${#NEED[@]} )); then
  echo "  설치: ${NEED[*]}"
  brew install "${NEED[@]}"
fi
PY="$(brew --prefix python@3.13)/bin/python3.13"
[[ -x "$PY" ]] || die "python3.13 을 찾을 수 없습니다: $PY"
ok "git · python3.13 · node $(node --version) · $(cargo --version | awk '{print $1, $2}') · cmake"

# ---- 2. 레포 받기 ----------------------------------------------------------------
step "에이전트 소스"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [[ -z "$INSTALL_DIR" && -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/backend/app/main.py" ]]; then
  INSTALL_DIR="$SCRIPT_DIR"   # 레포 안에서 실행한 경우
fi
INSTALL_DIR="${INSTALL_DIR:-$HOME/AI-agent}"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  ok "기존 레포 사용: $INSTALL_DIR"
  if [[ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH" || warn "git pull 실패 — 현재 버전으로 계속합니다."
  else
    warn "레포에 수정 중인 파일이 있어 git pull 을 건너뜁니다."
  fi
else
  [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]] && die "$INSTALL_DIR 가 비어 있지 않습니다. --dir 로 다른 위치를 지정하세요."
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" || die "git clone 실패. 비공개 레포라면 'gh auth login' 등으로 GitHub 로그인 후 다시 실행하세요."
  ok "받음: $INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---- 3. 백엔드 (Python) -----------------------------------------------------------
step "백엔드 (FastAPI · 임베딩 · 벡터 DB 클라이언트)"
if [[ ! -x backend/.venv/bin/python ]]; then
  "$PY" -m venv backend/.venv
fi
backend/.venv/bin/pip install --quiet --upgrade pip
REQ=backend/requirements.lock.txt; [[ -f $REQ ]] || REQ=backend/requirements.txt
echo "  패키지 설치 중 ($REQ, 처음엔 수 분 걸림)…"
backend/.venv/bin/pip install --quiet -r "$REQ"
ok "Python 패키지"
echo "  임베딩 모델 미리 받기…"
backend/.venv/bin/python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')" >/dev/null 2>&1 \
  && ok "임베딩 모델 (all-MiniLM-L6-v2)" || warn "임베딩 모델 다운로드 실패 — 첫 사용 때 다시 시도됩니다."

# ---- 4. Rust 추론 엔진 --------------------------------------------------------------
step "Rust 추론 엔진 빌드 (llama.cpp + Metal, 처음엔 수 분)"
(cd engine && cargo build --release --quiet) || die "엔진 빌드 실패"
ok "engine/target/release/agent-engine"

# ---- 5. 코딩 모델 -------------------------------------------------------------------
step "코딩 모델"
if [[ "$MODEL" == "auto" ]]; then
  if (( MEM_GB >= 32 )); then MODEL=30b; elif (( MEM_GB >= 16 )); then MODEL=14b; else MODEL=7b; fi
  echo "  메모리 ${MEM_GB}GB → ${MODEL} 모델 선택"
fi
case "$MODEL" in
  30b) M_REPO="unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"; M_FILE="Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"; M_GB=19 ;;
  14b) M_REPO="bartowski/Qwen2.5-Coder-14B-Instruct-GGUF"; M_FILE="Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf"; M_GB=11 ;;
  7b)  M_REPO="bartowski/Qwen2.5-Coder-7B-Instruct-GGUF";  M_FILE="Qwen2.5-Coder-7B-Instruct-Q5_K_M.gguf";  M_GB=6 ;;
  none) M_FILE="" ;;
  *) die "--model 은 auto|30b|14b|7b|none 중 하나여야 합니다" ;;
esac
if [[ -n "$M_FILE" ]]; then
  mkdir -p models
  if [[ -f "models/$M_FILE" ]]; then
    ok "이미 있음: models/$M_FILE"
  else
    (( FREE_GB > M_GB + 5 )) || die "디스크 공간 부족: ${M_GB}GB 모델에 여유 $((M_GB + 5))GB 이상 필요 (현재 ${FREE_GB}GB)"
    echo "  다운로드: $M_REPO/$M_FILE (~${M_GB}GB, 중단돼도 다시 실행하면 이어받음)"
    backend/.venv/bin/hf download "$M_REPO" "$M_FILE" --local-dir models || die "모델 다운로드 실패 — 다시 실행하면 이어받습니다."
    ok "models/$M_FILE"
  fi
else
  warn "모델을 받지 않았습니다. 나중에 채팅에서 \"30B 모델 받아줘\" 또는 ./install.sh --model 30b"
fi

# ---- 6. 벡터 DB (Qdrant) ------------------------------------------------------------
step "벡터 DB (Qdrant)"
if [[ $SKIP_DOCKER == 1 ]]; then
  warn "Qdrant 생략 — 벡터 DB 는 메모리 모드로 동작합니다 (백엔드 재시작 시 색인 초기화)."
else
  if ! command -v docker >/dev/null 2>&1; then
    if ask "Docker 가 없습니다. Docker Desktop 을 설치할까요? (회사 규모에 따라 유료 라이선스 대상)"; then
      brew install --cask docker
    fi
  fi
  if command -v docker >/dev/null 2>&1; then
    if ! docker info >/dev/null 2>&1; then
      echo "  Docker 실행 중…"
      open -a Docker || true
      for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
    fi
    if docker info >/dev/null 2>&1; then
      docker compose -f docker-compose.vector.yml up -d qdrant >/dev/null && ok "Qdrant (localhost:6333)"
    else
      warn "Docker 가 실행되지 않았습니다. Docker 를 켠 뒤: docker compose -f docker-compose.vector.yml up -d qdrant"
    fi
  else
    warn "Docker 없음 — 벡터 DB 는 메모리 모드로 동작합니다 (재시작 시 색인 초기화)."
  fi
fi

# ---- 7. 웹 대시보드 (선택) -------------------------------------------------------------
step "웹 대시보드 의존성"
(cd frontend && npm ci --silent --no-audit --no-fund >/dev/null 2>&1) && ok "frontend" || warn "frontend npm 설치 실패 (웹 화면만 영향)"

# ---- 8. VS Code 확장 ----------------------------------------------------------------
step "VS Code 확장"
CODE_BIN="$(command -v code || true)"
[[ -z "$CODE_BIN" && -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]] && CODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [[ $SKIP_VSCODE == 1 ]]; then
  echo "  생략 (--skip-vscode)"
elif [[ -z "$CODE_BIN" ]]; then
  warn "VS Code 가 없어 확장 설치를 건너뜁니다. VS Code 설치 후 ./install.sh 를 다시 실행하세요."
else
  (
    cd vscode-extension
    npm ci --silent --no-audit --no-fund >/dev/null 2>&1
    rm -f ./*.vsix
    npx --no-install vsce package --no-dependencies --allow-missing-repository >/dev/null 2>&1
    "$CODE_BIN" --install-extension ./*.vsix --force >/dev/null 2>&1
  ) && ok "VS Code 확장 설치 (VS Code 에서 Developer: Reload Window)" || warn "VS Code 확장 설치 실패 — 로그 확인"
fi

# ---- 9. IntelliJ 플러그인 -------------------------------------------------------------
step "IntelliJ 플러그인"
IDE_APP=""
for app in "/Applications/IntelliJ IDEA.app" "/Applications/IntelliJ IDEA Ultimate.app" "/Applications/IntelliJ IDEA CE.app" \
           "$HOME/Applications/IntelliJ IDEA.app" "$HOME/Applications/IntelliJ IDEA Ultimate.app" "$HOME/Applications/IntelliJ IDEA Community Edition.app" \
           "/Applications/IntelliJ IDEA Community Edition.app"; do
  [[ -f "$app/Contents/Resources/build.txt" ]] && { IDE_APP="$app"; break; }
done
if [[ $SKIP_INTELLIJ == 1 ]]; then
  echo "  생략 (--skip-intellij)"
elif [[ -z "$IDE_APP" ]]; then
  echo "  IntelliJ 가 없어 건너뜁니다."
else
  BUILD="$(cat "$IDE_APP/Contents/Resources/build.txt")"        # 예: IC-252.26830.84
  MAJOR="${BUILD#*-}"; MAJOR="${MAJOR%%.*}"
  VER="$(defaults read "$IDE_APP/Contents/Info.plist" CFBundleShortVersionString)"  # 예: 2025.2.3
  if (( MAJOR < 252 )); then
    warn "IntelliJ $VER 은 지원하지 않습니다 (2025.2 이상 필요)."
  else
    JBR="$IDE_APP/Contents/jbr/Contents/Home"
    (
      cd intellij-plugin
      JAVA_HOME="$JBR" ./gradlew buildPlugin --quiet --console=plain \
        -PlocalIdePath="$IDE_APP" -Porg.gradle.java.installations.paths="$JBR" >/dev/null
    ) || die "IntelliJ 플러그인 빌드 실패"
    case "${BUILD%%-*}" in IC) PRODUCT="IdeaIC" ;; IU) PRODUCT="IntelliJIdea" ;; *) PRODUCT="" ;; esac
    if [[ -n "$PRODUCT" ]]; then
      PLUGINS_DIR="$HOME/Library/Application Support/JetBrains/${PRODUCT}${VER%.*}/plugins"
      mkdir -p "$PLUGINS_DIR"
      rm -rf "$PLUGINS_DIR/local-coding-agent-intellij"
      unzip -q -o intellij-plugin/build/distributions/local-coding-agent-intellij-*.zip -d "$PLUGINS_DIR"
      ok "IntelliJ $VER 플러그인 설치 (IntelliJ 재시작 필요)"
    else
      warn "알 수 없는 IntelliJ 제품($BUILD). Settings → Plugins → Install Plugin from Disk 로 직접 설치: intellij-plugin/build/distributions/"
    fi
  fi
fi

# ---- 10. 설치 위치 기록 (IDE 플러그인이 자동으로 찾음) ------------------------------------
step "설정 기록"
cat > "$CONFIG_DIR/config.json" <<EOF
{
  "agentRoot": "$INSTALL_DIR",
  "model": "${M_FILE:-}",
  "installedAt": "$(date '+%Y-%m-%dT%H:%M:%S')"
}
EOF
chmod +x scripts/*.sh 2>/dev/null || true
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/scripts/agent.sh" "$HOME/.local/bin/local-agent"
ok "$CONFIG_DIR/config.json"
ok "명령어: ~/.local/bin/local-agent (start | stop | status | update)"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && ! grep -q '.local/bin' "$HOME/.zshrc" 2>/dev/null; then
  if ask "local-agent 명령을 쓰려면 ~/.local/bin 을 PATH 에 추가해야 합니다. ~/.zshrc 에 추가할까요?"; then
    printf '\n# Yang Coding\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.zshrc"
    ok "~/.zshrc 에 PATH 추가 (새 터미널부터 적용)"
  else
    warn "~/.local/bin 이 PATH 에 없습니다. 전체 경로로 실행: ~/.local/bin/local-agent"
  fi
fi

# ---- 11. 확인 ------------------------------------------------------------------------
step "설치 확인"
(cd backend && .venv/bin/python -c "import app.main" >/dev/null 2>&1) && ok "백엔드 로드" || warn "백엔드 로드 실패 — cd backend && .venv/bin/python -c 'import app.main'"
[[ -x engine/target/release/agent-engine ]] && ok "엔진 바이너리" || warn "엔진 바이너리 없음"

echo
echo "================================================================"
echo " 설치 완료: $INSTALL_DIR"
echo "================================================================"
echo " 시작하기"
echo "  1) local-agent start        # Qdrant + 엔진 + 백엔드 실행 (새 터미널에서)"
echo "  2) VS Code: Cmd+Shift+P → 'Yang Coding: 채팅 열기' (오른쪽 사이드바)"
echo "     IntelliJ: 재시작 후 오른쪽 사이드바 'Yang Coding'"
echo "  3) 프로젝트 폴더를 열고 자연어로 요청"
echo
echo " 매뉴얼: $INSTALL_DIR/docs/MANUAL.md   설치 로그: $LOG"
if (( ${#WARNINGS[@]} )); then
  echo
  echo " 확인할 사항:"
  for w in "${WARNINGS[@]}"; do echo "  - $w"; done
fi
