"""프로젝트 아트 컨셉 (아트 바이블): 프로젝트를 분석해 그림 스타일을 정하고, 모든 그림 생성에 적용한다.

분석 재료 (IDE 플러그인이 보내 줌 · 로컬/원격 공통):
  - 문서(README·기획서)와 코드에서 뽑은 힌트(캔버스·타일·스프라이트 크기, 게임 이름 등)
  - 이미 있는 그림 몇 장 → 비전 모델로 화풍 추출 + 실제 색상표
  - 벡터 DB 의 프로젝트 코드·첨부(기획서·컨셉 그림)에서 세계관·캐릭터 관련 부분
  - 사용자가 직접 적은 컨셉 (가장 우선)
→ 코딩 모델이 JSON 아트 바이블로 정리 → 파일 + 벡터 DB(kind=art-style) 에 저장.

그림 생성 때: 사용자의 짧은 설명 + 종류별 틀(캐릭터/타일/배경/아이콘/UI…) + 아트 바이블 스타일 → 영어 프롬프트.
생성 후 비전 모델이 컨셉과 대조해 점수를 매기고(0~10), 낮으면 문제점을 반영해 한 번 다시 그린다.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Dict, List, Optional

from . import attachments, llm_client
from .config import settings

ART_DIR = Path(settings.state_dir) / "art"
ART_DIR.mkdir(parents=True, exist_ok=True)

# 종류별 그림 틀 (영어 — 이미지 모델이 영어를 가장 잘 따름)
KIND_TEMPLATES: Dict[str, str] = {
    "character": "single game character, full body, centered, clearly readable shape and details, consistent proportions, game sprite",
    "sprite": "single game sprite, centered, clearly readable shape and details",
    "enemy": "single enemy character, full body, centered, clearly readable shape and details, game sprite",
    "item": "single game item icon, centered, clear readable shape",
    "icon": "single game icon, centered, simple readable shape",
    "tile": "seamless tileable texture tile, top-down view, fills the whole frame edge to edge, no border, no frame, no characters",
    "background": "wide game background scene, environment only, no characters, no text, no UI",
    "ui": "game UI element, flat, clean edges, centered",
    "effect": "game visual effect sprite, centered, glowing",
    "portrait": "character portrait, head and shoulders, centered",
}
TRANSPARENT_KINDS = {"character", "sprite", "enemy", "item", "icon", "ui", "effect"}


class ArtError(ValueError):
    pass


def _path(project: str) -> Path:
    safe = re.sub(r"[^\w.-]", "_", project or "default")[:80]
    return ART_DIR / f"{safe}.json"


def get(project: str) -> Optional[Dict]:
    p = _path(project)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def list_all() -> List[Dict]:
    out = []
    for p in sorted(ART_DIR.glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append({"project": d.get("project", p.stem), "concept_ko": d.get("concept_ko", ""), "updated_at": d.get("updated_at", "")})
        except json.JSONDecodeError:
            continue
    return out


def _sanitize(bible: Dict) -> Dict:
    """대상을 알아볼 수 없게 만드는 단어(단색·실루엣)와 색 자체를 금지하는 문구를 뺀다."""
    b = dict(bible)
    if b.get("style"):
        b["style"] = _style_words(b["style"])
    if b.get("negative"):
        b["negative"] = ", ".join(w.strip() for w in b["negative"].split(",") if w.strip() and not re.search(r"colou?rs?\b|bright", w, re.I))
    return b


def save(project: str, bible: Dict, store=None) -> Dict:
    bible = {**_sanitize(bible), "project": project, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    _path(project).write_text(json.dumps(bible, ensure_ascii=False, indent=2), encoding="utf-8")
    if store is not None:  # 벡터 DB: 코딩 에이전트의 SEARCH·컨텍스트에서도 찾을 수 있게
        try:
            text = to_markdown(bible)
            store.upsert(f"{settings.code_collection}-attachments", [{
                "id_key": f"art-style:{project}", "text": f"{project} 아트 컨셉 그림 스타일\n{text}",
                "payload": {"project": project, "source": "아트 컨셉", "kind": "art-style", "attachment_id": f"art-{project}", "content": text[:4000]},
            }])
        except Exception:  # noqa: BLE001
            pass
    return bible


def to_markdown(b: Dict) -> str:
    lines = [f"# 아트 컨셉 — {b.get('project', '')}", "", b.get("concept_ko", "")]
    for k, label in [("genre", "장르"), ("mood", "분위기"), ("style", "화풍(영어 키워드)"), ("palette_words", "색"), ("perspective", "시점"),
                     ("outline", "외곽선"), ("negative", "피할 것")]:
        if b.get(k):
            lines.append(f"- **{label}**: {b[k]}")
    if b.get("palette"):
        lines.append(f"- **색상표**: {' '.join(b['palette'])}")
    if b.get("sizes"):
        lines.append("- **크기**: " + ", ".join(f"{k} {v}" for k, v in b["sizes"].items()))
    for c in b.get("characters", [])[:12]:
        lines.append(f"- **캐릭터 {c.get('name', '')}**: {c.get('look', '')}")
    return "\n".join(lines)


def summary(project: str) -> str:
    """코딩 에이전트에 넣을 짧은 요약 (시스템 프롬프트용)"""
    b = get(project)
    if not b:
        return ""
    chars = "; ".join(f"{c.get('name')}: {c.get('look')}" for c in b.get("characters", [])[:6])
    return (f"{b.get('concept_ko', '')}\n화풍: {b.get('style', '')} · 색: {b.get('palette_words', '')} · 시점: {b.get('perspective', '')}"
            + (f"\n캐릭터: {chars}" if chars else "")
            + (f"\n크기: {', '.join(f'{k} {v}' for k, v in b.get('sizes', {}).items())}" if b.get("sizes") else ""))


# ---- 분석 ---------------------------------------------------------------------------------------
_SYNTH = """You are an art director for a software/game project. From the evidence below, write the project's ART BIBLE so that every
generated image looks like it belongs to the same project. If the user's own concept is given, it has top priority; otherwise infer from
the code, docs and existing images. Keep existing images' style if there are any. Output ONLY a JSON object with these keys:
{"concept_ko": "2-3 sentences in Korean describing the visual concept",
 "genre": "...", "mood": "...",
 "style": "comma-separated English keywords for an image model (art style, medium, rendering, resolution feel, detail level)",
 "palette_words": "English color words, e.g. 'deep purple, teal, muted gold'",
 "palette": ["#hex", ...],
 "perspective": "e.g. side view / top-down / isometric",
 "outline": "e.g. thick black 1px outline / no outline",
 "sizes": {"character": "32x32", "tile": "16x16", "icon": "24x24", "background": "640x360"},
 "characters": [{"name": "...", "look": "short English visual description"}],
 "negative": "English things to avoid"}
Only include sizes you can infer. Use English for style/palette_words/perspective/outline/characters.look/negative.
Rules: "style" at most 12 keywords. Subjects must stay recognizable and keep their natural colors (a skeleton is bone-white, a slime
is its slime color): NEVER use words like monochromatic, silhouette, single color, low contrast unless the user explicitly asked.
"palette_words" = 3-6 accent/theme colors. "negative" must not forbid normal colors."""


def analyze(project: str, payload: Dict, store=None) -> Dict:
    t0 = time.time()
    evidence: List[str] = []
    if payload.get("user_concept"):
        evidence.append(f"## USER CONCEPT (highest priority)\n{payload['user_concept']}")
    for path, text in list((payload.get("docs") or {}).items())[:6]:
        evidence.append(f"## DOC {path}\n{text[:2500]}")
    if payload.get("code_hints"):
        evidence.append(f"## CODE HINTS\n{payload['code_hints'][:3000]}")
    files = payload.get("files") or []
    if files:
        evidence.append("## FILES (sample)\n" + "\n".join(files[:150]))
    # 벡터 DB: 프로젝트 코드·첨부에서 세계관·캐릭터·화면 관련
    if store is not None:
        seen = set()
        for q in ("game concept story world characters enemies", "sprite tile size canvas width height resolution", "color theme art style"):
            for h in store.search(q, top_k=3, project=project) + attachments.search(store, q, project=project, top_k=2):
                key = (h.get("source"), h.get("content", "")[:60])
                if key in seen:
                    continue
                seen.add(key)
                evidence.append(f"## VECTOR {h.get('source')}\n{h.get('content', '')[:900]}")
    # 이미 있는 그림: 화풍 + 실제 색
    styles, palettes = [], []
    for img in (payload.get("images") or [])[:4]:
        try:
            png = attachments.prepare_image(__import__("base64").b64decode(img["data"]))
            from .imagegen import style_of

            styles.append(f"{img.get('path')}: {style_of(png)}")
            palettes += [c["hex"] for c in attachments.palette(png, n=5)]
        except Exception:  # noqa: BLE001
            continue
    if styles:
        evidence.append("## EXISTING IMAGES (keep this style)\n" + "\n".join(styles) + f"\nmeasured colors: {' '.join(dict.fromkeys(palettes))}")
    attachments.schedule_vision_unload(5)
    if len(evidence) == 0:
        raise ArtError("분석할 자료가 없습니다 (프로젝트 파일·문서·그림 또는 컨셉 문장이 필요)")
    text = "\n\n".join(evidence)[:24000]
    try:
        res = llm_client.chat([{"role": "system", "content": _SYNTH}, {"role": "user", "content": f"PROJECT: {project}\n\n{text}"}],
                              max_tokens=900, temperature=0.2)
    except llm_client.LLMError as exc:
        raise ArtError(f"아트 컨셉 정리 실패 (코딩 엔진 확인): {exc}") from exc
    bible = llm_client.extract_json(res.text)
    if not isinstance(bible, dict) or not bible.get("style"):
        raise ArtError(f"아트 컨셉을 만들지 못했습니다: {res.text[:200]}")
    bible["sources"] = {"docs": list((payload.get("docs") or {}).keys())[:6], "images": [i.get("path") for i in (payload.get("images") or [])[:4]],
                        "user_concept": bool(payload.get("user_concept"))}
    bible["seconds"] = round(time.time() - t0, 1)
    return save(project, bible, store)


def revise(project: str, instruction: str, store=None) -> Dict:
    """'더 어둡게, 보라색 위주로' 같은 말로 아트 컨셉 수정"""
    cur = get(project) or {}
    try:
        res = llm_client.chat([{"role": "system", "content": _SYNTH + "\nYou are REVISING an existing bible: keep everything not mentioned."},
                               {"role": "user", "content": f"CURRENT BIBLE:\n{json.dumps(cur, ensure_ascii=False)}\n\nCHANGE REQUEST (Korean or English):\n{instruction}"}],
                              max_tokens=900, temperature=0.2)
    except llm_client.LLMError as exc:
        raise ArtError(f"아트 컨셉 수정 실패: {exc}") from exc
    bible = llm_client.extract_json(res.text)
    if not isinstance(bible, dict) or not bible.get("style"):
        raise ArtError(f"수정 결과를 이해하지 못했습니다: {res.text[:200]}")
    bible["sources"] = cur.get("sources", {})
    return save(project, bible, store)


# ---- 생성 프롬프트 · 검사 -----------------------------------------------------------------------
_BAD_STYLE = re.compile(r"\b(monochrom\w*|silhouette\w*|single[- ]colou?r|low[- ]contrast|black and white|grayscale)\b", re.I)


def _style_words(text: str, limit: int = 12) -> str:
    words = [w.strip() for w in (text or "").split(",") if w.strip() and not _BAD_STYLE.search(w)]
    return ", ".join(dict.fromkeys(words[:limit]))


def compose(prompt: str, kind: str, bible: Optional[Dict]) -> str:
    """대상(무엇을)을 맨 앞에 두고 끝에서 한 번 더 강조 → 화풍 키워드가 대상을 덮어쓰지 않게.
    'avoid: …' 같은 부정 문장은 넣지 않는다 (가이던스 없는 터보 모델은 그 단어를 오히려 그린다)."""
    subject = prompt.strip().rstrip(".")
    parts = [subject]
    if kind in KIND_TEMPLATES:
        parts.append(KIND_TEMPLATES[kind])
    if bible:
        style = _style_words(bible.get("style", ""))
        if style:
            parts.append(f"art style: {style}")
        if bible.get("palette_words"):
            parts.append(f"theme accent colors: {_style_words(bible['palette_words'], 6)} (keep the subject's natural colors)")
        if bible.get("perspective") and kind not in ("icon", "ui", "portrait", "tile"):
            parts.append(bible["perspective"])
        if bible.get("outline") and kind in TRANSPARENT_KINDS and "no outline" not in bible["outline"].lower():
            parts.append(bible["outline"])
    parts.append(f"the image clearly shows: {subject}")
    return ", ".join(p for p in parts if p)


def default_size(kind: str, bible: Optional[Dict]) -> Optional[str]:
    sizes = (bible or {}).get("sizes") or {}
    for k in (kind, {"enemy": "character", "sprite": "character", "item": "icon"}.get(kind, "")):
        if k and re.fullmatch(r"\d+\s*x\s*\d+", str(sizes.get(k, ""))):
            return str(sizes[k]).replace(" ", "")
    return None


VERIFY_PROMPT = ("This image was generated for a game/app. Requested: \"{subject}\" ({kind}). Required art style: {style}.\n"
                 "First decide: is the main subject clearly recognizable as \"{subject}\"? If NOT (wrong subject, unrecognizable dark "
                 "silhouette, missing the main object), the score must be 4 or lower.\n"
                 "Then rate from 0 to 10 how well it matches the request AND the art style. Be strict about wrong view, missing requested "
                 "details, wrong art style, text errors, extra objects.\n"
                 "Answer ONLY JSON: {{\"subject_ok\": true/false, \"score\": <0-10>, \"problems\": \"short English list of the biggest mismatches, empty if none\"}}")


def verify(image_png: bytes, subject: str, kind: str, bible: Optional[Dict]) -> Dict:
    style = (bible or {}).get("style") or "as requested"
    res = attachments.vision(attachments.prepare_image(image_png), VERIFY_PROMPT.format(subject=subject, kind=kind or "image", style=style), max_tokens=160)
    data = llm_client.extract_json(res.get("text", "")) or {}
    try:
        score = float(data.get("score", 0))
    except (TypeError, ValueError):
        m = re.search(r"(\d+(?:\.\d+)?)\s*/\s*10|score\D+(\d+)", res.get("text", ""))
        score = float(next(g for g in m.groups() if g)) if m else 5.0
    problems = data.get("problems", "")
    problems = "; ".join(map(str, problems)) if isinstance(problems, list) else str(problems)
    subject_ok = data.get("subject_ok", True) is not False and not re.search(r"wrong subject|not an? \w+|unrecogni[sz]able|silhouette", problems, re.I)
    if not subject_ok:
        score = min(score, 4.0)  # 대상이 틀리면 점수가 높아도 다시 그린다
    return {"score": max(0.0, min(10.0, score)), "problems": problems[:300], "subject_ok": subject_ok}
