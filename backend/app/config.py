from dataclasses import dataclass
import os


@dataclass
class Settings:
    ollama_host: str = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    default_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")
    vector_store_path: str = os.getenv("VECTOR_STORE_PATH", "/Users/jinugi/Desktop/Project2026/AI-agent/backend/data/style_samples")
    project_root: str = os.getenv("PROJECT_ROOT", "/Users/jinugi/Desktop/Project2026/AI-agent")
    vector_backend: str = os.getenv("VECTOR_BACKEND", "qdrant")
    qdrant_url: str = os.getenv("QDRANT_URL", "http://localhost:6333")
    qdrant_collection: str = os.getenv("QDRANT_COLLECTION", "project-style")
    default_project_name: str = os.getenv("DEFAULT_PROJECT_NAME", "AI-agent")


settings = Settings()
