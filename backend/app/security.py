"""원격 접근 보안 (Tailscale serve / Cloudflare Tunnel 공통).

- 백엔드는 127.0.0.1 에만 바인드한다. 외부 요청은 tailscale serve 또는 cloudflared 프록시를 거쳐서만 들어온다.
- 프록시를 거친 요청에는 헤더가 붙는다 → '원격'으로 판정.
    Tailscale serve : Tailscale-User-Login, X-Forwarded-For
    Cloudflare      : Cf-Connecting-Ip, Cf-Ray (+ X-Forwarded-For)
- 원격 요청은 API 토큰(Authorization: Bearer …)이 반드시 필요하고, 허용 목록의 기능만 쓸 수 있다.
  서버에서 코드를 실행하는 기능(하네스 실행, 레포 clone, 엔진 시작, 모델 다운로드 등)은 원격에서 차단.
- 같은 맥에서 직접 오는 요청(IDE 로컬 모드)은 기존처럼 토큰 없이 동작한다.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Optional

from .config import settings

TOKEN_FILE = Path(settings.state_dir) / "remote_token"
ACCESS_LOG = Path(settings.state_dir) / "remote_access.log"
REMOTE_HEADERS = ("cf-connecting-ip", "cf-ray", "tailscale-user-login", "x-forwarded-for")

# 원격에서 허용하는 (메서드, 경로 정규식)
REMOTE_ALLOW = [
    ("GET", r"/api/health"),
    ("GET", r"/api/profiles"),
    ("GET", r"/api/models"),
    ("GET", r"/api/engine/status"),
    ("POST", r"/api/context"),
    ("POST", r"/api/style/search"),
    ("GET", r"/api/preferences"),
    ("POST", r"/api/preferences"),
    ("DELETE", r"/api/preferences/[\w-]+"),
    ("POST", r"/api/llm/generate"),
    ("POST", r"/api/remote/index"),
    ("GET", r"/api/remote/projects"),
]
_ALLOW_RE = [(m, re.compile(f"^{p}$")) for m, p in REMOTE_ALLOW]


def is_remote(headers) -> bool:
    return any(h in headers for h in REMOTE_HEADERS)


def get_token(create: bool = True) -> Optional[str]:
    env = os.getenv("AGENT_API_TOKEN")
    if env:
        return env
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip() or None
    if not create:
        return None
    return rotate_token()


def rotate_token() -> str:
    token = "la_" + secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    os.chmod(TOKEN_FILE, 0o600)
    return token


def token_ok(authorization: Optional[str]) -> bool:
    expected = get_token(create=False)
    if not expected or not authorization or not authorization.startswith("Bearer "):
        return False
    return hmac.compare_digest(authorization[7:].strip().encode(), expected.encode())


def remote_allowed(method: str, path: str) -> bool:
    return any(m == method and r.match(path) for m, r in _ALLOW_RE)


def audit(headers, method: str, path: str, status: int) -> None:
    try:
        line = json.dumps({
            "t": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "ip": headers.get("cf-connecting-ip") or (headers.get("x-forwarded-for") or "?").split(",")[0].strip(),
            "country": headers.get("cf-ipcountry", ""),
            "user": headers.get("tailscale-user-login", ""),
            "via": "cloudflare" if "cf-ray" in headers else ("tailscale" if "tailscale-user-login" in headers else "proxy"),
            "method": method, "path": path, "status": status,
        }, ensure_ascii=False)
        with ACCESS_LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass
