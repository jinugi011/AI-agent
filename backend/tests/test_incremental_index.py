import threading
import time

import pytest

from app.vector_store import CodeVectorStore


class FakeStore(CodeVectorStore):
    """메모리 백엔드 + 가짜 임베딩 (임베딩한 텍스트 수를 센다)"""

    def __init__(self):
        self.base_dir = None
        self._model = None
        self.qdrant_client = None
        self.collection_name = "code"
        self._memory = {}
        self.embedded = 0
        self.fail = False

    def embed(self, texts):
        import numpy as np
        if self.fail:
            raise RuntimeError("임베딩 실패")
        self.embedded += len(texts)
        return np.ones((len(texts), 4)) / 2


DOCS = [("lib/a.dart", "class A {}\n" * 100), ("lib/b.dart", "class B {}\n" * 10), ("README.md", "# 앱")]


def test_only_changed_chunks_are_embedded():
    s = FakeStore()
    r1 = s.index_docs("p", DOCS, {})
    first = s.embedded
    assert r1["embedded"] == first and r1["chunks"] == first
    s.embedded = 0
    r2 = s.index_docs("p", DOCS, {})          # 그대로 → 다시 계산 없음
    assert s.embedded == 0 and r2["embedded"] == 0 and r2["removed"] == 0
    changed = [("lib/a.dart", "class A {}\n" * 100), ("lib/b.dart", "class B2 {}\n" * 10), ("README.md", "# 앱")]
    s.index_docs("p", changed, {})
    assert s.embedded == 1  # 바뀐 b.dart 청크 1개만 (코딩 방법 요약은 그대로라 다시 계산 안 함)


def test_deleted_files_removed_but_history_kept():
    s = FakeStore()
    s.index_docs("p", DOCS, {})
    s.upsert("code", [{"id_key": "p:history:j1", "text": "작업", "payload": {"project": "p", "kind": "history"}}])
    s.index_docs("p", DOCS[:1], {})
    sources = {(x["payload"]["kind"], x["payload"].get("source")) for x in s._memory["code"]}
    assert ("code", "lib/b.dart") not in sources and ("code", "lib/a.dart") in sources
    assert any(k == "history" for k, _ in sources)  # 작업 이력은 재색인으로 지워지지 않는다


def test_failure_keeps_previous_data():
    s = FakeStore()
    s.index_docs("p", DOCS, {})
    before = len(s._memory["code"])
    s.fail = True
    with pytest.raises(RuntimeError):
        s.index_docs("p", [("lib/new.dart", "x\n" * 5)], {})
    assert len(s._memory["code"]) == before  # 실패해도 기존 검색 데이터 유지


def test_remote_jobs_coalesce(monkeypatch, tmp_path):
    from app import remote
    monkeypatch.setattr(remote, "REGISTRY", tmp_path / "rp.json")
    monkeypatch.setattr(remote.archinfo, "is_fresh", lambda n: True)
    calls = []
    gate = threading.Event()

    class SlowStore:
        def index_docs(self, name, docs, configs):
            calls.append(len(docs))
            gate.wait(5)
            return {"chunks": 1, "methods": {}, "embedded": 1, "removed": 0}

    st = SlowStore()
    remote.start_index(st, "proj", [{"path": "a.py", "content": "1"}])
    time.sleep(0.2)                              # 첫 작업이 잠금을 잡고 실행 중
    for n in range(2, 5):                        # 그동안 3번 더 요청 → 마지막 것만 실행돼야 함
        remote.start_index(st, "proj", [{"path": f"f{i}.py", "content": "1"} for i in range(n)])
    time.sleep(0.2)
    assert remote.get_project("proj")["status"] == "indexing"
    gate.set()
    for _ in range(50):
        if remote.get_project("proj")["status"] == "ready":
            break
        time.sleep(0.1)
    assert calls == [1, 4]                       # 중간 요청 2개는 건너뜀
    assert remote.get_project("proj")["status"] == "ready"


def test_partial_update_changed_and_deleted_files():
    s = FakeStore()
    s.index_docs("p", DOCS, {})
    s.embedded = 0
    r = s.index_docs("p", [("lib/b.dart", "class B3 {}\n" * 10)], {}, partial=True, deleted=["README.md"])
    assert r["embedded"] == 1 and s.embedded == 1
    sources = {x["payload"].get("source") for x in s._memory["code"] if x["payload"]["kind"] == "code"}
    assert "README.md" not in sources and "lib/a.dart" in sources   # 안 건드린 파일은 그대로
    assert any(x["payload"]["kind"] == "methods" for x in s._memory["code"])  # 요약은 유지
