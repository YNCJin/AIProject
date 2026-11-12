"""별도 프로세스로 실행 중인 검열 에이전트(MCP 서버)를 호출하는 클라이언트.

MODERATION_AGENT_URL 이 설정되면 오케스트레이터는 로컬 ModerationAgent 대신 이것을 쓴다.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import AsyncExitStack

from mcp import Client

from ..schemas import ChatMessage, ModerationResult

log = logging.getLogger("streamdirector.moderation.remote")


class RemoteModerationAgent:
    def __init__(self, url: str):
        self.url = url
        self._client: Client | None = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()

    async def _ensure(self) -> Client:
        async with self._lock:
            if self._client is None:
                self._stack = AsyncExitStack()
                self._client = await self._stack.enter_async_context(Client(self.url, read_timeout_seconds=5))
            return self._client

    async def close(self) -> None:
        if self._stack:
            await self._stack.aclose()
        self._client = self._stack = None

    async def moderate(self, messages: list[ChatMessage], weights: dict[int, float] | None = None,
                       session_id: str = "", use_llm: bool = True) -> ModerationResult:
        args = {"messages": [m.model_dump() for m in messages],
                "weights": {str(k): v for k, v in (weights or {}).items()},
                "session_id": session_id, "use_llm": use_llm}
        try:
            client = await self._ensure()
            res = await client.call_tool("moderate_chat", args)
        except Exception:
            await self.close()  # 연결이 끊겼으면 1회 재연결
            client = await self._ensure()
            res = await client.call_tool("moderate_chat", args)
        if res.is_error:
            raise RuntimeError(f"remote moderation error: {res.content}")
        data = res.structured_content or json.loads(res.content[0].text)
        return ModerationResult.model_validate(data.get("result", data))

    # 운영자 차단은 원격 에이전트에도 전달
    async def block_user(self, user_id: str) -> None:
        await (await self._ensure()).call_tool("block_user", {"user_id": user_id})

    async def unblock_user(self, user_id: str) -> None:
        await (await self._ensure()).call_tool("unblock_user", {"user_id": user_id})

    async def status_async(self) -> dict:
        """원격 에이전트의 백엔드/모델 로딩 상태."""
        try:
            res = await (await self._ensure()).call_tool("agent_status", {})
            data = res.structured_content or json.loads(res.content[0].text)
            return {k: data[k] for k in ("backend", "toxicity", "intent", "llm") if k in data}
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}
