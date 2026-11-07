from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List

import ollama

from .config import settings
from .vector_store import CodeVectorStore


class LocalProjectAgent:
    def __init__(self):
        self.vector_store = CodeVectorStore(settings.vector_store_path)
        self._bootstrap_default_project_style()

    def _bootstrap_default_project_style(self):
        default_project_root = Path("/Users/jinugi/Desktop/Project2026/YANGShopping")
        if default_project_root.exists():
            self.vector_store.add_project_style("YANGShopping", str(default_project_root))

    def _build_context(self, prompt: str) -> str:
        hits = self.vector_store.search(prompt, top_k=5)
        if not hits:
            return "코딩 스타일 가이드: 보안이 우선이며, 구조화된 아키텍처, 테스트 가능성, 명확한 문서화, 단계적 구현을 포함한다."
        context_lines = []
        for hit in hits:
            context_lines.append(f"Source: {hit['source']}\n{hit['content'][:800]}")
        return "\n\n---\n\n".join(context_lines)

    def _generate_structured_response(self, prompt: str, project_type: str, stack: List[str]) -> Dict[str, Any]:
        context = self._build_context(prompt)
        system_prompt = """
        당신은 현업 소프트웨어 아키텍트이자 보안 우선 코딩 에이전트입니다.
        아래 규칙을 엄격히 지켜서 프로젝트 설계와 초기 구조를 작성하세요.
        1) 결과는 반드시 JSON만 반환한다.
        2) 필수 키: title, summary, stack, features, architecture, security, deliverables, tasks, generated_files.
        3) 보안, 운영성, 테스트 가능성, 확장성을 우선적으로 반영한다.
        4) 쇼핑몰, 영상 교육, 모바일 앱, 관리자 대시보드 같은 실사용 도메인에 맞게 기능을 설계한다.
        5) generated_files는 실제 파일 경로와 목적을 구체적으로 나열한다.
        6) 마크다운 코드 블록, 설명 문장, 주석을 절대 포함하지 않는다.
        """
        user_prompt = f"""
        요구사항:
        - 프로젝트 유형: {project_type}
        - 기술 스택: {', '.join(stack)}
        - 사용자 프롬프트: {prompt}
        - 스타일 컨텍스트:
        {context}

        추가 요구사항:
        - 보안은 비밀번호/토큰/개인정보 마스킹, 환경변수 관리, 입력 검증, 권한 제어를 포함한다.
        - 도메인에 맞는 핵심 기능을 5개 이상 제안한다.
        - 아키텍처는 API, 서비스, 저장소, UI 계층을 명시한다.
        - tasks는 설계, 구현, 테스트, 배포 단계가 균형 있게 포함되어야 한다.

        응답 형식 예시:
        {{
          "title": "프로젝트명",
          "summary": "한 줄 설명",
          "stack": ["Python", "FastAPI", "PostgreSQL", "React"],
          "features": ["기능1", "기능2", "기능3"],
          "architecture": ["API Layer", "Service Layer", "Repository Layer", "UI Layer"],
          "security": ["비밀번호 마스킹", "입력 검증", "환경 변수 관리", "로그 마스킹"],
          "deliverables": ["결과물1", "결과물2"],
          "tasks": [
            {{"phase": "설계", "task": "업무"}},
            {{"phase": "구현", "task": "업무"}},
            {{"phase": "테스트", "task": "업무"}}
          ],
          "generated_files": [
            {{"path": "backend/app/main.py", "purpose": "API 엔트리 포인트"}},
            {{"path": "frontend/src/App.jsx", "purpose": "메인 화면"}}
          ]
        }}
        """
        try:
            response = ollama.chat(
                model=settings.default_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                format="json",
                options={"temperature": 0.2, "num_predict": 1500},
            )
            raw = response["message"]["content"]
            return json.loads(raw)
        except Exception:
            return {
                "title": project_type.title(),
                "summary": prompt[:180],
                "stack": stack,
                "features": ["인증", "주문/결제 흐름", "관리자 대시보드", "상품 관리", "로그 분석"],
                "architecture": ["API Layer", "Service Layer", "Repository Layer", "UI Layer"],
                "security": ["입력 검증", "RBAC", "민감정보 마스킹", "환경 변수 관리"],
                "deliverables": ["기초 서비스 설계", "초기 프로젝트 구조", "보안 가이드 문서"],
                "tasks": [
                    {"phase": "설계", "task": "도메인 요구사항과 사용자 플로우 정의"},
                    {"phase": "구현", "task": "핵심 API와 화면 구성"},
                    {"phase": "테스트", "task": "보안 및 기능 검증"},
                    {"phase": "배포", "task": "런타임/배포 문서화"},
                ],
                "generated_files": [
                    {"path": "backend/app/main.py", "purpose": "API 엔트리 포인트"},
                    {"path": "backend/app/services/domain_service.py", "purpose": "비즈니스 로직"},
                    {"path": "frontend/src/App.jsx", "purpose": "메인 화면"},
                ],
            }

    def create_project_template(self, payload: Dict[str, Any]) -> Path:
        title = re.sub(r"[^a-zA-Z0-9가-힣\-_ ]", "", payload.get("title", "local-agent-project")).strip().replace(" ", "-").lower()
        project_dir = Path(settings.project_root) / "generated_projects" / title
        project_dir.mkdir(parents=True, exist_ok=True)

        (project_dir / "README.md").write_text(
            "# " + payload.get("title", "Generated Project") + "\n\n"
            + payload.get("summary", "") + "\n\n"
            + "## Stack\n" + "\n".join(f"- {x}" for x in payload.get("stack", [])) + "\n"
            + "\n## Security\n" + "\n".join(f"- {x}" for x in payload.get("security", [])) + "\n",
            encoding="utf-8",
        )

        backend_dir = project_dir / "backend" / "app"
        (backend_dir / "api").mkdir(parents=True, exist_ok=True)
        (backend_dir / "services").mkdir(parents=True, exist_ok=True)
        (backend_dir / "repositories").mkdir(parents=True, exist_ok=True)
        (backend_dir / "models").mkdir(parents=True, exist_ok=True)

        (backend_dir / "main.py").write_text(
            "from fastapi import FastAPI\n\nfrom app.api.routes import router\n\napp = FastAPI(title=\"Generated Project\")\napp.include_router(router)\n\n@app.get(\"/health\")\ndef health():\n    return {\"status\": \"ok\"}\n",
            encoding="utf-8",
        )
        (backend_dir / "api" / "routes.py").write_text(
            "from fastapi import APIRouter\n\nrouter = APIRouter(prefix=\"/api\", tags=[\"core\"])\n\n@router.get(\"/status\")\ndef status():\n    return {\"status\": \"ready\"}\n",
            encoding="utf-8",
        )
        (backend_dir / "services" / "domain_service.py").write_text(
            "class DomainService:\n    def get_status(self):\n        return {\"result\": \"ok\"}\n",
            encoding="utf-8",
        )
        (project_dir / "backend" / "requirements.txt").write_text("fastapi\nuvicorn\npydantic\n", encoding="utf-8")

        frontend_dir = project_dir / "frontend" / "src"
        frontend_dir.mkdir(parents=True, exist_ok=True)
        (frontend_dir / "App.jsx").write_text(
            "export default function App() {\n  return (\n    <main style={{ padding: 24 }}>\n      <h1>Generated Project</h1>\n      <p>Secure, scalable starter UI</p>\n    </main>\n  );\n}\n",
            encoding="utf-8",
        )
        (frontend_dir / "styles.css").write_text(
            "body { font-family: sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }\nmain { max-width: 960px; margin: 0 auto; padding: 32px; }\n",
            encoding="utf-8",
        )

        return project_dir

    def generate(self, prompt: str, project_type: str, stack: List[str]) -> Dict[str, Any]:
        payload = self._generate_structured_response(prompt, project_type, stack)
        project_dir = self.create_project_template(payload)
        payload["project_dir"] = str(project_dir)
        payload["project_type"] = project_type
        return payload
