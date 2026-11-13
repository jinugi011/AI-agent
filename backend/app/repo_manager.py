"""git 레포 연결 관리 (요구사항 1, 7, 8).

연결 = (로컬 경로 확인 또는 원격 clone) → 프로필 감지/선택 → 레포 벡터화 → 레지스트리 저장.
"""
from __future__ import annotations

import json
import re
import subprocess
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from .config import settings
from .profiles import LANGUAGE_DEFAULT_PROFILE, detect_profile, get_profile

_REMOTE_RE = re.compile(r"^(https://|git@|ssh://)[\w.@:/\-~]+?(\.git)?/?$")


@dataclass
class RepoRecord:
    name: str
    path: str
    profile: str
    language: str
    remote: str = ""
    description: str = ""
    connected_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    last_indexed_at: str = ""
    index_stats: Dict = field(default_factory=dict)


def run_git(repo: Path, *args: str, check: bool = True, timeout: int = 120) -> str:
    proc = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 실패: {proc.stderr.strip()}")
    return proc.stdout.strip()


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", text.strip()).strip("-").lower()
    return slug[:48] or "project"


class RepoManager:
    def __init__(self, vector_store):
        self.vector_store = vector_store
        self.registry_path = Path(settings.state_dir) / "repos.json"
        self._lock = threading.Lock()

    def _load(self) -> Dict[str, RepoRecord]:
        try:
            raw = json.loads(self.registry_path.read_text(encoding="utf-8"))
            return {k: RepoRecord(**v) for k, v in raw.items()}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save(self, repos: Dict[str, RepoRecord]) -> None:
        tmp = self.registry_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({k: asdict(v) for k, v in repos.items()}, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.registry_path)

    def list(self) -> List[RepoRecord]:
        return sorted(self._load().values(), key=lambda r: r.connected_at, reverse=True)

    def get(self, name: str) -> RepoRecord:
        repos = self._load()
        if name not in repos:
            raise KeyError(f"연결된 레포가 아닙니다: {name}")
        return repos[name]

    def _resolve_location(self, location: str, name: str, init_if_missing: bool) -> tuple[Path, str]:
        location = location.strip()
        if _REMOTE_RE.match(location):
            target = Path(settings.workspaces_dir) / name
            if not (target / ".git").exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                proc = subprocess.run(["git", "clone", location, str(target)], capture_output=True, text=True, timeout=600)
                if proc.returncode != 0:
                    raise RuntimeError(f"git clone 실패: {proc.stderr.strip()}")
            return target, location

        path = Path(location).expanduser().resolve()
        if not path.exists():
            if not init_if_missing:
                raise FileNotFoundError(f"경로가 없습니다: {path}")
            path.mkdir(parents=True)
        if not (path / ".git").exists():
            if not init_if_missing:
                raise RuntimeError(f"git 레포가 아닙니다: {path} (새 프로젝트면 init_if_missing=true)")
            run_git(path, "init", "-b", "main")
        remote = run_git(path, "remote", "get-url", "origin", check=False)
        return path, remote

    def connect(
        self,
        location: str,
        name: str = "",
        profile: str = "",
        language: str = "",
        description: str = "",
        init_if_missing: bool = False,
    ) -> RepoRecord:
        name = slugify(name or Path(location.rstrip("/").removesuffix(".git")).name)
        path, remote = self._resolve_location(location, name, init_if_missing)

        if profile:
            prof = get_profile(profile)
        else:
            prof = detect_profile(path)
            if prof is None and language:
                prof = get_profile(LANGUAGE_DEFAULT_PROFILE.get(language.lower(), "python-fastapi"))
            if prof is None:
                raise ValueError("프로젝트 유형을 감지하지 못했습니다. profile 또는 language 를 지정하세요.")

        record = RepoRecord(
            name=name, path=str(path), profile=prof.key, language=language or prof.language,
            remote=remote, description=description,
        )
        with self._lock:
            repos = self._load()
            if name in repos:  # 재연결 시 최초 연결 시각 유지
                record.connected_at = repos[name].connected_at
            repos[name] = record
            self._save(repos)
        return self.reindex(name)

    def find_by_path(self, path: str) -> Optional[RepoRecord]:
        target = str(Path(path).expanduser().resolve())
        return next((r for r in self._load().values() if str(Path(r.path).resolve()) == target), None)

    def reindex(self, name: str) -> RepoRecord:
        """프로젝트를 연결할 때마다 코딩 방법을 다시 벡터화한다 (요구사항 8)."""
        record = self.get(name)
        stats = self.vector_store.index_repository(record.name, record.path)
        with self._lock:
            repos = self._load()
            record = repos[name]
            record.index_stats = stats
            record.last_indexed_at = datetime.now(timezone.utc).isoformat()
            self._save(repos)
        return record

    def disconnect(self, name: str) -> None:
        with self._lock:
            repos = self._load()
            repos.pop(name, None)
            self._save(repos)
        self.vector_store.delete_where(self.vector_store.collection_name, "project", name)

    def file_tree(self, name: str, limit: int = 400) -> List[str]:
        record = self.get(name)
        out = run_git(Path(record.path), "ls-files", "--cached", "--others", "--exclude-standard", check=False)
        files = [f for f in out.splitlines() if f]
        return files[:limit]
