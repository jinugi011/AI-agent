import pytest

from app import sysadmin


@pytest.fixture()
def env_file(tmp_path, monkeypatch):
    monkeypatch.setattr(sysadmin, "ENV_FILE", tmp_path / "agent.env")
    monkeypatch.setattr(sysadmin, "STATE", tmp_path)
    monkeypatch.setattr(sysadmin, "coder_models", lambda: ["/m/a.gguf", "/m/b.gguf"])
    for k in ("ENGINE_CTX", "IMAGEGEN_IDLE", "ENGINE_MODEL_PATH"):
        monkeypatch.delenv(k, raising=False)
    return tmp_path / "agent.env"


def test_save_validates_and_reports_restart(env_file, monkeypatch):
    r = sysadmin.save_config({"ENGINE_CTX": "49152", "IMAGEGEN_IDLE": "300"})
    assert set(r["changed"]) == {"ENGINE_CTX", "IMAGEGEN_IDLE"}
    assert r["restart_needed"] == ["engine"]
    text = env_file.read_text()
    assert 'ENGINE_CTX="49152"' in text and 'IMAGEGEN_IDLE="300"' in text
    assert sysadmin.read_env()["ENGINE_CTX"] == "49152"
    import os
    assert os.environ["IMAGEGEN_IDLE"] == "300"  # 바로 적용되는 설정은 현재 프로세스에도
    monkeypatch.delenv("IMAGEGEN_IDLE")
    # 같은 값 다시 저장 → 변경 없음
    assert sysadmin.save_config({"ENGINE_CTX": "49152"})["changed"] == []


@pytest.mark.parametrize("key,val", [
    ("ENGINE_CTX", "12345"), ("ENGINE_KV_TYPE", "f16; rm -rf /"), ("ENGINE_MODEL_PATH", "/etc/passwd"),
    ("IMAGEGEN_IDLE", "5"), ("IMAGEGEN_IDLE", "$(reboot)"), ("PATH", "/tmp"),
])
def test_rejects_bad_values(env_file, key, val):
    with pytest.raises(ValueError):
        sysadmin.save_config({key: val})
    assert not env_file.exists()


def test_logs_tail_and_filter(tmp_path, monkeypatch):
    log = tmp_path / "engine.log"
    log.write_text("\n".join(f"line {i} {'error' if i % 10 == 0 else 'ok'}" for i in range(500)))
    monkeypatch.setitem(sysadmin.LOGS, "engine", log)
    r = sysadmin.logs("engine", 20)
    assert r["lines"][-1] == "line 499 ok" and len(r["lines"]) == 20
    assert all("error" in line for line in sysadmin.logs("engine", 100, "ERROR")["lines"])
    with pytest.raises(ValueError):
        sysadmin.logs("../../etc/passwd")


def test_unknown_action():
    with pytest.raises(ValueError):
        sysadmin.action("rm-rf")


def test_switch_model_refuses_missing_or_downloading(env_file, tmp_path, monkeypatch):
    monkeypatch.setattr(sysadmin, "MODELS", tmp_path)
    with pytest.raises(ValueError):
        sysadmin.switch_model("coder-old")          # 파일 없음
    (tmp_path / "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf").write_bytes(b"x")
    monkeypatch.setattr(sysadmin, "_downloading", lambda name: True)
    with pytest.raises(ValueError):
        sysadmin.switch_model("coder-old")          # 다운로드 중
    with pytest.raises(ValueError):
        sysadmin.switch_model("nope")


def test_switch_model_writes_preset_env(env_file, tmp_path, monkeypatch):
    monkeypatch.setattr(sysadmin, "MODELS", tmp_path)
    (tmp_path / "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf").write_bytes(b"x")
    monkeypatch.setattr(sysadmin, "_downloading", lambda name: False)
    monkeypatch.setattr(sysadmin, "coder_models", lambda: [str(tmp_path / "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf")])
    calls = []
    monkeypatch.setattr(sysadmin, "action", lambda name: calls.append(name) or {})
    sysadmin.switch_model("coder-old")
    env = sysadmin.read_env()
    assert env["ENGINE_MODEL_PATH"].endswith("Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf")
    assert env["ENGINE_THINKING"] == "off" and env["ENGINE_KV_TYPE"] == "f16"
    assert calls == ["restart-engine"]
