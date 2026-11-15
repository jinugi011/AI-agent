"""Yang Coding 이미지 작업 프로세스 (FLUX.1-schnell 4bit · MLX + Pillow + rembg).

백엔드가 필요할 때 띄우고, IDLE 초 동안 요청이 없으면 스스로 종료해 메모리(약 10GB)를 돌려준다.
  GET  /health
  POST /generate {prompt, width, height, steps, seed, init_image(b64), strength}  → {image(b64 png), seconds}
  POST /process  {image(b64), ops:[{op:..}]}                                    → {images:[b64 png], log:[..]}

ops: resize{w,h,mode=fit|stretch|nearest} · crop{x,y,w,h} · flip{axis=x|y} · rotate{deg} · tint{color,amount}
     remove_bg · trim · pad_square · pixelate{cells,colors} · sheet_split{cols,rows} · sheet_join{images,cols}
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageOps

ARGS = None
_flux = None
_rembg = None
_lock = threading.Lock()
_last = time.time()


def log(*a):
    print("[imagegen]", *a, file=sys.stderr, flush=True)


def b64png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def load_b64(data: str) -> Image.Image:
    img = Image.open(io.BytesIO(base64.b64decode(data)))
    img.load()
    return img


def flux():
    global _flux
    if _flux is None:
        t = time.time()
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux.variants.txt2img.flux import Flux1

        _flux = Flux1(model_config=ModelConfig.schnell(), model_path=ARGS.model)
        log(f"FLUX 로드 {time.time() - t:.1f}s")
    return _flux


def generate(req: dict) -> dict:
    w = max(256, min(1536, int(req.get("width", 1024)) // 16 * 16))
    h = max(256, min(1536, int(req.get("height", 1024)) // 16 * 16))
    seed = int(req.get("seed") or random.randint(0, 2**31 - 1))
    steps = int(req.get("steps") or 4)
    init_path = None
    if req.get("init_image"):
        init = load_b64(req["init_image"]).convert("RGB").resize((w, h), Image.LANCZOS)
        init_path = os.path.join(ARGS.tmp, f"init-{os.getpid()}-{seed}.png")
        init.save(init_path)
    t = time.time()
    model = flux()
    loaded = time.time() - t
    t = time.time()
    try:
        out = model.generate_image(
            seed=seed, prompt=req["prompt"], num_inference_steps=steps, width=w, height=h,
            image_path=init_path, image_strength=float(req["strength"]) if init_path else None,
        )
    finally:
        if init_path and os.path.exists(init_path):
            os.remove(init_path)
    img = out.image if hasattr(out, "image") else out
    secs = time.time() - t
    try:  # 생성마다 쌓이는 GPU 버퍼 캐시를 비워 다음 생성이 느려지지 않게
        import mlx.core as mx
        (getattr(mx, "clear_cache", None) or mx.metal.clear_cache)()
    except Exception:
        pass
    log(f"생성 {w}x{h} steps={steps} {secs:.1f}s (로드 {loaded:.1f}s)")
    return {"image": b64png(img), "seconds": round(secs, 1), "load_seconds": round(loaded, 1), "seed": seed, "width": w, "height": h}


# ---- 가공 -------------------------------------------------------------------------------------
def _color(c: str):
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def remove_bg(img: Image.Image) -> Image.Image:
    global _rembg
    from rembg import new_session, remove

    if _rembg is None:
        _rembg = new_session(os.environ.get("YANG_REMBG_MODEL", "isnet-general-use"))
    return remove(img.convert("RGBA"), session=_rembg)


def trim(img: Image.Image) -> Image.Image:
    if img.mode != "RGBA":
        return img
    box = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    return img.crop(box) if box else img


def pad_square(img: Image.Image) -> Image.Image:
    s = max(img.size)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
    return out


def pixelate(img: Image.Image, cells: int, colors: int = 24) -> Image.Image:
    """가로 cells 칸 픽셀아트: 축소(박스 평균) → 팔레트 제한 → 알파는 0/255 로 (경계가 흐려지지 않게)"""
    img = img.convert("RGBA")
    ch = max(1, round(img.height * cells / img.width))
    small = img.resize((cells, ch), Image.BOX)
    alpha = small.getchannel("A").point(lambda a: 255 if a >= 128 else 0)
    rgb = small.convert("RGB").quantize(colors=max(2, min(256, colors)), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def resize(img: Image.Image, w: int, h: int, mode: str = "fit") -> Image.Image:
    if mode == "stretch":
        return img.resize((w, h), Image.LANCZOS)
    small = img.width <= w // 2 or mode == "nearest"  # 픽셀아트 확대는 계단 그대로
    resample = Image.NEAREST if small else Image.LANCZOS
    fitted = ImageOps.contain(img.convert("RGBA"), (w, h), method=resample)
    if fitted.size == (w, h):
        return fitted
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(fitted, ((w - fitted.width) // 2, (h - fitted.height) // 2))
    return out


def tint(img: Image.Image, color: str, amount: float) -> Image.Image:
    img = img.convert("RGBA")
    layer = Image.new("RGBA", img.size, _color(color) + (255,))
    mixed = Image.blend(img, layer, max(0.0, min(1.0, amount)))
    mixed.putalpha(img.getchannel("A"))
    return mixed


def process(req: dict) -> dict:
    images = [load_b64(req["image"])] if req.get("image") else []
    logs = []
    for op in req.get("ops", []):
        name = op.get("op")
        t = time.time()
        if name == "sheet_join":
            parts = [load_b64(x).convert("RGBA") for x in op.get("images", [])] + images
            cols = int(op.get("cols") or len(parts))
            cw, chh = max(p.width for p in parts), max(p.height for p in parts)
            rows = (len(parts) + cols - 1) // cols
            sheet = Image.new("RGBA", (cw * cols, chh * rows), (0, 0, 0, 0))
            for i, p in enumerate(parts):
                sheet.paste(p, ((i % cols) * cw, (i // cols) * chh))
            images = [sheet]
        elif name == "sheet_split":
            cols, rows = int(op.get("cols", 1)), int(op.get("rows", 1))
            out = []
            for img in images:
                cw, chh = img.width // cols, img.height // rows
                out += [img.crop((c * cw, r * chh, (c + 1) * cw, (r + 1) * chh)) for r in range(rows) for c in range(cols)]
            images = out
        else:
            fn = {
                "remove_bg": lambda im: remove_bg(im),
                "trim": trim,
                "pad_square": pad_square,
                "pixelate": lambda im: pixelate(im, int(op.get("cells", 32)), int(op.get("colors", 24))),
                "resize": lambda im: resize(im, int(op["w"]), int(op["h"]), op.get("mode", "fit")),
                "crop": lambda im: im.crop((int(op["x"]), int(op["y"]), int(op["x"]) + int(op["w"]), int(op["y"]) + int(op["h"]))),
                "flip": lambda im: ImageOps.mirror(im) if op.get("axis", "x") == "x" else ImageOps.flip(im),
                "rotate": lambda im: im.convert("RGBA").rotate(-float(op.get("deg", 90)), expand=True),
                "tint": lambda im: tint(im, op.get("color", "#ffffff"), float(op.get("amount", 0.3))),
                "grayscale": lambda im: ImageOps.grayscale(im).convert("RGBA"),
            }.get(name)
            if fn is None:
                raise ValueError(f"알 수 없는 가공: {name}")
            images = [fn(im) for im in images]
        logs.append(f"{name} {time.time() - t:.1f}s")
    return {"images": [b64png(i) for i in images], "sizes": [list(i.size) for i in images], "log": logs}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok", "loaded": _flux is not None, "model": ARGS.model, "pid": os.getpid()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        global _last
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            with _lock:  # GPU 작업은 한 번에 하나
                _last = time.time()
                if self.path == "/generate":
                    res = generate(req)
                elif self.path == "/process":
                    res = process(req)
                elif self.path == "/shutdown":
                    self._send(200, {"ok": True})
                    threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
                    return
                else:
                    return self._send(404, {"error": "not found"})
                _last = time.time()
            self._send(200, res)
        except Exception as exc:  # noqa: BLE001
            log("오류:", repr(exc))
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def idle_watch():
    while True:
        time.sleep(10)
        if not _lock.locked() and time.time() - _last > ARGS.idle:
            log(f"{ARGS.idle}s 동안 요청 없음 → 종료 (메모리 반환)")
            os._exit(0)


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=18093)
    p.add_argument("--model", required=True, help="mflux 4bit FLUX.1-schnell 폴더")
    p.add_argument("--idle", type=int, default=180)
    p.add_argument("--tmp", default="/tmp")
    ARGS = p.parse_args()
    threading.Thread(target=idle_watch, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    log(f"listening 127.0.0.1:{ARGS.port} (model {ARGS.model}, idle {ARGS.idle}s)")
    server.serve_forever()


if __name__ == "__main__":
    main()
