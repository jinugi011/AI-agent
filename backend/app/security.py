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

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Optional

from .config import settings

TOKEN_FILE = Path(settings.state_dir) / "remote_token"          # 기본 토큰 (평문, 권한 600)
TOKENS_FILE = Path(settings.state_dir) / "remote_tokens.json"  # 기기별 발급 토큰 (해시만 저장)
ACCESS_LOG = Path(settings.state_dir) / "remote_access.log"
REMOTE_HEADERS = ("cf-connecting-ip", "cf-ray", "tailscale-user-login", "x-forwarded-for")
CF_HEADERS = ("cf-connecting-ip", "cf-ray")
# 토큰 없이 통과시킬 Tailscale 계정 (한 줄에 하나). tailscale.sh on 이 소유자 계정을 기록한다.
TS_USERS_FILE = Path(settings.state_dir) / "tailscale_users.txt"
_TAILNET_NETS = [ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48")]

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
    ("POST", r"/api/attachments"),
    ("POST", r"/api/vision/inspect"),
    ("GET", r"/api/images/status"),
    ("POST", r"/api/images/generate"),
    ("GET", r"/api/images/search"),
    ("GET", r"/api/attachments"),
    ("GET", r"/api/attachments/[0-9a-f]{12}"),
    ("DELETE", r"/api/attachments/[0-9a-f]{12}"),
]
_ALLOW_RE = [(m, re.compile(f"^{p}$")) for m, p in REMOTE_ALLOW]


def is_remote(headers) -> bool:
    return any(h in headers for h in REMOTE_HEADERS)


def _trusted_logins() -> set:
    users = {u.strip().lower() for u in os.getenv("AGENT_TS_USERS", "").split(",") if u.strip()}
    try:
        users |= {l.strip().lower() for l in TS_USERS_FILE.read_text(encoding="utf-8").splitlines()
                  if l.strip() and not l.startswith("#")}
    except FileNotFoundError:
        pass
    return users


def trusted_tailscale_user(headers) -> Optional[str]:
    """Tailscale serve 가 붙여 주는 신원(Tailscale-User-Login)이 허용 목록의 계정이면 그 계정을 돌려준다.
    - Cloudflare 경유 요청(Cf-* 헤더)은 클라이언트가 헤더를 위조할 수 있으므로 신원 헤더를 믿지 않는다.
    - 접속 IP(X-Forwarded-For)가 Tailscale 대역(100.64.0.0/10)이어야 한다."""
    if any(h in headers for h in CF_HEADERS):
        return None
    login = (headers.get("tailscale-user-login") or "").strip().lower()
    if not login:
        return None
    try:
        ip = ipaddress.ip_address((headers.get("x-forwarded-for") or "").split(",")[0].strip())
    except ValueError:
        return None
    if not any(ip in net for net in _TAILNET_NETS):
        return None
    return login if login in _trusted_logins() else None


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


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _load_tokens() -> list:
    try:
        return json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_tokens(items: list) -> None:
    tmp = TOKENS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(TOKENS_FILE)


def list_tokens() -> list:
    return [{k: v for k, v in t.items() if k != "hash"} for t in _load_tokens()]


def issue_token(name: str) -> tuple:
    """기기별 토큰 발급. 평문은 이 순간에만 돌려주고 서버에는 해시만 저장한다."""
    name = (name or "").strip()[:60] or "이름 없음"
    token = "la_" + secrets.token_urlsafe(32)
    rec = {"id": secrets.token_hex(4), "name": name, "hash": _hash(token), "prefix": token[:7],
           "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "last_used": ""}
    items = _load_tokens()
    items.append(rec)
    _save_tokens(items)
    return {k: v for k, v in rec.items() if k != "hash"}, token


def revoke_token(token_id: str) -> bool:
    items = _load_tokens()
    kept = [t for t in items if t["id"] != token_id]
    if len(kept) == len(items):
        return False
    _save_tokens(kept)
    return True


def token_ok(authorization: Optional[str]) -> bool:
    if not authorization or not authorization.startswith("Bearer "):
        return False
    given = authorization[7:].strip()
    expected = get_token(create=False)
    if expected and hmac.compare_digest(given.encode(), expected.encode()):
        return True
    h = _hash(given)
    items = _load_tokens()
    for t in items:
        if hmac.compare_digest(h, t["hash"]):
            now = time.strftime("%Y-%m-%dT%H:%M:%S")
            if t.get("last_used", "")[:16] != now[:16]:  # 1분에 한 번만 기록
                t["last_used"] = now
                _save_tokens(items)
            return True
    return False


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
            "auth": "tailscale-identity" if trusted_tailscale_user(headers) else "token",
            "method": method, "path": path, "status": status,
        }, ensure_ascii=False)
        with ACCESS_LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass
