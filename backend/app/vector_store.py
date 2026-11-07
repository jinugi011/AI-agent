from __future__ import annotations

import os
from pathlib import Path
from typing import List, Dict, Any

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

try:
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams, PointStruct
except Exception:  # pragma: no cover
    QdrantClient = None
    Distance = None
    VectorParams = None
    PointStruct = None


class CodeVectorStore:
    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        self.sources: List[str] = []
        self.contents: List[str] = []
        self.index = None
        self.backend = os.getenv("VECTOR_BACKEND", "qdrant").lower()
        self.collection_name = os.getenv("QDRANT_COLLECTION", "project-style")
        self.qdrant_url = os.getenv("QDRANT_URL", "http://localhost:6333")
        self.qdrant_client = None
        if self.backend == "qdrant" and QdrantClient is not None:
            self.qdrant_client = QdrantClient(url=self.qdrant_url)
            self._init_qdrant_collection()
        else:
            self._load_documents()

    def _init_qdrant_collection(self):
        exists = self.qdrant_client.collection_exists(collection_name=self.collection_name)
        if not exists:
            self.qdrant_client.create_collection(
                collection_name=self.collection_name,
                vectors_config=VectorParams(size=384, distance=Distance.COSINE),
            )

    def _load_documents(self):
        for path in sorted(self.base_dir.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".py", ".js", ".ts", ".tsx", ".java", ".kt", ".dart", ".sql", ".md", ".yaml", ".yml", ".json"}:
                continue
            try:
                content = path.read_text(encoding="utf-8")
            except Exception:
                continue
            if not content.strip():
                continue
            self.sources.append(str(path.relative_to(self.base_dir.parent)))
            self.contents.append(f"{path.name}\n{content[:4000]}")

        if not self.contents:
            self.contents = ["기본 코딩 스타일 문서가 아직 없습니다."]
            self.sources = ["system"]

        embeddings = self.model.encode(self.contents, convert_to_numpy=True, normalize_embeddings=True)
        self.index = faiss.IndexFlatIP(embeddings.shape[1])
        self.index.add(embeddings.astype("float32"))

    def add_project_style(self, project_name: str, project_root: str):
        if self.backend != "qdrant" or self.qdrant_client is None:
            return
        docs = []
        for path in sorted(Path(project_root).rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".py", ".js", ".ts", ".tsx", ".java", ".kt", ".dart", ".sql", ".md", ".yaml", ".yml", ".json"}:
                continue
            try:
                content = path.read_text(encoding="utf-8")
            except Exception:
                continue
            if not content.strip():
                continue
            docs.append({
                "id": f"{project_name}:{path.relative_to(project_root)}",
                "payload": {
                    "project": project_name,
                    "source": str(path.relative_to(project_root)),
                    "content": content[:4000],
                },
                "vector": self.model.encode([f"{project_name} {path.name}\n{content[:2000]}"])[0].tolist(),
            })
        if docs:
            self.qdrant_client.upsert(
                collection_name=self.collection_name,
                points=[PointStruct(id=idx, vector=item["vector"], payload=item["payload"]) for idx, item in enumerate(docs)],
            )

    def search(self, query: str, top_k: int = 4) -> List[Dict[str, str]]:
        if self.backend == "qdrant" and self.qdrant_client is not None:
            vector = self.model.encode([query], normalize_embeddings=True)[0].tolist()
            result = self.qdrant_client.search(
                collection_name=self.collection_name,
                query_vector=vector,
                limit=top_k,
            )
            hits = []
            for item in result:
                hits.append({
                    "score": float(item.score),
                    "source": item.payload.get("source", "project"),
                    "content": item.payload.get("content", "")[:1200],
                })
            return hits

        if self.index is None:
            return []
        vector = self.model.encode([query], convert_to_numpy=True, normalize_embeddings=True).astype("float32")
        scores, indexes = self.index.search(vector, min(top_k, len(self.contents)))
        hits = []
        for score, idx in zip(scores[0], indexes[0]):
            if idx < 0:
                continue
            hits.append({
                "score": float(score),
                "source": self.sources[int(idx)],
                "content": self.contents[int(idx)][:1200],
            })
        return hits
