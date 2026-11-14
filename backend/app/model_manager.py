"""모델 카탈로그 · 다운로드 · Rust 엔진 프로세스 관리 (VS Code 채팅에서 자연어로 호출)."""
from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional

from . import llm_client
from .config import settings

ROOT = Path(settings.project_root)
MODELS_DIR = Path(os.getenv("AGENT_MODELS_DIR", str(ROOT / "models")))
ENGINE_BIN = ROOT / "engine" / "target" / "release" / "agent-engine"


@dataclass(frozen=True)
class CatalogModel:
    key: str
    label: str
    repo: str
    file: str
    size_gb: float
    ctx: int
    note: str


CATALOG: List[CatalogModel] = [
    CatalogModel("qwen3-coder-30b", "Qwen3-Coder 30B-A3B (Q4_K_M)", "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
                 "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf", 18.6, 32768, "권장 · M3 Max 36GB · MoE 라 빠름"),
    CatalogModel("qwen2.5-coder-14b", "Qwen2.5-Coder 14B (Q5_K_M)", "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF",
                 "Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf", 10.5, 32768, "메모리 여유가 적을 때"),
    CatalogModel("qwen2.5-coder-7b", "Qwen2.5-Coder 7B (Q5_K_M)", "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
                 "Qwen2.5-Coder-7B-Instruct-Q5_K_M.gguf", 5.4, 16384, "가볍고 빠름 · 품질 낮음"),
]


def _find_catalog(key_or_file: str) -> Optional[CatalogModel]:
    k = key_or_file.lower()
    return next((m for m in CATALOG if k in (m.key, m.file.lower()) or k in m.label.lower()), None)


class ModelManager:
    def __init__(self):
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        self._downloads: Dict[str, Dict] = {}
        self._engine: Optional[subprocess.Popen] = None
        self._engine_model: str = ""
        self._engine_log = Path(settings.state_dir) / "engine-backend.log"
        self._lock = threading.Lock()

    # ---- 카탈로그 / 로컬 모델 ------------------------------------------------------
    def _partial_bytes(self, file: str) -> int:
        """hf 다운로드 중인 .incomplete 파일 크기 (진행률 표시용)."""
        cache = MODELS_DIR / ".cache" / "huggingface" / "download"
        if not cache.exists():
            return 0
        lock = cache / f"{file}.lock"
        incompletes = sorted(cache.glob("*.incomplete"), key=lambda p: p.stat().st_mtime, reverse=True)
        return incompletes[0].stat().st_size if lock.exists() and incompletes else 0

    def list(self) -> Dict:
        local = sorted(str(p) for p in MODELS_DIR.glob("*.gguf"))
        models = []
        for m in CATALOG:
            path = MODELS_DIR / m.file
            dl = self._downloads.get(m.key, {})
            partial = self._partial_bytes(m.file) if not path.exists() else 0
            models.append({
                **asdict(m),
                "path": str(path),
                "downloaded": path.exists(),
                "downloading": dl.get("status") == "downloading" or partial > 0,
                "progress": round(min(partial / (m.size_gb * 1e9), 0.999), 3) if partial else (1.0 if path.exists() else 0.0),
                "error": dl.get("error", ""),
            })
        return {"catalog": models, "local_files": local, "models_dir": str(MODELS_DIR)}

    def download(self, key: str) -> Dict:
        m = _find_catalog(key)
        if m is None:
            raise KeyError(f"카탈로그에 없는 모델: {key}. 사용 가능: {', '.join(c.key for c in CATALOG)}")
        if (MODELS_DIR / m.file).exists():
            return {"status": "exists", "model": m.key}
        with self._lock:
            if self._downloads.get(m.key, {}).get("status") == "downloading":
                return {"status": "downloading", "model": m.key}
            self._downloads[m.key] = {"status": "downloading", "started": time.time()}

        def worker():
            try:
                from huggingface_hub import hf_hub_download

                hf_hub_download(repo_id=m.repo, filename=m.file, local_dir=str(MODELS_DIR))
                self._downloads[m.key] = {"status": "done"}
            except Exception as exc:  # noqa: BLE001
                self._downloads[m.key] = {"status": "error", "error": str(exc)}

        threading.Thread(target=worker, daemon=True).start()
        return {"status": "started", "model": m.key, "size_gb": m.size_gb}

    # ---- 엔진 프로세스 -------------------------------------------------------------
    def resolve_model_path(self, model: str) -> Path:
        m = _find_catalog(model) if model else None
        path = MODELS_DIR / m.file if m else Path(model).expanduser()
        if not model:  # 미지정: 받아둔 모델 중 카탈로그 우선순위가 가장 높은 것
            path = next((MODELS_DIR / c.file for c in CATALOG if (MODELS_DIR / c.file).exists()), Path(settings.model_path))
        if not path.exists():
            raise FileNotFoundError(f"모델 파일이 없습니다: {path}. 먼저 다운로드하세요.")
        return path

    def engine_status(self) -> Dict:
        health = llm_client.engine_health()
        managed = self._engine is not None and self._engine.poll() is None
        return {
            "online": health is not None,
            "managed": managed,
            "model": (health or {}).get("model"),
            "url": settings.engine_url,
            "binary": str(ENGINE_BIN),
            "binary_exists": ENGINE_BIN.exists(),
            "log_tail": self._engine_log.read_text(encoding="utf-8", errors="replace")[-1500:] if self._engine_log.exists() else "",
        }

    def start_engine(self, model: str = "", ctx: int = 0, wait: float = 180) -> Dict:
        running = llm_client.engine_health()
        if running and not model:
            # 이미 떠 있는 엔진(local-agent start 등으로 실행)을 중복 실행하지 않는다
            return {"status": "already-running", "model": running.get("model")}
        path = self.resolve_model_path(model)
        if running and Path(running["model"].get("model_path", "")).resolve() == path.resolve():
            return {"status": "already-running", "model": running.get("model")}
        if running and not (self._engine is not None and self._engine.poll() is None):
            raise RuntimeError(
                f"다른 엔진({running['model'].get('model_name')})이 이미 실행 중입니다. "
                "local-agent stop 으로 끈 뒤 다시 시도하세요."
            )
        if not ENGINE_BIN.exists():
            build = subprocess.run(["cargo", "build", "--release"], cwd=ROOT / "engine", capture_output=True, text=True)
            if build.returncode != 0:
                raise RuntimeError(f"엔진 빌드 실패: {build.stderr[-1500:]}")
        self.stop_engine()
        cat = next((c for c in CATALOG if c.file == path.name), None)
        port = settings.engine_url.rsplit(":", 1)[-1].strip("/")
        cmd = [str(ENGINE_BIN), "--model", str(path), "--port", port, "--ctx", str(ctx or (cat.ctx if cat else 16384))]
        log = self._engine_log.open("w", encoding="utf-8")
        self._engine = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self._engine_model = str(path)
        deadline = time.time() + wait
        while time.time() < deadline:
            if self._engine.poll() is not None:
                raise RuntimeError(f"엔진이 시작 중 종료되었습니다:\n{self.engine_status()['log_tail']}")
            health = llm_client.engine_health(timeout=1)
            if health:
                return {"status": "started", "model": health.get("model")}
            time.sleep(1)
        return {"status": "loading", "message": "모델 로딩이 계속되는 중입니다. 잠시 후 상태를 확인하세요."}

    def stop_engine(self) -> Dict:
        if self._engine is not None and self._engine.poll() is None:
            self._engine.terminate()
            try:
                self._engine.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self._engine.kill()
            self._engine = None
            return {"status": "stopped"}
        return {"status": "not-managed", "online": llm_client.engine_health() is not None}
