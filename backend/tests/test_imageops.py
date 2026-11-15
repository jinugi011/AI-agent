"""이미지 스튜디오: 나누기·가공·ZIP."""
import base64
import io
import zipfile

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app import imagegen, imageops, main

client = TestClient(main.app)


def b64(img: Image.Image) -> str:
    buf = io.BytesIO(); img.save(buf, format="PNG"); return base64.b64encode(buf.getvalue()).decode()


def sheet_white() -> Image.Image:
    """흰 배경에 들쭉날쭉 놓인 그림 4개 (하나는 눈 두 개가 떨어져 있는 얼굴)"""
    im = Image.new("RGB", (400, 300), "#ffffff")
    d = ImageDraw.Draw(im)
    d.rectangle([20, 20, 80, 90], fill="#ff0000")            # 1 (위 왼쪽)
    d.ellipse([150, 30, 230, 110], fill="#00aa00")           # 2 (위 가운데)
    d.ellipse([290, 15, 380, 105], fill="#ffcc00")           # 3 (위 오른쪽 얼굴)
    d.ellipse([315, 45, 325, 55], fill="#ffffff")            #   얼굴 안 흰 눈 (투명해지면 안 됨)
    d.rectangle([60, 180, 200, 260], fill="#0000ff")          # 4 (아래)
    d.rectangle([5, 290, 7, 292], fill="#000000")             # 잡티 (최소 크기 미만 → 버림)
    return im


def test_split_auto_white_background_reading_order_and_transparency():
    r = client.post("/api/images/split", json={"image": b64(sheet_white()), "mode": "auto", "padding": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["background"] == "#ffffff"
    boxes = [p["box"] for p in body["pieces"]]
    assert len(boxes) == 4
    assert [b[0] < 300 for b in boxes[:3]] and boxes[0][0] == 20 and boxes[1][0] == 150 and boxes[2][0] == 290 and boxes[3][1] == 180
    face = imageops.load(body["pieces"][2]["image"])
    assert face.getpixel((0, 0))[3] == 0                       # 바깥 흰 배경 → 투명
    assert face.getpixel((320 - 290, 50 - 15))[3] == 255       # 얼굴 안 흰 눈은 그대로


def test_split_auto_transparent_png_merges_close_parts():
    im = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([10, 10, 40, 40], fill="#ff0000")
    d.rectangle([44, 10, 60, 40], fill="#ff0000")   # 4px 떨어진 조각 → gap 6 이면 하나
    d.rectangle([120, 20, 180, 80], fill="#00ff00")
    r = client.post("/api/images/split", json={"image": b64(im), "gap": 6, "padding": 0}).json()
    assert r["background"] == "transparent" and [p["box"] for p in r["pieces"]] == [[10, 10, 51, 31], [120, 20, 61, 61]]
    r2 = client.post("/api/images/split", json={"image": b64(im), "gap": 0, "padding": 0}).json()
    assert len(r2["pieces"]) == 3


def test_split_grid_skips_empty_cells():
    im = Image.new("RGBA", (128, 64), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle([4, 4, 20, 20], fill="#ff0000")
    ImageDraw.Draw(im).rectangle([100, 40, 120, 60], fill="#00ff00")
    r = client.post("/api/images/split", json={"image": b64(im), "mode": "grid", "cols": 4, "rows": 2}).json()
    assert [p["cell"] for p in r["pieces"]] == [[0, 0], [3, 1]] and r["pieces"][0]["size"] == [32, 32]
    all8 = client.post("/api/images/split", json={"image": b64(im), "mode": "grid", "cols": 4, "rows": 2, "skip_empty": False}).json()
    assert len(all8["pieces"]) == 8


def test_edit_ops_chain():
    im = Image.new("RGBA", (100, 60), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle([30, 10, 69, 49], fill="#336699")
    ops = [{"op": "trim"}, {"op": "pad_square", "margin": 2}, {"op": "pixelate", "cells": 8}, {"op": "resize", "w": 64, "h": 64, "mode": "nearest"},
           {"op": "flip", "axis": "x"}, {"op": "outline", "color": "#000000", "width": 1}, {"op": "brightness", "amount": 1.1}]
    r = client.post("/api/images/edit", json={"image": b64(im), "ops": ops})
    assert r.status_code == 200, r.text
    assert r.json()["size"] == [64, 64]
    bad = client.post("/api/images/edit", json={"image": b64(im), "ops": [{"op": "explode"}]})
    assert bad.status_code == 422


def test_edit_remove_bg_uses_worker(monkeypatch):
    called = []
    monkeypatch.setattr(imagegen, "remove_bg_image", lambda img: (called.append(1), img)[1])
    r = client.post("/api/images/edit", json={"image": b64(sheet_white()), "ops": [{"op": "remove_bg"}, {"op": "trim"}]})
    assert r.status_code == 200 and called


def test_edit_instruction_goes_through_llm(monkeypatch):
    from app import llm_client

    class R: text = '[{"op":"flip","axis":"x"},{"op":"resize","w":32,"h":32}]'
    monkeypatch.setattr(llm_client, "chat", lambda *a, **k: R())
    r = client.post("/api/images/edit", json={"image": b64(sheet_white()), "instruction": "좌우 반전하고 32픽셀로"})
    assert r.status_code == 200 and r.json()["size"] == [32, 32] and r.json()["ops"][0]["op"] == "flip"


def test_zip():
    im = b64(Image.new("RGBA", (4, 4), (255, 0, 0, 255)))
    r = client.post("/api/images/zip", json={"files": [{"name": "hero", "data": im}, {"name": "hero", "data": im}, {"name": "../x.png", "data": im}]})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert names == ["hero.png", "hero_1.png", "..x.png"] and all("/" not in n for n in names)


def test_edit_instruction_accepts_shorthand(monkeypatch):
    from app import llm_client

    class R: text = '["remove_bg", "pixelate{cells:8}", "resize{w:16,h:16,mode=nearest}", "flip{axis=x}"]'
    monkeypatch.setattr(llm_client, "chat", lambda *a, **k: R())
    monkeypatch.setattr(imagegen, "remove_bg_image", lambda img: img)
    r = client.post("/api/images/edit", json={"image": b64(sheet_white()), "instruction": "배경 지우고 픽셀아트"})
    assert r.status_code == 200, r.text
    assert r.json()["ops"][1] == {"op": "pixelate", "cells": 8} and r.json()["ops"][2]["mode"] == "nearest" and r.json()["size"] == [16, 16]
