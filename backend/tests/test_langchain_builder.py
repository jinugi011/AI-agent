import time
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app import langchain_builder as lc


class Store:
    def __init__(self):
        self.calls = []

    def search(self, query, **kwargs):
        self.calls.append((query, kwargs))
        return [{"source": "src/orders.py", "content": "def cancel_order(): pass"}]


def test_real_chain_retrieves_only_selected_project_and_reviews(monkeypatch):
    calls, events, store = [], [], Store()

    def chat(messages, **kwargs):
        calls.append((messages, kwargs))
        return lc.llm_client.LLMResult(text="초안" if len(calls) == 1 else "검토된 구현 명세", backend="fake")

    monkeypatch.setattr(lc.llm_client, "chat", chat)
    result = lc.execute(lc.ChainRequest(goal="주문 취소", project="shop", retrieval=True), store,
                        lambda *args: events.append(args))
    assert result["output"] == "검토된 구현 명세"
    assert store.calls == [("주문 취소", {"project": "shop", "top_k": 4, "kind": "code"})]
    assert "src/orders.py" in calls[0][0][1]["content"]
    assert "초안" in calls[1][0][1]["content"]
    assert [e[0] for e in events] == ["context", "generate", "review"]


def test_no_retrieval_or_review_and_literal_prompt_braces(monkeypatch):
    def chat(messages, **kwargs):
        assert messages[0]["content"] == 'JSON 예: {"key": "value"}'
        return lc.llm_client.LLMResult(text="명세", backend="fake", finish_reason="length")

    monkeypatch.setattr(lc.llm_client, "chat", chat)
    store = Store()
    result = lc.execute(lc.ChainRequest(goal="기능 구현", review=False, system_prompt='JSON 예: {"key": "value"}'), store, lambda *a: None)
    assert not store.calls
    assert len(result["stats"]) == 1
    assert result["warnings"]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(lc.remote, "list_projects", lambda: {"remote-shop": {}})
    app = FastAPI()
    app.include_router(lc.create_router(Store(), SimpleNamespace(list=lambda: [SimpleNamespace(name="local-shop")])))
    return TestClient(app)


def wait_job(client, job_id):
    for _ in range(200):
        response = client.get(f"/api/langchain/runs/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"done", "error"}:
            return job
        time.sleep(.01)
    pytest.fail("background workflow did not finish")


def test_run_api_records_result_and_model_failure(client, monkeypatch):
    monkeypatch.setattr(lc.llm_client, "chat", lambda *a, **k: lc.llm_client.LLMResult(text="실제 체인 결과", backend="fake"))
    response = client.post("/api/langchain/runs", json={"goal": "검색 기능"})
    assert response.status_code == 202
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "done" and job["result"]["output"] == "실제 체인 결과"
    assert job["config"]["goal"] == "검색 기능"

    def failure(*args, **kwargs):
        raise lc.llm_client.LLMError("엔진 오프라인")

    monkeypatch.setattr(lc.llm_client, "chat", failure)
    response = client.post("/api/langchain/runs", json={"goal": "로그인 기능"})
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "error" and "엔진 오프라인" in job["error"]


@pytest.mark.parametrize("payload", [{"goal": " "}, {"goal": "test", "retrieval": True},
    {"goal": "test", "top_k": 99}, {"goal": "test", "system_prompt": " "},
    {"goal": "test", "max_tokens": 999999}, {"goal": "test", "temperature": -1}])
def test_api_validates_configuration(client, payload):
    assert client.post("/api/langchain/runs", json=payload).status_code == 422


def test_status_missing_runtime_and_unknown_job(client, monkeypatch):
    assert client.get("/api/langchain/status").json()["projects"] == ["local-shop", "remote-shop"]
    monkeypatch.setattr(lc, "runtime_version", lambda: None)
    assert client.get("/api/langchain/status").json()["available"] is False
    assert client.post("/api/langchain/runs", json={"goal": "test"}).status_code == 503
    assert client.get("/api/langchain/runs/unknown").status_code == 404


def test_remote_allowlist_does_not_grant_execution():
    from app import security
    assert security.remote_allowed("POST", "/api/langchain/runs")
    assert security.remote_allowed("GET", "/api/langchain/runs/" + "a" * 32)
    assert not security.remote_allowed("POST", "/api/agent/run")


def test_semantic_harness_preserves_acceptance_criteria(monkeypatch):
    seen = []
    def chat(messages, **kwargs):
        seen.append(messages)
        return lc.llm_client.LLMResult(text="- [ ] R1 본인 주문 취소\nGiven 본인 주문 When 취소 Then 재고 복구", backend="fake")
    monkeypatch.setattr(lc.llm_client, "chat", chat)
    lc.execute(lc.ChainRequest(goal="주문 취소", acceptance_criteria="배송 중 취소 불가\n재고는 한 번만 복구", mode="harness"), Store(), lambda *a: None)
    assert len(seen) == 2
    for messages in seen:
        assert "Given/When/Then" in messages[0]["content"]
        assert "배송 중 취소 불가\n재고는 한 번만 복구" in messages[1]["content"]
