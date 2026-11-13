"""코딩 에이전트 루프.

작업 1건 = 브랜치 생성 → 컨텍스트 수집(선호/제약 + 코딩 방법 + 유사 코드) → 하네스 생성
        → [구현 → 하네스 실행 → 실패 로그 피드백] × N → 커밋 → 작업 이력 벡터화
"""
from __future__ import annotations

import json
import re
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from . import llm_client
from .config import settings
from .harness import FILE_FORMAT_RULES, Harness, apply_changes, parse_file_blocks
from .preferences import PreferenceStore
from .profiles import get_profile
from .repo_manager import RepoManager, run_git, slugify
from .vector_store import CodeVectorStore

MAX_CONTEXT_FILE_CHARS = 14_000
TEST_FIX_RE = re.compile(r"^TEST-FIX:\s*(.+)$", re.M)


@dataclass
class Job:
    repo: str
    task: str
    id: str = field(default_factory=lambda: time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6])
    status: str = "queued"  # queued | running | passed | failed | error
    branch: str = ""
    iterations: int = 0
    logs: List[Dict] = field(default_factory=list)
    harness: Dict = field(default_factory=dict)
    last_test: Dict = field(default_factory=dict)
    changed_files: List[str] = field(default_factory=list)
    commit: str = ""
    test_fixes: List[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%S"))
    finished_at: str = ""


class JobStore:
    def __init__(self):
        self.dir = Path(settings.state_dir) / "jobs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def save(self, job: Job) -> None:
        with self._lock:
            tmp = self.dir / f"{job.id}.tmp"
            tmp.write_text(json.dumps(asdict(job), ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.dir / f"{job.id}.json")

    def get(self, job_id: str) -> Optional[Job]:
        path = self.dir / f"{Path(job_id).name}.json"
        if not path.exists():
            return None
        return Job(**json.loads(path.read_text(encoding="utf-8")))

    def list(self, limit: int = 30) -> List[Job]:
        paths = sorted(self.dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
        return [Job(**json.loads(p.read_text(encoding="utf-8"))) for p in paths]


def _failure_signature(output: str) -> frozenset:
    """실패한 테스트 식별자 집합 (pytest/jest/go/cargo 의 FAILED/FAIL 줄 기준)."""
    return frozenset(re.findall(r"^(?:FAILED|FAIL|--- FAIL:|test .+ \.\.\. FAILED)\s*(\S+)", output, re.M))


class CodingAgent:
    def __init__(self, vector_store: CodeVectorStore, repos: RepoManager, prefs: PreferenceStore):
        self.vector_store = vector_store
        self.repos = repos
        self.prefs = prefs
        self.jobs = JobStore()
        self._repo_locks: Dict[str, threading.Lock] = {}

    # ---- 공개 API ---------------------------------------------------------------
    def submit(self, repo: str, task: str, max_iterations: Optional[int] = None) -> Job:
        self.repos.get(repo)  # 존재 확인
        job = Job(repo=repo, task=task)
        self.jobs.save(job)
        threading.Thread(target=self._run_safe, args=(job, max_iterations or settings.max_iterations), daemon=True).start()
        return job

    # ---- 내부 -------------------------------------------------------------------
    def _save_raw(self, job: Job, name: str, text: str) -> None:
        """LLM 원문 출력 보관 (디버깅·감사용): agent_state/jobs/<id>/<name>.txt"""
        d = self.jobs.dir / job.id
        d.mkdir(exist_ok=True)
        (d / f"{name}.txt").write_text(text, encoding="utf-8")

    def _log(self, job: Job, step: str, message: str, **extra) -> None:
        job.logs.append({"ts": time.strftime("%H:%M:%S"), "step": step, "message": message, **extra})
        self.jobs.save(job)

    def _run_safe(self, job: Job, max_iterations: int) -> None:
        lock = self._repo_locks.setdefault(job.repo, threading.Lock())
        if not lock.acquire(blocking=False):
            job.status = "error"
            self._log(job, "error", "같은 레포에서 다른 작업이 실행 중입니다.")
            return
        try:
            self._run(job, max_iterations)
        except Exception as exc:  # noqa: BLE001
            job.status = "error"
            self._log(job, "error", f"{type(exc).__name__}: {exc}", trace=traceback.format_exc()[-2000:])
        finally:
            job.finished_at = time.strftime("%Y-%m-%dT%H:%M:%S")
            self.jobs.save(job)
            lock.release()

    def _build_context(self, record, profile, task: str) -> str:
        repo = Path(record.path)
        prefs = self.prefs.render_for(task, project=record.name, language=record.language, profile=profile.key)
        methods = self.vector_store.project_methods(record.name) or "(아직 색인되지 않음)"
        hits = self.vector_store.search(task, top_k=8, project=record.name, kind="code")
        tree = self.repos.file_tree(record.name)

        # 검색으로 찾은 파일의 현재 전체 내용을 우선 제공 (수정 대상일 가능성이 높음)
        seen, file_blobs, budget = set(), [], MAX_CONTEXT_FILE_CHARS
        for hit in hits:
            src = hit["source"]
            if src in seen or not (repo / src).is_file():
                continue
            seen.add(src)
            content = (repo / src).read_text(encoding="utf-8", errors="replace")
            if len(content) > budget:
                continue
            budget -= len(content)
            file_blobs.append(f"--- {src} ---\n{content}")

        conventions = "\n".join(f"- {c}" for c in profile.conventions)
        return f"""## 사용자 선호 / 제약 (항상 준수)
{prefs or '- (없음)'}

## 이 레포의 코딩 방법 (자동 추출)
{methods}

## 프로필 관례 ({profile.label})
{conventions}

## 레포 파일 목록
{chr(10).join(tree) or '(빈 레포)'}

## 관련 파일 현재 내용
{chr(10).join(file_blobs) or '(없음)'}"""

    def _review_harness(self, job: Job, harness: Harness, profile, repo: Path, test_output: str) -> bool:
        """정체 시 '테스트가 틀렸나, 구현이 틀렸나'만 묻는 집중 판정. 테스트를 고쳤으면 True."""
        self._log(job, "review", "같은 실패가 반복되어 하네스 테스트 자체를 검토합니다")
        tests = "\n".join(
            f"<<<FILE {p}\n{(repo / p).read_text(encoding='utf-8', errors='replace')}\nFILE>>>"
            for p in sorted(str(f.relative_to(repo)) for f in (repo / profile.harness_dir).rglob("*") if f.is_file())
        )
        impl = "\n".join(
            f"--- {p} ---\n{(repo / p).read_text(encoding='utf-8', errors='replace')}"
            for p in job.changed_files if (repo / p).is_file() and not p.startswith(profile.harness_dir)
        )
        prompt = f"""Requirements:
{json.dumps(job.harness.get('requirements', []), ensure_ascii=False, indent=1)}

Original request: {job.task}

Implementation:
{impl}

Tests:
{tests}

Failing output:
{test_output[-3000:]}

Question: for EACH failing test, recompute the expected value by hand from the requirements.
Is the failing test wrong (contradicts the requirements or has a wrong expected value), or is the implementation wrong?
If any test is wrong, write `TEST-FIX: <test name> — <reason>` lines and output the corrected test file(s) in full.
If the implementation is wrong, answer only `VERDICT: implementation` and explain in one line.

{FILE_FORMAT_RULES}"""
        res = llm_client.chat([{"role": "user", "content": prompt}], max_tokens=4000, temperature=0.0)
        self._save_raw(job, "review", res.text)
        reasons = TEST_FIX_RE.findall(res.text)
        fixes = [c for c in parse_file_blocks(res.text) if c.content is not None]
        if not reasons or not fixes:
            self._log(job, "review", "판정: 구현 쪽 문제 → 계속 구현 수정")
            return False
        apply_changes(repo, fixes, allowed_prefix=profile.harness_dir)
        job.test_fixes += reasons
        self._log(job, "test-fix", "하네스 테스트 수정: " + " / ".join(reasons))
        return True

    def _run(self, job: Job, max_iterations: int) -> None:
        record = self.repos.get(job.repo)
        profile = get_profile(record.profile)
        repo = Path(record.path)
        job.status = "running"

        if run_git(repo, "status", "--porcelain", check=False):
            raise RuntimeError("레포에 커밋되지 않은 변경이 있습니다. 커밋하거나 stash 한 뒤 다시 실행하세요.")
        job.branch = f"agent/{slugify(job.task)[:32]}-{job.id[-6:]}"
        run_git(repo, "checkout", "-b", job.branch)
        self._log(job, "branch", f"브랜치 생성: {job.branch}")

        self._log(job, "index", "레포 재색인 (최신 코딩 방법 반영)")
        self.repos.reindex(record.name)
        context = self._build_context(record, profile, job.task)

        self._log(job, "harness", "요구사항 → 테스트 하네스 생성 중")
        harness = Harness(repo, profile)
        job.harness = harness.generate(job.task, context)
        self._save_raw(job, "00-harness", job.harness.pop("raw", ""))
        self._log(job, "harness", f"요구사항 {len(job.harness['requirements'])}개, 테스트 {len(job.harness['test_files'])}개 작성",
                  files=job.harness["test_files"])
        test_files_text = "\n".join(
            f"--- {p} ---\n{(repo / p).read_text(encoding='utf-8', errors='replace')}"
            for p in (f[2:] for f in job.harness["test_files"])
            if (repo / p).is_file()
        )

        system = (
            f"You are an expert {profile.language} engineer working inside an existing git repository "
            f"({profile.label}). Implement the requested change so that the harness tests pass. "
            "Match the repository's existing conventions exactly. Obey every user constraint. "
            "Do NOT modify the harness tests; fix the implementation instead. "
            "Before the files, write at most 5 short lines of plan.\n\n" + FILE_FORMAT_RULES
        )
        base_user = f"""{context}

## 요구사항 (하네스)
{json.dumps(job.harness['requirements'], ensure_ascii=False, indent=1)}

## 하네스 테스트 (수정 금지)
{test_files_text}

## 작업
{job.task}"""

        feedback = ""
        last_output = ""
        prev_failures: frozenset = frozenset()
        stall_reviewed = False
        for i in range(1, max_iterations + 1):
            job.iterations = i
            self._log(job, "implement", f"[{i}/{max_iterations}] 구현 생성 중")
            messages = [{"role": "system", "content": system}, {"role": "user", "content": base_user}]
            if feedback:
                messages += [{"role": "assistant", "content": last_output}, {"role": "user", "content": feedback}]
            res = llm_client.chat(messages, max_tokens=8000, temperature=0.15)
            last_output = res.text
            self._save_raw(job, f"{i:02d}-implement", res.text)
            # 하네스 테스트는 원칙적으로 수정 금지. 테스트 자체가 요구사항과 모순될 때만
            # 'TEST-FIX: 이유' 를 명시한 경우에 한해 허용하고, 이유를 로그·커밋에 남긴다.
            fix_reasons = TEST_FIX_RE.findall(res.text) if i > 1 else []
            in_harness = lambda c: c.path.strip().removeprefix("./").startswith(profile.harness_dir)
            changes = [c for c in parse_file_blocks(res.text) if fix_reasons or not in_harness(c)]
            applied = apply_changes(repo, changes)
            if fix_reasons and any(in_harness(c) for c in changes):
                job.test_fixes += fix_reasons
                self._log(job, "test-fix", "하네스 테스트 수정: " + " / ".join(fix_reasons))
            job.changed_files = sorted(set(job.changed_files) | {a[2:] for a in applied})
            self._log(job, "implement", f"파일 {len(applied)}개 반영 ({res.backend}, {res.tokens_per_second:.1f} tok/s)", files=applied)
            if not applied:
                feedback = "No files were produced. Output the implementation using the exact <<<FILE ... FILE>>> format."
                continue

            result = harness.run()
            job.last_test = result
            self._log(job, "test", f"{'통과' if result['passed'] else '실패'} ({result['command']}, {result['duration']}s)",
                      output=result["output"][-2500:])
            if result["passed"]:
                break

            # 같은 실패가 반복되면(정체) 구현이 아니라 테스트가 틀렸을 가능성을 별도 질문으로 판정한다.
            failures = _failure_signature(result["output"])
            if failures and failures == prev_failures and not stall_reviewed:
                stall_reviewed = True
                if self._review_harness(job, harness, profile, repo, result["output"]):
                    result = harness.run()
                    job.last_test = result
                    self._log(job, "test", f"{'통과' if result['passed'] else '실패'} (테스트 수정 후 재실행)",
                              output=result["output"][-2500:])
                    if result["passed"]:
                        break
            prev_failures = failures
            feedback = (
                "The harness failed. Test output:\n"
                f"{result['output'][-5000:]}\n\n"
                "Normally fix the IMPLEMENTATION. Only if a failing test is itself wrong — it contradicts the "
                "stated requirements (e.g. wrong arithmetic in an expected value, or demands behavior nobody asked for) — "
                "you may correct that test: write a line `TEST-FIX: <test name> — <why it is wrong>` and output the "
                "corrected test file. Never weaken a correct test. Output every changed file again in full."
            )

        job.status = "passed" if job.last_test.get("passed") else "failed"
        run_git(repo, "add", "-A")
        if run_git(repo, "status", "--porcelain", check=False):
            msg = f"agent: {job.task.strip().splitlines()[0][:72]}\n\nharness: {job.status} after {job.iterations} iteration(s)\njob: {job.id}"
            if job.test_fixes:
                msg += "\n\nharness test fixes:\n" + "\n".join(f"- {r}" for r in job.test_fixes)
            run_git(repo, "commit", "-m", msg)
            job.commit = run_git(repo, "rev-parse", "--short", "HEAD")
            self._log(job, "commit", f"{job.branch} 에 커밋 {job.commit} ({job.status})")

        # 작업 결과를 프로젝트 이력으로 벡터화 → 다음 작업에서 참고
        self.vector_store.upsert(
            self.vector_store.collection_name,
            [{
                "id_key": f"{record.name}:history:{job.id}",
                "text": f"{record.name} task: {job.task}",
                "payload": {"project": record.name, "source": f"job:{job.id}", "kind": "history", "language": "meta",
                            "content": f"작업: {job.task}\n결과: {job.status}\n변경: {', '.join(job.changed_files)}"},
            }],
        )
