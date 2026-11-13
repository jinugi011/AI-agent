"""요구사항 하네스 (요구사항 5).

사용자 요구사항 → (LLM) 검증 가능한 요구사항 목록 + 프로필별 테스트 파일 → 실행/판정.
하네스는 레포의 .agent/harness/ 에 기록되어 이후 작업에서도 회귀 테스트로 계속 사용된다.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from . import llm_client
from .config import settings
from .profiles import ProjectProfile

FILE_BLOCK_RE = re.compile(r"<<<FILE[ \t]+([^\n>]+?)[ \t]*\n(.*?)\n?FILE>>>", re.S)
DELETE_RE = re.compile(r"<<<DELETE[ \t]+([^\n>]+?)[ \t]*>>>")
# 대체 형식: "`path/to/file.py`" 를 언급한 직후의 ``` 코드 펜스 (작은 모델이 자주 쓰는 형식)
FENCED_RE = re.compile(r"`([\w./-]+\.\w+)`[^\n`]*\n+```[\w+-]*\n(.*?)\n```", re.S)
REQ_BLOCK_RE = re.compile(r"<<<REQUIREMENTS[ \t]*\n(.*?)\n?REQUIREMENTS>>>", re.S)

FILE_FORMAT_RULES = """Output files ONLY in this exact format (no markdown fences, no JSON escaping):
<<<FILE relative/path/to/file.ext
<full file content>
FILE>>>
To delete a file: <<<DELETE relative/path>>>
Always output the COMPLETE content of every file you change."""


@dataclass
class FileChange:
    path: str
    content: Optional[str]  # None = 삭제


def parse_file_blocks(text: str) -> List[FileChange]:
    changes = [FileChange(m.group(1).strip(), m.group(2)) for m in FILE_BLOCK_RE.finditer(text)]
    changes += [FileChange(m.group(1).strip(), None) for m in DELETE_RE.finditer(text)]
    if not changes:
        changes = [FileChange(m.group(1).strip(), m.group(2)) for m in FENCED_RE.finditer(text)]
    return changes


def safe_path(repo: Path, rel: str) -> Path:
    rel = rel.strip().removeprefix("./")
    target = (repo / rel).resolve()
    if repo.resolve() not in target.parents:
        raise ValueError(f"레포 밖 경로는 수정할 수 없습니다: {rel}")
    if ".git" in target.relative_to(repo.resolve()).parts:
        raise ValueError(f".git 내부는 수정할 수 없습니다: {rel}")
    return target


def apply_changes(repo: Path, changes: List[FileChange], allowed_prefix: Optional[str] = None) -> List[str]:
    applied = []
    for ch in changes:
        if allowed_prefix and not ch.path.strip().removeprefix("./").startswith(allowed_prefix):
            continue
        target = safe_path(repo, ch.path)
        if ch.content is None:
            if target.exists():
                target.unlink()
                applied.append(f"D {ch.path}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        content = ch.content if ch.content.endswith("\n") else ch.content + "\n"
        target.write_text(content, encoding="utf-8")
        applied.append(f"W {ch.path}")
    return applied


class Harness:
    def __init__(self, repo: Path, profile: ProjectProfile):
        self.repo = repo
        self.profile = profile
        self.dir = repo / ".agent" / "harness"

    @property
    def requirements_path(self) -> Path:
        return self.dir / "requirements.json"

    def load_requirements(self) -> List[Dict]:
        try:
            return json.loads(self.requirements_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def generate(self, task: str, context: str) -> Dict:
        """요구사항을 검증 가능한 항목과 테스트 코드로 변환해 레포에 기록한다."""
        existing = self.load_requirements()
        p = self.profile
        system = (
            "You are a senior test engineer. Convert the user's requirements into a test harness "
            "BEFORE implementation exists (test-first). Tests must be deterministic, fast, offline, "
            "and must import the code under test at the paths the implementation will create. "
            "For every expected value, write the calculation as a comment right above the assertion "
            "(e.g. `# 2*100 + 3*200 = 800`) and use that result — never guess numbers. "
            "Only test behavior the user actually asked for."
        )
        user = f"""Project profile: {p.label} ({p.language}; frameworks: {', '.join(p.frameworks)})
Harness test directory: {p.harness_dir}
Test file naming: {p.test_file_pattern}
Existing requirements (keep their ids; still must pass): {json.dumps(existing, ensure_ascii=False)[:3000]}

{context}

New requirements from the user (the ONLY source of requirements):
{task}

The preferences/constraints in the context above are coding rules for the implementation,
NOT requirements — do not turn them into REQ items or tests.

Respond with:
1) A requirements block:
<<<REQUIREMENTS
[{{"id": "REQ-001", "title": "...", "acceptance": ["observable, testable criterion", "..."]}}]
REQUIREMENTS>>>
   Include existing requirements plus new ones. Use short ids.
2) Test files placed ONLY under {p.harness_dir}/ — one file per requirement group, each test name mentions its REQ id.

{FILE_FORMAT_RULES}"""
        res = llm_client.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=6000,
            temperature=0.1,
        )
        reqs: List[Dict] = existing
        m = REQ_BLOCK_RE.search(res.text)
        if m:
            try:
                parsed = llm_client.extract_json(m.group(1))
                if isinstance(parsed, list) and parsed:
                    reqs = parsed
            except llm_client.LLMError:
                pass
        tests = [c for c in parse_file_blocks(res.text) if c.content is not None]
        written = apply_changes(self.repo, tests, allowed_prefix=p.harness_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.requirements_path.write_text(json.dumps(reqs, ensure_ascii=False, indent=2), encoding="utf-8")
        with (self.dir / "tasks.md").open("a", encoding="utf-8") as fh:
            fh.write(f"\n## {time.strftime('%Y-%m-%d %H:%M')}\n{task.strip()}\n")
        return {"requirements": reqs, "test_files": written, "backend": res.backend, "raw": res.text}

    def _command(self, full: bool) -> List[str]:
        cmd = list(self.profile.full_test_command if full else self.profile.harness_command)
        if cmd and cmd[0] == "python":
            venv_py = self.repo / ".venv" / "bin" / "python"
            cmd[0] = str(venv_py) if venv_py.exists() else sys.executable
        return cmd

    def run(self, full: bool = False) -> Dict:
        cmd = self._command(full)
        if not cmd or (not Path(cmd[0]).is_absolute() and not cmd[0].startswith("./") and shutil.which(cmd[0]) is None):
            return {"passed": False, "returncode": None, "command": " ".join(cmd), "duration": 0,
                    "output": f"테스트 도구를 찾을 수 없습니다: {cmd[0] if cmd else '(없음)'} — {self.profile.setup_hint}"}
        env = {**os.environ, "CI": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        started = time.time()
        try:
            proc = subprocess.run(cmd, cwd=self.repo, capture_output=True, text=True, timeout=settings.test_timeout, env=env)
            output = (proc.stdout + "\n" + proc.stderr).strip()
            code = proc.returncode
        except subprocess.TimeoutExpired as exc:
            output = f"테스트 시간 초과 ({settings.test_timeout}s)\n{exc.stdout or ''}"
            code = -1
        return {
            "passed": code == 0,
            "returncode": code,
            "command": " ".join(cmd),
            "duration": round(time.time() - started, 1),
            "output": output[-6000:],
        }
