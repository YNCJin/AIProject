"""검열 에이전트를 독립 MCP 서버로 실행 (기본 http://127.0.0.1:8766/mcp).

메인 서버에서 MODERATION_AGENT_URL=http://127.0.0.1:8766/mcp 로 지정하면
채팅 전처리를 이 별도 프로세스(에이전트)가 담당한다.
"""

from __future__ import annotations

import time
from typing import Any

from mcp.server.mcpserver import MCPServer

from . import __version__
from .agents.moderation_agent import ModerationAgent
from .config import settings
from .logging_setup import setup_logging
from .schemas import ChatMessage


def create_moderation_server(agent: ModerationAgent | None = None) -> MCPServer:
    agent = agent or ModerationAgent()
    started = time.time()
    mcp = MCPServer(name="streamdirector-moderation", title="Chat Moderation Agent", version=__version__,
                    instructions="채팅 전처리(분탕·욕설·도배·광고·무관 채팅 차단) 에이전트.")

    @mcp.tool(description="채팅 묶음 검열. weights: 메시지 인덱스(문자열) -> 후원 가중치.")
    async def moderate_chat(messages: list[ChatMessage], weights: dict[str, float] | None = None,
                            session_id: str = "", use_llm: bool = True) -> dict[str, Any]:
        w = {int(k): v for k, v in (weights or {}).items()}
        res = await agent.moderate(messages, w, session_id=session_id, use_llm=use_llm)
        return {"result": res.model_dump(mode="json")}

    @mcp.tool(description="사용자 차단")
    async def block_user(user_id: str) -> dict[str, Any]:
        agent.block_user(user_id)
        return {"blocked": user_id}

    @mcp.tool(description="사용자 차단 해제")
    async def unblock_user(user_id: str) -> dict[str, Any]:
        agent.unblock_user(user_id)
        return {"unblocked": user_id}

    @mcp.tool(description="에이전트 상태/통계")
    async def agent_status() -> dict[str, Any]:
        return {"uptime_sec": round(time.time() - started, 1), **agent.status(), "stats": dict(agent.stats),
                "blocked_users": len(agent.blocked_users)}

    return mcp


def main() -> None:
    import contextlib

    import uvicorn

    setup_logging()
    agent = ModerationAgent()
    app = create_moderation_server(agent).streamable_http_app(json_response=True, host=settings.host)
    inner = app.router.lifespan_context

    @contextlib.asynccontextmanager
    async def lifespan(a):
        import asyncio

        task = asyncio.create_task(agent.load_models())  # 로컬 모델 백그라운드 로딩
        async with inner(a):
            yield
        task.cancel()

    app.router.lifespan_context = lifespan
    uvicorn.run(app, host=settings.host, port=settings.moderation_port, log_level="warning")


if __name__ == "__main__":
    main()
