"""코딩 에이전트 전체 흐름 테스트 (LLM/임베딩은 가짜로 대체해 오프라인·결정적으로 실행)."""
import hashlib
import subprocess
from pathlib import Path

import numpy as np
import pytest

from app import coding_agent as ca
from app import harness as hz
from app import llm_client
from app.config import settings
from app.preferences import PreferenceStore
from app.repo_manager import RepoManager
from app.vector_store import CodeVectorStore, extract_coding_methods, iter_source_files


def fake_embed(self, texts):
    vecs = []
    for t in texts:
        seed = int(hashlib.md5(t.encode()).hexdigest()[:8], 16)
        v = np.random.default_rng(seed).standard_normal(384)
        vecs.append(v / np.linalg.norm(v))
    return np.array(vecs, dtype="float32")


HARNESS_OUT = '''<<<REQUIREMENTS
[{"id": "REQ-001", "title": "add 함수", "acceptance": ["add(2, 3) == 5"]}]
REQUIREMENTS>>>
<<<FILE tests/agent_harness/test_calc.py
from calc.ops import add


def test_req_001_add():
    assert add(2, 3) == 5
FILE>>>
'''

BAD_IMPL = '''plan: add function
<<<FILE calc/__init__.py
FILE>>>
<<<FILE calc/ops.py
def add(a: int, b: int) -> int:
    return a - b
FILE>>>
<<<FILE tests/agent_harness/test_calc.py
def test_cheat():
    assert True
FILE>>>
'''

GOOD_IMPL = '''<<<FILE calc/ops.py
def add(a: int, b: int) -> int:
    return a + b
FILE>>>
'''


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "state_dir", str(tmp_path / "state"))
    monkeypatch.setattr(settings, "vector_backend", "memory")
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(CodeVectorStore, "embed", fake_embed)

    repo = tmp_path / "demo-repo"
    repo.mkdir()
    (repo / "requirements.txt").write_text("pytest\n")
    (repo / "README.md").write_text("# demo\n")
    git = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True)
    git("init", "-b", "main")
    git("config", "user.email", "agent@example.com")
    git("config", "user.name", "agent")
    git("add", "-A")
    git("commit", "-m", "init")

    vs = CodeVectorStore()
    repos = RepoManager(vs)
    prefs = PreferenceStore(vs)
    return repo, vs, repos, prefs


def test_parse_file_blocks_and_delete():
    changes = hz.parse_file_blocks("x\n<<<FILE a/b.py\nprint(1)\nFILE>>>\n<<<DELETE old.py>>>")
    assert [(c.path, c.content) for c in changes] == [("a/b.py", "print(1)"), ("old.py", None)]


def test_safe_path_blocks_escape(tmp_path):
    with pytest.raises(ValueError):
        hz.safe_path(tmp_path, "../outside.py")
    with pytest.raises(ValueError):
        hz.safe_path(tmp_path, ".git/config")
    assert hz.safe_path(tmp_path, "./.github/ci.yml") == (tmp_path / ".github/ci.yml").resolve()


def test_preferences_persist_and_scope(env):
    _, vs, _, prefs = env
    prefs.add("pydantic v2 만 사용", kind="constraint", scope="language", scope_value="python")
    prefs.add("Riverpod 사용", kind="preference", scope="profile", scope_value="flutter")
    reloaded = PreferenceStore(vs)  # 새 인스턴스(재시작)에서도 유지
    py_block = reloaded.render_for("x", language="python", profile="python-fastapi")
    assert "pydantic v2" in py_block and "Riverpod" not in py_block
    assert py_block.index("제약") < py_block.index("코딩 스타일")


def test_connect_detects_profile_and_indexes(env):
    repo, vs, repos, _ = env
    record = repos.connect(str(repo))
    assert record.profile == "python-fastapi"
    assert record.index_stats["chunks"] >= 2
    assert "코딩 방법" in vs.project_methods(record.name)
    # 재연결 시 중복 없이 교체
    repos.connect(str(repo))
    assert len([p for p in vs._memory[vs.collection_name] if p["payload"]["project"] == record.name]) == record.index_stats["chunks"]


def test_agent_loop_retries_until_harness_passes(env, monkeypatch):
    repo, vs, repos, prefs = env
    record = repos.connect(str(repo))
    outputs = iter([HARNESS_OUT, BAD_IMPL, GOOD_IMPL])
    prompts = []

    def fake_chat(messages, **kwargs):
        prompts.append(messages)
        return llm_client.LLMResult(text=next(outputs), backend="fake")

    monkeypatch.setattr(llm_client, "chat", fake_chat)
    agent = ca.CodingAgent(vs, repos, prefs)
    job = ca.Job(repo=record.name, task="calc.ops.add 함수 구현")
    agent._run_safe(job, max_iterations=3)

    assert job.status == "passed", job.logs
    assert job.iterations == 2
    assert job.commit
    # 구현 단계에서 하네스 테스트를 바꿔치기하려는 시도는 무시되어야 한다
    assert "add(2, 3) == 5" in (repo / "tests/agent_harness/test_calc.py").read_text()
    # 실패 로그가 다음 시도에 피드백되었는지
    assert "harness failed" in prompts[2][-1]["content"]
    # 선호/제약이 프롬프트에 항상 포함
    assert "환경변수" in prompts[1][1]["content"]
    assert (repo / ".agent/harness/requirements.json").exists()
    branch = subprocess.run(["git", "branch", "--show-current"], cwd=repo, capture_output=True, text=True).stdout.strip()
    assert branch == job.branch and branch.startswith("agent/")
    assert ca.JobStore().get(job.id).status == "passed"


def test_agent_refuses_dirty_repo(env, monkeypatch):
    repo, vs, repos, prefs = env
    record = repos.connect(str(repo))
    (repo / "wip.py").write_text("x = 1\n")
    agent = ca.CodingAgent(vs, repos, prefs)
    job = ca.Job(repo=record.name, task="anything")
    agent._run_safe(job, max_iterations=1)
    assert job.status == "error"
    assert "커밋되지 않은 변경" in job.logs[-1]["message"]


def test_extract_methods_two_space_js(tmp_path):
    (tmp_path / "a.js").write_text("function fooBar() {\n  if (x) {\n    return 'a';\n  }\n}\n")
    m = extract_coding_methods(tmp_path, list(iter_source_files(tmp_path)))
    assert m["indentation"] == "2 spaces"
    assert m["naming"] == "camelCase"
    assert m["js_quotes"] == "single"


WRONG_HARNESS = HARNESS_OUT.replace("add(2, 3) == 5", "add(2, 3) == 6")

TEST_FIX = '''TEST-FIX: test_req_001_add — 2 + 3 은 6 이 아니라 5 이다
<<<FILE tests/agent_harness/test_calc.py
from calc.ops import add


def test_req_001_add():
    assert add(2, 3) == 5
FILE>>>
'''


def test_agent_allows_explicit_test_fix_and_records_reason(env, monkeypatch):
    repo, vs, repos, prefs = env
    record = repos.connect(str(repo))
    outputs = iter([WRONG_HARNESS, BAD_IMPL.replace("a - b", "a + b"), TEST_FIX])
    monkeypatch.setattr(llm_client, "chat", lambda messages, **kw: llm_client.LLMResult(text=next(outputs), backend="fake"))
    agent = ca.CodingAgent(vs, repos, prefs)
    job = ca.Job(repo=record.name, task="add 구현")
    agent._run_safe(job, max_iterations=3)

    assert job.status == "passed", job.logs
    assert job.test_fixes == ["test_req_001_add — 2 + 3 은 6 이 아니라 5 이다"]
    assert any(l["step"] == "test-fix" for l in job.logs)
    log = subprocess.run(["git", "log", "-1", "--format=%B"], cwd=repo, capture_output=True, text=True).stdout
    assert "harness test fixes" in log and "6 이 아니라 5" in log


def test_stall_triggers_focused_harness_review(env, monkeypatch):
    repo, vs, repos, prefs = env
    record = repos.connect(str(repo))
    impl = BAD_IMPL.replace("a - b", "a + b")
    outputs = iter([WRONG_HARNESS, impl, impl, TEST_FIX])
    calls = []

    def fake_chat(messages, **kw):
        calls.append(messages)
        return llm_client.LLMResult(text=next(outputs), backend="fake")

    monkeypatch.setattr(llm_client, "chat", fake_chat)
    agent = ca.CodingAgent(vs, repos, prefs)
    job = ca.Job(repo=record.name, task="add 구현")
    agent._run_safe(job, max_iterations=4)

    assert job.status == "passed", job.logs
    assert job.iterations == 2  # 2회 연속 같은 실패 → 리뷰에서 테스트 수정 → 통과
    assert "recompute the expected value" in calls[3][-1]["content"]
    assert [l["step"] for l in job.logs].count("review") == 1


def test_failure_signature_parses_pytest():
    out = "FAILED tests/a.py::test_x - AssertionError\nFAILED tests/a.py::test_y\n1 passed"
    assert ca._failure_signature(out) == {"tests/a.py::test_x", "tests/a.py::test_y"}


def test_parse_fenced_fallback_only_when_no_blocks():
    text = "Here's the updated `shop/cart.py` file:\n\n```python\nx = 1\n```\n"
    assert [(c.path, c.content) for c in hz.parse_file_blocks(text)] == [("shop/cart.py", "x = 1")]
    strict = "<<<FILE a.py\ny = 2\nFILE>>>\n" + text
    assert [c.path for c in hz.parse_file_blocks(strict)] == ["a.py"]
