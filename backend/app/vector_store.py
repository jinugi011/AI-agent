"""코딩 스타일/방법 벡터 저장소 (Qdrant, 실패 시 메모리 내 numpy 대체).

컬렉션
- code-style        : 연결된 레포의 코드 청크(kind=code) + 추출된 코딩 방법 요약(kind=methods)
- agent-preferences : 사용자가 저장한 스타일/선호/제약 (preferences.py 가 관리)
"""
from __future__ import annotations

import re
import uuid
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import numpy as np

from .config import settings

try:
    from qdrant_client import QdrantClient
    from qdrant_client.models import (
        Distance,
        FieldCondition,
        Filter,
        FilterSelector,
        MatchValue,
        PointStruct,
        VectorParams,
    )
except Exception:  # pragma: no cover
    QdrantClient = None

CODE_EXTENSIONS = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript",
    ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".dart": "dart", ".swift": "swift", ".go": "go",
    ".rs": "rust", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".h": "cpp", ".c": "c", ".sql": "sql",
    ".md": "markdown", ".yaml": "yaml", ".yml": "yaml", ".json": "json", ".toml": "toml", ".css": "css",
}
SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", "Pods",
    ".dart_tool", ".gradle", ".idea", ".vscode", "coverage", ".pytest_cache", "DerivedData", "models",
}
STYLE_CONFIG_FILES = [
    ".editorconfig", ".prettierrc", ".prettierrc.json", ".eslintrc", ".eslintrc.json", "eslint.config.js",
    "ruff.toml", ".flake8", "pyproject.toml", "rustfmt.toml", "analysis_options.yaml", ".swiftlint.yml",
    "detekt.yml", ".golangci.yml", "tsconfig.json",
]
MAX_FILE_BYTES = 200_000
CHUNK_LINES = 80
EMBED_DIM = 384


def iter_source_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS or (part.startswith(".") and part not in {".github"}) for part in path.relative_to(root).parts[:-1]):
            continue
        if path.is_file() and path.suffix.lower() in CODE_EXTENSIONS and path.stat().st_size <= MAX_FILE_BYTES:
            yield path


def chunk_text(text: str, lines_per_chunk: int = CHUNK_LINES) -> List[str]:
    lines = text.splitlines()
    return ["\n".join(lines[i : i + lines_per_chunk]) for i in range(0, len(lines), lines_per_chunk)] or [text]


def extract_coding_methods(root: Path, files: List[Path]) -> Dict[str, Any]:
    """레포에서 코딩 방법(관례)을 휴리스틱으로 추출한다. LLM 없이 빠르게 동작."""
    lang_counter: Counter = Counter()
    indent_counter: Counter = Counter()
    quote_counter: Counter = Counter()
    naming: Counter = Counter()
    semicolon_lines = js_lines = 0
    typed_defs = py_defs = 0
    async_uses = 0
    for path in files:
        lang = CODE_EXTENSIONS[path.suffix.lower()]
        if lang in {"markdown", "json", "yaml", "toml"}:
            continue
        lang_counter[lang] += 1
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        for line in text.splitlines()[:400]:
            stripped = line.lstrip()
            if not stripped:
                continue
            lead = line[: len(line) - len(stripped)]
            if lead.startswith("\t"):
                indent_counter["tabs"] += 1
            elif lead:
                n = len(lead)
                indent_counter["4" if n % 4 == 0 else "2" if n % 2 == 0 else "other"] += 1
            if lang in {"javascript", "typescript"}:
                js_lines += 1
                if stripped.rstrip().endswith(";"):
                    semicolon_lines += 1
                quote_counter["single"] += stripped.count("'")
                quote_counter["double"] += stripped.count('"')
            if "async " in stripped or "await " in stripped:
                async_uses += 1
        if lang == "python":
            for m in re.finditer(r"^\s*def (\w+)\((.*?)\)\s*(->)?", text, re.M):
                py_defs += 1
                typed_defs += 1 if (m.group(3) or ":" in m.group(2)) else 0
                naming["snake_case" if "_" in m.group(1) or m.group(1).islower() else "camelCase"] += 1
        else:
            for m in re.finditer(r"(?:function|func|fun|fn)\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(", text):
                name = m.group(1) or m.group(2)
                if name:
                    naming["snake_case" if "_" in name else ("PascalCase" if name[0].isupper() else "camelCase")] += 1

    # 2칸 들여쓰기 코드도 4/8칸 줄이 많으므로, 2(mod 4) 줄이 일정 비율 이상이면 2칸으로 본다.
    spaced = indent_counter["2"] + indent_counter["4"]
    if indent_counter["tabs"] > spaced:
        indent = "tabs"
    elif spaced:
        indent = "2" if indent_counter["2"] > 0.15 * spaced else "4"
    else:
        indent = "unknown"
    top_dirs = sorted({p.relative_to(root).parts[0] for p in files if len(p.relative_to(root).parts) > 1})[:15]
    test_files = [str(p.relative_to(root)) for p in files if re.search(r"(^|/)(tests?|__tests__|spec)(/|$)|(_test|\.test|\.spec|Tests?)\.\w+$", str(p.relative_to(root)))]
    methods: Dict[str, Any] = {
        "languages": dict(lang_counter.most_common(6)),
        "indentation": "tabs" if indent == "tabs" else f"{indent} spaces",
        "naming": naming.most_common(1)[0][0] if naming else "unknown",
        "top_level_dirs": top_dirs,
        "style_configs": [f for f in STYLE_CONFIG_FILES if (root / f).exists()],
        "test_files_sample": test_files[:10],
        "has_tests": bool(test_files),
        "uses_async": async_uses > 5,
    }
    if py_defs:
        methods["python_type_hint_ratio"] = round(typed_defs / py_defs, 2)
    if js_lines:
        methods["js_semicolons"] = semicolon_lines / js_lines > 0.3
        methods["js_quotes"] = "single" if quote_counter["single"] >= quote_counter["double"] else "double"
    return methods


def methods_to_text(project: str, methods: Dict[str, Any]) -> str:
    lines = [f"# {project} 코딩 방법 요약"]
    for key, value in methods.items():
        lines.append(f"- {key}: {value}")
    return "\n".join(lines)


class CodeVectorStore:
    def __init__(self, base_dir: Optional[str] = None):
        self.base_dir = Path(base_dir or settings.vector_store_path)
        self._model = None
        self.qdrant_client = None
        self.collection_name = settings.code_collection
        self._memory: Dict[str, List[Dict[str, Any]]] = {}  # Qdrant 불가 시 대체 저장소
        if settings.vector_backend.lower() == "qdrant" and QdrantClient is not None:
            try:
                client = QdrantClient(url=settings.qdrant_url, timeout=10)
                client.get_collections()
                self.qdrant_client = client
            except Exception:
                self.qdrant_client = None
        self.ensure_collection(self.collection_name)

    @property
    def backend(self) -> str:
        return "qdrant" if self.qdrant_client is not None else "memory"

    @property
    def model(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(settings.embedding_model)
        return self._model

    def embed(self, texts: List[str]) -> np.ndarray:
        return self.model.encode(texts, convert_to_numpy=True, normalize_embeddings=True, batch_size=32)

    def ensure_collection(self, name: str) -> None:
        if self.qdrant_client is None:
            self._memory.setdefault(name, [])
            return
        if not self.qdrant_client.collection_exists(collection_name=name):
            self.qdrant_client.create_collection(
                collection_name=name, vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE)
            )

    # ---- 범용 upsert/delete/search ------------------------------------------------
    def upsert(self, collection: str, items: List[Dict[str, Any]]) -> int:
        """items: [{id_key, text, payload}] — id_key 로 결정적 UUID 를 만들어 재색인 시 덮어쓴다."""
        if not items:
            return 0
        self.ensure_collection(collection)
        vectors = self.embed([it["text"] for it in items])
        ids = [str(uuid.uuid5(uuid.NAMESPACE_URL, it["id_key"])) for it in items]
        if self.qdrant_client is None:
            store = {p["id"]: p for p in self._memory[collection]}
            for pid, vec, it in zip(ids, vectors, items):
                store[pid] = {"id": pid, "vector": vec, "payload": it["payload"]}
            self._memory[collection] = list(store.values())
            return len(items)
        for start in range(0, len(items), 128):
            self.qdrant_client.upsert(
                collection_name=collection,
                points=[
                    PointStruct(id=pid, vector=vec.tolist(), payload=it["payload"])
                    for pid, vec, it in list(zip(ids, vectors, items))[start : start + 128]
                ],
            )
        return len(items)

    def delete_where(self, collection: str, key: str, value: str) -> None:
        if self.qdrant_client is None:
            self._memory[collection] = [p for p in self._memory.get(collection, []) if p["payload"].get(key) != value]
            return
        if self.qdrant_client.collection_exists(collection_name=collection):
            self.qdrant_client.delete(
                collection_name=collection,
                points_selector=FilterSelector(filter=Filter(must=[FieldCondition(key=key, match=MatchValue(value=value))])),
            )

    def query(self, collection: str, text: str, top_k: int = 5, filters: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
        self.ensure_collection(collection)
        vector = self.embed([text])[0]
        filters = {k: v for k, v in (filters or {}).items() if v}
        if self.qdrant_client is None:
            points = [p for p in self._memory.get(collection, []) if all(p["payload"].get(k) == v for k, v in filters.items())]
            scored = sorted(((float(np.dot(vector, p["vector"])), p) for p in points), key=lambda x: -x[0])[:top_k]
            return [{"score": s, **p["payload"]} for s, p in scored]
        qfilter = Filter(must=[FieldCondition(key=k, match=MatchValue(value=v)) for k, v in filters.items()]) if filters else None
        result = self.qdrant_client.query_points(
            collection_name=collection, query=vector.tolist(), limit=top_k, query_filter=qfilter, with_payload=True
        )
        return [{"score": float(p.score), **(p.payload or {})} for p in result.points]

    # ---- 레포 색인 (요구사항 3, 8) ------------------------------------------------
    def index_repository(self, project: str, root: str) -> Dict[str, Any]:
        """레포 전체를 청크 단위로 벡터화하고 코딩 방법 요약을 함께 저장한다. 재연결 시 이전 색인을 교체."""
        root_path = Path(root)
        files = list(iter_source_files(root_path))
        methods = extract_coding_methods(root_path, files)

        items: List[Dict[str, Any]] = []
        for path in files:
            try:
                text = path.read_text(encoding="utf-8")
            except Exception:
                continue
            if not text.strip():
                continue
            rel = str(path.relative_to(root_path))
            lang = CODE_EXTENSIONS[path.suffix.lower()]
            for i, chunk in enumerate(chunk_text(text)):
                items.append({
                    "id_key": f"{project}:{rel}:{i}",
                    "text": f"{project} {rel}\n{chunk[:2000]}",
                    "payload": {"project": project, "source": rel, "language": lang, "kind": "code", "chunk": i, "content": chunk[:4000]},
                })
        for cfg in methods["style_configs"]:
            try:
                content = (root_path / cfg).read_text(encoding="utf-8")[:4000]
            except Exception:
                continue
            items.append({
                "id_key": f"{project}:config:{cfg}",
                "text": f"{project} style config {cfg}\n{content}",
                "payload": {"project": project, "source": cfg, "language": "config", "kind": "style-config", "content": content},
            })
        methods_text = methods_to_text(project, methods)
        items.append({
            "id_key": f"{project}:methods",
            "text": methods_text,
            "payload": {"project": project, "source": "coding-methods", "language": "meta", "kind": "methods", "content": methods_text},
        })

        self.delete_where(self.collection_name, "project", project)
        count = self.upsert(self.collection_name, items)
        return {"files": len(files), "chunks": count, "methods": methods, "backend": self.backend}

    def project_methods(self, project: str) -> Optional[str]:
        hits = self.query(self.collection_name, f"{project} 코딩 방법 요약", top_k=1, filters={"project": project, "kind": "methods"})
        return hits[0]["content"] if hits else None

    # ---- 하위 호환 API ---------------------------------------------------------------
    def add_project_style(self, project_name: str, project_root: str) -> Dict[str, Any]:
        return self.index_repository(project_name, project_root)

    def search(self, query: str, top_k: int = 4, project: Optional[str] = None, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        hits = self.query(self.collection_name, query, top_k=top_k, filters={"project": project, "kind": kind})
        return [
            {"score": h["score"], "source": h.get("source", ""), "project": h.get("project", ""), "kind": h.get("kind", ""), "content": h.get("content", "")[:1200]}
            for h in hits
        ]
