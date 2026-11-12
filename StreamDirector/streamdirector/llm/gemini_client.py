"""Google AI Studio (Gemini API) 래퍼.

- Structured Output: response_mime_type=application/json + response_json_schema 로 JSON 스키마 강제
- 타임아웃: 실시간성(채팅~반영 3초)을 위해 호출별 타임아웃을 짧게 두고, 실패 시 호출자가 폴백 처리
- LLM_MODE=mock 이면 네트워크 없이 결정적 응답을 돌려준다 (오프라인 시연·통신 검증용)
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..config import settings
from .quota import QuotaGuard

# 무료 할당량은 프로젝트 단위이므로 프로세스 전체가 하나의 가드를 공유한다
quota_guard = QuotaGuard(settings.gemini_rpm_limit, settings.gemini_daily_limit,
                         settings.db_path.parent / "gemini_usage.json")

log = logging.getLogger("streamdirector.llm")


class LLMUnavailable(RuntimeError):
    pass


@dataclass
class LLMResponse:
    data: Any  # 파싱된 JSON
    raw_text: str
    model: str
    latency_ms: float
    usage: dict[str, int]


class GeminiClient:
    def __init__(self, mock_responder: Callable[[str, str], Any] | None = None):
        self._client = None
        self._mock_responder = mock_responder
        if settings.llm_mode == "live" and settings.gemini_api_key:
            from google import genai

            self._client = genai.Client(api_key=settings.gemini_api_key)

    @property
    def mode(self) -> str:
        if settings.llm_mode == "mock":
            return "mock"
        return "live" if self._client else "off"

    async def generate_json(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        json_schema: dict[str, Any],
        timeout_sec: float,
        temperature: float = 0.2,
        max_output_tokens: int = 1024,
        mock_key: str = "",
    ) -> LLMResponse:
        start = time.perf_counter()
        if self.mode == "mock":
            if not self._mock_responder:
                raise LLMUnavailable("mock responder not configured")
            data = self._mock_responder(mock_key, user_prompt)
            await asyncio.sleep(0.02)  # 네트워크 지연 흉내
            raw = json.dumps(data, ensure_ascii=False)
            return LLMResponse(data, raw, f"mock:{model}", (time.perf_counter() - start) * 1000, {})
        if self.mode == "off":
            raise LLMUnavailable("GEMINI_API_KEY 가 설정되지 않았거나 LLM_MODE=off")
        blocked = quota_guard.try_acquire()
        if blocked:
            raise LLMUnavailable(blocked)

        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            response_mime_type="application/json",
            response_json_schema=json_schema,
            # 2.5 계열은 thinking 을 끄면 지연이 크게 줄어든다 (flash-lite 는 기본 off)
            thinking_config=types.ThinkingConfig(thinking_budget=0) if "2.5" in model else None,
        )
        try:
            resp = await asyncio.wait_for(
                self._client.aio.models.generate_content(model=model, contents=user_prompt, config=config),
                timeout=timeout_sec,
            )
        except TimeoutError as e:
            raise LLMUnavailable(f"timeout after {timeout_sec}s") from e
        except Exception as e:  # google.genai.errors.APIError 등
            raise LLMUnavailable(f"{type(e).__name__}: {e}") from e

        raw = resp.text or ""
        latency = (time.perf_counter() - start) * 1000
        usage = {}
        if resp.usage_metadata:
            usage = {
                "prompt_tokens": resp.usage_metadata.prompt_token_count or 0,
                "output_tokens": resp.usage_metadata.candidates_token_count or 0,
            }
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise LLMUnavailable(f"invalid JSON from model: {raw[:200]}") from e
        return LLMResponse(data, raw, model, latency, usage)

    async def probe(self, model: str) -> dict[str, Any]:
        """API 키/모델 접근 가능 여부를 최소 비용으로 확인 (health_check 용)."""
        if self.mode != "live":
            return {"mode": self.mode, "ok": self.mode == "mock"}
        start = time.perf_counter()
        try:
            r = await self.generate_json(
                model=model,
                system_prompt="Reply with JSON.",
                user_prompt='Return {"ok": true}',
                json_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]},
                timeout_sec=5.0,
                max_output_tokens=20,
            )
            return {"mode": "live", "ok": bool(r.data.get("ok")), "model": model, "latency_ms": round(r.latency_ms, 1)}
        except LLMUnavailable as e:
            return {"mode": "live", "ok": False, "model": model, "error": str(e),
                    "latency_ms": round((time.perf_counter() - start) * 1000, 1)}
