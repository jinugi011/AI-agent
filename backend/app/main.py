from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import re
from typing import Dict, List, Optional

from . import llm_client
from .agent_service import LocalProjectAgent
from .coding_agent import CodingAgent
from .config import settings
from .harness import Harness
from .model_manager import ModelManager
from .langchain_builder import create_router as create_langchain_router
from .remote_tasks import create_router as create_remote_work_router
from .preferences import PreferenceStore
from .profiles import PROFILES, get_profile
from .repo_manager import RepoManager
from .vector_store import CodeVectorStore
from . import archinfo, artstyle, attachments, imagegen, imageops, remote, security, sysadmin, worklog

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
    # 허용된 Tailscale 계정(본인)은 토큰 없이 로컬과 같은 권한 (관리 페이지 포함)
    if security.trusted_tailscale_user(request.headers):
        response = await call_next(request)
        security.audit(request.headers, method, path, response.status_code)
        return response
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
app.include_router(create_langchain_router(vector_store, repos))
app.include_router(create_remote_work_router())


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
    target: str = "auto"  # auto | remote(원격 PC 의 경로 → PC 대기 등록) | server(이 맥의 경로 · git URL)


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
    attachment_project: str = ""  # 첨부를 올릴 때 쓴 프로젝트 이름 (IDE 작업 폴더 이름)


class LLMRequest(BaseModel):
    messages: List[Dict[str, str]]
    max_tokens: int = 4096
    temperature: float = 0.2
    top_p: float = 0.9
    stop: List[str] = []
    stream: bool = True
    think: Optional[bool] = None       # 이 요청만 생각(추론) 켜기/끄기 (에이전트: 요청의 첫 단계에서 짧게)
    think_budget: Optional[int] = None


class RemoteFile(BaseModel):
    path: str
    content: str


class RemoteIndexRequest(BaseModel):
    project: str
    files: List[RemoteFile]
    language: str = ""
    client_path: str = ""  # 원격 PC 의 폴더 경로 (표시·재색인용)
    partial: bool = False  # true: 바뀐 파일만 (에이전트가 고친 직후) · deleted: 지워진 파일 경로
    deleted: List[str] = []
    arch: str = "auto"  # 아키텍처 분석: auto(없거나 7일 지났을 때) | force | off


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
    attachments.unload_now_if_pending()  # 코딩 시작 → 비전 모델을 내려 코딩 모델 속도 확보
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
        "worklog": worklog.render(request.attachment_project or project),
        "architecture": archinfo.get(project) if project else None,  # 아키텍처 · 코딩 규칙 (자동 분석)  # 최근 작업 기록 (새 대화에서 이어서 작업)
        "art": artstyle.summary(request.attachment_project or project),  # 프로젝트 아트 컨셉 (그림 생성 프롬프트에 반영)
        # 업로드한 첨부(이미지·PDF·MD) 중 질문과 관련된 부분
        "attachments": attachments.search(vector_store, request.query, project=request.attachment_project or project, top_k=3)
        if request.query else [],
    }


class ArchSaveRequest(BaseModel):
    markdown: str


@app.get("/api/arch/{project}")
def get_arch(project: str):
    from .repo_manager import slugify
    project = slugify(project)
    md = archinfo.get(project)
    rp = remote.get_project(project) or {}
    return {"success": True, "markdown": md, "status": rp.get("arch_status"), "error": rp.get("arch_error")}


@app.put("/api/arch/{project}")
def save_arch(project: str, request: ArchSaveRequest):
    from .repo_manager import slugify
    project = slugify(project)
    return {"success": True, "markdown": archinfo.save_manual(project, request.markdown)}


class WorklogRequest(BaseModel):
    project: str
    request: str
    summary: str
    files: List[str] = []


@app.post("/api/worklog")
def add_worklog(request: WorklogRequest):
    try:
        return {"success": True, "item": worklog.add(request.project, request.request, request.summary, request.files)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/worklog/{project}")
def get_worklog(project: str, n: int = 20):
    return {"success": True, "items": worklog.recent(project, n)}


# ---- 첨부 파일: 이미지 · PDF · MD 업로드 → 분석 → 코딩에 사용 ----------------------------
class AttachmentUpload(BaseModel):
    name: str
    data: str            # 파일 바이트 base64
    project: str = ""    # IDE 작업 폴더(프로젝트) 이름 — 같은 프로젝트의 질문에서 검색됨
    prompt: str = ""     # 이미지 분석 지시 (비우면 개발자용 상세 분석)


@app.post("/api/attachments")
def upload_attachment(request: AttachmentUpload):
    import base64 as _b64
    import binascii

    try:
        data = _b64.b64decode(request.data, validate=False)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="data 는 base64 여야 합니다")
    try:
        meta = attachments.save(vector_store, request.project, request.name, data, request.prompt)
    except attachments.AttachmentError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"success": True, "attachment": attachments.get(meta["id"]) | {"indexed": meta["indexed"]}}


# ---- 이미지 생성·가공 (FLUX.1-schnell + 배경 제거·픽셀아트·스프라이트 시트) ---------------------
class ImageRequest(BaseModel):
    prompt: str = ""              # 영어 (생성할 때)
    width: int = 0
    height: int = 0
    steps: int = 4
    seed: Optional[int] = None
    refs: List[str] = []          # 참고 이미지 b64 (프로젝트 파일)
    ref_search: str = ""          # 무료 이미지 검색어 (Openverse CC0·퍼블릭 도메인)
    ref_attachment: str = ""      # 첨부한 이미지 이름/ID
    strength: float = 0.0         # 참고 이미지를 밑그림으로 쓰는 정도 (0 = 스타일만)
    use_style: bool = True
    source: Optional[str] = None  # 고칠/가공할 기존 이미지 b64
    join: List[str] = []          # 스프라이트 시트로 합칠 이미지들 b64
    cols: int = 0
    transparent: Optional[bool] = None   # 비우면 종류에 따라 (캐릭터·아이템·아이콘·UI 는 투명)
    pixel: int = 0
    colors: int = 24
    ops: str = ""
    translate: bool = False       # 한글 prompt 를 영어로 바꿔서 생성 (웹 스튜디오)
    project: str = ""             # 아트 컨셉을 적용할 프로젝트
    kind: str = ""                # character|enemy|sprite|item|icon|tile|background|ui|effect|portrait
    verify: bool = True           # 비전 모델로 요청·컨셉 대조, 낮으면 한 번 다시
    use_art: bool = True


@app.get("/api/images/status")
def images_status():
    return {"success": True, **imagegen.available()}


@app.post("/api/images/generate")
def images_generate(request: ImageRequest):
    try:
        return {"success": True, **imagegen.generate(request.model_dump())}
    except imagegen.ImageGenError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except attachments.AttachmentError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# ---- 이미지 스튜디오 (웹): 나누기 · 가공 · 말로 가공 · ZIP --------------------------------------
class SplitRequest(BaseModel):
    image: str
    mode: str = "auto"         # auto | grid
    cols: int = 4
    rows: int = 4
    gap: int = 6               # auto: 이 거리(px) 안의 조각은 하나로
    min_size: int = 8          # auto: 이보다 작은 조각은 버림
    padding: int = 2
    tolerance: int = 24        # 배경색과의 차이 허용치
    transparent: bool = True   # 단색 배경을 투명하게
    skip_empty: bool = True    # grid: 빈 칸 건너뛰기
    trim_cells: bool = False   # grid: 칸마다 여백 정리


@app.post("/api/images/split")
def images_split(request: SplitRequest):
    try:
        img = imageops.load(request.image)
        if request.mode == "grid":
            return {"success": True, **imageops.split_grid(img, request.cols, request.rows, request.skip_empty, request.tolerance, request.trim_cells)}
        return {"success": True, **imageops.split_auto(img, request.gap, request.min_size, request.padding, request.tolerance, request.transparent)}
    except imageops.ImageOpError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


class EditRequest(BaseModel):
    image: str
    ops: List[Dict] = []
    instruction: str = ""      # 자연어 ("배경 지우고 64px 픽셀아트로, 좌우 반전")


_EDIT_SYSTEM = ("You convert an image-editing request (often Korean) into a JSON array of operations, applied in order. "
                "Available operations (JSON objects with an 'op' key): " + imageops.OPS_HELP + ". "
                "Use remove_bg for background removal (then usually trim). For 'NNpx pixel art' use pixelate{cells:NN} then resize to the "
                "requested display size with mode nearest if asked. Colors are #rrggbb. Output ONLY the JSON array, no explanation. "
                'Example: [{"op":"remove_bg"},{"op":"trim"},{"op":"pixelate","cells":32},{"op":"resize","w":64,"h":64,"mode":"nearest"},'
                '{"op":"flip","axis":"x"}]')


def _coerce_op(o) -> Optional[Dict]:
    """모델이 JSON 대신 약식('pixelate{cells:48}', 'flip{axis=x}', 'remove_bg')으로 답해도 받아들인다."""
    import re as _re

    if isinstance(o, dict):
        return o if o.get("op") else None
    if not isinstance(o, str):
        return None
    m = _re.fullmatch(r"\s*([a-z_]+)\s*(?:\{(.*)\})?\s*", o)
    if not m:
        return None
    op: Dict = {"op": m.group(1)}
    for part in filter(None, (m.group(2) or "").split(",")):
        if not _re.search(r"[:=]", part):
            continue
        k, v = _re.split(r"[:=]", part, maxsplit=1)
        v = v.strip().strip("'\"")
        try:
            op[k.strip()] = float(v) if "." in v else int(v)
        except ValueError:
            op[k.strip()] = v
    return op


def _ops_from_instruction(text: str, size) -> List[Dict]:
    try:
        res = llm_client.chat([{"role": "system", "content": _EDIT_SYSTEM},
                               {"role": "user", "content": f"Image size: {size[0]}x{size[1]}. Request: {text}"}], max_tokens=300, temperature=0)
    except llm_client.LLMError as exc:
        raise HTTPException(status_code=503, detail=f"말로 가공하려면 코딩 엔진이 필요합니다: {exc}")
    ops = llm_client.extract_json(res.text)
    if isinstance(ops, dict):
        ops = ops.get("ops") or [ops]
    ops = [_coerce_op(o) for o in ops] if isinstance(ops, list) else None
    if not ops or not all(ops):
        raise HTTPException(status_code=422, detail=f"가공 지시를 이해하지 못했습니다: {res.text[:200]}")
    return ops


@app.post("/api/images/edit")
def images_edit(request: EditRequest):
    try:
        img = imageops.load(request.image)
        ops = _ops_from_instruction(request.instruction, img.size) if request.instruction.strip() else request.ops
        if not ops:
            raise HTTPException(status_code=400, detail="가공할 내용이 없습니다")
        for op in ops[:20]:
            img = imageops.apply_op(img, op, remove_bg=imagegen.remove_bg_image)
        return {"success": True, "image": imageops.to_b64(img), "size": list(img.size), "ops": ops}
    except (imageops.ImageOpError, imagegen.ImageGenError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))


class ZipEntry(BaseModel):
    name: str = ""
    data: str


class ZipRequest(BaseModel):
    files: List[ZipEntry]


@app.post("/api/images/zip")
def images_zip(request: ZipRequest):
    from fastapi.responses import Response

    if not request.files:
        raise HTTPException(status_code=400, detail="파일이 없습니다")
    data = imageops.make_zip([f.model_dump() for f in request.files[:500]])
    return Response(data, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="images.zip"'})


@app.get("/api/images/search")
def images_search(q: str, n: int = 6):
    try:
        return {"success": True, "results": imagegen.search_refs(q, max(1, min(n, 20)))}
    except imagegen.ImageGenError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


# ---- 프로젝트 아트 컨셉 ------------------------------------------------------------------------
class ArtImage(BaseModel):
    path: str = ""
    data: str


class ArtAnalyze(BaseModel):
    project: str
    files: List[str] = []
    docs: Dict[str, str] = {}
    code_hints: str = ""
    images: List[ArtImage] = []
    user_concept: str = ""


class ArtRevise(BaseModel):
    instruction: str


@app.get("/api/art")
def art_list():
    return {"success": True, "projects": artstyle.list_all()}


@app.get("/api/art/{project}")
def art_get(project: str):
    b = artstyle.get(project)
    if not b:
        raise HTTPException(status_code=404, detail="아직 아트 컨셉이 없습니다 (/art 로 분석)")
    return {"success": True, "art": b, "markdown": artstyle.to_markdown(b)}


@app.post("/api/art/analyze")
def art_analyze(request: ArtAnalyze):
    try:
        b = artstyle.analyze(request.project, request.model_dump(), vector_store)
    except artstyle.ArtError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"success": True, "art": b, "markdown": artstyle.to_markdown(b)}


@app.put("/api/art/{project}")
def art_revise(project: str, request: ArtRevise):
    try:
        b = artstyle.revise(project, request.instruction, vector_store)
    except artstyle.ArtError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"success": True, "art": b, "markdown": artstyle.to_markdown(b)}


class VisionInspect(BaseModel):
    image: str           # PNG/JPEG base64 (게임·앱 실행 화면)
    expect: str = ""     # 화면에 보여야 하는 것
    context: str = ""    # web | python | flutter …


@app.post("/api/vision/inspect")
def vision_inspect(request: VisionInspect):
    import base64 as _b64

    try:
        data = _b64.b64decode(request.image)
        return {"success": True, **attachments.inspect_screen(data, request.expect, request.context)}
    except attachments.AttachmentError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="image 는 base64 이미지여야 합니다")


@app.get("/api/attachments")
def list_attachments(project: str = ""):
    return {"success": True, "attachments": attachments.list_all(project)}


@app.get("/api/attachments/{att_id}")
def get_attachment(att_id: str):
    try:
        return {"success": True, "attachment": attachments.get(att_id)}
    except (FileNotFoundError, attachments.AttachmentError):
        raise HTTPException(status_code=404, detail="첨부가 없습니다")


@app.delete("/api/attachments/{att_id}")
def delete_attachment(att_id: str):
    try:
        ok = attachments.delete(vector_store, att_id)
    except attachments.AttachmentError:
        ok = False
    if not ok:
        raise HTTPException(status_code=404, detail="첨부가 없습니다")
    return {"success": True}


# ---- 원격 PC 지원: LLM 중계 · 업로드 색인 -------------------------------------------
@app.post("/api/llm/generate")
def llm_generate(request: LLMRequest):
    """엔진은 localhost 에만 두고 백엔드가 중계한다 (원격 PC 의 IDE 플러그인용)."""
    attachments.unload_now_if_pending()  # 코딩 중에는 비전 모델을 내려 코딩 속도 확보
    body = request.model_dump(exclude_none=True)
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
    if request.partial:
        # 바뀐 파일만 바로 갱신 (작고 빠름 · 기다렸다가 결과 반환). 아직 전체 색인이 없는 프로젝트면 무시.
        from .repo_manager import slugify
        name = slugify(request.project)
        if not remote.get_project(name):
            return {"success": True, "skipped": "전체 색인 전"}
        docs = [(f.path, f.content) for f in request.files if remote._clean_rel(f.path)]
        stats = vector_store.index_docs(name, docs, {}, partial=True,
                                        deleted=[d for d in request.deleted if remote._clean_rel(d)])
        return {"success": True, "partial": stats}
    try:
        record = remote.start_index(vector_store, request.project, [f.model_dump() for f in request.files], request.language, arch=request.arch,
                                     client_path=request.client_path)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc))
    return {"success": True, "project": record}


@app.get("/api/remote/pending")
def remote_pending():
    """플러그인이 주기적으로 확인: 이 PC 에서 올려야 할 프로젝트 경로들"""
    return {"success": True, "items": remote.pending()}


@app.delete("/api/remote/projects/{name}")
def remote_delete(name: str):
    """원격 프로젝트 등록 삭제 + 그 프로젝트의 임베딩 데이터도 정리 (PC 의 파일은 그대로)"""
    from .repo_manager import slugify
    remote.remove(name)
    vector_store.delete_where(vector_store.collection_name, "project", slugify(name))
    return {"success": True}


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
    loc = request.location.strip()
    is_url = bool(re.match(r"^(https?://|git@|ssh://)", loc))
    if request.target == "remote" or (request.target == "auto" and not is_url and not Path(loc).expanduser().exists()
                                       and not request.init_if_missing):
        # 이 맥에 없는 경로 = 원격 PC 의 경로 → 'PC 대기'로 등록, 그 PC 의 플러그인이 올려 색인한다
        rec = remote.register_pending(loc, request.name, request.language, request.profile)
        return {"success": True, "pending": True, "project": rec,
                "message": f"원격 PC 프로젝트 '{rec['name']}' 를 등록했습니다. 그 PC 에서 IDE(Yang Coding)가 서버에 연결되면 "
                           "자동으로 파일을 올려 코드 임베딩 · 코딩 스타일 · 아키텍처를 분석합니다."}
    try:
        record = repos.connect(**request.model_dump(exclude={"target"}))
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
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


# ---- 원격 접속 토큰 관리 (이 맥 또는 '내 Tailscale 계정'으로만 접근) ------------------------
# 토큰으로 들어온 원격 요청·Cloudflare 경유 요청은 미들웨어에서 403 → 유출된 토큰으로 새 토큰을 만들 수 없다.
class TokenIssueRequest(BaseModel):
    name: str


@app.get("/api/admin/whoami")
def admin_whoami(request: Request):
    """관리 페이지에 표시할 '누구로 확인되었는지' (이 맥 또는 Tailscale 계정)."""
    user = security.trusted_tailscale_user(request.headers)
    return {"success": True, "via": "tailscale" if user else "local", "user": user or "이 맥(로컬)"}


@app.get("/api/admin/tokens")
def admin_tokens():
    default = security.get_token(create=False)
    return {"success": True, "default": {"exists": bool(default), "prefix": (default or "")[:7]},
            "tokens": security.list_tokens()}


@app.post("/api/admin/tokens")
def admin_issue_token(request: TokenIssueRequest):
    item, token = security.issue_token(request.name)
    return {"success": True, "item": item, "token": token}


@app.delete("/api/admin/tokens/{token_id}")
def admin_revoke_token(token_id: str):
    if not security.revoke_token(token_id):
        raise HTTPException(status_code=404, detail="토큰이 없습니다")
    return {"success": True}


class AdminConfigRequest(BaseModel):
    values: Dict[str, str]


@app.get("/api/admin/system")
def admin_system():
    return {"success": True, **sysadmin.status()}


@app.post("/api/admin/system/{name}")
def admin_system_action(name: str):
    try:
        return {"success": True, **sysadmin.action(name)}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class ModelSwitchRequest(BaseModel):
    preset: str


@app.get("/api/admin/models")
def admin_models():
    return {"success": True, "presets": sysadmin.presets()}


@app.post("/api/admin/models")
def admin_switch_model(request: ModelSwitchRequest):
    try:
        return {"success": True, **sysadmin.switch_model(request.preset)}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/admin/config")
def admin_config():
    return {"success": True, **sysadmin.get_config()}


@app.put("/api/admin/config")
def admin_config_save(request: AdminConfigRequest):
    try:
        return {"success": True, **sysadmin.save_config(request.values)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class ShellRequest(BaseModel):
    command: str
    cwd: str = ""


@app.post("/api/admin/shell")
def admin_shell(request: ShellRequest):
    """관리 페이지 명령 창: 이 맥에서 명령 실행 (소유자만 · 출력은 NDJSON 스트림)"""
    if not request.command.strip():
        raise HTTPException(status_code=400, detail="명령을 입력하세요")
    return StreamingResponse(sysadmin.shell_stream(request.command, request.cwd), media_type="application/x-ndjson")


@app.get("/api/admin/logs/{name}")
def admin_logs(name: str, lines: int = 200, grep: str = ""):
    try:
        return {"success": True, **sysadmin.logs(name, lines, grep)}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/admin/tokens/default")
def admin_default_token():
    return {"success": True, "token": security.get_token()}


@app.post("/api/admin/tokens/default/rotate")
def admin_rotate_default():
    return {"success": True, "token": security.rotate_token()}


# ---- IDE 플러그인 다운로드 (이 맥 또는 '내 Tailscale 계정'으로만) ---------------------------
_PLUGINS = {
    "vscode": ("vscode-extension", "local-coding-agent-*.vsix", "VS Code 확장", "application/octet-stream"),
    "intellij": ("intellij-plugin/build/distributions", "local-coding-agent-intellij-*.zip", "IntelliJ 플러그인 (2025.2+)", "application/zip"),
    "android-studio": ("intellij-plugin/build-android/distributions", "local-coding-agent-android-studio-*.zip",
                       "Android Studio 플러그인 (2025.1+ · Flutter)", "application/zip"),
}


def _latest_plugin(kind: str) -> Optional[Path]:
    folder, pattern, _, _ = _PLUGINS[kind]
    files = sorted((Path(settings.project_root) / folder).glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


@app.get("/api/downloads")
def downloads():
    import re as _re
    items = []
    for kind, (_, _, label, _) in _PLUGINS.items():
        f = _latest_plugin(kind)
        items.append({
            "kind": kind, "label": label, "available": f is not None,
            "filename": f.name if f else "", "size": f.stat().st_size if f else 0,
            "version": (_re.search(r"-(\d+\.\d+\.\d+)\.", f.name).group(1) if f and _re.search(r"-(\d+\.\d+\.\d+)\.", f.name) else ""),
            "updated_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="minutes") if f else "",
            "url": f"/api/downloads/{kind}",
        })
    ts_file = Path(settings.state_dir) / "tailscale_url"
    ts = ts_file.read_text(encoding="utf-8").strip() if ts_file.exists() else ""
    return {"success": True, "items": items,
            "server": {"https": ts, "http": (ts.replace("https:", "http:") + ":18010") if ts else ""}}


@app.get("/api/downloads/{kind}")
def download_plugin(kind: str):
    from fastapi.responses import FileResponse
    if kind not in _PLUGINS:
        raise HTTPException(status_code=404, detail="알 수 없는 플러그인")
    f = _latest_plugin(kind)
    if f is None:
        raise HTTPException(status_code=404, detail="설치 파일이 아직 빌드되지 않았습니다")
    return FileResponse(f, filename=f.name, media_type=_PLUGINS[kind][3])


# ---- 관리 페이지(웹 대시보드): 빌드된 frontend/dist 를 같은 주소에서 서비스 ------------------
# /api/* 라우트를 먼저 등록하고 마지막에 "/" 를 마운트해야 API 를 가리지 않는다.
_DASHBOARD = Path(settings.project_root) / "frontend" / "dist"
if _DASHBOARD.is_dir():
    app.mount("/", StaticFiles(directory=_DASHBOARD, html=True), name="dashboard")
