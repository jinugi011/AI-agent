"""Authenticated handoff to an explicitly selected IDE; never executes server commands."""
from copy import deepcopy
import hashlib
import hmac
import threading
import time
from typing import Literal
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

LEASE_SECONDS = 90
TERMINAL = {"completed", "rejected", "failed", "cancelled"}


class Registration(BaseModel):
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    key: str = Field(min_length=32, max_length=128)
    project: str = Field(min_length=1, max_length=200)
    workspace: str = Field(min_length=1, max_length=2000)
    label: str = Field(min_length=1, max_length=200)
    protocol_version: int = Field(default=1, ge=1, le=2)


class ClientKey(BaseModel):
    key: str = Field(min_length=32, max_length=128)


class TaskRequest(BaseModel):
    agent_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    task: str = Field(min_length=1, max_length=50000)
    mode: Literal["implementation", "harness"] = "harness"

    @field_validator("task")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("요구사항을 입력하세요")
        return value.strip()


class ExecutionKey(ClientKey):
    lease_token: str = Field(pattern=r"^[0-9a-f]{32}$")


class TaskUpdate(ExecutionKey):
    status: Literal["running", "completed", "rejected", "failed", "cancelled"]
    detail: str = Field(default="", max_length=2000)


class TaskControl(BaseModel):
    attempt: int = Field(ge=0)
    previous_execution_stopped: bool = False


class ResumeRequest(TaskControl):
    agent_id: str = Field(pattern=r"^[0-9a-f]{32}$")


def create_router():
    router = APIRouter(prefix="/api/remote/work", tags=["remote-work"])
    agents, tasks, lock = {}, {}, threading.Lock()

    def digest(key):
        return hashlib.sha256(key.encode()).hexdigest()

    def authorize(agent_id, key):
        agent = agents.get(agent_id)
        if not agent or not hmac.compare_digest(agent["key_hash"], digest(key)):
            raise HTTPException(403, "다른 IDE 세션의 작업을 가져올 수 없습니다")
        return agent

    def public(task):
        return deepcopy({k: v for k, v in task.items() if k != "lease_token"})

    def get(task_id):
        if task_id not in tasks:
            raise HTTPException(404, "작업 기록이 없습니다. 서버 재시작 시 초기화됩니다.")
        return tasks[task_id]

    def expire():
        now = time.time()
        for task in tasks.values():
            state = task["status"]
            if state in {"offered", "running", "cancel_requested"}:
                stale = now - task["last_response_at"] >= LEASE_SECONDS
            elif state == "pending":
                stale = now - agents.get(task["agent_id"], {}).get("last_seen", 0) >= LEASE_SECONDS
            else:
                continue
            if stale:
                task.update(status="disconnected", previous_status=state, disconnected_at=now, updated_at=now,
                            detail="90초 이상 작업 응답이 없습니다. 자동 재실행하지 않습니다. 이전 실행을 중단·확인한 뒤 재개하거나 취소하세요.")

    def execution(task_id, data):
        task = get(task_id)
        authorize(task["agent_id"], data.key)
        if not hmac.compare_digest(task.get("lease_token", ""), data.lease_token):
            raise HTTPException(409, "이전 실행 회차입니다. 현재 작업을 갱신하거나 다시 실행할 수 없습니다.")
        return task

    def online_agent(agent_id):
        agent = agents.get(agent_id)
        if not agent or time.time() - agent["last_seen"] >= 60:
            raise HTTPException(409, "대상 IDE가 오프라인입니다. 원격 PC에서 프로젝트와 Yang Coding을 여세요.")
        if agent["protocol_version"] < 2:
            raise HTTPException(409, "연결 복구를 지원하는 최신 IDE 플러그인이 필요합니다.")
        return agent

    @router.post("/agents")
    def register(data: Registration):
        with lock:
            expire()
            if data.id in agents:
                old = authorize(data.id, data.key)
                if (old["project"], old["workspace"]) != (data.project, data.workspace):
                    raise HTTPException(409, "IDE 세션의 대상 프로젝트가 변경되었습니다")
            # Expire disconnected clients; pending work is not reassigned to another PC.
            for key in list(agents):
                if time.time() - agents[key]["last_seen"] > 86400:
                    del agents[key]
            if len(agents) >= 100 and data.id not in agents:
                raise HTTPException(429, "등록된 IDE가 너무 많습니다")
            agents[data.id] = {**data.model_dump(exclude={"key"}), "key_hash": digest(data.key), "last_seen": time.time()}
        return {"id": data.id}

    @router.get("/agents")
    def list_agents():
        with lock:
            expire()
            return {"agents": [{**{k: v for k, v in a.items() if k != "key_hash"}, "online": time.time() - a["last_seen"] < 60}
                               for a in agents.values()]}

    @router.post("/tasks", status_code=202)
    def submit(data: TaskRequest):
        with lock:
            expire()
            agent = online_agent(data.agent_id)
            for key in list(tasks):
                if len(tasks) < 100:
                    break
                if tasks[key]["status"] in TERMINAL and tasks[key]["stopped_confirmed"]:
                    del tasks[key]
            if len(tasks) >= 100:
                raise HTTPException(429, "작업 대기열이 가득 찼습니다")
            job = {"id": uuid.uuid4().hex, **data.model_dump(), "status": "pending", "detail": "원격 IDE 수신 대기",
                   "project": agent["project"], "workspace": agent["workspace"], "attempt": 0,
                   "created_at": time.time(), "updated_at": time.time(), "last_response_at": None,
                   "stopped_confirmed": True, "lease_token": ""}
            tasks[job["id"]] = job
            return public(job)

    @router.post("/agents/{agent_id}/claim")
    def claim(agent_id: str, data: ClientKey):
        with lock:
            expire()
            authorize(agent_id, data.key)
            online_agent(agent_id)
            if any(t["agent_id"] == agent_id and t["status"] in {"offered", "running", "cancel_requested"} for t in tasks.values()):
                return {"task": None}
            for task in tasks.values():
                if task["agent_id"] == agent_id and task["status"] == "pending":
                    task.update(status="offered", detail="원격 IDE에서 작업 내용 확인 중", lease_token=uuid.uuid4().hex,
                                last_response_at=time.time(), updated_at=time.time(), stopped_confirmed=False)
                    return {"task": deepcopy(task)}
            return {"task": None}

    @router.get("/tasks/{task_id}")
    def get_task(task_id: str):
        with lock:
            expire()
            return public(get(task_id))

    @router.post("/tasks/{task_id}/heartbeat")
    def heartbeat(task_id: str, data: ExecutionKey):
        with lock:
            expire()
            task = execution(task_id, data)
            task["last_response_at"] = time.time()
            return {"status": task["status"], "should_stop": task["status"] not in {"offered", "running"}}

    @router.post("/tasks/{task_id}/cancel")
    def cancel(task_id: str, data: TaskControl):
        with lock:
            expire()
            task = get(task_id)
            if task["attempt"] != data.attempt:
                raise HTTPException(409, "실행 회차가 변경되었습니다. 최신 상태를 확인하세요.")
            if task["status"] not in TERMINAL:
                confirmed = task["status"] == "pending" or data.previous_execution_stopped
                task.update(status="cancelled" if confirmed else "cancel_requested", updated_at=time.time(),
                            detail="실행 전 취소 또는 사용자의 중단 확인으로 취소를 확정했습니다." if confirmed else "IDE에 중단을 요청했습니다. 중단 확인 전에는 실행이 계속될 수 있습니다.")
                if confirmed:
                    task.update(stopped_confirmed=True, lease_token="")
            return public(task)

    @router.post("/tasks/{task_id}/resume")
    def resume(task_id: str, data: ResumeRequest):
        with lock:
            expire()
            task = get(task_id)
            if task["attempt"] != data.attempt or task["status"] not in {"disconnected", "cancelled", "failed"}:
                raise HTTPException(409, "재개할 수 없는 상태이거나 이미 재개한 작업입니다.")
            if not data.previous_execution_stopped:
                raise HTTPException(409, "이전 IDE 실행과 하위 명령이 중단되었는지 먼저 확인하세요.")
            agent = online_agent(data.agent_id)
            if (agent["project"], agent["workspace"]) != (task["project"], task["workspace"]):
                raise HTTPException(409, "재개는 동일한 프로젝트·폴더의 IDE에서만 가능합니다.")
            task.update(agent_id=data.agent_id, status="pending", attempt=task["attempt"] + 1, lease_token="",
                        last_response_at=None, updated_at=time.time(), stopped_confirmed=True,
                        detail="사용자가 명시적으로 재개했습니다. 기존 변경과 하네스 진행률을 확인한 뒤 이어서 수행합니다.")
            return public(task)

    @router.post("/tasks/{task_id}")
    def update(task_id: str, data: TaskUpdate):
        with lock:
            expire()
            task = execution(task_id, data)
            allowed = {"offered": {"running", "rejected", "failed", "cancelled"}, "running": {"completed", "failed", "cancelled"},
                       "cancel_requested": {"cancelled"}, "disconnected": {"cancelled"}}
            if task["status"] == data.status and task["status"] in TERMINAL:
                return public(task)
            if data.status not in allowed.get(task["status"], set()):
                raise HTTPException(409, "이미 처리되었거나 올바르지 않은 상태 변경입니다")
            task.update(status=data.status, detail=data.detail, last_response_at=time.time(), updated_at=time.time(),
                        stopped_confirmed=data.status in TERMINAL)
            return public(task)

    return router
