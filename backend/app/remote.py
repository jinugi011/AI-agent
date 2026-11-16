"""원격 PC 프로젝트 지원: IDE 플러그인이 업로드한 파일을 맥에서 벡터화하고, LLM 생성을 중계한다."""
from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Dict, Iterator, List, Optional

import httpx

from .config import settings
from .profiles import detect_profile_from
from .repo_manager import slugify
from . import archinfo
from .vector_store import STYLE_CONFIG_FILES, CodeVectorStore

REGISTRY = Path(settings.state_dir) / "remote_projects.json"
MAX_FILES = 3000
MAX_FILE_BYTES = 200_000
MAX_TOTAL_BYTES = 30_000_000
HEARTBEAT_SECONDS = 15
_lock = threading.Lock()
_jobs_guard = threading.Lock()
_project_locks: Dict[str, threading.Lock] = {}
_latest: Dict[str, tuple] = {}  # 프로젝트 → 처리할 가장 최근 요청 (job_id, docs, store, arch)


def _load() -> Dict[str, dict]:
    try:
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: Dict[str, dict]) -> None:
    tmp = REGISTRY.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(REGISTRY)


def list_projects() -> Dict[str, dict]:
    return _load()


def get_project(name: str) -> Optional[dict]:
    return _load().get(slugify(name))


_URL_RE = __import__("re").compile(r"^(https?://|git@|ssh://)")


def register_pending(location: str, name: str = "", language: str = "", profile: str = "") -> dict:
    """원격 PC 의 로컬 경로로 프로젝트 등록 (서버는 그 폴더를 못 보므로 'PC 대기').
    그 PC 의 플러그인이 다음에 연결될 때 경로를 확인하고 파일을 올려 색인한다 (/api/remote/pending)."""
    loc = location.strip()
    if not loc or _URL_RE.match(loc):
        raise ValueError("원격 PC 의 폴더 경로를 입력하세요")
    base = loc.replace("\\", "/").rstrip("/").split("/")[-1]
    pname = slugify(name or base)
    rec = {"name": pname, "client_path": loc, "status": "waiting-pc", "language": language, "profile": profile,
           "requested_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "remote": True}
    with _lock:
        data = _load()
        data[pname] = {**data.get(pname, {}), **rec}
        _save(data)
    return rec


def remove(name: str) -> None:
    with _lock:
        data = _load()
        data.pop(slugify(name), None)
        _save(data)


def pending() -> List[dict]:
    return [{"name": k, "client_path": v.get("client_path", "")} for k, v in _load().items()
            if v.get("status") == "waiting-pc" and v.get("client_path")]


def _set(name: str, update: dict) -> None:
    with _lock:
        data = _load()
        data[name] = {**data.get(name, {}), **update}
        _save(data)


def _clean_rel(path: str) -> Optional[str]:
    p = PurePosixPath(path.replace("\\", "/"))
    if p.is_absolute() or ".." in p.parts or not p.parts or p.parts[0] == ".git":
        return None
    return str(p)


def start_index(store: CodeVectorStore, project: str, files: List[dict], language: str = "", arch: str = "auto",
                client_path: str = "") -> dict:
    """업로드 파일 검증 → 프로필 감지 → 백그라운드 색인 (Cloudflare 100초 응답 제한 회피)."""
    name = slugify(project)
    if len(files) > MAX_FILES:
        raise ValueError(f"파일이 너무 많습니다 ({len(files)} > {MAX_FILES})")
    docs: Dict[str, str] = {}
    total = 0
    for f in files:
        rel = _clean_rel(str(f.get("path", "")))
        content = f.get("content", "")
        if rel is None or not isinstance(content, str):
            continue
        if len(content.encode("utf-8")) > MAX_FILE_BYTES:
            continue
        total += len(content)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("업로드 용량이 너무 큽니다 (최대 30MB)")
        docs[rel] = content

    profile = detect_profile_from(lambda n: n in docs, lambda n: docs.get(n))
    record = {
        "name": name,
        "profile": profile.key if profile else "",
        "language": language or (profile.language if profile else ""),
        "files": len(docs),
        "status": "indexing",
        "requested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "remote": True,
    }
    if client_path:
        record["client_path"] = client_path
    with _lock:
        data = _load()
        data[name] = {**data.get(name, {}), **record}
        _save(data)

    job_id = uuid.uuid4().hex[:12]
    with _jobs_guard:
        # 같은 프로젝트에 요청이 몰리면 가장 최근 것만 남긴다 (이전 대기 요청은 버림)
        prev = _latest.get(name)
        want_arch = arch if not prev or arch != "auto" else prev[3]
        if prev and prev[3] == "force":
            want_arch = "force"
        _latest[name] = (job_id, docs, store, want_arch)
    _set(name, {"job_id": job_id})
    threading.Thread(target=_run_jobs, args=(name,), daemon=True).start()
    return {**record, "job_id": job_id}


def _run_jobs(name: str) -> None:
    """프로젝트별로 한 번에 하나만 색인. 기다리는 동안 새 요청이 오면 가장 최근 것만 처리한다."""
    with _jobs_guard:
        lock = _project_locks.setdefault(name, threading.Lock())
    with lock:
        with _jobs_guard:
            job = _latest.pop(name, None)
        if job is None:  # 다른 스레드가 이미 최신 요청을 처리함
            return
        job_id, docs, store, arch = job
        try:
            configs = {k: v for k, v in docs.items() if k in STYLE_CONFIG_FILES}
            stats = store.index_docs(name, list(docs.items()), configs)
            update = {"chunks": stats["chunks"], "methods": stats["methods"], "embedded": stats.get("embedded"),
                      "removed": stats.get("removed"), "indexed_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "error": ""}
            ok = True
        except Exception as exc:  # noqa: BLE001
            update, ok = {"error": str(exc)}, False
        with _jobs_guard:
            newer = name in _latest
        # 더 새 요청이 기다리면 상태는 'indexing' 유지 (그 작업이 끝날 때 ready 로)
        update["status"] = "indexing" if newer else ("ready" if ok else "error")
        update["last_job_id"] = job_id
        _set(name, update)
        # 아키텍처 분석 (큰 프로젝트의 레이어·패턴·코딩 규칙) — 없거나 오래됐을 때만, 코딩 모델로 1분 정도
        if ok and not newer and (arch == "force" or (arch == "auto" and not archinfo.is_fresh(name))):
            _set(name, {"arch_status": "analyzing"})
            try:
                archinfo.analyze(name, docs)
                _set(name, {"arch_status": "ready", "arch_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "arch_error": ""})
            except Exception as exc:  # noqa: BLE001
                _set(name, {"arch_status": "error", "arch_error": str(exc)[:300]})


def stream_generate(body: dict) -> Iterator[str]:
    """엔진 스트리밍 응답을 NDJSON 그대로 중계. 엔진이 다른 요청을 처리 중이거나 긴 프롬프트를 읽는 동안
    15초마다 {"ping":1} 을 보내 Cloudflare 의 응답 대기 시간 제한(100초)에 끊기지 않게 한다.
    클라이언트가 끊기면 엔진 연결도 닫아 생성을 중단시킨다."""
    q: "queue.Queue[Optional[str]]" = queue.Queue()
    holder: Dict[str, httpx.Response] = {}
    stop = threading.Event()

    def reader():
        try:
            with httpx.Client(timeout=httpx.Timeout(None, connect=5)) as client:
                with client.stream("POST", f"{settings.engine_url}/generate", json=body) as resp:
                    holder["resp"] = resp
                    if resp.status_code >= 400:
                        q.put(json.dumps({"done": True, "error": resp.read().decode("utf-8", "replace")[:500]}))
                        return
                    for line in resp.iter_lines():
                        if stop.is_set():
                            return
                        if line:
                            q.put(line)
        except Exception as exc:  # noqa: BLE001
            if not stop.is_set():
                q.put(json.dumps({"done": True, "error": f"엔진 연결 실패: {exc}"}))
        finally:
            q.put(None)

    threading.Thread(target=reader, daemon=True).start()
    try:
        yield json.dumps({"ping": 1}) + "\n"  # 즉시 첫 바이트 전송
        while True:
            try:
                item = q.get(timeout=HEARTBEAT_SECONDS)
            except queue.Empty:
                yield json.dumps({"ping": 1}) + "\n"
                continue
            if item is None:
                break
            yield item + "\n"
    finally:
        stop.set()
        resp = holder.get("resp")
        if resp is not None:
            try:
                resp.close()  # 엔진 쪽 연결 종료 → 생성 중단
            except Exception:
                pass
