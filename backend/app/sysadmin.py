"""서버 관리 (관리 페이지 '서버 관리'): 원격에서 상태 확인 · 재시작 · 설정 · 로그.

- 이 맥 또는 허용된 Tailscale 계정(본인)만 쓸 수 있다 (토큰 원격 접속은 security.REMOTE_ALLOW 에 없어 403).
- 설정은 state_dir/agent.env (KEY="값") 에 저장 → launchd 실행기(scripts/service.sh)가 서비스 시작 때 읽는다.
  값은 정해진 선택지·숫자 범위만 받아 셸 주입이 불가능하다.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

from .config import settings

ROOT = Path(settings.project_root)
STATE = Path(settings.state_dir)
ENV_FILE = STATE / "agent.env"
MODELS = ROOT / "models"
UID = os.getuid()
SERVICES = {"engine": "com.localagent.engine", "backend": "com.localagent.backend"}
LOGS = {
    "engine": STATE / "engine.log",
    "backend": STATE / "backend.log",
    "imagegen": STATE / "imagegen.log",
    "access": STATE / "remote_access.log",
}
IMAGEGEN_URL = "http://127.0.0.1:18093"
STARTED = time.time()


def coder_models() -> List[str]:
    if not MODELS.exists():
        return []
    # 다운로드 중인(아직 덜 받은) 파일은 고를 수 없게 — 고르면 엔진이 로드에 실패해 계속 재시작한다
    busy = _run("pgrep", "-fl", "curl")
    return sorted(str(p) for p in MODELS.glob("*.gguf")
                  if not re.search(r"mmproj|-VL-", p.name, re.I) and p.name not in busy)


def fields() -> List[Dict]:
    """관리 페이지에서 바꿀 수 있는 설정. service: 바꾼 뒤 재시작이 필요한 서비스 ('' = 바로 적용)."""
    models = coder_models()
    return [
        {"key": "ENGINE_MODEL_PATH", "label": "코딩 모델", "type": "select", "service": "engine",
         "options": models, "labels": [Path(m).name for m in models], "default": models[0] if models else "",
         "help": "바꾸면 엔진을 다시 시작합니다 (모델 로딩 20~60초)."},
        {"key": "ENGINE_CTX", "label": "컨텍스트 길이 (토큰)", "type": "select", "service": "engine",
         "options": ["16384", "32768", "49152", "65536"], "default": "32768",
         "help": "길수록 큰 파일·긴 대화를 보지만 메모리를 더 쓰고 느려집니다. 36GB 맥은 32768 권장."},
        {"key": "ENGINE_KV_TYPE", "label": "KV 캐시 형식", "type": "select", "service": "engine",
         "options": ["f16", "q8_0", "q4_0"], "default": "f16",
         "help": "f16 이 가장 빠름 (측정 결과). q8_0 은 메모리 절반, 조금 느림."},
        {"key": "ENGINE_FLASH", "label": "Flash Attention", "type": "select", "service": "engine",
         "options": ["auto", "on", "off"], "default": "auto", "help": "off 는 약 40% 느립니다."},
        {"key": "ENGINE_THINKING", "label": "생각(추론) 모드", "type": "select", "service": "engine",
         "options": ["auto", "on", "off"], "labels": ["자동 (추론 모델만 켬)", "항상 켬", "끔"], "default": "auto",
         "help": "코딩 모델은 꺼야 빠릅니다 (에이전트는 요청의 첫 단계에서만 짧게 생각합니다)."},
        {"key": "ENGINE_VISION_IDLE", "label": "비전 모델 자동 내림 (초)", "type": "int", "service": "engine",
         "min": 0, "max": 3600, "default": "300", "help": "코딩 요청이 오면 어차피 바로 내립니다. 0 = 계속 유지."},
        {"key": "IMAGEGEN_FAMILY", "label": "이미지 생성 모델", "type": "select", "service": "",
         "options": ["", "zimage", "flux"], "labels": ["자동 (Z-Image 우선)", "Z-Image-Turbo", "FLUX.1-schnell"],
         "default": "", "help": "바로 적용 (다음 생성부터)."},
        {"key": "IMAGEGEN_IDLE", "label": "이미지 모델 자동 종료 (초)", "type": "int", "service": "",
         "min": 30, "max": 3600, "default": "180", "help": "이 시간 동안 그림 요청이 없으면 메모리를 돌려줍니다."},
    ]


# ---- 모델 프리셋 (플러그인 /model · 관리 페이지 '모델 선택') -----------------------------------------
PRESETS = [
    {"id": "coder", "label": "코딩 (Qwen3.6-35B-A3B)", "files": ["Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf", "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"],
     "env": {"ENGINE_CTX": "32768", "ENGINE_KV_TYPE": "f16", "ENGINE_THINKING": "off"},
     "help": "평소 코딩용. 빠름 (MoE · 활성 3B)."},
    {"id": "coder-old", "label": "이전 코딩 (Qwen3-Coder-30B)", "files": ["Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"],
     "env": {"ENGINE_CTX": "32768", "ENGINE_KV_TYPE": "f16", "ENGINE_THINKING": "off"},
     "help": "이전 기본 모델. 비교하거나 Qwen3.6 이 이상할 때."},
]


def presets() -> List[Dict]:
    current = os.path.basename(read_env().get("ENGINE_MODEL_PATH", "") or (_get(f"{settings.engine_url}/health") or {}).get("model", {}).get("model_path", ""))
    out = []
    for p in PRESETS:
        path = next((MODELS / f for f in p["files"] if (MODELS / f).exists()), None)
        out.append({"id": p["id"], "label": p["label"], "help": p["help"], "available": path is not None and not _downloading(path.name),
                    "file": path.name if path else p["files"][0], "active": bool(path and path.name == current)})
    return out


def switch_model(preset_id: str) -> Dict:
    p = next((x for x in PRESETS if x["id"] == preset_id), None)
    if p is None:
        raise ValueError(f"알 수 없는 모델: {preset_id} (coder | coder-old)")
    path = next((MODELS / f for f in p["files"] if (MODELS / f).exists()), None)
    if path is None or _downloading(path.name if path else p["files"][0]):
        raise ValueError(f"{p['label']} 모델 파일이 아직 없습니다 (다운로드 중이거나 설치 전)")
    r = save_config({"ENGINE_MODEL_PATH": str(path), **p["env"]})
    action("restart-engine")
    return {"message": f"{p['label']} 로 바꿉니다. 모델 로딩까지 20~60초 걸립니다.", "changed": r["changed"]}


def _downloading(fname: str) -> bool:
    return fname in _run("pgrep", "-fl", "curl")


# ---- agent.env ---------------------------------------------------------------------------------
def read_env() -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not ENV_FILE.exists():
        return out
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)="?(.*?)"?\s*$', line)
        if m and not line.lstrip().startswith("#"):
            out[m.group(1)] = m.group(2)
    return out


def _validate(field: Dict, value: str) -> str:
    value = str(value).strip()
    if field["type"] == "select":
        if value not in field["options"]:
            raise ValueError(f"{field['label']}: 허용되지 않는 값입니다 ({value})")
        return value
    if not re.fullmatch(r"\d{1,6}", value):
        raise ValueError(f"{field['label']}: 숫자를 입력하세요")
    n = int(value)
    if not field["min"] <= n <= field["max"]:
        raise ValueError(f"{field['label']}: {field['min']}~{field['max']} 사이로 입력하세요")
    return str(n)


def get_config() -> Dict:
    env = read_env()
    items = []
    for f in fields():
        items.append({**f, "value": env.get(f["key"], os.environ.get(f["key"], f["default"]))})
    return {"fields": items, "file": str(ENV_FILE), "launchd": _launchd_uses_env()}


def save_config(values: Dict[str, str]) -> Dict:
    by_key = {f["key"]: f for f in fields()}
    env = read_env()
    changed: List[str] = []
    for key, raw in values.items():
        if key not in by_key:
            raise ValueError(f"알 수 없는 설정: {key}")
        val = _validate(by_key[key], raw)
        current = env.get(key, os.environ.get(key, by_key[key]["default"]))
        if val != current:
            changed.append(key)
        env[key] = val
    STATE.mkdir(parents=True, exist_ok=True)
    lines = ["# Yang Coding 서버 설정 (관리 페이지 '서버 관리'에서 수정 · scripts/service.sh 가 읽음)"]
    lines += [f'{k}="{v}"' for k, v in sorted(env.items())]
    tmp = ENV_FILE.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(ENV_FILE)
    # 바로 적용되는 설정은 이 백엔드 프로세스에도 반영
    for key in changed:
        if not by_key[key]["service"]:
            os.environ[key] = env[key]
    restart = sorted({by_key[k]["service"] for k in changed if by_key[k]["service"]})
    return {"changed": changed, "restart_needed": restart}


# ---- 상태 ---------------------------------------------------------------------------------------
def _get(url: str, timeout: float = 2.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:  # noqa: BLE001
        return None


def _post(url: str, timeout: float = 10.0) -> Optional[dict]:
    try:
        req = urllib.request.Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except Exception:  # noqa: BLE001
        return None


def _run(*cmd: str, timeout: float = 5) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:  # noqa: BLE001
        return ""


def _launchd(label: str) -> Dict:
    out = _run("launchctl", "print", f"gui/{UID}/{label}")
    if not out:
        return {"registered": False}
    pid = re.search(r"^\s*pid = (\d+)", out, re.M)
    state = re.search(r"^\s*state = (\S+)", out, re.M)
    last = re.search(r"last exit code = (.+)", out)
    return {"registered": True, "state": state.group(1) if state else "?", "pid": int(pid.group(1)) if pid else None,
            "last_exit": last.group(1).strip() if last else ""}


def _launchd_uses_env() -> bool:
    plist = Path.home() / "Library" / "LaunchAgents" / f"{SERVICES['engine']}.plist"
    return plist.exists() and "service.sh" in plist.read_text(encoding="utf-8", errors="replace")


def _rss_mb(pid: Optional[int]) -> Optional[int]:
    if not pid:
        return None
    out = _run("ps", "-o", "rss=", "-p", str(pid)).strip()
    return int(out) // 1024 if out.isdigit() else None


def _etime(pid: Optional[int]) -> str:
    return _run("ps", "-o", "etime=", "-p", str(pid)).strip() if pid else ""


def memory() -> Dict:
    total = int((_run("sysctl", "-n", "hw.memsize").strip() or "0"))
    vm = _run("vm_stat")
    page = int((re.search(r"page size of (\d+)", vm) or [0, 16384])[1])

    def pages(name: str) -> int:
        m = re.search(rf"{name}:\s+(\d+)", vm)
        return int(m.group(1)) if m else 0

    free = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * page
    gb = 1024 ** 3
    return {"total_gb": round(total / gb, 1), "available_gb": round(free / gb, 1),
            "used_gb": round((total - free) / gb, 1) if total else None}


def status() -> Dict:
    engine = _get(f"{settings.engine_url}/health")
    image = _get(f"{IMAGEGEN_URL}/health")
    svc = {k: _launchd(v) for k, v in SERVICES.items()}
    for k, v in svc.items():
        v["rss_mb"] = _rss_mb(v.get("pid"))
        v["uptime"] = _etime(v.get("pid"))
    if not svc["backend"].get("pid"):
        svc["backend"]["pid"] = os.getpid()
        svc["backend"]["uptime"] = _etime(os.getpid())
        svc["backend"]["rss_mb"] = _rss_mb(os.getpid())
    disk = os.statvfs(str(ROOT))
    return {
        "engine": {"online": engine is not None, "model": (engine or {}).get("model", {}),
                   "coder_loaded": (engine or {}).get("coder_loaded"), "vision": (engine or {}).get("vision"),
                   **svc["engine"]},
        "backend": {"online": True, **svc["backend"]},
        "imagegen": {"online": image is not None, "loaded": (image or {}).get("loaded"),
                     "family": (image or {}).get("family"), "pid": (image or {}).get("pid"),
                     "rss_mb": _rss_mb((image or {}).get("pid"))},
        "memory": memory(),
        "disk_free_gb": round(disk.f_bavail * disk.f_frsize / 1024 ** 3, 1),
        "settings_via_launchd": _launchd_uses_env(),
    }


# ---- 동작 ---------------------------------------------------------------------------------------
def _kickstart(label: str, delay: float = 0) -> bool:
    if not _launchd(label).get("registered"):
        return False
    cmd = f"sleep {delay}; launchctl kickstart -k gui/{UID}/{label}" if delay else f"launchctl kickstart -k gui/{UID}/{label}"
    # 자기 자신(백엔드)을 재시작할 때도 응답을 먼저 보내도록, 분리된 세션에서 실행
    subprocess.Popen(["/bin/sh", "-c", cmd], start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def action(name: str) -> Dict:
    if name == "restart-engine":
        if not _kickstart(SERVICES["engine"]):
            raise RuntimeError("엔진이 launchd 서비스로 등록되어 있지 않습니다 (./scripts/server-mode.sh on)")
        return {"message": "엔진을 다시 시작합니다. 모델 로딩까지 20~60초 걸립니다."}
    if name == "restart-backend":
        if not _kickstart(SERVICES["backend"], delay=1):
            raise RuntimeError("백엔드가 launchd 서비스로 등록되어 있지 않습니다 (./scripts/server-mode.sh on)")
        return {"message": "백엔드를 다시 시작합니다. 5~10초 뒤 페이지가 다시 연결됩니다."}
    if name == "restart-all":
        _post(f"{IMAGEGEN_URL}/shutdown", timeout=3)
        ok = _kickstart(SERVICES["engine"]) and _kickstart(SERVICES["backend"], delay=2)
        if not ok:
            raise RuntimeError("서비스가 launchd 로 등록되어 있지 않습니다 (./scripts/server-mode.sh on)")
        return {"message": "엔진·백엔드·이미지 모델을 모두 다시 시작합니다. 1분 정도 뒤 다시 확인하세요."}
    if name == "stop-imagegen":
        return {"message": "이미지 모델을 껐습니다 (메모리 반환)." if _post(f"{IMAGEGEN_URL}/shutdown", 3)
                else "이미지 모델이 이미 꺼져 있습니다."}
    if name == "engine-sleep":
        _post(f"{settings.engine_url}/sleep", timeout=60)
        return {"message": "코딩·비전 모델을 메모리에서 내렸습니다. 다음 코딩 요청 때 자동으로 다시 올립니다."}
    if name == "vision-unload":
        _post(f"{settings.engine_url}/vision/unload", timeout=30)
        return {"message": "비전 모델을 내렸습니다."}
    raise ValueError(f"알 수 없는 동작: {name}")


def logs(name: str, lines: int = 200, grep: str = "") -> Dict:
    path = LOGS.get(name)
    if path is None:
        raise ValueError(f"알 수 없는 로그: {name}")
    if not path.exists():
        return {"name": name, "lines": []}
    lines = max(10, min(2000, lines))
    with path.open("rb") as fh:  # 큰 로그도 끝부분만 읽기
        fh.seek(0, 2)
        size = fh.tell()
        fh.seek(max(0, size - 2_000_000))
        text = fh.read().decode("utf-8", errors="replace")
    rows = text.splitlines()
    if grep:
        g = grep.lower()
        rows = [r for r in rows if g in r.lower()]
    return {"name": name, "lines": rows[-lines:], "size_kb": size // 1024}


# ---- 명령 창 (관리 페이지) -------------------------------------------------------------------------
# 이 맥의 셸에서 명령을 실행해 출력을 실시간으로 보낸다. 소유자(이 맥 · 허용된 Tailscale 계정)만 — 토큰 원격 접속은 403.
SHELL_TIMEOUT = 600
CWD_MARK = "__YANG_CWD__"


def shell_stream(command: str, cwd: str = ""):
    """NDJSON 줄: {"out": 텍스트} … 마지막 {"exit": 코드, "cwd": 실행 후 폴더}"""
    import select
    import signal

    start = Path(cwd).expanduser() if cwd else ROOT
    if not start.is_dir():
        start = ROOT
    # cd 가 다음 명령에도 이어지도록, 끝난 뒤의 폴더를 표식과 함께 출력
    script = f'{command}\n__rc=$?\nprintf "\\n{CWD_MARK}%s\\n" "$PWD"\nexit $__rc'
    env = {**os.environ, "TERM": "dumb", "NO_COLOR": "1", "CLICOLOR": "0", "PAGER": "cat", "GIT_PAGER": "cat"}
    proc = subprocess.Popen(["/bin/zsh", "-lc", script], cwd=str(start), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, env=env, start_new_session=True)
    deadline = time.time() + SHELL_TIMEOUT
    new_cwd = str(start)
    buf = b""
    try:
        while True:
            ready, _, _ = select.select([proc.stdout], [], [], 0.5)
            if ready:
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                buf += chunk
                text, sep, rest = buf.rpartition(b"\n")
                if sep:
                    buf = rest
                    out = text.decode("utf-8", errors="replace") + "\n"
                    if CWD_MARK in out:
                        out, _, tail = out.partition(CWD_MARK)
                        new_cwd = tail.strip().splitlines()[0] if tail.strip() else new_cwd
                        out = out.rstrip("\n") + ("\n" if out.strip() else "")
                    if out:
                        yield json.dumps({"out": out}, ensure_ascii=False) + "\n"
            elif proc.poll() is not None:
                break
            if time.time() > deadline:
                os.killpg(proc.pid, signal.SIGTERM)
                yield json.dumps({"out": f"\n[시간 초과 {SHELL_TIMEOUT}s — 종료됨]\n"}, ensure_ascii=False) + "\n"
                break
        if buf:
            out = buf.decode("utf-8", errors="replace")
            if CWD_MARK in out:
                out, _, tail = out.partition(CWD_MARK)
                new_cwd = tail.strip() or new_cwd
            if out.strip():
                yield json.dumps({"out": out}, ensure_ascii=False) + "\n"
        code = proc.wait(timeout=5)
        yield json.dumps({"exit": code, "cwd": new_cwd}, ensure_ascii=False) + "\n"
    finally:  # 브라우저가 끊거나 '중지'를 누르면 프로세스 그룹 전체 종료
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                os.killpg(proc.pid, signal.SIGKILL)
