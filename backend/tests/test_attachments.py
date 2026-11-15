"""첨부 파일 업로드·분석 테스트 (비전 모델은 가짜로 대체)."""
import base64
import io

import pytest
from fastapi.testclient import TestClient

from app import attachments, main


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(attachments, "ATT_DIR", tmp_path)
    calls = []

    def fake_vision(png, prompt="", max_tokens=2048):
        if prompt == attachments.CLASSIFY_PROMPT:
            return {"text": "UI"}
        calls.append(png)
        return {"text": "로그인 화면: 이메일 입력창, 비밀번호 입력창, 파란 로그인 버튼(#2563eb)", "model_name": "fake-vl",
                "image_width": 100, "image_height": 50}

    monkeypatch.setattr(attachments, "vision", fake_vision)
    unloads = []
    monkeypatch.setattr(attachments, "schedule_vision_unload", lambda delay=0: unloads.append(delay))
    c = TestClient(main.app)
    c.unloads = unloads
    c.vision_calls = calls
    return c


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def png_bytes(w=3200, h=1800, mode="RGBA") -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new(mode, (w, h), (255, 0, 0, 128) if mode == "RGBA" else (255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def pdf_bytes(text_pages=1, blank_pages=1) -> bytes:
    """글자 페이지 + 빈(스캔본 같은) 페이지로 된 최소 PDF 를 직접 만든다."""
    msg = "API spec: GET /users returns a list of users with id, name, email fields."
    stream = f"BT /F1 12 Tf 50 700 Td ({msg}) Tj ET".encode()
    n = text_pages + blank_pages
    objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>",
            3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            4: b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            5: b"<< /Length 0 >>\nstream\n\nendstream"}
    kids = []
    for i in range(n):
        num = 6 + i
        content = 4 if i < text_pages else 5
        objs[num] = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                     b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % content)
        kids.append(b"%d 0 R" % num)
    objs[2] = b"<< /Type /Pages /Kids [" + b" ".join(kids) + b"] /Count %d >>" % n
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for k in sorted(objs):
        offsets[k] = len(out)
        out += b"%d 0 obj\n" % k + objs[k] + b"\nendobj\n"
    xref = len(out)
    size = max(objs) + 1
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for k in range(1, size):
        out += b"%010d 00000 n \n" % offsets[k]
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)
    return bytes(out)


def test_markdown_upload_and_get(client):
    md = "# 요구사항\n\n- 회원가입 API\n- JWT 로그인\n".encode()
    r = client.post("/api/attachments", json={"name": "spec.md", "data": b64(md), "project": "shop"})
    assert r.status_code == 200, r.text
    att = r.json()["attachment"]
    assert att["kind"] == "text" and "JWT 로그인" in att["content"] and att["project"] == "shop"
    assert client.get(f"/api/attachments/{att['id']}").json()["attachment"]["name"] == "spec.md"
    assert [a["id"] for a in client.get("/api/attachments?project=shop").json()["attachments"]] == [att["id"]]
    assert client.get("/api/attachments?project=other").json()["attachments"] == []
    assert not client.vision_calls and not client.unloads  # 텍스트는 비전 모델을 쓰지 않음


def test_image_goes_to_vision_and_is_downscaled(client):
    from PIL import Image
    r = client.post("/api/attachments", json={"name": "login.png", "data": b64(png_bytes()), "project": "shop"})
    assert r.status_code == 200, r.text
    att = r.json()["attachment"]
    assert att["kind"] == "image" and "로그인 버튼" in att["content"]
    assert "실제 색상" in att["content"] and "`#" in att["content"]  # 픽셀에서 뽑은 색상표
    assert client.unloads  # 분석 후 비전 모델을 내리도록 예약 (코딩 모델 속도 보호)
    sent = Image.open(io.BytesIO(client.vision_calls[0]))
    assert max(sent.size) == attachments.MAX_IMAGE_SIDE and sent.mode == "RGB"


def test_pdf_text_pages_extracted_and_blank_pages_use_vision(client):
    r = client.post("/api/attachments", json={"name": "api.pdf", "data": b64(pdf_bytes(1, 1)), "project": "shop"})
    assert r.status_code == 200, r.text
    att = r.json()["attachment"]
    assert att["kind"] == "pdf" and att["pages"] == 2 and att["vision_pages"] == 1
    assert "GET /users" in att["content"] and "2쪽 (이미지 분석)" in att["content"]
    assert len(client.vision_calls) == 1


def test_rejects_unknown_binary_and_bad_ids(client):
    r = client.post("/api/attachments", json={"name": "x.bin", "data": b64(b"\x00\xff\xfe" * 100)})
    assert r.status_code == 422
    assert client.get("/api/attachments/../../etc").status_code == 404
    assert client.get("/api/attachments/zzzzzzzzzzzz").status_code == 404


def test_delete(client):
    att = client.post("/api/attachments", json={"name": "a.md", "data": b64(b"hello")}).json()["attachment"]
    assert client.delete(f"/api/attachments/{att['id']}").status_code == 200
    assert client.get(f"/api/attachments/{att['id']}").status_code == 404


def test_vision_unavailable_reports_clear_error(client, monkeypatch):
    def broken(png, prompt="", max_tokens=2048):
        raise attachments.AttachmentError("이미지 분석 실패: 엔진에 연결할 수 없습니다")
    monkeypatch.setattr(attachments, "vision", broken)
    r = client.post("/api/attachments", json={"name": "a.png", "data": b64(png_bytes(10, 10, "RGB"))})
    assert r.status_code == 422 and "이미지 분석 실패" in r.json()["detail"]


def test_classify_labels():
    assert attachments.classify("다이어그램") == "diagram"
    assert attachments.classify(" 오류 ") == "error"
    assert attachments.classify("문서") == "doc"
    assert attachments.classify("UI") == "ui" and attachments.classify("모르겠음") == "ui"


def test_palette_finds_dominant_colors():
    from PIL import Image
    im = Image.new("RGB", (100, 100), "#1e3a8a")
    im.paste(Image.new("RGB", (100, 20), "#ffffff"), (0, 0))
    buf = io.BytesIO(); im.save(buf, format="PNG")
    cols = attachments.palette(buf.getvalue())
    assert cols[0]["hex"] == "#1e3a8a" and cols[0]["percent"] > 70
    assert any(c["hex"] == "#ffffff" for c in cols)


def test_inspect_blank_screen_detected_without_trusting_model(client):
    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", (800, 600), "#000000").save(buf, format="PNG")
    r = client.post("/api/vision/inspect", json={"image": b64(buf.getvalue()), "expect": "플레이어"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["blank"] is True and "한 가지 색" in body["text"] and client.unloads


def test_inspect_normal_screen(client):
    r = client.post("/api/vision/inspect", json={"image": b64(png_bytes(400, 300, "RGB"))})
    assert r.status_code == 200 and "로그인" in r.json()["text"]
