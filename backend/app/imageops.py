"""이미지 스튜디오용 가공 (Pillow · numpy · scipy, 모델 없이 즉시 처리).

- split_auto: 한 장에 여러 그림이 있는 이미지 → 배경(투명 또는 가장자리 색)으로 떨어진 덩어리마다 잘라냄
- split_grid: 가로×세로 칸으로 균등 분할 (빈 칸 건너뛰기)
- apply_ops: 가공 단계 목록 적용. 배경 제거(remove_bg)만 AI(rembg, 이미지 작업 프로세스) 사용
"""
from __future__ import annotations

import base64
import io
import zipfile
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

MAX_PIXELS = 40_000_000  # 약 6300×6300


class ImageOpError(ValueError):
    pass


def load(b64: str) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(base64.b64decode(b64)))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise ImageOpError(f"이미지를 열 수 없습니다: {exc}") from exc
    if img.width * img.height > MAX_PIXELS:
        raise ImageOpError(f"이미지가 너무 큽니다 ({img.width}×{img.height})")
    if getattr(img, "n_frames", 1) > 1:
        img.seek(0)
    return img.convert("RGBA")


def to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


# ---- 배경 판별 -------------------------------------------------------------------------------
def foreground_mask(img: Image.Image, tolerance: int = 24) -> Tuple[np.ndarray, Optional[Tuple[int, int, int]]]:
    """그림 부분 = True. 투명도가 있으면 알파로, 없으면 가장자리에서 가장 흔한 색을 배경으로 본다."""
    arr = np.asarray(img.convert("RGBA"))
    alpha = arr[..., 3]
    if (alpha < 250).mean() > 0.01:  # 투명 배경
        return alpha > 16, None
    rgb = arr[..., :3].astype(np.int16)
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    q = (border // 8) * 8  # 가장자리 색을 묶어서 가장 흔한 색
    colors, counts = np.unique(q.reshape(-1, 3), axis=0, return_counts=True)
    ref = colors[counts.argmax()]
    near = border[(np.abs(q - ref).max(axis=1) == 0)]
    bg = tuple(int(x) for x in near.mean(axis=0)) if len(near) else tuple(int(x) for x in ref)
    dist = np.abs(rgb - np.array(bg, dtype=np.int16)).max(axis=2)
    return dist > tolerance, bg


def _clear_bg(crop: Image.Image, bg: Optional[Tuple[int, int, int]], tolerance: int) -> Image.Image:
    """단색 배경을 투명하게 (가장자리와 이어진 배경만 → 그림 안의 같은 색은 남김)"""
    if bg is None:
        return crop
    from scipy import ndimage

    arr = np.array(crop.convert("RGBA"))
    dist = np.abs(arr[..., :3].astype(np.int16) - np.array(bg, dtype=np.int16)).max(axis=2)
    bgmask = dist <= tolerance
    labels, _ = ndimage.label(bgmask)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    outside = np.isin(labels, list(edge)) if edge else np.zeros_like(bgmask)
    arr[..., 3] = np.where(outside, 0, arr[..., 3])
    return Image.fromarray(arr, "RGBA")


# ---- 나누기 -----------------------------------------------------------------------------------
def split_auto(img: Image.Image, gap: int = 6, min_size: int = 8, padding: int = 2, tolerance: int = 24,
               transparent: bool = True) -> Dict:
    from scipy import ndimage

    mask, bg = foreground_mask(img, tolerance)
    if not mask.any():
        raise ImageOpError("배경만 있고 그림을 찾지 못했습니다 (허용 오차를 낮추거나 격자 나누기를 쓰세요)")
    merged = ndimage.binary_dilation(mask, iterations=max(0, gap)) if gap > 0 else mask  # 가까운 조각(눈·그림자)은 하나로
    labels, n = ndimage.label(merged)
    boxes = []
    for i, sl in enumerate(ndimage.find_objects(labels), start=1):
        if sl is None:
            continue
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        inside = mask[y0:y1, x0:x1] & (labels[y0:y1, x0:x1] == i)
        if not inside.any():
            continue
        ys, xs = np.nonzero(inside)  # 팽창한 만큼 다시 줄여 실제 그림 경계로
        y0, y1, x0, x1 = y0 + ys.min(), y0 + ys.max() + 1, x0 + xs.min(), x0 + xs.max() + 1
        if (x1 - x0) < min_size or (y1 - y0) < min_size:
            continue
        boxes.append([int(x0), int(y0), int(x1 - x0), int(y1 - y0)])
    if len(boxes) > 400:
        raise ImageOpError(f"조각이 너무 많습니다 ({len(boxes)}개). 최소 크기나 병합 간격을 늘리세요")
    boxes = _reading_order(boxes)
    pieces = []
    for x, y, w, h in boxes:
        box = (max(0, x - padding), max(0, y - padding), min(img.width, x + w + padding), min(img.height, y + h + padding))
        crop = img.crop(box)
        if transparent:
            crop = _clear_bg(crop, bg, tolerance)
        pieces.append({"image": to_b64(crop), "box": [box[0], box[1], box[2] - box[0], box[3] - box[1]], "size": list(crop.size)})
    return {"pieces": pieces, "background": "transparent" if bg is None else "#%02x%02x%02x" % bg}


def _reading_order(boxes: List[List[int]]) -> List[List[int]]:
    """왼쪽 위부터 줄 단위로 (세로로 겹치는 것끼리 한 줄)"""
    rows: List[List[List[int]]] = []
    for b in sorted(boxes, key=lambda b: b[1]):
        for row in rows:
            top = min(r[1] for r in row)
            bottom = max(r[1] + r[3] for r in row)
            if b[1] < bottom and b[1] + b[3] > top and b[1] < top + (bottom - top) * 0.6:
                row.append(b)
                break
        else:
            rows.append([b])
    return [b for row in rows for b in sorted(row, key=lambda b: b[0])]


def split_grid(img: Image.Image, cols: int, rows: int, skip_empty: bool = True, tolerance: int = 24,
               trim_cells: bool = False) -> Dict:
    if not (1 <= cols <= 64 and 1 <= rows <= 64):
        raise ImageOpError("격자는 가로·세로 1~64칸")
    mask, bg = foreground_mask(img, tolerance)
    cw, ch = img.width / cols, img.height / rows
    pieces = []
    for r in range(rows):
        for c in range(cols):
            box = (round(c * cw), round(r * ch), round((c + 1) * cw), round((r + 1) * ch))
            cell = mask[box[1]:box[3], box[0]:box[2]]
            if skip_empty and not cell.any():
                continue
            crop = img.crop(box)
            if trim_cells and cell.any():
                ys, xs = np.nonzero(cell)
                crop = crop.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
            pieces.append({"image": to_b64(crop), "box": [box[0], box[1], box[2] - box[0], box[3] - box[1]], "size": list(crop.size), "cell": [c, r]})
    return {"pieces": pieces, "background": "transparent" if bg is None else "#%02x%02x%02x" % bg}


# ---- 가공 -------------------------------------------------------------------------------------
def _color(c: str) -> Tuple[int, int, int]:
    c = c.strip().lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    try:
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError as exc:
        raise ImageOpError(f"색 형식은 #rrggbb: {c}") from exc


def trim(img: Image.Image, tolerance: int = 24) -> Image.Image:
    mask, _ = foreground_mask(img, tolerance)
    if not mask.any():
        return img
    ys, xs = np.nonzero(mask)
    return img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


def pad_square(img: Image.Image, margin: int = 0) -> Image.Image:
    s = max(img.size) + margin * 2
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
    return out


def pixelate(img: Image.Image, cells: int, colors: int = 24) -> Image.Image:
    ch = max(1, round(img.height * cells / img.width))
    small = img.resize((cells, ch), Image.BOX)
    alpha = small.getchannel("A").point(lambda a: 255 if a >= 128 else 0)
    rgb = small.convert("RGB").quantize(colors=max(2, min(256, colors)), method=Image.Quantize.MEDIANCUT,
                                        dither=Image.Dither.NONE).convert("RGB")
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def resize(img: Image.Image, w: int, h: int, mode: str = "fit") -> Image.Image:
    if w <= 0 and h <= 0:
        raise ImageOpError("크기를 입력하세요")
    if w <= 0:
        w = max(1, round(img.width * h / img.height))
    if h <= 0:
        h = max(1, round(img.height * w / img.width))
    pixel = mode == "nearest" or (mode == "fit" and img.width <= w // 2)
    resample = Image.NEAREST if pixel else Image.LANCZOS
    if mode in ("stretch", "nearest-stretch"):
        return img.resize((w, h), resample)
    fitted = ImageOps.contain(img, (w, h), method=resample)
    if mode == "cover":
        return ImageOps.fit(img, (w, h), method=resample)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(fitted, ((w - fitted.width) // 2, (h - fitted.height) // 2))
    return out


def outline(img: Image.Image, color: str = "#000000", width: int = 1) -> Image.Image:
    """투명 배경 그림 둘레에 외곽선 (픽셀아트·스티커 느낌)"""
    alpha = img.getchannel("A")
    grown = alpha.filter(ImageFilter.MaxFilter(width * 2 + 1))
    base = Image.new("RGBA", img.size, _color(color) + (0,))
    base.putalpha(grown)
    base.alpha_composite(img)
    return base


def _keep_alpha(img: Image.Image, fn: Callable[[Image.Image], Image.Image]) -> Image.Image:
    a = img.getchannel("A")
    out = fn(img.convert("RGB")).convert("RGBA")
    out.putalpha(a)
    return out


def apply_op(img: Image.Image, op: Dict, remove_bg: Optional[Callable[[Image.Image], Image.Image]] = None) -> Image.Image:
    name = op.get("op")
    f = lambda k, d: float(op.get(k, d))  # noqa: E731
    if name == "crop":
        x, y, w, h = int(f("x", 0)), int(f("y", 0)), int(f("w", img.width)), int(f("h", img.height))
        if w <= 0 or h <= 0:
            raise ImageOpError("자를 영역이 비어 있습니다")
        return img.crop((max(0, x), max(0, y), min(img.width, x + w), min(img.height, y + h)))
    if name == "resize":
        return resize(img, int(f("w", 0)), int(f("h", 0)), op.get("mode", "fit"))
    if name == "scale":
        s = f("factor", 2)
        return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.NEAREST if op.get("pixel") else Image.LANCZOS)
    if name == "flip":
        return ImageOps.mirror(img) if op.get("axis", "x") == "x" else ImageOps.flip(img)
    if name == "rotate":
        return img.rotate(-f("deg", 90), expand=True, resample=Image.BICUBIC)
    if name == "trim":
        return trim(img, int(f("tolerance", 24)))
    if name == "pad_square":
        return pad_square(img, int(f("margin", 0)))
    if name == "pad":
        m = int(f("margin", 8))
        out = Image.new("RGBA", (img.width + 2 * m, img.height + 2 * m), (0, 0, 0, 0))
        out.paste(img, (m, m))
        return out
    if name == "pixelate":
        return pixelate(img, int(f("cells", 32)), int(f("colors", 24)))
    if name == "grayscale":
        return _keep_alpha(img, ImageOps.grayscale)
    if name == "brightness":
        return _keep_alpha(img, lambda i: ImageEnhance.Brightness(i).enhance(f("amount", 1.2)))
    if name == "contrast":
        return _keep_alpha(img, lambda i: ImageEnhance.Contrast(i).enhance(f("amount", 1.2)))
    if name == "saturation":
        return _keep_alpha(img, lambda i: ImageEnhance.Color(i).enhance(f("amount", 1.3)))
    if name == "tint":
        layer = Image.new("RGBA", img.size, _color(op.get("color", "#ffffff")) + (255,))
        mixed = Image.blend(img, layer, max(0.0, min(1.0, f("amount", 0.3))))
        mixed.putalpha(img.getchannel("A"))
        return mixed
    if name == "invert":
        return _keep_alpha(img, ImageOps.invert)
    if name == "outline":
        return outline(img, op.get("color", "#000000"), max(1, int(f("width", 1))))
    if name == "clear_color":
        return _clear_bg(img, _color(op.get("color", "#ffffff")), int(f("tolerance", 24)))
    if name == "remove_bg":
        if remove_bg is None:
            raise ImageOpError("배경 제거(AI)를 쓸 수 없습니다")
        return remove_bg(img)
    raise ImageOpError(f"알 수 없는 가공: {name}")


OPS_HELP = ("crop{x,y,w,h} · resize{w,h,mode=fit|stretch|cover|nearest} · scale{factor,pixel} · flip{axis=x|y} · rotate{deg} · "
            "trim · pad_square{margin} · pad{margin} · pixelate{cells,colors} · grayscale · brightness{amount} · contrast{amount} · "
            "saturation{amount} · tint{color,amount} · invert · outline{color,width} · clear_color{color,tolerance} · remove_bg")


def make_zip(files: List[Dict]) -> bytes:
    buf = io.BytesIO()
    used = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, f in enumerate(files):
            name = "".join(ch for ch in (f.get("name") or f"image_{i + 1}") if ch.isalnum() or ch in "-_. 가-힣") or f"image_{i + 1}"
            name = name if name.lower().endswith(".png") else name + ".png"
            base, n = name, 1
            while name in used:
                name = base[:-4] + f"_{n}.png"
                n += 1
            used.add(name)
            z.writestr(name, base64.b64decode(f["data"]))
    return buf.getvalue()
