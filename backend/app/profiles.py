"""프로젝트 유형 프로필: 서버/웹/모바일/CLI 등 다양한 프로젝트를 같은 루프로 다루기 위한 정의."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional


@dataclass(frozen=True)
class ProjectProfile:
    key: str
    label: str
    category: str  # server | web | mobile | desktop | cli | library
    language: str
    frameworks: List[str]
    markers: List[str]  # 존재하면 이 프로필로 감지되는 파일
    harness_dir: str  # 요구사항 하네스 테스트를 둘 디렉터리
    test_file_pattern: str  # {name} 자리에 요구사항 slug
    harness_command: List[str]  # 하네스만 실행
    full_test_command: List[str]  # 회귀 확인용 전체 테스트
    setup_hint: str = ""
    conventions: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


PROFILES: Dict[str, ProjectProfile] = {
    p.key: p
    for p in [
        ProjectProfile(
            "python-fastapi", "Python FastAPI 서버", "server", "python", ["FastAPI", "pytest"],
            ["requirements.txt", "pyproject.toml"], "tests/agent_harness", "test_{name}.py",
            ["python", "-m", "pytest", "-q", "tests/agent_harness"], ["python", "-m", "pytest", "-q"],
            "pip install -r requirements.txt pytest httpx",
            ["타입 힌트 사용", "pydantic 모델로 입력 검증", "라우터/서비스/저장소 계층 분리"],
        ),
        ProjectProfile(
            "node-server", "Node.js / TypeScript 서버", "server", "typescript", ["Express", "Vitest"],
            ["package.json"], "tests/agent_harness", "{name}.test.ts",
            ["npx", "vitest", "run", "tests/agent_harness"], ["npm", "test", "--silent"],
            "npm install -D vitest",
            ["ESM 모듈", "async/await", "입력 검증(zod)"],
        ),
        ProjectProfile(
            "react-web", "React 웹 (Vite)", "web", "javascript", ["React", "Vite", "Vitest"],
            ["vite.config.js", "vite.config.ts"], "src/__agent_harness__", "{name}.test.jsx",
            ["npx", "vitest", "run", "src/__agent_harness__"], ["npx", "vitest", "run"],
            "npm install -D vitest @testing-library/react jsdom",
            ["함수형 컴포넌트와 훅", "상태는 최소 범위에 유지"],
        ),
        ProjectProfile(
            "go-server", "Go 서버", "server", "go", ["net/http"],
            ["go.mod"], "internal/agentharness", "{name}_test.go",
            ["go", "test", "./internal/agentharness/..."], ["go", "test", "./..."],
            "", ["에러는 즉시 반환", "context.Context 전달"],
        ),
        ProjectProfile(
            "rust", "Rust (서버/CLI)", "server", "rust", ["cargo"],
            ["Cargo.toml"], "tests", "agent_{name}.rs",
            ["cargo", "test", "--quiet"], ["cargo", "test", "--quiet"],
            "", ["Result 기반 에러 처리", "unwrap 지양"],
        ),
        ProjectProfile(
            "spring-boot", "Java/Kotlin Spring Boot 서버", "server", "kotlin", ["Spring Boot", "JUnit5"],
            ["build.gradle.kts", "build.gradle", "pom.xml"], "src/test/kotlin/agentharness", "{Name}Test.kt",
            ["./gradlew", "test", "--tests", "agentharness.*"], ["./gradlew", "test"],
            "", ["Controller/Service/Repository 계층", "DTO 검증(@Valid)"],
        ),
        ProjectProfile(
            "flutter", "Flutter 모바일 앱", "mobile", "dart", ["Flutter", "flutter_test"],
            ["pubspec.yaml"], "test/agent_harness", "{name}_test.dart",
            ["flutter", "test", "test/agent_harness"], ["flutter", "test"],
            "flutter pub get", ["위젯은 작게 분리", "상태관리 일관성 유지"],
        ),
        ProjectProfile(
            "react-native", "React Native 모바일 앱", "mobile", "typescript", ["React Native", "Jest"],
            ["app.json", "metro.config.js"], "__tests__/agent_harness", "{name}.test.tsx",
            ["npx", "jest", "__tests__/agent_harness"], ["npx", "jest"],
            "npm install", ["플랫폼 분기 최소화", "네이티브 모듈 래핑"],
        ),
        ProjectProfile(
            "android-kotlin", "Android (Kotlin)", "mobile", "kotlin", ["Android", "JUnit"],
            ["app/build.gradle.kts", "app/build.gradle"], "app/src/test/java/agentharness", "{Name}Test.kt",
            ["./gradlew", "testDebugUnitTest"], ["./gradlew", "testDebugUnitTest"],
            "", ["MVVM", "코루틴", "ViewModel 단위 테스트"],
        ),
        ProjectProfile(
            "ios-swift", "iOS / Swift Package", "mobile", "swift", ["Swift", "XCTest"],
            ["Package.swift"], "Tests/AgentHarnessTests", "{Name}Tests.swift",
            ["swift", "test"], ["swift", "test"],
            "", ["값 타입 우선", "async/await"],
        ),
    ]
}

LANGUAGE_DEFAULT_PROFILE = {
    "python": "python-fastapi",
    "typescript": "node-server",
    "javascript": "react-web",
    "go": "go-server",
    "rust": "rust",
    "kotlin": "spring-boot",
    "java": "spring-boot",
    "dart": "flutter",
    "swift": "ios-swift",
}


def get_profile(key: str) -> ProjectProfile:
    if key not in PROFILES:
        raise KeyError(f"알 수 없는 프로젝트 프로필: {key}. 사용 가능: {', '.join(PROFILES)}")
    return PROFILES[key]


def detect_profile(repo: Path) -> Optional[ProjectProfile]:
    """디스크의 레포 내용으로 프로필을 추정한다."""
    def read(name: str) -> Optional[str]:
        try:
            return (repo / name).read_text(encoding="utf-8")
        except Exception:
            return None
    return detect_profile_from(lambda name: (repo / name).exists(), read)


def detect_profile_from(exists: Callable[[str], bool], read: Callable[[str], Optional[str]]) -> Optional[ProjectProfile]:
    """파일 존재 여부/내용 함수로 프로필을 추정한다 (원격 업로드 파일 목록에도 사용). 구체적인 마커를 먼저 본다."""
    if exists("pubspec.yaml"):
        return PROFILES["flutter"]
    if exists("app/build.gradle.kts") or exists("app/build.gradle"):
        return PROFILES["android-kotlin"]
    if exists("Package.swift"):
        return PROFILES["ios-swift"]
    if exists("Cargo.toml"):
        return PROFILES["rust"]
    if exists("go.mod"):
        return PROFILES["go-server"]
    if any(exists(m) for m in ("build.gradle.kts", "build.gradle", "pom.xml")):
        return PROFILES["spring-boot"]
    if exists("package.json"):
        try:
            deps = json.loads(read("package.json") or "{}")
            names = {**deps.get("dependencies", {}), **deps.get("devDependencies", {})}
        except Exception:
            names = {}
        if "react-native" in names or "expo" in names:
            return PROFILES["react-native"]
        if "react" in names and ("vite" in names or exists("vite.config.js") or exists("vite.config.ts")):
            return PROFILES["react-web"]
        return PROFILES["node-server"]
    if any(exists(m) for m in ("pyproject.toml", "requirements.txt", "setup.py")):
        return PROFILES["python-fastapi"]
    return None
