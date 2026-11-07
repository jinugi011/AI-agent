from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

from .agent_service import LocalProjectAgent

app = FastAPI(title="Local Coding Agent", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

agent = LocalProjectAgent()


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


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "model": "qwen2.5-coder:7b",
        "service": "local-coding-agent",
        "vector_backend": "qdrant",
        "vector_url": "http://localhost:6333",
    }


@app.post("/api/generate")
def generate(request: PromptRequest):
    result = agent.generate(request.prompt, request.project_type, request.stack)
    return {"success": True, "result": result}


@app.post("/api/style/index")
def index_project(request: ProjectIndexRequest):
    agent.vector_store.add_project_style(request.project_name, request.project_root)
    return {
        "success": True,
        "project_name": request.project_name,
        "project_root": request.project_root,
        "message": "프로젝트 스타일이 Qdrant에 인덱싱되었습니다.",
    }


@app.post("/api/style/search")
def style_search(request: StyleSearchRequest):
    hits = agent.vector_store.search(request.query, top_k=request.top_k)
    return {"success": True, "query": request.query, "hits": hits}


@app.get("/api/demo")
def demo():
    return {
        "example_prompt": "쇼핑몰 관리자 기능을 포함한 보안 중심의 온라인 스토어를 만들어줘. 포인트, 장바구니, 주문, 관리자 대시보드, 로그 분석을 포함해.",
        "example_stack": ["Python", "FastAPI", "React", "PostgreSQL", "Redis"],
        "project_type": "ecommerce"
    }
