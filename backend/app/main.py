from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import Dict, List, Optional

from . import llm_client
from .agent_service import LocalProjectAgent
from .coding_agent import CodingAgent
from .config import settings
from .harness import Harness
from .model_manager import ModelManager
from .preferences import PreferenceStore
from .profiles import PROFILES, get_profile
from .repo_manager import RepoManager
from .vector_store import CodeVectorStore
from . import remote, security

app = FastAPI(title="Yang Coding", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def remote_guard(request: Request, call_next):
    """Cloudflare Tunnel 을 거친 원격 요청: API 토큰 필수 + 허용 목록 기능만."""
    if not security.is_remote(request.headers):
        return await call_next(request)
    method, path = request.method, request.url.path
    if not security.token_ok(request.headers.get("authorization")):
        security.audit(request.headers, method, path, 401)
        return JSONResponse({"detail": "API 토큰이 필요합니다 (Authorization: Bearer …)"}, status_code=401)
    if not security.remote_allowed(method, path):
        security.audit(request.headers, method, path, 403)
        return JSONResponse({"detail": "원격 접속에서는 사용할 수 없는 기능입니다 (서버에서 코드를 실행하는 기능은 차단)"}, status_code=403)
    response = await call_next(request)
    security.audit(request.headers, method, path, response.status_code)
    return response

vector_store = CodeVectorStore(settings.vector_store_path)
agent = LocalProjectAgent(vector_store)
preferences = PreferenceStore(vector_store)
repos = RepoManager(vector_store)
coding_agent = CodingAgent(vector_store, repos, preferences)
models = ModelManager()


class PromptRequest(BaseModel):
    prompt: str
    project_type: str = "web-app"
    stack: List[str] = ["Python", "FastAPI", "React", "PostgreSQL"]


class ProjectIndexRequest(BaseModel):
    project_name: str
    project_root: str


class StyleSearchRequest(BaseModel):
    query: str
    top_k: int = 5
    project: Optional[str] = None


class DeployActionRequest(BaseModel):
    action: str
    environment: str = "production"


class RepoConnectRequest(BaseModel):
    location: str  # 로컬 경로 또는 git 원격 URL
    name: str = ""
    profile: str = ""  # 비우면 자동 감지
    language: str = ""
    description: str = ""
    init_if_missing: bool = False


class PreferenceRequest(BaseModel):
    text: str
    kind: str = "preference"
    scope: str = "global"
    scope_value: str = ""


class AgentRunRequest(BaseModel):
    repo: str
    task: str
    max_iterations: Optional[int] = None


@app.get("/api/health")
def health():
    engine = llm_client.engine_health()
    return {
        "status": "ok",
        "service": "yang-coding",
        "engine": {"url": settings.engine_url, "online": engine is not None, "info": (engine or {}).get("model")},
        "model": ((engine or {}).get("model") or {}).get("model_name") or f"(engine offline) fallback {settings.default_model}",
        "vector_backend": vector_store.backend,
        "vector_url": settings.qdrant_url,
    }


# ---- 모델 / 엔진 관리 (VS Code 채팅에서 호출) -------------------------------------
class ModelDownloadRequest(BaseModel):
    model: str


class EngineStartRequest(BaseModel):
    model: str = ""  # 카탈로그 key 또는 gguf 경로. 비우면 받아둔 모델 중 최우선
    ctx: int = 0


class ContextRequest(BaseModel):
    query: str
    workspace_path: str = ""
    repo: str = ""
    project: str = ""  # 원격 PC 프로젝트 이름 (/api/remote/index 로 색인한 것)
    top_k: int = 6


class LLMRequest(BaseModel):
    messages: List[Dict[str, str]]
    max_tokens: int = 4096
    temperature: float = 0.2
    top_p: float = 0.9
    stop: List[str] = []
    stream: bool = True


class RemoteFile(BaseModel):
    path: str
    content: str


class RemoteIndexRequest(BaseModel):
    project: str
    files: List[RemoteFile]
    language: str = ""


@app.get("/api/models")
def list_models():
    return {"success": True, **models.list()}


@app.post("/api/models/download")
def download_model(request: ModelDownloadRequest):
    try:
        return {"success": True, **models.download(request.model)}
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/engine/status")
def engine_status():
    return {"success": True, **models.engine_status()}


@app.post("/api/engine/start")
def engine_start(request: EngineStartRequest):
    try:
        return {"success": True, **models.start_engine(request.model, request.ctx)}
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/engine/stop")
def engine_stop():
    return {"success": True, **models.stop_engine()}


# ---- 채팅 에이전트용 컨텍스트 (선호/제약 + 코딩 방법 + 유사 코드) ----------------------
def _repo_for(workspace_path: str, repo: str):
    if repo:
        return _repo_or_404(repo)
    if not workspace_path:
        return None
    record = repos.find_by_path(workspace_path)
    if record is None:  # 워크스페이스를 처음 열면 자동 연결 + 벡터화
        try:
            record = repos.connect(workspace_path)
        except (FileNotFoundError, ValueError, KeyError, RuntimeError):
            return None
    return record


@app.post("/api/context")
def chat_context(request: ContextRequest):
    if request.project:  # 원격 PC 프로젝트
        rp = remote.get_project(request.project)
        repo = {"name": rp["name"], "profile": rp.get("profile", ""), "language": rp.get("language", ""),
                "remote": True, "status": rp.get("status")} if rp else None
    else:
        record = _repo_for(request.workspace_path, request.repo)
        repo = asdict(record) if record else None
    project = repo["name"] if repo else ""
    return {
        "success": True,
        "repo": repo,
        "preferences": preferences.render_for(request.query, project=project,
                                              language=repo["language"] if repo else "",
                                              profile=repo["profile"] if repo else ""),
        "methods": vector_store.project_methods(project) if project else None,
        "hits": vector_store.search(request.query, top_k=request.top_k, project=project or None) if request.query else [],
    }


# ---- 원격 PC 지원: LLM 중계 · 업로드 색인 -------------------------------------------
@app.post("/api/llm/generate")
def llm_generate(request: LLMRequest):
    """엔진은 localhost 에만 두고 백엔드가 중계한다 (원격 PC 의 IDE 플러그인용)."""
    body = request.model_dump()
    body["max_tokens"] = min(body["max_tokens"], 8192)
    if not request.stream:
        try:
            result = llm_client.chat(body["messages"], max_tokens=body["max_tokens"], temperature=body["temperature"], stop=body["stop"])
        except llm_client.LLMError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        return {"text": result.text, "completion_tokens": result.completion_tokens, "tokens_per_second": result.tokens_per_second}
    return StreamingResponse(
        remote.stream_generate(body),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/remote/index")
def remote_index(request: RemoteIndexRequest):
    try:
        record = remote.start_index(vector_store, request.project, [f.model_dump() for f in request.files], request.language)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc))
    return {"success": True, "project": record}


@app.get("/api/remote/projects")
def remote_projects():
    return {"success": True, "projects": remote.list_projects()}


# ---- 프로젝트 프로필 (서버/웹/모바일) -------------------------------------------
@app.get("/api/profiles")
def list_profiles():
    return {"success": True, "profiles": [p.to_dict() for p in PROFILES.values()]}


# ---- 레포 연결 / 벡터화 ----------------------------------------------------------
def _repo_or_404(name: str):
    try:
        return repos.get(name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/repos")
def list_repos():
    return {"success": True, "repos": [asdict(r) for r in repos.list()]}


@app.post("/api/repos/connect")
def connect_repo(request: RepoConnectRequest):
    try:
        record = repos.connect(**request.model_dump())
    except (FileNotFoundError, ValueError, KeyError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"success": True, "repo": asdict(record)}


@app.post("/api/repos/{name}/reindex")
def reindex_repo(name: str):
    _repo_or_404(name)
    return {"success": True, "repo": asdict(repos.reindex(name))}


@app.delete("/api/repos/{name}")
def disconnect_repo(name: str):
    _repo_or_404(name)
    repos.disconnect(name)
    return {"success": True}


@app.get("/api/repos/{name}/harness")
def repo_harness(name: str):
    record = _repo_or_404(name)
    harness = Harness(Path(record.path), get_profile(record.profile))
    return {"success": True, "requirements": harness.load_requirements(), "profile": record.profile}


@app.post("/api/repos/{name}/harness/run")
def run_repo_harness(name: str, full: bool = False):
    record = _repo_or_404(name)
    return {"success": True, "result": Harness(Path(record.path), get_profile(record.profile)).run(full=full)}


# ---- 선호 / 스타일 / 제약 (영구 저장) ----------------------------------------------
@app.get("/api/preferences")
def list_preferences():
    return {"success": True, "items": [asdict(i) for i in preferences.list()]}


@app.post("/api/preferences")
def add_preference(request: PreferenceRequest):
    try:
        item = preferences.add(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"success": True, "item": asdict(item)}


@app.delete("/api/preferences/{item_id}")
def delete_preference(item_id: str):
    if not preferences.delete(item_id):
        raise HTTPException(status_code=404, detail="항목이 없습니다")
    return {"success": True}


# ---- 코딩 에이전트 작업 ------------------------------------------------------------
@app.post("/api/agent/run")
def agent_run(request: AgentRunRequest):
    _repo_or_404(request.repo)
    if not request.task.strip():
        raise HTTPException(status_code=400, detail="작업 내용이 비어 있습니다")
    job = coding_agent.submit(request.repo, request.task, request.max_iterations)
    return {"success": True, "job": asdict(job)}


@app.get("/api/agent/jobs")
def agent_jobs():
    return {"success": True, "jobs": [
        {k: v for k, v in asdict(j).items() if k not in {"logs", "harness", "last_test"}} for j in coding_agent.jobs.list()
    ]}


@app.get("/api/agent/jobs/{job_id}")
def agent_job(job_id: str):
    job = coding_agent.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="작업이 없습니다")
    return {"success": True, "job": asdict(job)}


@app.post("/api/generate")
def generate(request: PromptRequest):
    result = agent.generate(request.prompt, request.project_type, request.stack)
    return {"success": True, "result": result}


def _resolve_project_dir(project_name: str) -> Path:
    project_root = Path(settings.project_root) / "generated_projects"
    if not project_root.exists():
        raise HTTPException(status_code=404, detail="No generated_projects directory found")

    matches = [
        item for item in project_root.iterdir()
        if item.is_dir() and item.name.lower() == project_name.lower()
    ]
    if not matches:
        raise HTTPException(status_code=404, detail=f"Project '{project_name}' not found")
    return matches[0]


@app.get("/api/projects")
def list_projects():
    project_root = Path(settings.project_root) / "generated_projects"
    projects = []
    if project_root.exists():
        for item in sorted(project_root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if item.is_dir():
                projects.append({
                    "name": item.name,
                    "path": str(item),
                    "updated_at": datetime.fromtimestamp(item.stat().st_mtime).isoformat(),
                    "files": len(list(item.rglob("*"))),
                })
    return {"success": True, "projects": projects}


@app.get("/api/projects/{project_name}/tree")
def project_tree(project_name: str):
    project_dir = _resolve_project_dir(project_name)
    files = []
    for path in sorted(project_dir.rglob("*"), key=lambda p: str(p.relative_to(project_dir)).lower()):
        relative_path = str(path.relative_to(project_dir))
        if path.is_file():
            files.append({
                "path": relative_path,
                "type": "file",
                "size": path.stat().st_size,
            })
        elif path.is_dir():
            files.append({
                "path": relative_path,
                "type": "directory",
            })
    return {
        "success": True,
        "project_name": project_name,
        "root": str(project_dir),
        "files": files,
    }


@app.post("/api/style/index")
def index_project(request: ProjectIndexRequest):
    stats = vector_store.index_repository(request.project_name, request.project_root)
    return {
        "success": True,
        "project_name": request.project_name,
        "project_root": request.project_root,
        "stats": stats,
        "message": f"프로젝트 스타일이 {vector_store.backend}에 인덱싱되었습니다.",
    }


@app.post("/api/style/search")
def style_search(request: StyleSearchRequest):
    hits = vector_store.search(request.query, top_k=request.top_k, project=request.project)
    return {"success": True, "query": request.query, "hits": hits}


@app.get("/api/deploy/status")
def deploy_status():
    return {
        "summary": [
            {"label": "Production", "value": "healthy", "status": "online"},
            {"label": "Staging", "value": "deploying", "status": "warning"},
            {"label": "Preview", "value": "4 branches", "status": "info"},
            {"label": "Uptime", "value": "99.97%", "status": "success"},
        ],
        "recent_deployments": [
            {"env": "production", "version": "v2.8.1", "time": "2 minutes ago", "status": "success"},
            {"env": "staging", "version": "v2.8.2", "time": "15 minutes ago", "status": "warning"},
            {"env": "preview", "version": "v2.8.3-pr42", "time": "1 hour ago", "status": "success"},
        ],
        "environments": [
            {"name": "production", "domain": "app.example.com", "branch": "main", "trigger": "GitHub push"},
            {"name": "staging", "domain": "staging.example.com", "branch": "develop", "trigger": "manual approval"},
        ],
    }


@app.get("/api/cicd/status")
def cicd_status():
    return {
        "pipeline": [
            {"name": "Lint", "status": "passed"},
            {"name": "Tests", "status": "passed"},
            {"name": "Build", "status": "passed"},
            {"name": "Security Scan", "status": "running"},
            {"name": "Deploy", "status": "queued"},
        ],
        "notes": [
            "Docker image build 자동화",
            "Qdrant + Ollama 의존성 검증",
            "보안 스캔 및 정적 분석",
            "Azure / Docker 배포 준비",
        ],
    }


@app.post("/api/deploy/trigger")
def trigger_deploy(request: DeployActionRequest):
    allowed = {"Build", "Deploy", "Rollback", "Pipeline run"}
    if request.action not in allowed:
        raise HTTPException(status_code=400, detail="지원하지 않는 배포 작업입니다.")

    return {
        "success": True,
        "action": request.action,
        "environment": request.environment,
        "status": "queued",
        "message": f"{request.action} 작업이 {request.environment} 환경에 큐에 등록되었습니다.",
        "job_id": f"job-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
    }


@app.get("/api/demo")
def demo():
    return {
        "example_prompt": "쇼핑몰 관리자 기능을 포함한 보안 중심의 온라인 스토어를 만들어줘. 포인트, 장바구니, 주문, 관리자 대시보드, 로그 분석을 포함해.",
        "example_stack": ["Python", "FastAPI", "React", "PostgreSQL", "Redis"],
        "project_type": "ecommerce"
    }
