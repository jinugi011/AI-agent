"""LLM 호출 클라이언트.

기본 경로는 Rust 추론 엔진(engine/, llama.cpp + Metal)이며,
엔진이 꺼져 있을 때만 Ollama 로 대체한다.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, List, Optional

from .config import settings


class LLMError(RuntimeError):
    pass


@dataclass
class LLMResult:
    text: str
    backend: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    tokens_per_second: float = 0.0
    finish_reason: str = ""


def _post_json(url: str, body: dict, timeout: float) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise LLMError(f"engine HTTP {exc.code}: {detail}") from exc


def engine_health(timeout: float = 2.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(f"{settings.engine_url}/health", timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def chat(
    messages: List[Dict[str, str]],
    *,
    max_tokens: int = 4096,
    temperature: float = 0.2,
    grammar: Optional[str] = None,
    stop: Optional[List[str]] = None,
) -> LLMResult:
    try:
        res = _post_json(
            f"{settings.engine_url}/generate",
            {
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "grammar": grammar,
                "stop": stop or [],
            },
            settings.engine_timeout,
        )
        return LLMResult(
            text=res["text"],
            backend="rust-engine",
            prompt_tokens=res.get("prompt_tokens", 0),
            completion_tokens=res.get("completion_tokens", 0),
            tokens_per_second=res.get("tokens_per_second", 0.0),
            finish_reason=res.get("finish_reason", ""),
        )
    except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
        if not settings.llm_fallback_ollama:
            raise LLMError(f"Rust 엔진에 연결할 수 없습니다 ({settings.engine_url}): {exc}") from exc
        return _ollama_chat(messages, max_tokens=max_tokens, temperature=temperature, stop=stop, cause=exc)


def _ollama_chat(messages, *, max_tokens, temperature, stop, cause) -> LLMResult:
    try:
        import ollama

        client = ollama.Client(host=settings.ollama_host)
        res = client.chat(
            model=settings.default_model,
            messages=messages,
            options={"temperature": temperature, "num_predict": max_tokens, "stop": stop or None},
        )
        return LLMResult(text=res["message"]["content"], backend=f"ollama:{settings.default_model}")
    except Exception as exc:  # noqa: BLE001
        raise LLMError(
            f"LLM 백엔드를 사용할 수 없습니다. Rust 엔진({settings.engine_url})을 실행하세요. "
            f"engine: {cause} / ollama: {exc}"
        ) from exc


def extract_json(text: str):
    """모델 출력에서 첫 번째 JSON 객체/배열을 추출한다."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise LLMError(f"모델 출력에서 JSON 을 찾을 수 없습니다: {text[:300]}")
