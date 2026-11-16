"""이미지 생성·가공 오케스트레이션 (프로젝트용 그림을 다운로드하지 않고 만든다).

흐름: 참고 이미지 준비(프로젝트 파일 · 첨부 · Openverse CC0/퍼블릭 도메인 검색)
   → 비전 모델로 참고 이미지의 '스타일'만 글로 추출 (그림을 베끼지 않음)
   → 엔진 잠자기(코딩·비전 모델 내림: 36GB 맥에서 같이 올리면 스왑으로 10배 느려짐)
   → FLUX.1-schnell(4bit, Apache-2.0) 작업 프로세스로 생성 → 가공(배경 제거·픽셀아트·크기·시트)
코딩 모델은 다음 코딩 요청 때 엔진이 작업 프로세스를 끄고 자동으로 다시 올린다.
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import attachments
from .config import settings
from .llm_client import LLMError, _post_json

ROOT = Path(settings.project_root)
WORKER_PORT = 18093
WORKER_URL = f"http://127.0.0.1:{WORKER_PORT}"
PYTHON = ROOT / "imagegen" / ".venv" / "bin" / "python"
WORKER = ROOT / "imagegen" / "worker.py"
MODEL_DIRS = {"zimage": ROOT / "models" / "z-image-turbo-q4", "flux": ROOT / "models" / "flux-schnell-4bit"}


def family() -> str:
    """기본: Z-Image-Turbo (지시를 더 잘 따름, 비교 시험 결과). 없으면 FLUX.1-schnell. IMAGEGEN_FAMILY 로 고정 가능."""
    import os

    want = os.getenv("IMAGEGEN_FAMILY", "")
    if want in MODEL_DIRS and (MODEL_DIRS[want] / "transformer").exists():
        return want
    return "zimage" if (MODEL_DIRS["zimage"] / "transformer").exists() else "flux"


MODEL_DIR = MODEL_DIRS["flux"]
LOG = Path(settings.state_dir) / "imagegen.log"
OPENVERSE = "https://api.openverse.org/v1/images/"
USER_AGENT = "YangCoding-ImageRef/1.0"


class ImageGenError(ValueError):
    pass


def available() -> Dict:
    fam = family()
    has = (MODEL_DIRS[fam] / "transformer").exists()
    return {"python": PYTHON.exists(), "worker": WORKER.exists(), "model": has, "family": fam,
            "models": {k: (v / "transformer").exists() for k, v in MODEL_DIRS.items()},
            "ready": PYTHON.exists() and WORKER.exists() and has}


# ---- 작업 프로세스 ------------------------------------------------------------------------
def _get(url: str, timeout: float = 2.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:  # noqa: BLE001
        return None


def _worker(path: str, body: dict, timeout: float = 900) -> dict:
    try:
        return _post_json(f"{WORKER_URL}{path}", body, timeout=timeout)
    except LLMError as exc:
        raise ImageGenError(f"이미지 작업 실패: {exc}") from exc


def ensure_worker() -> None:
    h = _get(f"{WORKER_URL}/health")
    if h and h.get("family", "flux") == family():
        return
    if h:  # 다른 모델로 떠 있으면 끄고 다시
        try:
            _post_json(f"{WORKER_URL}/shutdown", {}, timeout=5)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.5)
    st = available()
    if not st["ready"]:
        raise ImageGenError("이미지 생성 환경이 없습니다. 맥에서 ./install.sh --imagegen yes 를 실행하세요 "
                            f"(python={st['python']}, model={st['model']})")
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "ab") as log:
        fam = family()
        subprocess.Popen([str(PYTHON), str(WORKER), "--model", str(MODEL_DIRS[fam]), "--family", fam, "--port", str(WORKER_PORT), "--idle", os.getenv("IMAGEGEN_IDLE", "180"),
                          "--tmp", str(Path(settings.state_dir))],
                         stdout=log, stderr=log, start_new_session=True, env={"PATH": "/usr/bin:/bin", "TQDM_DISABLE": "1",
                                                                               "HOME": str(Path.home())})
    for _ in range(120):
        if _get(f"{WORKER_URL}/health"):
            return
        time.sleep(0.5)
    raise ImageGenError(f"이미지 작업 프로세스가 시작되지 않았습니다 (로그: {LOG})")


def engine_sleep() -> None:
    """코딩·비전 모델을 내려 메모리 확보 (엔진이 다음 코딩 요청 때 자동으로 다시 올림)"""
    try:
        _post_json(f"{settings.engine_url}/sleep", {}, timeout=60)
    except Exception:  # noqa: BLE001 — 이전 버전 엔진이거나 꺼져 있으면 그냥 진행
        pass


# ---- 참고 이미지 ---------------------------------------------------------------------------
def search_refs(query: str, n: int = 4) -> List[Dict]:
    """Openverse 에서 CC0·퍼블릭 도메인 이미지만 검색 (출처 표기 의무가 없는 라이선스)"""
    q = urllib.parse.urlencode({"q": query, "license": "cc0,pdm", "page_size": n, "mature": "false"})
    req = urllib.request.Request(f"{OPENVERSE}?{q}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read())
    except Exception as exc:  # noqa: BLE001
        raise ImageGenError(f"무료 이미지 검색 실패 (Openverse): {exc}") from exc
    out = []
    for it in data.get("results", [])[:n]:
        out.append({"title": it.get("title") or "", "creator": it.get("creator") or "", "license": (it.get("license") or "").upper(),
                    "license_url": it.get("license_url") or "", "source": it.get("foreign_landing_url") or it.get("url") or "",
                    "thumbnail": it.get("thumbnail") or it.get("url") or "", "url": it.get("url") or ""})
    return out


def _download(url: str, limit: int = 15 * 1024 * 1024) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ImageGenError("참고 이미지가 너무 큽니다")
    return data


def attachment_image(name_or_id: str) -> bytes:
    for m in attachments.list_all():
        if m["kind"] == "image" and (m["id"] == name_or_id or m["name"] == name_or_id):
            return (attachments.ATT_DIR / m["id"] / m["name"]).read_bytes()
    raise ImageGenError(f"첨부 이미지를 찾을 수 없습니다: {name_or_id}")


STYLE_PROMPT = ("Describe only the visual STYLE of this image so another artist can paint a different subject in the same style: "
                "art style and medium, rendering (pixel art / flat / painterly / 3D), outline, color palette, lighting, perspective, "
                "level of detail. Do not describe the subject. Answer with one line of comma-separated English keywords, at most 35 words.")


def style_of(image: bytes) -> str:
    res = attachments.vision(attachments.prepare_image(image), STYLE_PROMPT, max_tokens=90)
    text = re.sub(r"\s+", " ", res.get("text", "")).strip().strip(".")
    return text[:300]


# ---- 가공 지시 해석 -------------------------------------------------------------------------
def parse_ops(text: str) -> List[Dict]:
    """'flip-x; tint #ff8800 0.3; crop 0,0,32,32; resize 128x128; sheet-split 4x1; remove-bg; pixelate 32 16'"""
    ops: List[Dict] = []
    for raw in re.split(r"[;\n]", text or ""):
        t = raw.strip().lower()
        if not t:
            continue
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", t)]
        if t.startswith(("flip-x", "flipx", "mirror")):
            ops.append({"op": "flip", "axis": "x"})
        elif t.startswith(("flip-y", "flipy")):
            ops.append({"op": "flip", "axis": "y"})
        elif t.startswith("rotate"):
            ops.append({"op": "rotate", "deg": nums[0] if nums else 90})
        elif t.startswith("tint"):
            color = re.search(r"#[0-9a-f]{6}", t)
            rest = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", t.replace(color.group(0), "") if color else t)]
            ops.append({"op": "tint", "color": color.group(0) if color else "#ffffff", "amount": rest[0] if rest and rest[0] <= 1 else 0.3})
        elif t.startswith("crop") and len(nums) >= 4:
            ops.append({"op": "crop", "x": nums[0], "y": nums[1], "w": nums[2], "h": nums[3]})
        elif t.startswith(("resize", "size")) and len(nums) >= 2:
            ops.append({"op": "resize", "w": int(nums[0]), "h": int(nums[1]), "mode": "stretch" if "stretch" in t else "nearest" if "nearest" in t else "fit"})
        elif t.startswith(("remove-bg", "removebg", "transparent", "배경")):
            ops += [{"op": "remove_bg"}, {"op": "trim"}]
        elif t.startswith("trim"):
            ops.append({"op": "trim"})
        elif t.startswith(("pad-square", "square")):
            ops.append({"op": "pad_square"})
        elif t.startswith(("pixelate", "pixel")) and nums:
            ops.append({"op": "pixelate", "cells": int(nums[0]), "colors": int(nums[1]) if len(nums) > 1 else 24})
        elif t.startswith(("grayscale", "gray")):
            ops.append({"op": "grayscale"})
        elif t.startswith(("sheet-split", "split")) and len(nums) >= 2:
            ops.append({"op": "sheet_split", "cols": int(nums[0]), "rows": int(nums[1])})
        else:
            raise ImageGenError(f"알 수 없는 가공 지시: '{raw.strip()}' (flip-x · rotate 90 · tint #ff0000 0.3 · crop x,y,w,h · "
                                "resize WxH · remove-bg · trim · pad-square · pixelate 32 · grayscale · sheet-split 4x1)")
    return ops


def _gen_size(w: int, h: int) -> Tuple[int, int]:
    """목표 크기 → 생성 크기: 작은 스프라이트는 512 로 그려 줄이고, 큰 그림은 최대 1024 (16의 배수)"""
    longest = max(w, h)
    target = 512 if longest <= 512 else min(1024, longest)
    s = target / longest
    return max(256, int(w * s) // 16 * 16), max(256, int(h * s) // 16 * 16)


HANGUL = re.compile(r"[가-힣]")


def translate(text: str) -> str:
    from . import llm_client

    try:
        res = llm_client.chat([
            {"role": "system", "content": "Translate the user's image description into one concise English prompt for an image generation model. "
                                          "Keep every visual detail (subject, style, colors, view, background). Output only the English prompt."},
            {"role": "user", "content": text}], max_tokens=200, temperature=0.1)
    except llm_client.LLMError as exc:
        raise ImageGenError(f"한글 설명을 영어로 바꾸지 못했습니다 (코딩 엔진 확인): {exc}") from exc
    out = res.text.strip().strip('"').splitlines()[0].strip() if res.text.strip() else ""
    if not out or HANGUL.search(out):
        raise ImageGenError("한글 설명을 영어로 바꾸지 못했습니다. 영어로 입력해 주세요.")
    return out


def remove_bg_image(img):
    """배경 제거(rembg)만 작업 프로세스에서 (FLUX 는 로드하지 않음)"""
    from . import imageops

    ensure_worker()
    res = _worker("/process", {"image": imageops.to_b64(img), "ops": [{"op": "remove_bg"}]}, timeout=300)
    return imageops.load(res["images"][0])


def generate(req: Dict) -> Dict:
    """IMAGE 도구 한 번: 생성(또는 기존 이미지 가공) → 가공 → 결과 이미지(들)"""
    timings: Dict[str, float] = {}
    t0 = time.time()
    prompt = (req.get("prompt") or "").strip()
    width, height = int(req.get("width") or 0), int(req.get("height") or 0)
    source = req.get("source")  # 기존 이미지(b64): 고쳐 그리기 또는 가공만
    joins = req.get("join") or []
    if not prompt and not source and not joins:
        raise ImageGenError("prompt(생성) 또는 from/join(가공할 이미지)이 필요합니다")
    if HANGUL.search(prompt) and req.get("translate"):
        prompt = translate(prompt)  # 웹 스튜디오: 한글 입력 → 영어 (코딩 모델을 내리기 전에)
    if HANGUL.search(prompt):
        raise ImageGenError("prompt 는 영어로 써야 합니다 (이미지 모델이 영어만 잘 이해함). 같은 내용을 영어로 바꿔 IMAGE 를 다시 호출하세요.")
    ops = parse_ops(req.get("ops") or "")
    from . import artstyle

    project = (req.get("project") or "").strip()
    kind = (req.get("kind") or "").strip().lower()
    bible = artstyle.get(project) if project and req.get("use_art", True) else None
    if prompt and not (width and height):
        size = artstyle.default_size(kind, bible)
        if size:
            width, height = (int(x) for x in size.split("x"))
    transparent = req.get("transparent")
    if transparent is None:
        transparent = kind in artstyle.TRANSPARENT_KINDS
    pixel_style = bool(bible and "pixel" in (bible.get("style") or "").lower())
    credits: List[Dict] = []
    style = ""
    used_prompt = ""

    # 1) 참고 이미지 (스타일 추출용, strength>0 이면 밑그림으로도 사용)
    ref_bytes: Optional[bytes] = None
    if req.get("refs"):
        ref_bytes = base64.b64decode(req["refs"][0])
    elif req.get("ref_attachment"):
        ref_bytes = attachment_image(req["ref_attachment"])
    elif req.get("ref_search"):
        t = time.time()
        found = search_refs(req["ref_search"], n=3)
        for it in found:
            try:
                ref_bytes = _download(it["thumbnail"] or it["url"])
                credits.append({k: it[k] for k in ("title", "creator", "license", "license_url", "source")})
                break
            except Exception:  # noqa: BLE001
                continue
        timings["search"] = round(time.time() - t, 1)
        if ref_bytes is None:
            raise ImageGenError(f"'{req['ref_search']}' 로 쓸 수 있는 무료(CC0·퍼블릭 도메인) 참고 이미지를 찾지 못했습니다")
    if ref_bytes and prompt and req.get("use_style", True):
        t = time.time()
        style = style_of(ref_bytes)
        timings["style"] = round(time.time() - t, 1)

    images: List[str] = []
    verify_info = None
    if prompt:
        parts = [artstyle.compose(prompt, kind, bible)]
        if style:
            parts.append(f"reference style: {style}")
        if transparent:
            parts.append("single subject, centered, full view, isolated on a plain solid white background, no shadow, no text")
        used_prompt = ", ".join(parts)
        gw, gh = _gen_size(width or 1024, height or 1024)
        strength = float(req.get("strength") or 0)
        init = source or (base64.b64encode(ref_bytes).decode() if ref_bytes and strength > 0 else None)
        engine_sleep()
        t = time.time()
        ensure_worker()
        timings["worker"] = round(time.time() - t, 1)
        t = time.time()
        gen_body = {"prompt": used_prompt, "width": gw, "height": gh, "steps": req.get("steps") or None,
                    "seed": req.get("seed"), "init_image": init, "strength": strength or (0.55 if source else 0)}
        res = _worker("/generate", gen_body)
        timings["generate"] = round(time.time() - t, 1)
        images = [res["image"]]
        # 자기 검사: 비전 모델이 요청·아트 컨셉과 대조 → 낮으면 문제점을 반영해 한 번 더 그려 더 나은 쪽을 쓴다
        if req.get("verify", True):
            t = time.time()
            try:
                check = artstyle.verify(base64.b64decode(images[0]), prompt, kind, bible)
                verify_log = [check]
                if check["score"] < float(req.get("min_score") or 7):
                    retry = dict(gen_body, seed=(res.get("seed") or 0) + 1,
                                 prompt=used_prompt + (f", must fix: {check['problems']}" if check["problems"] else ""))
                    res2 = _worker("/generate", retry)
                    check2 = artstyle.verify(base64.b64decode(res2["image"]), prompt, kind, bible)
                    verify_log.append(check2)
                    if check2["score"] >= check["score"]:
                        images, used_prompt = [res2["image"]], retry["prompt"]
                timings["verify"] = round(time.time() - t, 1)
                verify_info = {"scores": [v["score"] for v in verify_log], "problems": verify_log[-1]["problems"]}
            except Exception as exc:  # noqa: BLE001 — 검사 실패해도 그림은 돌려준다
                verify_info = {"error": str(exc)[:200]}
        else:
            verify_info = None
    else:
        images = [source] if source else []

    # 2) 가공: 배경 제거 → 픽셀아트 → 사용자 지시 → 최종 크기
    pipeline: List[Dict] = []
    if transparent:
        pipeline += [{"op": "remove_bg"}, {"op": "trim"}, {"op": "pad_square"} if width == height and width else {"op": "trim"}]
    if req.get("pixel"):
        pipeline.append({"op": "pixelate", "cells": int(req["pixel"]), "colors": int(req.get("colors") or 24)})
    elif prompt and pixel_style and width and width <= 128:
        # 아트 컨셉이 픽셀아트면 목표 크기의 칸 수로 깔끔하게 (최근접 축소보다 덜 깨짐)
        pipeline.append({"op": "pixelate", "cells": width, "colors": int(req.get("colors") or 32)})
    pipeline += ops
    if width and height and not any(o["op"] in ("resize", "sheet_split") for o in ops):
        pipeline.append({"op": "resize", "w": width, "h": height, "mode": "nearest" if (req.get("pixel") or pixel_style) else "fit"})
    if joins:
        pipeline.insert(0, {"op": "sheet_join", "images": joins, "cols": int(req.get("cols") or len(joins) + len(images))})
    sizes: List[List[int]] = []
    if pipeline:
        if not prompt:
            ensure_worker()  # 가공만: 배경 제거 모델(rembg)은 작아서 코딩 모델을 내릴 필요 없음
        t = time.time()
        res = _worker("/process", {"image": images[0] if images else None, "ops": pipeline})
        timings["process"] = round(time.time() - t, 1)
        images, sizes = res["images"], res["sizes"]
    else:
        from PIL import Image
        sizes = [list(Image.open(io.BytesIO(base64.b64decode(images[0]))).size)]
    timings["total"] = round(time.time() - t0, 1)
    return {"images": images, "sizes": sizes, "credits": credits, "prompt_used": used_prompt, "style": style, "timings": timings,
            "verify": verify_info, "kind": kind, "art": bool(bible), "model": family()}
