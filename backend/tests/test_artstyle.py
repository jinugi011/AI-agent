"""프로젝트 아트 컨셉: 분석 → 저장 → 생성 프롬프트 적용 → 자기 검사 재생성."""
import base64
import io

import pytest
from fastapi.testclient import TestClient

from app import artstyle, imagegen, llm_client, main

client = TestClient(main.app)
BIBLE = {"concept_ko": "어두운 판타지 16비트 픽셀아트", "style": "16-bit pixel art, dark fantasy, crisp pixels", "palette_words": "deep purple, teal",
         "palette": ["#2a1a4a", "#2bb5a0"], "perspective": "side view", "outline": "thick black outline",
         "sizes": {"character": "32x32", "tile": "16x16"}, "characters": [{"name": "Necro", "look": "hooded necromancer"}], "negative": "blurry, 3d"}


@pytest.fixture(autouse=True)
def tmp_art(tmp_path, monkeypatch):
    monkeypatch.setattr(artstyle, "ART_DIR", tmp_path)


def png() -> str:
    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", (64, 64), "#ff0000").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_compose_and_default_size():
    p = artstyle.compose("hooded necromancer with green staff", "character", BIBLE)
    assert p.startswith("hooded necromancer") and "16-bit pixel art" in p and "deep purple" in p and "side view" in p and "outline" in p
    assert p.endswith("the image clearly shows: hooded necromancer with green staff") and "avoid" not in p
    dark = artstyle.compose("skeleton", "enemy", {**BIBLE, "style": "pixel art, monochromatic, silhouette, 8-bit"})
    assert "monochromatic" not in dark and "silhouette" not in dark and "8-bit" in dark
    assert "seamless tileable" in artstyle.compose("mossy floor", "tile", BIBLE) and "outline" not in artstyle.compose("mossy floor", "tile", BIBLE)
    assert artstyle.default_size("enemy", BIBLE) == "32x32" and artstyle.default_size("tile", BIBLE) == "16x16"
    assert artstyle.default_size("background", BIBLE) is None


def test_analyze_saves_and_context_includes_art(monkeypatch):
    class R: text = '{"concept_ko":"밝은 카툰","style":"cartoon, flat colors","palette_words":"pastel","sizes":{"character":"64x64"}}'
    seen = {}
    monkeypatch.setattr(llm_client, "chat", lambda msgs, **k: (seen.setdefault("msgs", msgs), R())[1])
    r = client.post("/api/art/analyze", json={"project": "shop", "docs": {"README.md": "귀여운 쇼핑 게임"}, "user_concept": "파스텔 톤 카툰"})
    assert r.status_code == 200, r.text
    assert "USER CONCEPT" in seen["msgs"][1]["content"] and "README.md" in seen["msgs"][1]["content"]
    assert client.get("/api/art/shop").json()["art"]["style"] == "cartoon, flat colors"
    ctx = client.post("/api/context", json={"query": "hi", "attachment_project": "shop"}).json()
    assert "밝은 카툰" in ctx["art"]


def test_revise(monkeypatch):
    artstyle.save("g", BIBLE)
    class R: text = '{"style":"16-bit pixel art, darker","palette_words":"black, purple"}'
    monkeypatch.setattr(llm_client, "chat", lambda *a, **k: R())
    r = client.put("/api/art/g", json={"instruction": "더 어둡게"})
    assert r.status_code == 200 and r.json()["art"]["palette_words"] == "black, purple"


def test_generate_applies_art_and_regenerates_on_low_score(monkeypatch):
    artstyle.save("game", BIBLE)
    calls = []
    monkeypatch.setattr(imagegen, "engine_sleep", lambda: None)
    monkeypatch.setattr(imagegen, "ensure_worker", lambda: None)

    def worker(path, body, timeout=900):
        calls.append((path, body))
        if path == "/generate":
            return {"image": png(), "seed": 1}
        return {"images": [png()], "sizes": [[32, 32]]}
    monkeypatch.setattr(imagegen, "_worker", worker)
    scores = iter([{"score": 3, "problems": "not pixel art"}, {"score": 8, "problems": ""}])
    monkeypatch.setattr(artstyle, "verify", lambda *a, **k: next(scores))
    r = client.post("/api/images/generate", json={"prompt": "hooded necromancer", "project": "game", "kind": "character"})
    assert r.status_code == 200, r.text
    body = r.json()
    gens = [b for p, b in calls if p == "/generate"]
    assert len(gens) == 2 and "16-bit pixel art" in gens[0]["prompt"] and "must fix: not pixel art" in gens[1]["prompt"]
    assert body["verify"]["scores"] == [3, 8] and body["art"] is True
    ops = [o["op"] for o in next(b for p, b in calls if p == "/process")["ops"]]
    assert ops[:2] == ["remove_bg", "trim"] and "pixelate" in ops  # 캐릭터 → 투명 · 픽셀아트 컨셉 → 32칸
