from dataclasses import dataclass, field
from pathlib import Path
import os

_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Settings:
    project_root: str = os.getenv("PROJECT_ROOT", str(_ROOT))

    # Rust 추론 엔진 (engine/) — 기본 LLM 경로
    engine_url: str = os.getenv("ENGINE_URL", "http://127.0.0.1:8091")
    engine_timeout: float = float(os.getenv("ENGINE_TIMEOUT", "900"))
    model_path: str = os.getenv(
        "ENGINE_MODEL_PATH", str(_ROOT / "models" / "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf")
    )

    # 엔진이 없을 때만 쓰는 대체 경로
    ollama_host: str = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    default_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")
    llm_fallback_ollama: bool = os.getenv("LLM_FALLBACK_OLLAMA", "1") == "1"

    # 벡터 DB
    vector_backend: str = os.getenv("VECTOR_BACKEND", "qdrant")
    qdrant_url: str = os.getenv("QDRANT_URL", "http://localhost:6333")
    qdrant_collection: str = os.getenv("QDRANT_COLLECTION", "project-style")
    code_collection: str = os.getenv("QDRANT_CODE_COLLECTION", "code-style")
    prefs_collection: str = os.getenv("QDRANT_PREFS_COLLECTION", "agent-preferences")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    vector_store_path: str = os.getenv("VECTOR_STORE_PATH", str(_ROOT / "backend" / "data" / "style_samples"))

    # 에이전트 상태 (선호/제약, 레포 목록, 작업 로그) — 항상 디스크에 저장
    state_dir: str = os.getenv("AGENT_STATE_DIR", str(_ROOT / "backend" / "data" / "agent_state"))
    workspaces_dir: str = os.getenv("AGENT_WORKSPACES_DIR", str(_ROOT / "workspaces"))
    max_iterations: int = int(os.getenv("AGENT_MAX_ITERATIONS", "4"))
    test_timeout: int = int(os.getenv("AGENT_TEST_TIMEOUT", "600"))

    default_project_name: str = os.getenv("DEFAULT_PROJECT_NAME", "AI-agent")
    extra: dict = field(default_factory=dict)


settings = Settings()
Path(settings.state_dir).mkdir(parents=True, exist_ok=True)
