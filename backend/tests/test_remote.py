"""원격(Cloudflare Tunnel) 접근 보안 + 원격 프로젝트 색인 테스트."""
import json
import time

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import remote, security
from app.config import settings
from app.vector_store import CodeVectorStore

from test_coding_agent import fake_embed

TOKEN = "la_test_token_123"
CF = {"cf-connecting-ip": "203.0.113.7", "cf-ray": "abc123"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_API_TOKEN", TOKEN)
    monkeypatch.setattr(security, "ACCESS_LOG", tmp_path / "access.log")
    monkeypatch.setattr(remote, "REGISTRY", tmp_path / "remote_projects.json")
    monkeypatch.setattr(settings, "vector_backend", "memory")
    monkeypatch.setattr(CodeVectorStore, "embed", fake_embed)
    monkeypatch.setattr(main, "vector_store", CodeVectorStore())
    return TestClient(main.app)


def auth(token=TOKEN):
    return {**CF, "Authorization": f"Bearer {token}"}


def test_local_requests_need_no_token(client):
    assert client.get("/api/agent/jobs").status_code == 200


def test_remote_requires_valid_token(client, tmp_path):
    assert client.get("/api/health", headers=CF).status_code == 401
    assert client.get("/api/health", headers=auth("wrong")).status_code == 401
    assert client.get("/api/health", headers=auth()).status_code == 200
    log = [json.loads(l) for l in (tmp_path / "access.log").read_text().splitlines()]
    assert [e["status"] for e in log] == [401, 401, 200]
    assert log[0]["ip"] == "203.0.113.7"


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/repos/connect"),
    ("POST", "/api/agent/run"),
    ("POST", "/api/engine/start"),
    ("POST", "/api/models/download"),
    ("POST", "/api/repos/x/harness/run"),
    ("GET", "/docs"),
    ("GET", "/openapi.json"),
])
def test_remote_blocks_server_side_execution(client, method, path):
    r = client.request(method, path, headers=auth(), json={})
    assert r.status_code == 403, (path, r.text)


def test_remote_index_then_context(client):
    files = [
        {"path": "requirements.txt", "content": "fastapi\n"},
        {"path": "shop/cart.py", "content": "def add_item(sku: str) -> None:\n    return None\n"},
        {"path": "../escape.py", "content": "x = 1\n"},          # 경로 조작 → 무시
        {"path": "/etc/passwd.py", "content": "x = 1\n"},        # 절대 경로 → 무시
    ]
    r = client.post("/api/remote/index", headers=auth(), json={"project": "My Shop", "files": files})
    assert r.status_code == 200, r.text
    rec = r.json()["project"]
    assert rec["name"] == "my-shop" and rec["profile"] == "python-fastapi" and rec["files"] == 2

    for _ in range(50):
        if remote.get_project("my-shop")["status"] != "indexing":
            break
        time.sleep(0.1)
    assert remote.get_project("my-shop")["status"] == "ready"

    ctx = client.post("/api/context", headers=auth(), json={"query": "cart", "project": "my-shop"}).json()
    assert ctx["repo"]["remote"] is True and ctx["repo"]["profile"] == "python-fastapi"
    assert "코딩 방법" in ctx["methods"]
    assert any(h["source"] == "shop/cart.py" for h in ctx["hits"])
    assert all(h["source"] != "../escape.py" for h in ctx["hits"])


def test_llm_stream_reports_engine_error_as_done(client, monkeypatch):
    monkeypatch.setattr(settings, "engine_url", "http://127.0.0.1:9")  # 닫힌 포트
    r = client.post("/api/llm/generate", headers=auth(), json={"messages": [{"role": "user", "content": "hi"}]})
    lines = [json.loads(l) for l in r.text.splitlines() if l]
    assert lines[0] == {"ping": 1}
    assert lines[-1]["done"] is True and "엔진 연결 실패" in lines[-1]["error"]


def test_tailscale_serve_requests_are_remote(client, tmp_path):
    ts = {"tailscale-user-login": "me@example.com", "x-forwarded-for": "100.101.102.103"}
    assert client.get("/api/health", headers=ts).status_code == 401
    assert client.get("/api/health", headers={**ts, "Authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert client.post("/api/agent/run", headers={**ts, "Authorization": f"Bearer {TOKEN}"}, json={}).status_code == 403
    last = json.loads((tmp_path / "access.log").read_text().splitlines()[-1])
    assert last["via"] == "tailscale" and last["user"] == "me@example.com" and last["ip"] == "100.101.102.103"
