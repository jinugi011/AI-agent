"""코딩 스타일 · 선호 · 제약 사항 영구 저장소 (요구사항 6).

- 원본은 JSON 파일(agent_state/preferences.json)에 항상 저장 → 재시작/세션 끊김에도 유지
- 동시에 Qdrant 'agent-preferences' 컬렉션에 벡터화 → 작업 내용과 관련된 항목을 의미 검색
- 프롬프트 생성 시 범위가 맞는 constraint 는 검색 결과와 무관하게 '항상' 주입한다
"""
from __future__ import annotations

import json
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from .config import settings

KINDS = ("style", "preference", "constraint")
SCOPES = ("global", "language", "profile", "project")


@dataclass
class PreferenceItem:
    text: str
    kind: str = "preference"  # style | preference | constraint
    scope: str = "global"  # global | language | profile | project
    scope_value: str = ""  # 예: python, flutter, my-shop
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def applies_to(self, project: str = "", language: str = "", profile: str = "") -> bool:
        if self.scope == "global":
            return True
        target = {"language": language, "profile": profile, "project": project}.get(self.scope, "")
        return bool(target) and self.scope_value.lower() == target.lower()


DEFAULT_PREFERENCES = [
    PreferenceItem("비밀번호·토큰·개인정보는 로그와 응답에 절대 평문으로 남기지 않는다", "constraint"),
    PreferenceItem("모든 외부 입력은 검증한다", "constraint"),
    PreferenceItem("비밀값은 코드에 하드코딩하지 않고 환경변수로 관리한다", "constraint"),
    PreferenceItem("새 기능에는 반드시 테스트를 함께 작성한다", "preference"),
    PreferenceItem("함수는 작게, 이름은 의도가 드러나게 짓는다", "style"),
]


class PreferenceStore:
    def __init__(self, vector_store=None, path: Optional[Path] = None):
        self.path = path or Path(settings.state_dir) / "preferences.json"
        self.vector_store = vector_store
        self._lock = threading.Lock()
        if not self.path.exists():
            self._write(DEFAULT_PREFERENCES)
            self._sync_vectors(DEFAULT_PREFERENCES)

    def _read(self) -> List[PreferenceItem]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []
        return [PreferenceItem(**item) for item in raw]

    def _write(self, items: List[PreferenceItem]) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(i) for i in items], ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)  # 원자적 교체: 쓰는 도중 끊겨도 파일이 깨지지 않음

    def _sync_vectors(self, items: List[PreferenceItem]) -> None:
        if self.vector_store is None:
            return
        try:
            self.vector_store.upsert(
                settings.prefs_collection,
                [{"id_key": f"pref:{i.id}", "text": f"[{i.kind}/{i.scope}:{i.scope_value}] {i.text}", "payload": asdict(i)} for i in items],
            )
        except Exception:
            pass  # 벡터 동기화 실패는 원본(JSON) 저장에 영향을 주지 않는다

    def list(self) -> List[PreferenceItem]:
        return self._read()

    def add(self, text: str, kind: str = "preference", scope: str = "global", scope_value: str = "") -> PreferenceItem:
        if kind not in KINDS:
            raise ValueError(f"kind 는 {KINDS} 중 하나여야 합니다")
        if scope not in SCOPES:
            raise ValueError(f"scope 는 {SCOPES} 중 하나여야 합니다")
        if not text.strip():
            raise ValueError("내용이 비어 있습니다")
        item = PreferenceItem(text=text.strip(), kind=kind, scope=scope, scope_value=scope_value.strip())
        with self._lock:
            items = self._read()
            items.append(item)
            self._write(items)
        self._sync_vectors([item])
        return item

    def delete(self, item_id: str) -> bool:
        with self._lock:
            items = self._read()
            kept = [i for i in items if i.id != item_id]
            if len(kept) == len(items):
                return False
            self._write(kept)
        if self.vector_store is not None:
            try:
                self.vector_store.delete_where(settings.prefs_collection, "id", item_id)
            except Exception:
                pass
        return True

    def render_for(self, task: str, project: str = "", language: str = "", profile: str = "") -> str:
        """프롬프트에 넣을 선호/제약 블록. 범위가 맞는 항목은 전부 포함한다."""
        applicable = [i for i in self._read() if i.applies_to(project, language, profile)]
        if not applicable:
            return ""
        order = {"constraint": 0, "style": 1, "preference": 2}
        applicable.sort(key=lambda i: order.get(i.kind, 9))
        labels = {"constraint": "제약(반드시 준수)", "style": "코딩 스타일", "preference": "선호"}
        return "\n".join(f"- [{labels.get(i.kind, i.kind)}] {i.text}" for i in applicable)
