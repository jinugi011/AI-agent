"""프로젝트 작업 기록: 대화(요청 → 한 일 · 바꾼 파일)를 프로젝트별로 남겨, 새 대화에서도 이어서 작업할 수 있게 한다.

state_dir/worklog/<project>.jsonl 에 한 줄씩. /api/context 가 최근 기록을 돌려주고, 플러그인은 새 대화의 첫 요청에 붙인다.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Dict, List

from .config import settings

DIR = Path(settings.state_dir) / "worklog"
MAX_KEEP = 200


def _path(project: str) -> Path:
    safe = re.sub(r"[^\w.-]", "_", project.strip())[:80] or "_"
    return DIR / f"{safe}.jsonl"


def add(project: str, request: str, summary: str, files: List[str]) -> Dict:
    if not project.strip():
        raise ValueError("project 가 필요합니다")
    item = {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "request": request.strip()[:500],
            "summary": summary.strip()[:800], "files": [f for f in files if isinstance(f, str)][:30]}
    DIR.mkdir(parents=True, exist_ok=True)
    p = _path(project)
    lines = p.read_text(encoding="utf-8").splitlines() if p.exists() else []
    lines.append(json.dumps(item, ensure_ascii=False))
    p.write_text("\n".join(lines[-MAX_KEEP:]) + "\n", encoding="utf-8")
    return item


def recent(project: str, n: int = 6) -> List[Dict]:
    p = _path(project) if project else None
    if not p or not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines()[-n:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def render(project: str, n: int = 6) -> str:
    items = recent(project, n)
    return "\n".join(
        f"- [{i['t'][:16].replace('T', ' ')}] 요청: {i['request'][:200]}\n  한 일: {i['summary'][:400]}"
        + (f"\n  파일: {', '.join(i['files'][:12])}" if i.get("files") else "")
        for i in items
    )
