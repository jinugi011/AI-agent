from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.remote_tasks import create_router


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(create_router())
    return TestClient(app)


def register(client, agent_id="a" * 32, key="k" * 64, workspace="C:/work/shop"):
    response = client.post("/api/remote/work/agents", json={"id": agent_id, "key": key,
        "project": "shop", "workspace": workspace, "label": "VS Code · remote-pc", "protocol_version": 2})
    assert response.status_code == 200, response.text


def test_delivery_is_bound_to_selected_ide_and_claimed_once(client):
    register(client)
    register(client, "b" * 32, "z" * 64, "C:/other/shop")
    agents = client.get("/api/remote/work/agents").json()["agents"]
    assert agents[0]["online"] and "key" not in agents[0] and "key_hash" not in agents[0]
    submitted = client.post("/api/remote/work/tasks", json={"agent_id": "a" * 32, "task": "주문 취소. 본인 주문만 가능", "mode": "harness"})
    assert submitted.status_code == 202
    task_id = submitted.json()["id"]
    claim = lambda agent, key: client.post(f"/api/remote/work/agents/{agent}/claim", json={"key": key})
    assert claim("a" * 32, "wrong" * 10).status_code == 403
    assert claim("b" * 32, "z" * 64).json()["task"] is None
    claimed = claim("a" * 32, "k" * 64).json()["task"]
    assert claimed["id"] == task_id
    lease = {"lease_token": claimed["lease_token"]}
    assert claim("a" * 32, "k" * 64).json()["task"] is None
    path = f"/api/remote/work/tasks/{task_id}"
    assert client.post(path, json={**lease, "key": "z" * 64, "status": "running"}).status_code == 403
    assert client.post(path, json={**lease, "key": "k" * 64, "status": "running"}).status_code == 200
    assert client.post(path, json={**lease, "key": "k" * 64, "status": "completed", "detail": "응답 종료"}).status_code == 200
    assert client.get(path).json()["status"] == "completed"
    assert "lease_token" not in client.get(path).json()
    assert client.post(path, json={**lease, "key": "k" * 64, "status": "running"}).status_code == 409


def test_unknown_ide_blank_input_and_session_replacement_rejected(client):
    assert client.post("/api/remote/work/tasks", json={"agent_id": "a" * 32, "task": "기능"}).status_code == 409
    register(client)
    assert client.post("/api/remote/work/tasks", json={"agent_id": "a" * 32, "task": " "}).status_code == 422
    assert client.post("/api/remote/work/agents", json={"id": "a" * 32, "key": "x" * 64,
        "project": "shop", "workspace": "elsewhere", "label": "spoofed"}).status_code == 403
    assert client.post("/api/remote/work/agents", json={"id": "a" * 32, "key": "k" * 64,
        "project": "shop", "workspace": "elsewhere", "label": "moved"}).status_code == 409


def test_task_requires_explicit_claim_before_running_and_can_be_rejected(client):
    register(client)
    job = client.post("/api/remote/work/tasks", json={"agent_id": "a" * 32, "task": "테스트 먼저 작성"}).json()
    path = f"/api/remote/work/tasks/{job['id']}"
    assert client.post(path, json={"key": "k" * 64, "lease_token": "0" * 32, "status": "running"}).status_code == 409
    claimed = client.post("/api/remote/work/agents/" + "a" * 32 + "/claim", json={"key": "k" * 64}).json()["task"]
    assert client.post(path, json={"key": "k" * 64, "lease_token": claimed["lease_token"], "status": "rejected"}).status_code == 200


def test_offline_ide_cannot_receive_new_work(client, monkeypatch):
    from app import remote_tasks
    now = remote_tasks.time.time()
    register(client)
    monkeypatch.setattr(remote_tasks.time, "time", lambda: now + 61)
    assert not client.get("/api/remote/work/agents").json()["agents"][0]["online"]
    assert client.post("/api/remote/work/tasks", json={"agent_id": "a" * 32, "task": "기능"}).status_code == 409
