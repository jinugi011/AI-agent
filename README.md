# Yang Coding

로컬 GGUF 코딩 모델(Rust + llama.cpp/Metal)로 git 레포에 직접 코드를 작성하는 에이전트.
요구사항을 먼저 테스트 하네스로 만들고, 테스트가 통과할 때까지 구현을 반복한다.
VS Code 확장(`vscode-extension/`)과 IntelliJ 플러그인(`intellij-plugin/`)의 채팅창으로 자연어 코딩을 지원한다.

**전체 작업 내역과 사용 매뉴얼: [docs/MANUAL.md](docs/MANUAL.md)** · 외부 접속(Tailscale): [§4.8](docs/MANUAL.md)

```
frontend (React)  ──►  backend (FastAPI :8010)  ──►  engine (Rust, llama.cpp Metal :18091)
                            │                              └─ models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf
                            └─►  Qdrant (:6333)  code-style / agent-preferences
```

## 새 PC에 설치

```bash
curl -fsSL https://raw.githubusercontent.com/jinugi011/AI-agent/main/install.sh | bash
local-agent start
```
자세한 내용: [docs/MANUAL.md §3.0](docs/MANUAL.md)

## 빠른 시작 (이미 설치된 PC)

```bash
brew install rust            # 최초 1회
scripts/dev.sh download      # 모델 다운로드 (~18.6GB)
scripts/dev.sh               # Qdrant + 엔진 + API + UI 실행 → http://localhost:5173
```

엔진만 확인: `engine/target/release/agent-engine --model models/<file>.gguf --prompt "fizzbuzz in python"`

## 동작

1. **레포 연결** (`POST /api/repos/connect`): 로컬 경로 또는 git URL(→ `workspaces/`에 clone).
   프로젝트 유형은 자동 감지하거나 직접 선택한다. 연결/재연결할 때마다 코드 청크와
   추출한 코딩 방법(들여쓰기, 네이밍, 테스트 위치, 린트 설정 등)을 Qdrant에 다시 벡터화한다.
2. **작업 실행** (`POST /api/agent/run`):
   `agent/<작업>` 브랜치 생성 → 재색인 → 요구사항을 `.agent/harness/requirements.json`과
   테스트 파일로 생성 → 구현 → 하네스 실행 → 실패 로그를 피드백해 최대 N회 반복 → 커밋.
   하네스 테스트는 구현 단계에서 수정할 수 없고, 이후 작업에서도 회귀 테스트로 계속 쓰인다.
   커밋되지 않은 변경이 있는 레포에서는 실행하지 않는다.
3. **스타일/선호/제약** (`/api/preferences`): `backend/data/agent_state/preferences.json`에
   영구 저장되고 Qdrant에도 동기화된다. 범위(전체/언어/프로젝트 유형/프로젝트)가 맞는 항목은
   모든 프롬프트에 항상 포함된다.

## 지원 프로젝트 유형

| 분류 | 프로필 | 하네스 실행 |
|---|---|---|
| 서버 | python-fastapi, node-server, go-server, rust, spring-boot | pytest / vitest / go test / cargo test / gradle |
| 웹 | react-web | vitest |
| 모바일 | flutter, react-native, android-kotlin, ios-swift | flutter test / jest / gradle / swift test |

정의는 [backend/app/profiles.py](backend/app/profiles.py)에 있다.

## 모델 선택 (M3 Max 36GB)

기본값은 `Qwen3-Coder-30B-A3B-Instruct Q4_K_M`(18.6GB)이다. MoE 구조라 토큰마다 3B만 활성화되어
빠르고, 32k 컨텍스트까지 메모리에 들어간다. 메모리가 부족하면 `MODEL_REPO=Qwen/Qwen2.5-Coder-14B-Instruct-GGUF`,
`MODEL_FILE=qwen2.5-coder-14b-instruct-q5_k_m.gguf`(10.5GB)로 바꾸고 `ENGINE_CTX`를 줄인다.

## 테스트

```bash
cd backend && .venv/bin/python -m pytest -q tests     # LLM/임베딩은 가짜로 대체, 오프라인 실행
```
