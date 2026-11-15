"""첨부 파일(이미지 · PDF · MD/텍스트) 업로드 → 분석 → 저장 · 벡터화.

- MD/텍스트/코드: 그대로 읽는다.
- PDF: 페이지별 텍스트 추출(pypdfium2). 글자가 거의 없는 페이지(스캔본·그림)는 이미지로 렌더링해 비전 모델로 분석.
- 이미지: Rust 엔진의 비전 모델(/vision)이 "개발자가 구현할 수 있을 만큼 자세한 글"로 풀어 준다.

분석 결과(content.md)는 backend/data/attachments/<id>/ 에 저장하고, 첨부 전용 벡터 컬렉션에 색인한다
(코드 컬렉션은 프로젝트 재색인 때 통째로 교체되므로 따로 둔다).
"""
from __future__ import annotations

import base64
import io
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .config import settings
from .llm_client import LLMError, _post_json
from .vector_store import CodeVectorStore, chunk_text

ATT_DIR = Path(settings.state_dir).parent / "attachments"
COLLECTION = f"{settings.code_collection}-attachments"
MAX_BYTES = 25 * 1024 * 1024
MAX_PDF_PAGES = 300           # 텍스트 추출 최대 페이지
MAX_VISION_PAGES = 10         # 비전 모델로 분석할 스캔 페이지 최대 수 (페이지당 10~30초)
MIN_PAGE_CHARS = 40           # 이보다 글자가 적으면 스캔/그림 페이지로 보고 비전 분석
MAX_IMAGE_SIDE = 1600         # 비전 모델에 넣기 전 긴 변 최대 픽셀 (토큰 수·메모리 제한)
VISION_TIMEOUT = 600

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
TEXT_EXT = {
    ".md", ".markdown", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml",
    ".html", ".htm", ".css", ".sql", ".log", ".ini", ".env.example", ".properties", ".gradle", ".kts",
    ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".kt", ".dart", ".go", ".rs", ".swift", ".c", ".h", ".cpp",
    ".cs", ".php", ".rb", ".sh", ".vue", ".svelte",
}

ATT_DIR.mkdir(parents=True, exist_ok=True)


class AttachmentError(ValueError):
    pass


# ---- 종류 판별 ---------------------------------------------------------------------
def detect_kind(name: str, data: bytes) -> str:
    head = data[:16]
    if head.startswith(b"%PDF"):
        return "pdf"
    if (head.startswith(b"\x89PNG") or head.startswith(b"\xff\xd8\xff") or head[:6] in (b"GIF87a", b"GIF89a")
            or (head.startswith(b"RIFF") and data[8:12] == b"WEBP") or head.startswith(b"BM")):
        return "image"
    ext = Path(name).suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext == ".pdf":
        return "pdf"
    if ext in TEXT_EXT or ext == "":
        return "text"
    try:
        data[:4096].decode("utf-8")
        return "text"
    except UnicodeDecodeError:
        raise AttachmentError(f"지원하지 않는 파일 형식입니다: {name} (이미지 · PDF · MD/텍스트만 가능)")


def detect_kind_safe(name: str, data: bytes) -> str:
    try:
        return detect_kind(name, data)
    except AttachmentError:
        return ""


# ---- 이미지 → 비전 모델 --------------------------------------------------------------
def prepare_image(data: bytes) -> bytes:
    """비전 모델 입력용 PNG: RGB 변환 + 긴 변 MAX_IMAGE_SIDE 로 축소 (투명 배경은 흰색)."""
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise AttachmentError(f"이미지를 열 수 없습니다: {exc}") from exc
    if getattr(img, "n_frames", 1) > 1:
        img.seek(0)  # 움직이는 GIF 는 첫 프레임
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")
    w, h = img.size
    scale = MAX_IMAGE_SIDE / max(w, h)
    if scale < 1:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


# 종류별 분석 지시 (7B 비전 모델은 "~일 때만" 같은 조건을 잘 못 지키므로, 종류를 먼저 묻고 맞는 지시를 쓴다)
CLASSIFY_PROMPT = "이 이미지의 종류를 다음 중 하나의 단어로만 답하세요: UI, 다이어그램, 오류, 문서"
_COMMON = "한국어로 답하세요. 이미지에 없는 내용은 절대 만들어 내지 마세요. 추측한 값은 '(추정)'이라고 표시하세요."
KIND_PROMPTS = {
    "ui": "이 UI 화면(또는 디자인 시안)을 개발자가 그대로 코드로 구현할 수 있도록 분석해 주세요.\n"
          "## 글자\n화면의 모든 글자를 위에서 아래, 왼쪽에서 오른쪽 순서로 빠짐없이 그대로.\n"
          "## 구조\n위에서 아래로 영역(헤더·사이드바·본문·카드·푸터)을 나누고, 영역마다 구성요소(버튼·입력창·링크·표·아이콘·이미지)를 "
          "글자, 위치(왼쪽/가운데/오른쪽), 대략 크기, 정렬, 간격과 함께 나열.\n"
          "## 모양\n모서리 둥글기, 그림자, 테두리, 글자 크기·굵기, 각 영역과 버튼의 색. " + _COMMON,
    "diagram": "이 다이어그램을 개발자가 코드·설정으로 옮길 수 있도록 분석해 주세요.\n"
               "## 종류\n아키텍처 / ERD / 흐름도 / 시퀀스 / 기타\n## 글자\n모든 글자를 빠짐없이 그대로.\n"
               "## 요소\n모든 노드(상자·표·액터)와 그 속성(ERD 면 컬럼·타입·키).\n"
               "## 연결\n모든 연결을 '출발 → 도착 (라벨)' 형식으로, 화살표 방향과 관계(1:N 등)까지. " + _COMMON,
    "error": "이 오류·터미널·코드 화면을 분석해 주세요.\n"
             "## 글자\n화면의 모든 글자(명령, 출력, 오류 메시지, 스택 트레이스, 코드)를 코드 블록 안에 한 글자도 빠짐없이 그대로.\n"
             "## 오류\n핵심 오류 메시지와 발생 위치(파일·줄), 원인으로 보이는 부분. " + _COMMON,
    "doc": "이 문서·표 이미지를 분석해 주세요.\n"
           "## 글자\n모든 글자를 원래 순서와 제목 구조대로 빠짐없이 그대로. 표는 마크다운 표로.\n"
           "## 요점\n문서에 실제로 적힌 요구사항·수치·규칙만 정리 (적혀 있지 않으면 이 항목은 생략). " + _COMMON,
}


def classify(label: str) -> str:
    t = label.strip().lower()
    if "다이어그램" in t or "diagram" in t or "erd" in t or "흐름" in t:
        return "diagram"
    if "오류" in t or "error" in t or "터미널" in t or "코드" in t:
        return "error"
    if "문서" in t or "doc" in t or "표" in t:
        return "doc"
    return "ui"


def palette(image_png: bytes, n: int = 8) -> List[Dict]:
    """이미지의 실제 픽셀 색상 상위 n개 (#hex, 면적 %) — 비전 모델의 색 추정보다 정확하다."""
    from PIL import Image

    img = Image.open(io.BytesIO(image_png)).convert("RGB")
    img.thumbnail((400, 400))
    q = img.quantize(colors=16, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette() or []
    counts = sorted(q.getcolors() or [], reverse=True)
    total = sum(c for c, _ in counts) or 1
    merged: List[List] = []  # [r, g, b, count] — 눈으로 구분 안 되는 비슷한 색(안티앨리어싱 등)은 큰 쪽에 합친다
    for count, idx in counts:
        r, g, b = pal[idx * 3: idx * 3 + 3]
        for m in merged:
            if abs(m[0] - r) + abs(m[1] - g) + abs(m[2] - b) <= 18:
                m[3] += count
                break
        else:
            merged.append([r, g, b, count])
    merged.sort(key=lambda m: -m[3])
    out = []
    for r, g, b, count in merged[:n]:
        pct = round(count * 100 / total, 1)
        if pct >= 0.5:
            out.append({"hex": f"#{r:02x}{g:02x}{b:02x}", "percent": pct})
    return out


def blank_ratio(image_png: bytes) -> float:
    """가장 많은 한 가지 색이 차지하는 비율(%) — 비슷한 색(±6)은 같은 색으로 본다."""
    from PIL import Image

    img = Image.open(io.BytesIO(image_png)).convert("RGB")
    img.thumbnail((256, 256))
    px = list(img.getdata())
    r0, g0, b0 = max(set(px), key=px.count)
    same = sum(1 for r, g, b in px if abs(r - r0) <= 6 and abs(g - g0) <= 6 and abs(b - b0) <= 6)
    return same * 100 / max(len(px), 1)


def inspect_screen(image_png: bytes, expect: str = "", context: str = "") -> Dict:
    """게임·앱 실행 화면 점검 (PLAY 도구용). 단색 화면은 픽셀로 바로 판정하고, 나머지는 비전 모델이 문제를 찾는다."""
    png = prepare_image(image_png)
    colors = palette(png, n=4)
    top = colors[0] if colors else {"hex": "", "percent": 0}
    blank = blank_ratio(png) >= 99.8  # 어두운 배경에 작은 캐릭터만 있는 정상 게임도 99% 가 나오므로 기준을 높게
    lines: List[str] = []
    if blank:
        lines.append(f"⚠ 화면이 거의 한 가지 색({top['hex']}, {top['percent']}%)입니다 — 아무것도 그려지지 않았을 가능성이 큽니다 "
                     "(캔버스 크기 0·그리기 코드 미실행·리소스 로드 실패·카메라 위치 오류 등).")
    want = f"\n사용자가 기대한 화면: {expect}" if expect else ""
    prompt = ("이것은 개발 중인 게임·앱을 실행해서 캡처한 화면입니다." + want + "\n"
              "1. 화면에 실제로 보이는 것을 짧게 나열하세요 (캐릭터·적·배경·UI·글자).\n"
              "2. 다음 문제가 보이면 각각 근거와 함께 적으세요: 빈 화면/검정·흰색만, 오브젝트가 안 보이거나 화면 밖으로 잘림, "
              "겹침, 글자 깨짐·잘림, 오류 메시지·스택 트레이스 표시, 이미지 깨짐(빈 상자·물음표 아이콘)."
              + (" 기대한 화면과 다른 점도 적으세요." if expect else "") + "\n"
              "3. 문제가 없으면 '눈에 띄는 문제 없음'이라고 쓰세요. 이미지에 없는 것은 만들어 내지 마세요. 한국어로 짧게.")
    try:
        res = vision(png, prompt, max_tokens=700)
        lines.append(res.get("text", "").strip())
    finally:
        schedule_vision_unload()
    if colors:
        lines.append("주요 색: " + ", ".join(f"{c['hex']} {c['percent']}%" for c in colors))
    return {"text": "\n".join(l for l in lines if l), "blank": blank, "colors": colors}


def describe_image(image_png: bytes, prompt: str = "") -> Dict:
    """이미지 분석: 사용자 지시가 있으면 그대로, 없으면 종류 판별 → 종류별 지시로 분석. UI 면 실제 색상표를 덧붙인다."""
    if prompt.strip():
        res = vision(image_png, prompt)
        return {**res, "image_kind": "custom"}
    kind = classify(vision(image_png, CLASSIFY_PROMPT, max_tokens=8).get("text", ""))
    res = vision(image_png, KIND_PROMPTS[kind])
    text = res.get("text", "").strip()
    if kind == "ui":
        colors = palette(image_png)
        if colors:
            rows = "\n".join(f"| `{c['hex']}` | {c['percent']}% |" for c in colors)
            text += ("\n\n## 실제 색상 (픽셀에서 추출 · 정확)\n면적이 큰 순서. 위 설명의 색 추정과 다르면 이 값을 쓰세요.\n\n"
                     f"| 색 | 면적 |\n|---|---|\n{rows}")
    return {**res, "text": text, "image_kind": kind}


# 비전 모델(약 6GB)이 코딩 모델과 함께 메모리에 있으면 스왑으로 코딩 속도가 크게 떨어진다 (36GB 맥에서 60 → 7 tok/s).
# 마지막 분석 후 잠시 뒤 내린다 (연달아 올리는 첨부는 다시 로드하지 않도록 짧게 기다림).
UNLOAD_AFTER_SECONDS = 20
_unload_timer: Optional[threading.Timer] = None
_unload_lock = threading.Lock()


def _unload_vision(if_idle_seconds: int = 0) -> None:
    try:
        _post_json(f"{settings.engine_url}/vision/unload", {"if_idle_seconds": if_idle_seconds}, timeout=30)
    except Exception:  # noqa: BLE001 — 이전 버전 엔진·엔진 꺼짐: 엔진 자체의 유휴 해제에 맡긴다
        pass


def schedule_vision_unload(delay: float = UNLOAD_AFTER_SECONDS) -> None:
    global _unload_timer
    with _unload_lock:
        if _unload_timer is not None:
            _unload_timer.cancel()
        # 예약 해제: 그 사이 다른 분석이 비전 모델을 썼으면 엔진이 내리지 않는다
        _unload_timer = threading.Timer(delay, _unload_vision, kwargs={"if_idle_seconds": max(1, int(delay) - 5)})
        _unload_timer.daemon = True
        _unload_timer.start()


def unload_now_if_pending() -> None:
    """코딩 요청이 오면 예약된 해제를 기다리지 않고 바로 비전 모델을 내린다."""
    global _unload_timer
    with _unload_lock:
        timer, _unload_timer = _unload_timer, None
    if timer is not None and timer.is_alive():
        timer.cancel()
        _unload_vision()


def vision(image_png: bytes, prompt: str = "", max_tokens: int = 2048) -> Dict:
    """엔진 /vision 호출. 비전 모델이 없거나 엔진이 꺼져 있으면 AttachmentError."""
    try:
        return _post_json(
            f"{settings.engine_url}/vision",
            {"image": base64.b64encode(image_png).decode(), "prompt": prompt, "max_tokens": max_tokens, "temperature": 0.1},
            timeout=VISION_TIMEOUT,
        )
    except LLMError as exc:
        msg = str(exc)
        if "404" in msg:
            msg = "엔진이 이미지 분석을 지원하지 않는 이전 버전입니다. 엔진을 다시 시작하세요."
        raise AttachmentError(f"이미지 분석 실패: {msg}") from exc
    except OSError as exc:
        raise AttachmentError(f"이미지 분석 실패: 엔진({settings.engine_url})에 연결할 수 없습니다 ({exc})") from exc


# ---- 분석 -----------------------------------------------------------------------------
def analyze(name: str, data: bytes, prompt: str = "", progress: Optional[Callable[[str], None]] = None) -> Dict:
    """→ {kind, content(markdown), pages, vision_pages, notes[]}"""
    say = progress or (lambda _m: None)
    kind = detect_kind(name, data)
    notes: List[str] = []
    if kind == "text":
        text = data.decode("utf-8", errors="replace")
        return {"kind": "text", "content": text, "pages": 0, "vision_pages": 0, "notes": notes}

    if kind == "image":
        say("이미지 분석 중 (비전 모델)…")
        res = describe_image(prepare_image(data), prompt)
        kinds = {"ui": "UI 화면", "diagram": "다이어그램", "error": "오류·코드 화면", "doc": "문서", "custom": "사용자 지시"}
        notes.append(f"비전 모델 {res.get('model_name', '')} · 분석 방식: {kinds.get(res.get('image_kind'), '')}")
        content = f"# 이미지 분석: {name} ({kinds.get(res.get('image_kind'), '')})\n\n{res.get('text', '').strip()}\n"
        return {"kind": "image", "content": content, "pages": 0, "vision_pages": 1, "notes": notes}

    # PDF
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(data)
    except Exception as exc:  # noqa: BLE001
        raise AttachmentError(f"PDF 를 열 수 없습니다 (암호가 걸려 있거나 손상됨): {exc}") from exc
    n = len(pdf)
    parts = [f"# PDF: {name} ({n}쪽)\n"]
    vision_pages = 0
    skipped_vision = 0
    vision_off = False
    for i in range(min(n, MAX_PDF_PAGES)):
        page = pdf[i]
        text = page.get_textpage().get_text_range().replace("\r\n", "\n").replace("\r", "\n").strip()
        if len(re.sub(r"\s", "", text)) >= MIN_PAGE_CHARS:
            parts.append(f"\n## {i + 1}쪽\n\n{text}\n")
            continue
        if vision_off or vision_pages >= MAX_VISION_PAGES:
            skipped_vision += 1
            parts.append(f"\n## {i + 1}쪽\n\n(글자가 없는 페이지 — 이미지 분석 안 함)\n")
            continue
        say(f"{i + 1}/{n}쪽: 글자가 없는 페이지 → 이미지로 분석 중…")
        bitmap = page.render(scale=2.0).to_pil()
        buf = io.BytesIO()
        bitmap.save(buf, format="PNG")
        try:
            res = describe_image(prepare_image(buf.getvalue()), prompt)
            parts.append(f"\n## {i + 1}쪽 (이미지 분석)\n\n{res.get('text', '').strip()}\n")
            vision_pages += 1
        except AttachmentError as exc:
            parts.append(f"\n## {i + 1}쪽\n\n(이미지 분석 실패: {exc})\n")
            if str(exc) not in notes:
                notes.append(str(exc))
            vision_off = True  # 엔진·비전 모델 문제면 나머지 페이지도 실패하므로 더 시도하지 않음
    if n > MAX_PDF_PAGES:
        notes.append(f"{MAX_PDF_PAGES}쪽까지만 읽었습니다 (전체 {n}쪽)")
    if skipped_vision:
        notes.append(f"글자 없는 페이지 {skipped_vision}개는 이미지 분석을 건너뜀 (한도 {MAX_VISION_PAGES}쪽 또는 비전 모델 사용 불가)")
    pdf.close()
    return {"kind": "pdf", "content": "".join(parts), "pages": n, "vision_pages": vision_pages, "notes": notes}


# ---- 저장 / 조회 / 삭제 ----------------------------------------------------------------
def _safe_name(name: str) -> str:
    base = Path(name.replace("\\", "/")).name or "file"
    return re.sub(r"[^\w.\-가-힣 ]", "_", base)[:120]


def _meta_path(att_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", att_id or ""):
        raise AttachmentError("잘못된 첨부 ID")
    return ATT_DIR / att_id / "meta.json"


def save(store: CodeVectorStore, project: str, name: str, data: bytes, prompt: str = "",
         progress: Optional[Callable[[str], None]] = None) -> Dict:
    if not data:
        raise AttachmentError("빈 파일입니다")
    if len(data) > MAX_BYTES:
        raise AttachmentError(f"파일이 너무 큽니다 ({len(data) // 1024 // 1024}MB, 최대 {MAX_BYTES // 1024 // 1024}MB)")
    name = _safe_name(name)
    started = time.time()
    try:
        result = analyze(name, data, prompt, progress)
    finally:
        if detect_kind_safe(name, data) in ("image", "pdf"):
            schedule_vision_unload()
    att_id = uuid.uuid4().hex[:12]
    folder = ATT_DIR / att_id
    folder.mkdir(parents=True)
    (folder / name).write_bytes(data)
    (folder / "content.md").write_text(result["content"], encoding="utf-8")
    content = result["content"]
    meta = {
        "id": att_id, "name": name, "kind": result["kind"], "project": project or "",
        "size": len(data), "chars": len(content), "pages": result["pages"], "vision_pages": result["vision_pages"],
        "notes": result["notes"], "summary": re.sub(r"\s+", " ", content)[:300],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "seconds": round(time.time() - started, 1),
    }
    (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    meta["indexed"] = _index(store, meta, content)
    return meta


def _index(store: CodeVectorStore, meta: Dict, content: str) -> int:
    items = []
    for i, chunk in enumerate(chunk_text(content, 60)):
        if not chunk.strip():
            continue
        items.append({
            "id_key": f"attachment:{meta['id']}:{i}",
            "text": f"{meta['project']} 첨부 {meta['name']}\n{chunk[:2000]}",
            "payload": {"project": meta["project"], "attachment_id": meta["id"], "source": meta["name"],
                        "kind": "attachment", "chunk": i, "content": chunk[:4000]},
        })
    try:
        return store.upsert(COLLECTION, items)
    except Exception:  # noqa: BLE001 — 벡터 DB 가 없어도 첨부 자체는 사용 가능
        return 0


def get(att_id: str, with_content: bool = True) -> Dict:
    p = _meta_path(att_id)
    if not p.exists():
        raise FileNotFoundError(att_id)
    meta = json.loads(p.read_text(encoding="utf-8"))
    if with_content:
        meta["content"] = (p.parent / "content.md").read_text(encoding="utf-8")
    return meta


def list_all(project: str = "") -> List[Dict]:
    out = []
    for p in ATT_DIR.glob("*/meta.json"):
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not project or m.get("project") == project:
            out.append(m)
    return sorted(out, key=lambda m: m.get("created_at", ""), reverse=True)


def delete(store: CodeVectorStore, att_id: str) -> bool:
    p = _meta_path(att_id)
    if not p.exists():
        return False
    shutil.rmtree(p.parent)
    try:
        store.delete_where(COLLECTION, "attachment_id", att_id)
    except Exception:  # noqa: BLE001
        pass
    return True


def search(store: CodeVectorStore, query: str, project: str = "", top_k: int = 4) -> List[Dict]:
    try:
        hits = store.query(COLLECTION, query, top_k=top_k, filters={"project": project})
    except Exception:  # noqa: BLE001
        return []
    return [{"score": h["score"], "source": h.get("source", ""), "attachment_id": h.get("attachment_id", ""),
             "kind": "attachment", "content": h.get("content", "")[:1200]} for h in hits]
