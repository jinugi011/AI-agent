# Local Coding Agent — 작업 내역 및 사용 매뉴얼

> 기준일: 2026-11-13 · 대상 장비: Apple M3 Max (36GB) · macOS

로컬에서 돌아가는 코딩 모델(Qwen3-Coder 30B)을 Rust로 구동하고, VS Code 채팅창에서 자연어로
코드를 읽고·수정하고·테스트하는 에이전트입니다. 외부 API를 쓰지 않으며 코드는 로컬 밖으로 나가지 않습니다.

---

## 1. 구성 한눈에 보기

```
┌──────────────── VS Code ────────────────┐
│  Local Agent 채팅 패널 (확장)              │
│   · 에이전트 루프 (모델 ↔ 도구 반복)         │
│   · 파일 수정 = VS Code 편집 API (diff/되돌리기) │
│   · 명령 실행 = 승인 후 실행                 │
└───────┬───────────────────────┬─────────┘
        │ 스트리밍 생성            │ 컨텍스트/선호/모델 관리
        ▼                       ▼
 Rust 엔진 :8091          FastAPI 백엔드 :8010 ──► Qdrant :6333
 (llama.cpp + Metal)       · 레포 연결·벡터화          code-style / agent-preferences
 Qwen3-Coder-30B GGUF      · 선호/제약 영구 저장
                           · 요구사항 하네스 작업
                           · 모델 다운로드·엔진 실행
```

| 구성요소 | 위치 | 역할 |
|---|---|---|
| Rust 추론 엔진 | `engine/` | GGUF 모델을 Metal GPU로 구동. `/health`, `/generate`(일반/스트리밍) |
| 백엔드 | `backend/app/` | 레포·선호·하네스·모델 관리 API |
| VS Code 확장 | `vscode-extension/` | 채팅 UI와 에이전트 루프 |
| IntelliJ 플러그인 | `intellij-plugin/` | 같은 채팅 UI(JCEF) + Kotlin 에이전트 루프 |
| 웹 대시보드 | `frontend/` | 브라우저용 작업 화면 (Coding Agent 탭) |
| 벡터 DB | Qdrant (Docker) | 코드 스타일·코딩 방법·선호 벡터 저장 |
| 모델 파일 | `models/` | `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf` (18.6GB, git 제외) |

---

## 2. 작업 내역

### 2.1 1단계 — 코딩 에이전트 기반 (백엔드 + Rust 엔진)

| 요구사항 | 구현 | 파일 |
|---|---|---|
| git 레포·언어·만들 기능 입력 → 코딩 | 레포 연결(로컬 경로/git URL clone), 작업마다 `agent/…` 브랜치 생성 후 커밋 | `repo_manager.py`, `coding_agent.py` |
| M3 Max용 코딩 모델 | Qwen3-Coder-30B-A3B Q4_K_M. MoE(토큰당 3B 활성)라 빠르고 32k 컨텍스트 수용 | `model_manager.py` |
| 코딩 스타일 벡터화 (Qdrant) | 코드를 80줄 단위로 나눠 임베딩 + 린트/포맷 설정 + 자동 추출한 "코딩 방법" 저장 | `vector_store.py` |
| 모델 직접 접근 (C++ → **Rust**로 변경) | `llama-cpp-2` 크레이트로 llama.cpp 호출, HTTP 서버 내장 | `engine/src/` |
| 요구사항 하네스화 | 요구사항 → 테스트 먼저 생성 → 구현 → 테스트 → 실패 로그 피드백 반복 | `harness.py` |
| 스타일·선호·제약 항상 저장 | JSON 파일(원본) + Qdrant 동기화, 범위가 맞으면 모든 프롬프트에 항상 포함 | `preferences.py` |
| 모바일·서버 등 다양한 프로젝트 | 10개 프로필 (아래 표) | `profiles.py` |
| 연결할 때마다 코딩 방법 벡터화 | 연결·재연결·작업 시작 시 재색인 (이전 색인 교체) | `vector_store.py` |

지원 프로필:

| 분류 | 프로필 키 | 테스트 도구 |
|---|---|---|
| 서버 | `python-fastapi`, `node-server`, `go-server`, `rust`, `spring-boot` | pytest, vitest, go test, cargo test, gradle |
| 웹 | `react-web` | vitest |
| 모바일 | `flutter`, `react-native`, `android-kotlin`, `ios-swift` | flutter test, jest, gradle, swift test |

### 2.2 2단계 — VS Code 확장 (Claude Code 스타일 채팅)

- **채팅 패널**: 사이드바 아이콘 또는 `Cmd+Shift+L`. 응답이 토큰 단위로 실시간 표시되고 중단 버튼으로 즉시 멈춤
- **자연어 도구 사용**: 모델이 필요에 따라 파일 읽기/검색/수정, 명령 실행, 선호 저장, 하네스 작업, 모델 관리를 호출
- **안전장치**: 파일 수정은 대화 턴 단위로 diff 보기·되돌리기, 터미널 명령은 기본적으로 승인 필요, 워크스페이스 밖/`.git` 내부 수정 차단
- **모델·엔진 설정을 채팅으로**: 엔진이 꺼져 있어도 "30B 모델 받아줘", "엔진 시작해줘" 같은 말은 처리됨. 설정 카드에 다운로드 진행률 표시
- **레포 자동 연결**: 워크스페이스에서 처음 요청하면 자동으로 연결·벡터화
- **Rust 엔진 스트리밍 추가**: NDJSON 토큰 스트리밍, 클라이언트 연결이 끊기면 생성 중단

### 2.3 검증 결과

| 항목 | 결과 |
|---|---|
| 백엔드 단위 테스트 (가짜 LLM, 전체 흐름) | 13개 통과 |
| 확장 프로토콜 단위 테스트 | 5개 통과 |
| 웹 프론트엔드 빌드 | 성공 |
| Rust 엔진 (7B / 30B 실모델) | 7B ≈ 50 tok/s, 30B ≈ 60 tok/s, 한글 스트리밍·중단 정상 |
| 하네스 작업 실모델 e2e (7B) | 데모 레포에서 테스트 생성→구현→통과→커밋 성공 (31초) |
| 채팅 루프 실모델 시뮬레이션 (30B) | 도구 프로토콜 준수 확인. 아래 4.3의 품질 문제 발견 후 프롬프트·실행 규칙 보완 |
| VS Code 확장 설치·표시 | 설치·활성화 확인, 0.1.1에서 오른쪽 보조 사이드바로 이동 (채팅 기능 전체 점검은 사용하면서 확인) |
| IntelliJ 플러그인 빌드 · 프로토콜 테스트 · 구조 검증 | 성공 · 5개 통과 · 경고 없음 |
| IntelliJ 플러그인 로드 (샌드박스 IDE) | 오류 없이 로드됨 ("Loaded custom plugins: Local Coding Agent") |
| **IntelliJ 채팅 패널 실제 동작** | **아직 확인 전** — 프로젝트를 열고 툴 윈도우를 띄워 확인 필요 |

### 2.4 개발 중 발견해 고친 문제

- 포트 충돌: 8090을 다른 Java 앱이 사용 중 → 엔진 기본 포트 **8091**
- 엔진 종료 시 Metal 자원 해제 순서 오류로 크래시 → 해제 순서 수정
- 기존 벡터 저장소에서 모든 프로젝트가 같은 ID를 써 서로 덮어씀 → 결정적 UUID로 수정
- 모델이 기대값이 틀린 테스트를 생성 → 같은 실패 반복 시 "테스트가 틀렸나?"를 따로 판정, 테스트 수정 시 이유를 로그·커밋에 기록
- 작은 모델의 출력 형식 이탈(마크다운 코드블록) → 대체 파서 추가
- 30B가 요청한 시그니처를 바꾸고 테스트를 약화시켜 통과시킴 → 금지 규칙 추가
- 30B가 결과를 보기 전에 수정·실행을 한꺼번에 호출 → 조회 도구가 앞에 있으면 조회만 실행하고 나머지는 다시 요청하게 함

---

## 3. 설치

### 3.0 새 PC에 한 번에 설치 (설치 스크립트 · 권장)

다른 Mac에 같은 환경을 만들 때는 `install.sh` 하나로 끝납니다.

**준비물**: macOS (Apple Silicon 권장), 인터넷, 디스크 여유 (30B 모델 기준 약 35GB).
VS Code / IntelliJ 는 미리 설치해 두면 플러그인까지 자동으로 설치됩니다.

**실행** — 터미널에서 둘 중 하나:
```bash
# 1) 한 줄 설치 (레포를 ~/AI-agent 에 받음)
curl -fsSL https://raw.githubusercontent.com/jinugi011/AI-agent/main/install.sh | bash

# 2) 레포를 직접 받은 뒤 실행
git clone https://github.com/jinugi011/AI-agent.git ~/AI-agent
cd ~/AI-agent && ./install.sh
```
> 레포가 비공개라면 먼저 GitHub 로그인(`brew install gh && gh auth login`)이 필요합니다.
> 이 PC에서 작업한 최신 내용이 다른 PC에 가려면 **먼저 commit · push** 되어 있어야 합니다.

**설치 스크립트가 하는 일** (이미 된 단계는 건너뜀 · 다시 실행해도 안전)

| 단계 | 내용 |
|---|---|
| 1 | macOS·메모리·디스크 확인, Xcode Command Line Tools 확인 |
| 2 | Homebrew (없으면 설치 여부 질문) → git, python@3.13, node, rust, cmake |
| 3 | 레포 받기 (`~/AI-agent`, 이미 있으면 `git pull`) |
| 4 | 백엔드 가상환경 + **검증된 고정 버전** 패키지 (`backend/requirements.lock.txt`) + 임베딩 모델 |
| 5 | Rust 엔진 빌드 (llama.cpp + Metal) |
| 6 | **메모리에 맞는 코딩 모델 자동 선택·다운로드** — 32GB↑: 30B · 16GB↑: 14B · 그 외: 7B |
| 7 | Docker 확인 (없으면 Docker Desktop 설치 여부 질문) → Qdrant 실행 |
| 8 | 웹 대시보드 의존성 |
| 9 | VS Code 확장 빌드·설치 (VS Code 가 있을 때) |
| 10 | IntelliJ 플러그인 빌드·설치 (IntelliJ 2025.2+ 가 있을 때, IDE 내장 Java 로 빌드 — 별도 JDK 불필요) |
| 11 | 설치 위치를 `~/.config/local-agent/config.json` 에 기록 → **VS Code·IntelliJ 가 자동으로 찾음 (폴더 지정 불필요)** |
| 12 | `local-agent` 명령 등록 (`~/.local/bin`, PATH 추가 여부 질문) |

**옵션**

| 옵션 | 설명 |
|---|---|
| `--model auto\|30b\|14b\|7b\|none` | 모델 선택 (기본 auto) |
| `--dir <경로>` | 설치 위치 (기본 `~/AI-agent`) |
| `--skip-vscode` · `--skip-intellij` · `--skip-docker` | 해당 단계 생략 |
| `-y` | 모든 질문에 '예' |

예) 메모리가 적은 노트북에 7B 로: `./install.sh --model 7b`

**설치 후**
```bash
local-agent start      # Qdrant + 엔진 + 백엔드 실행 (새 터미널에서)
local-agent status     # 상태 확인
local-agent stop       # 종료
local-agent logs       # 엔진·백엔드 로그
local-agent update     # 최신 소스 받고 재설치 (모델 유지)
```
그다음 VS Code 는 **Developer: Reload Window** 후 `Cmd+Shift+P` → **Local Agent: 채팅 열기**,
IntelliJ 는 재시작 후 오른쪽 사이드바 **Local Agent**.
설치 로그: `~/.config/local-agent/install.log`

**검증**: 이 PC에서 ① 이미 설치된 상태로 재실행(14초, 전 단계 통과) ② 가상환경·빌드·모델이 없는 빈 복사본에서
처음부터 설치(1분 43초 — 패키지 캐시 있음, 새 PC는 모델 제외 10~20분 예상) 를 확인했습니다.
아직 **실제 다른 Mac 에서는 실행해 보지 않았습니다.**

### 3.1 수동 설치 (스크립트 없이)

```bash
cd ~/Desktop/Project2026/AI-agent

# Rust (엔진 빌드용)
brew install rust

# 백엔드 가상환경 (검증된 고정 버전)
cd backend && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.lock.txt && cd ..

# Rust 엔진 빌드 (수 분)
cd engine && cargo build --release && cd ..

# 모델 다운로드 (18.6GB, 이미 받아둠)
scripts/dev.sh download

# Qdrant
docker compose -f docker-compose.vector.yml up -d qdrant
```

### 3.2 VS Code 확장 설치

설치 파일: `vscode-extension/local-coding-agent-0.1.1.vsix` (이미 만들어져 있음)

**1) 확장 설치** — 둘 중 편한 방법

- 터미널:
  ```bash
  cd ~/Desktop/Project2026/AI-agent/vscode-extension
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    --install-extension local-coding-agent-0.1.1.vsix --force
  ```
- VS Code 화면: 확장 탭(`Cmd+Shift+X`) → 오른쪽 위 **`…`** → **VSIX에서 설치…** → 위 파일 선택

설치 후 `Cmd+Shift+P` → **Developer: Reload Window** 로 창을 새로고침합니다.

**2) AI-agent 폴더 지정 (처음 한 번만)**

`Cmd+,` → `localAgent.agentRoot` 검색 → 아래 경로 입력. 이후 VS Code를 켜면 백엔드가 자동 실행됩니다.
```
/Users/<사용자>/Desktop/Project2026/AI-agent
```
(명령 팔레트의 **Local Agent: AI-agent 폴더 지정** 으로 폴더를 골라도 됩니다.)

**3) 채팅창 열기 — 오른쪽 보조 사이드바**

0.1.1부터 채팅창은 **오른쪽 보조 사이드바**에 뜹니다.

- 보조 사이드바가 닫혀 있으면 `Cmd+Option+B` (메뉴: 보기 → 모양 → 보조 사이드바)
- 위쪽 탭에서 **Local Agent** 선택 (Codex 등 다른 탭과 나란히 표시)
- 가장 확실한 방법: `Cmd+Shift+P` → **Local Agent: 채팅 열기**
- 다른 위치가 좋으면 탭을 끌어서 옮기면 VS Code가 위치를 기억합니다.

> `Cmd+Shift+L` 은 VS Code 기본 단축키("일치하는 항목 모두 선택")와 겹쳐 채팅이 안 열릴 수 있습니다. 명령 팔레트를 쓰세요.

**4) 다시 설치할 때 (확장 코드를 고친 경우)**
```bash
cd ~/Desktop/Project2026/AI-agent/vscode-extension
npm run package
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension local-coding-agent-0.1.1.vsix --force
```
그 다음 **Developer: Reload Window**.

> 확장 개발 모드: `vscode-extension` 폴더를 VS Code로 열고 `F5` → 새 창에서 바로 테스트.

### 3.3 IntelliJ 플러그인 설치

IntelliJ IDEA **2025.2 이상**(CE/Ultimate)에서 동작합니다. 현재 설치된 IntelliJ IDEA CE 2025.2.3은 지원됩니다.
Android Studio는 버전 체계가 달라 동작 여부를 확인하지 않았습니다.

설치 파일: `intellij-plugin/build/distributions/local-coding-agent-intellij-0.1.0.zip` (이미 만들어져 있음)

**1) 플러그인 설치**

1. IntelliJ 메뉴 **IntelliJ IDEA → Settings…** (`Cmd+,`)
2. 왼쪽 **Plugins**
3. 위쪽 **⚙ (톱니바퀴)** → **Install Plugin from Disk…**
4. 아래 파일 선택 (파일 창에서 `Cmd+Shift+G` 를 누르고 경로를 붙여넣으면 바로 이동)
   ```
   /Users/<사용자>/Desktop/Project2026/AI-agent/intellij-plugin/build/distributions/local-coding-agent-intellij-0.1.0.zip
   ```
5. **Restart IDE** — 실행 중인 앱(예: SpringBoot 서버)이 있으면 먼저 정리

**2) AI-agent 폴더 지정 (처음 한 번만)**

**Settings → Tools → Local Coding Agent** → **AI-agent 폴더**에 아래 경로 입력 → **OK**
```
/Users/<사용자>/Desktop/Project2026/AI-agent
```
백엔드가 꺼져 있으면 채팅창을 열 때 자동으로 실행됩니다.

**3) 사용**

1. 작업할 프로젝트를 엽니다 (git 레포).
2. **오른쪽 사이드바**의 **Local Agent** 클릭
3. 상단 상태 표시 확인 → 🟢 `Qwen3-Coder-30B…` 이면 바로 자연어로 요청
   (🟡 엔진 꺼짐이면 카드의 **엔진 시작** 버튼 또는 "엔진 시작해줘")
4. 에디터에서 코드 선택 → 우클릭 → **Local Agent: 선택 영역에 대해 묻기**

| 기능 | IntelliJ에서 |
|---|---|
| 채팅 UI | VS Code 확장과 같은 화면(`chat.js`/`chat.css` 공유, JCEF 내장 브라우저), IDE 테마 색 자동 적용 |
| 파일 수정 | IntelliJ 편집 명령으로 반영 → 에디터에서 **Cmd+Z** 로도 되돌리기 가능 |
| diff | 채팅의 **diff** → IntelliJ 비교 창 |
| 선택 영역 질문 | 에디터 우클릭 → **Local Agent: 선택 영역에 대해 묻기** (`Cmd+Shift+L`) |
| 새 대화 | 툴 윈도우 제목줄의 **+** 버튼 또는 `/new` |
| 설정 | Settings → Tools → Local Coding Agent (항목은 VS Code 설정과 동일) |
| 백엔드 로그 | `backend/data/agent_state/backend-intellij.log` |

**4) 다시 빌드·설치할 때 (플러그인 코드를 고친 경우)**
```bash
cd ~/Desktop/Project2026/AI-agent/intellij-plugin
gradle buildPlugin
```
그 다음 1)의 **Install Plugin from Disk…** 로 새 zip을 설치하고 IDE를 재시작합니다.

> 개발 모드: `gradle runIde` → 플러그인이 설치된 샌드박스 IntelliJ 실행 (사용자 설정과 분리됨).

---

## 4. 사용법

### 4.1 시작 순서

1. Qdrant가 떠 있는지 확인 (`docker ps`에 `coding-agent-qdrant`)
2. 작업할 프로젝트 폴더(git 레포)를 VS Code 또는 IntelliJ로 연다
3. 채팅창 열기 — VS Code: 오른쪽 보조 사이드바의 **Local Agent** (`Cmd+Shift+P` → **Local Agent: 채팅 열기**) /
   IntelliJ: 오른쪽 사이드바의 **Local Agent**
4. 상단 상태줄 확인
   - 🔴 백엔드 꺼짐 → **백엔드 시작** 버튼
   - 🟡 엔진 꺼짐 → 설정 카드에서 모델의 **엔진 시작** (30B 로딩 약 10~30초), 또는 채팅에 "엔진 시작해줘"
   - 🟢 `Qwen3-Coder-30B-A3B-Instruct (ctx 32768) · 레포명` → 사용 가능
5. 자연어로 요청

### 4.2 이렇게 말하면 됩니다

| 하고 싶은 것 | 예시 |
|---|---|
| 기능 구현 | "장바구니에 쿠폰 할인 기능 추가하고 테스트 돌려줘" |
| 코드 이해 | "결제 흐름이 어디서 시작되는지 설명해줘" |
| 선택 영역 작업 | 에디터에서 코드 선택 → "이거 리팩터링해줘" (우클릭 **선택 영역에 대해 묻기**도 가능) |
| 버그 수정 | "pytest 돌려보고 실패하는 거 고쳐줘" |
| 선호·제약 저장 | "앞으로 Python 은 ruff 규칙, 줄 길이 100 으로 해줘", "이 프로젝트에서 금액은 항상 int 원 단위야. 기억해줘" |
| 큰 기능을 테스트 우선으로 | "/task 회원가입 API: 이메일 형식 검증, 비밀번호 8자 이상, 중복 이메일은 409" |
| 모델 관리 | "모델 상태 알려줘", "14B 모델 받아줘", "엔진 껐다 켜줘" |
| 다른 레포 연결 | "/connect https://github.com/me/app.git" |

### 4.3 채팅 화면 요소

- **도구 카드**: `✓ Read src/app.py`, `◌ Run: npm test`(실행 중), `✕`(실패), `⊘`(거부). "세부 정보"를 펼치면 출력이 보입니다.
- **파일 변경 카드**: `Edit shop/cart.py +5 −1 diff 열기`
  - **diff** → 변경 전/후 비교 창
  - 턴이 끝나면 `N개 파일 변경됨 · 되돌리기` → 그 턴의 모든 파일 변경을 원래대로
- **승인 카드** (명령 실행 시): **허용 / 항상 허용(이 대화 동안) / 거부**
- **중단** 버튼: 모델 생성과 실행 중인 명령을 즉시 멈춤

### 4.4 슬래시 명령

| 명령 | 설명 |
|---|---|
| `/help` | 사용법 |
| `/new` | 새 대화 (대화 기록·"항상 허용" 초기화) |
| `/stop` | 중단 |
| `/undo` | 마지막 턴의 파일 변경 되돌리기 |
| `/model status` · `/model download <key>` · `/model start [key]` · `/model stop` | 모델 관리. key: `qwen3-coder-30b`, `qwen2.5-coder-14b`, `qwen2.5-coder-7b` |
| `/remember <종류> <범위> 내용` | 종류 `style`·`preference`·`constraint`, 범위 `global`·`language:python`·`profile:flutter`·`project` |
| `/task 요구사항` | 하네스 작업 (새 브랜치에서 테스트 우선 구현 → 커밋) |
| `/connect 경로|URL` | 레포 연결·벡터화 |
| `/reindex` | 현재 레포 재벡터화 |

### 4.5 모델이 쓰는 도구

| 도구 | 동작 | 승인 |
|---|---|---|
| `READ` / `LIST` / `GREP` / `SEARCH` | 파일 읽기, 목록, 텍스트 검색, 벡터 검색 | 불필요 |
| `FILE` / `EDIT` | 파일 생성·전체 교체 / 부분 수정(SEARCH→REPLACE) | 기본 자동 (설정으로 "ask" 가능), 항상 되돌리기 가능 |
| `RUN` | 터미널 명령 (`/bin/zsh -lc`, 워크스페이스에서, 5분 제한) | **기본 승인 필요** |
| `REMEMBER` | 선호/제약 영구 저장 | 불필요 |
| `HARNESS` | 백엔드 하네스 작업 실행 | 불필요 (새 브랜치에서 진행) |
| `MODEL` / `CONNECT` | 모델·엔진 관리 / 레포 연결 | 불필요 |

### 4.6 확장 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `localAgent.agentRoot` | (빈 값) | AI-agent 폴더. 백엔드 자동 실행에 필요 |
| `localAgent.backendUrl` | `http://127.0.0.1:8010` | 백엔드 주소 |
| `localAgent.engineUrl` | `http://127.0.0.1:8091` | Rust 엔진 주소 |
| `localAgent.autoStartBackend` | `true` | VS Code 시작 시 백엔드 자동 실행 |
| `localAgent.approveEdits` | `auto` | 파일 수정 승인 (`auto` / `ask`) |
| `localAgent.approveCommands` | `ask` | 명령 실행 승인 (`ask` / `auto` — `auto`는 권장하지 않음) |
| `localAgent.maxSteps` | `16` | 한 요청에서 모델↔도구 최대 반복 수 |
| `localAgent.maxTokens` | `4096` | 응답 1회 최대 토큰 |
| `localAgent.temperature` | `0.2` | 생성 온도 |

---

## 5. 하네스 작업 (테스트 우선 자동 구현)

`/task` 또는 채팅에서 큰 기능을 요청하면 백엔드가 다음을 수행합니다.

1. 레포에 커밋되지 않은 변경이 있으면 **거부** (작업 중인 코드 보호 — 먼저 커밋/stash)
2. `agent/<작업명>-<id>` 브랜치 생성, 레포 재색인
3. 요구사항을 `.agent/harness/requirements.json` 과 테스트 파일(`tests/agent_harness/` 등 프로필별 위치)로 생성
4. 구현 → 하네스 테스트 실행 → 실패 출력을 모델에 피드백 (기본 최대 4회)
5. 같은 실패가 반복되면 "테스트가 틀렸는지" 별도 판정. 테스트를 고치면 이유가 로그와 커밋 메시지에 남음
6. 결과(통과/실패)와 함께 커밋. 작업 이력은 벡터화되어 다음 작업에서 참고

하네스는 레포에 남아 이후 작업의 회귀 테스트로도 쓰입니다. 결과 브랜치는 직접 검토 후 병합하세요.

---

## 6. 선호 · 스타일 · 제약

- 저장 위치: `backend/data/agent_state/preferences.json` (원본) + Qdrant `agent-preferences`
- 종류: **constraint**(반드시 준수) > **style**(코딩 스타일) > **preference**(선호) 순으로 프롬프트에 들어감
- 범위: `global`(모든 프로젝트) · `language:python` · `profile:flutter` · `project`(현재 레포)
- 기본 제약 5개가 들어 있음 (비밀값 평문 금지, 입력 검증, 환경변수 사용, 테스트 동반, 작은 함수)
- 확인/삭제: 웹 대시보드(`http://localhost:5173` → Coding Agent 탭 3번 영역) 또는 `GET/DELETE /api/preferences`

---

## 7. 백엔드 API 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 백엔드·엔진·벡터DB 상태 |
| GET | `/api/models` | 모델 카탈로그, 다운로드 여부·진행률 |
| POST | `/api/models/download` | `{model}` 다운로드 시작 (백그라운드) |
| GET/POST | `/api/engine/status` · `/start` · `/stop` | 엔진 프로세스 관리. start `{model, ctx}` |
| POST | `/api/context` | `{query, workspace_path}` → 선호·코딩 방법·관련 코드 (미연결 레포 자동 연결) |
| GET/POST/DELETE | `/api/repos`, `/api/repos/connect`, `/api/repos/{name}` | 레포 목록/연결/해제 |
| POST | `/api/repos/{name}/reindex` | 재벡터화 |
| GET/POST | `/api/repos/{name}/harness`, `/harness/run` | 하네스 요구사항 조회/실행 |
| GET/POST/DELETE | `/api/preferences` | 선호·제약 |
| POST/GET | `/api/agent/run`, `/api/agent/jobs`, `/api/agent/jobs/{id}` | 하네스 작업 실행/조회 |
| POST | `/api/style/search` | 벡터 검색 |

Rust 엔진: `GET /health`, `POST /generate` `{messages, max_tokens, temperature, top_p, grammar, stop, seed, stream}`.
`stream: true`면 줄마다 `{"token": "…"}`, 마지막 줄에 `{"done": true, …통계}`.

---

## 8. 문제 해결

| 증상 | 확인/조치 |
|---|---|
| VS Code에서 채팅창이 안 보임 | `Cmd+Shift+P` → **Local Agent: 채팅 열기**. 보조 사이드바가 닫혀 있으면 `Cmd+Option+B`. 그래도 없으면 **Developer: Reload Window**, 확장 탭에서 `Local Coding Agent` 설치 여부 확인 (VS Code 프로필을 여러 개 쓰면 다른 프로필에 설치됐을 수 있음) |
| IntelliJ에서 Local Agent가 안 보임 | Settings → Plugins → Installed 에 `Local Coding Agent` 가 켜져 있는지 확인 → IDE 재시작. 메뉴 **View → Tool Windows → Local Agent** |
| IntelliJ 채팅창이 빈 화면 | JCEF(내장 브라우저)가 꺼진 IDE일 수 있음 → JetBrains Runtime 으로 실행 중인지 확인 |
| 설치 스크립트 실패 | `~/.config/local-agent/install.log` 확인 후 다시 `./install.sh` (중단된 단계부터 이어서 진행, 모델 다운로드도 이어받음) |
| `local-agent: command not found` | `~/.local/bin/local-agent` 로 실행하거나 `~/.zshrc` 에 `export PATH="$HOME/.local/bin:$PATH"` 추가 |
| 상태줄 "백엔드 꺼짐" | `localAgent.agentRoot` 지정 → **Local Agent: 백엔드 시작**. 로그는 출력 패널 "Local Agent" |
| 엔진 시작 실패 | `backend/data/agent_state/engine.log` 확인. 바이너리 없으면 `cd engine && cargo build --release` |
| 엔진 포트 충돌 | 8091을 쓰는 프로세스 확인: `lsof -nP -iTCP:8091 -sTCP:LISTEN` |
| 메모리 부족·느림 | 다른 큰 앱 종료, 또는 14B 모델(`/model download qwen2.5-coder-14b`) 사용 |
| 벡터 검색 결과 없음 | Qdrant 실행 확인 (`curl localhost:6333`), `/reindex` |
| 하네스 작업이 바로 실패 | "커밋되지 않은 변경" → 커밋 또는 `git stash` 후 재시도 |
| 모델이 엉뚱하게 수정 | 턴 끝의 **되돌리기** 또는 `/undo`, 요구사항을 더 구체적으로 다시 요청 |
| 응답이 중간에 끊김 | `localAgent.maxTokens` 늘리기, 또는 "계속"이라고 입력 |

수동 실행이 필요하면 `scripts/dev.sh`가 Qdrant → 엔진 → 백엔드 → 웹 UI를 한 번에 띄웁니다.

---

## 9. 알려진 한계와 다음 단계

**한계**
- VS Code 안에서의 실제 UI 동작은 아직 확인 전입니다 (로직은 단위 테스트와 실모델 시뮬레이션으로 검증).
- 로컬 30B 모델은 상용 모델보다 판단력이 약합니다. 요청한 시그니처를 바꾸거나 테스트를 느슨하게 고치는 경향이 있어 규칙을 추가했지만, **변경 사항은 diff로 꼭 확인**하세요.
- 엔진은 요청을 하나씩 순서대로 처리합니다 (여러 창에서 동시에 쓰면 대기).
- 컨텍스트 32k를 넘는 긴 대화는 오래된 도구 결과부터 요약됩니다. 주제가 바뀌면 `/new`를 권장합니다.
- 임베딩 모델(all-MiniLM-L6-v2)은 영어 중심이라 한국어 질의의 벡터 검색 품질이 낮을 수 있습니다.

**다음 단계 후보**
1. VS Code에 설치해 실제 사용 점검 (설정 카드, 승인, diff, 되돌리기)
2. 한국어·코드 겸용 임베딩 모델로 교체 (예: bge-m3)
3. 하네스 작업을 채팅 패널 안에서 실시간 로그로 표시 (현재는 도구 카드에 진행 단계만 표시)
4. 엔진 KV 캐시 재사용 (같은 대화의 앞부분을 다시 계산하지 않도록) → 응답 속도 개선
