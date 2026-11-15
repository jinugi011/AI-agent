"""이미지 생성 오케스트레이션 테스트 (작업 프로세스·엔진·검색은 가짜)."""
import base64
import io

import pytest
from fastapi.testclient import TestClient

from app import imagegen, main


def png(color="#ff0000", size=(64, 64)) -> str:
    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", size, color).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture()
def calls(monkeypatch):
    log = []
    monkeypatch.setattr(imagegen, "engine_sleep", lambda: log.append(("sleep",)))
    monkeypatch.setattr(imagegen, "ensure_worker", lambda: log.append(("worker",)))
    monkeypatch.setattr(imagegen, "style_of", lambda b: (log.append(("style",)), "pixel art, flat colors")[1])

    def worker(path, body, timeout=900):
        log.append((path, body))
        if path == "/generate":
            return {"image": png(), "seconds": 1}
        n = 4 if any(o["op"] == "sheet_split" for o in body["ops"]) else 1
        return {"images": [png()] * n, "sizes": [[32, 32]] * n, "log": []}

    monkeypatch.setattr(imagegen, "_worker", worker)
    return log


def test_parse_ops():
    ops = imagegen.parse_ops("flip-x; tint #ff8800 0.4; crop 0,0,32,16; resize 128x64 nearest; remove-bg; pixelate 32 16; sheet-split 4x1")
    assert ops[0] == {"op": "flip", "axis": "x"}
    assert ops[1] == {"op": "tint", "color": "#ff8800", "amount": 0.4}
    assert ops[2] == {"op": "crop", "x": 0, "y": 0, "w": 32, "h": 16}
    assert ops[3] == {"op": "resize", "w": 128, "h": 64, "mode": "nearest"}
    assert ops[4:6] == [{"op": "remove_bg"}, {"op": "trim"}]
    assert ops[6] == {"op": "pixelate", "cells": 32, "colors": 16}
    assert ops[7] == {"op": "sheet_split", "cols": 4, "rows": 1}
    with pytest.raises(imagegen.ImageGenError):
        imagegen.parse_ops("explode")


def test_gen_size():
    assert imagegen._gen_size(64, 64) == (512, 512)
    assert imagegen._gen_size(1920, 1080) == (1024, 576)
    assert imagegen._gen_size(32, 128) == (256, 512)


def test_generate_sprite_sleeps_engine_then_generates_and_processes(calls):
    c = TestClient(main.app)
    r = c.post("/api/images/generate", json={"prompt": "pixel art knight", "width": 64, "height": 64, "transparent": True, "pixel": 32})
    assert r.status_code == 200, r.text
    names = [x[0] for x in calls]
    assert names.index("sleep") < names.index("/generate") < names.index("/process")  # 모델을 내린 뒤 생성
    gen = next(x[1] for x in calls if x[0] == "/generate")
    assert (gen["width"], gen["height"]) == (512, 512) and "white background" in gen["prompt"]
    proc = [o["op"] for o in next(x[1] for x in calls if x[0] == "/process")["ops"]]
    assert proc[:2] == ["remove_bg", "trim"] and "pixelate" in proc and proc[-1] == "resize"


def test_korean_prompt_rejected_before_any_model_work(calls):
    r = TestClient(main.app).post("/api/images/generate", json={"prompt": "귀여운 기사", "width": 64, "height": 64})
    assert r.status_code == 422 and "영어" in r.json()["detail"] and calls == []


def test_ref_search_adds_style_and_credits(calls, monkeypatch):
    monkeypatch.setattr(imagegen, "search_refs", lambda q, n=3: [{"title": "Knight", "creator": "anon", "license": "CC0", "license_url": "u",
                                                                  "source": "https://example.org/k", "thumbnail": "t", "url": "u"}])
    monkeypatch.setattr(imagegen, "_download", lambda url, limit=0: base64.b64decode(png()))
    r = TestClient(main.app).post("/api/images/generate", json={"prompt": "a slime monster", "ref_search": "pixel knight", "width": 512, "height": 512})
    body = r.json()
    assert r.status_code == 200 and body["credits"][0]["license"] == "CC0" and "pixel art" in body["prompt_used"]


def test_process_only_split_sheet(calls):
    r = TestClient(main.app).post("/api/images/generate", json={"source": png(size=(128, 32)), "ops": "sheet-split 4x1"})
    assert r.status_code == 200 and len(r.json()["images"]) == 4
    assert not any(x[0] == "/generate" for x in calls)
