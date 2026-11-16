"""프로젝트 아키텍처 분석: 큰 프로젝트(Spring 백엔드 · Flutter 앱 등)의 구조·레이어·패턴·코딩 규칙을 문서로 만든다.

- 원격 색인(/api/remote/index) 때 업로드된 파일로 자동 분석 (없거나 오래됐을 때만 · force 로 다시).
- 규칙 기반으로 레이어별 대표 파일을 고르고(Controller/Service/Mapper/… · screen/bloc/repository/…),
  코딩 모델이 "새 기능을 추가할 때 따라야 할 규칙" 중심으로 요약한다.
- 결과는 state_dir/arch/<project>.md → /api/context 의 "architecture" 로 매 대화 시스템 프롬프트에 들어간다.
"""
from __future__ import annotations

import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import llm_client
from .config import settings

DIR = Path(settings.state_dir) / "arch"
MAX_AGE_DAYS = 7
SAMPLE_CHARS = 2400
EVIDENCE_CHARS = 30000

# (분류 이름, 경로/파일명 정규식) — 앞에 있는 것이 우선
SPRING_LAYERS: List[Tuple[str, str]] = [
    ("test", r"(^|/)src/test/|Test\.(kt|java)$"),
    ("controller", r"(Controller|Resource|Api|Endpoint)\.(kt|java)$|/(controller|web|api|rest)/"),
    ("service", r"(Service|ServiceImpl|UseCase|Facade)\.(kt|java)$|/(service|usecase|application)/"),
    ("mapper-xml", r"(mapper|mappers|sqlmap)/.*\.xml$|Mapper\.xml$"),
    ("repository", r"(Repository|Mapper|Dao|DAO)\.(kt|java)$|/(repository|mapper|dao|persistence)/"),
    ("entity", r"(Entity|Vo|VO)\.(kt|java)$|/(entity|domain|model|vo)/"),
    ("dto", r"(Dto|DTO|Request|Response|Command|Query)\.(kt|java)$|/(dto|payload)/"),
    ("config", r"(Config|Configuration|Properties|Security\w*)\.(kt|java)$|/(config|configuration)/"),
    ("exception", r"(Exception|Error|Advice|Handler)\.(kt|java)$|/(exception|error)/"),
    ("util", r"/(util|utils|common|support|helper)/"),
]
FLUTTER_LAYERS: List[Tuple[str, str]] = [
    ("test", r"(^|/)test/|_test\.dart$"),
    ("generated", r"\.(g|freezed|gr|config|mocks)\.dart$"),
    ("entry", r"^lib/main(_\w+)?\.dart$|^lib/app\.dart$"),
    ("routing", r"(router|routes|route)\w*\.dart$|/(router|routes|navigation)/"),
    ("state", r"(bloc|cubit|provider|notifier|controller|viewmodel|view_model|store|state)\w*\.dart$|/(bloc|blocs|providers|controllers|viewmodels|state|cubit)/"),
    ("screen", r"(screen|page|view)\w*\.dart$|/(screens|pages|views|presentation|ui)/"),
    ("widget", r"/(widgets|components|common_widgets)/"),
    ("repository", r"(repository|repo)\w*\.dart$|/(repositories|repository|data)/"),
    ("api", r"(api|client|service|datasource|remote)\w*\.dart$|/(api|services|network|datasources|remote)/"),
    ("model", r"(model|entity|dto)\w*\.dart$|/(models|entities|domain|dto)/"),
    ("di", r"(injection|locator|di|dependencies)\w*\.dart$|/(di|injection)/"),
    ("theme", r"(theme|colors|styles|constants)\w*\.dart$|/(theme|constants|config)/"),
]
CODE_RE = re.compile(r"\.(kt|java|dart|py|ts|tsx|js|jsx|go|rs|swift|xml)$", re.I)
SECRET_RE = re.compile(r"(?im)^(\s*[\w.-]*(password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)[\w.-]*\s*[:=]\s*).+$")
CONFIG_NAMES = ("build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle", "pom.xml", "pubspec.yaml",
                "analysis_options.yaml", "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml")
APP_CONFIG_RE = re.compile(r"(^|/)(application|bootstrap)(-\w+)?\.(ya?ml|properties)$")


def _path(project: str) -> Path:
    return DIR / (re.sub(r"[^\w.-]", "_", project)[:80] + ".md")


def get(project: str) -> Optional[str]:
    p = _path(project)
    return p.read_text(encoding="utf-8") if project and p.exists() else None


def is_fresh(project: str) -> bool:
    p = _path(project)
    return p.exists() and time.time() - p.stat().st_mtime < MAX_AGE_DAYS * 86400


def mask_secrets(text: str) -> str:
    return SECRET_RE.sub(lambda m: m.group(1) + "***", text)


def classify(path: str, kind: str) -> Optional[str]:
    layers = SPRING_LAYERS if kind == "spring" else FLUTTER_LAYERS if kind == "flutter" else []
    for name, rx in layers:
        if re.search(rx, path, re.I):
            return name
    return None


def project_kind(paths: List[str], docs: Dict[str, str]) -> str:
    if "pubspec.yaml" in docs or any(p.startswith("lib/") and p.endswith(".dart") for p in paths):
        return "flutter"
    if any(re.search(r"\.(kt|java)$", p) for p in paths) and any(n in docs for n in ("build.gradle.kts", "build.gradle", "pom.xml")) \
            or any(re.search(r"(^|/)build\.gradle(\.kts)?$|(^|/)pom\.xml$", p) for p in paths):
        return "spring"
    return "generic"


def _pick(cands: List[str], docs: Dict[str, str], n: int) -> List[str]:
    """중간 크기(너무 작거나 큰 것 제외) 파일 우선, 서로 다른 폴더에서"""
    def score(p: str) -> float:
        size = len(docs.get(p, ""))
        return abs(size - 3500) + (8000 if size < 400 else 0)
    out, seen_dirs = [], set()
    for p in sorted(cands, key=score):
        d = p.rsplit("/", 1)[0]
        if d in seen_dirs and len(cands) > n:
            continue
        out.append(p)
        seen_dirs.add(d)
        if len(out) >= n:
            break
    return out


def collect_evidence(docs: Dict[str, str]) -> Tuple[str, str]:
    paths = sorted(docs)
    kind = project_kind(paths, docs)
    parts: List[str] = [f"PROJECT KIND (guess): {kind}"]

    # 폴더 구조: 코드 파일 수가 많은 폴더 (깊이 4까지)
    dirs = Counter()
    for p in paths:
        if CODE_RE.search(p):
            segs = p.split("/")[:-1]
            for i in range(1, min(len(segs), 6) + 1):
                dirs["/".join(segs[:i])] += 1
    top = [f"{d}/ ({n})" for d, n in sorted(dirs.items()) if n >= 2 and d.count("/") <= 5][:160]
    parts.append("DIRECTORIES (code file count):\n" + "\n".join(top))

    # 빌드·설정 (비밀값 가림)
    for p in paths:
        name = p.rsplit("/", 1)[-1]
        if (name in CONFIG_NAMES and p.count("/") <= 2) or APP_CONFIG_RE.search(p):
            parts.append(f"--- {p} ---\n{mask_secrets(docs[p])[:2500]}")
    # 문서: README·아키텍처·설계·명세·요구사항·규칙 (docs/ 폴더 포함, 최대 8개)
    doc_re = re.compile(r"(^|/)(readme|architecture|arch|design|spec|requirement|convention|contributing|guide|adr|api|"
                        r"설계|명세|요구|기획|구조|규칙|가이드)[^/]*\.(md|adoc|rst|txt)$|(^|/)docs?/[^/]+\.(md|adoc|rst)$", re.I)
    doc_files = [p for p in paths if doc_re.search(p) and not p.startswith(".yang/") and "node_modules" not in p]
    doc_files.sort(key=lambda p: (p.count("/"), not re.search(r"arch|설계|구조|design", p, re.I)))
    for p in doc_files[:8]:
        parts.append(f"--- DOC {p} ---\n{docs[p][:2500]}")

    # 레이어별 분류 · 대표 파일
    by_layer: Dict[str, List[str]] = defaultdict(list)
    for p in paths:
        if CODE_RE.search(p):
            layer = classify(p, kind)
            if layer:
                by_layer[layer].append(p)
    if by_layer:
        parts.append("LAYER FILE COUNTS: " + ", ".join(f"{k}={len(v)}" for k, v in sorted(by_layer.items())))
        for layer, files in sorted(by_layer.items(), key=lambda kv: -len(kv[1])):
            parts.append(f"{layer} examples: " + ", ".join(files[:8]))
    sample_layers = [l for l in by_layer if l not in ("generated", "test")] + (["test"] if "test" in by_layer else [])
    budget = EVIDENCE_CHARS - sum(len(x) for x in parts)
    for layer in sample_layers:
        for p in _pick(by_layer[layer], docs, 2 if layer not in ("test", "util", "theme") else 1):
            if budget <= 0:
                break
            body = mask_secrets(docs[p])[:SAMPLE_CHARS]
            parts.append(f"--- SAMPLE [{layer}] {p} ---\n{body}")
            budget -= len(body) + 60
    if not by_layer:  # 모르는 구조: 큰 폴더에서 몇 개
        for p in _pick([p for p in paths if CODE_RE.search(p)], docs, 8):
            parts.append(f"--- SAMPLE {p} ---\n{mask_secrets(docs[p])[:SAMPLE_CHARS]}")
    return kind, "\n\n".join(parts)[:EVIDENCE_CHARS + 4000]


_SYNTH = """You are a senior software architect. From the evidence (directory tree, build files, and sample source files of ONE project),
write an ARCHITECTURE & CONVENTIONS guide that a coding agent must follow when adding or changing code in this project.
Write in Korean (keep code identifiers, paths and annotations in original form). Markdown, at most ~3500 characters. Sections:

## 개요
기술 스택(언어·프레임워크·주요 라이브러리와 버전), 모듈 구성, 도메인(무엇을 하는 시스템인지 추정).
## 구조와 레이어
레이어/폴더 규칙을 경로 패턴으로 (예: `src/main/kotlin/.../{도메인}/controller/XxxController.kt`). 의존 방향.
## 핵심 패턴
실제 샘플에서 확인한 방식만: DI 방식, 트랜잭션, DB 접근(JPA/MyBatis XML 등), 요청·응답 형식(공통 응답 래퍼), 예외 처리,
인증·권한, 로깅, 상태관리·라우팅·API 호출(Flutter), 코드 생성(freezed/json_serializable 등).
## 네이밍·코드 스타일
클래스·메서드·파일·패키지 이름 규칙, 들여쓰기, 주석·문서화 습관, null 처리, 불변성 등 샘플에서 보이는 습관.
## 새 기능을 추가할 때 (체크리스트)
이 프로젝트에서 새 API/화면을 만드는 순서를 실제 예시 파일 경로와 함께 단계별로 (예: 1) Controller 2) Service 3) Mapper 인터페이스 4) Mapper XML ...).
## 주의
지켜야 할 제약·흔한 실수(예: 생성 파일 직접 수정 금지, build_runner 필요, 공통 응답 형식 유지).

Project documents (DOC ...) describe intended architecture and rules — follow them and point out where code differs.
Only state what the evidence supports; if unsure, say "추정". No preamble, output the markdown only."""


def analyze(project: str, docs: Dict[str, str]) -> str:
    kind, evidence = collect_evidence(docs)
    res = llm_client.chat([{"role": "system", "content": _SYNTH},
                           {"role": "user", "content": f"PROJECT: {project}\n\n{evidence}"}],
                          max_tokens=1800, temperature=0.2)
    md = re.sub(r"^```(?:markdown|md)?\s*|\s*```$", "", res.text.strip())
    md = re.sub(r"<think>.*?</think>\s*", "", md, flags=re.S)
    header = f"# {project} 아키텍처 · 코딩 규칙 (자동 분석 {time.strftime('%Y-%m-%d')} · {kind} · 파일 {len(docs)}개)\n\n"
    DIR.mkdir(parents=True, exist_ok=True)
    _path(project).write_text(header + md + "\n", encoding="utf-8")
    return header + md


def save_manual(project: str, markdown: str) -> str:
    """사용자가 직접 고친 아키텍처 문서 저장 (자동 분석이 덮어쓰지 않도록 7일 동안 신선)"""
    DIR.mkdir(parents=True, exist_ok=True)
    _path(project).write_text(markdown.strip() + "\n", encoding="utf-8")
    return markdown
