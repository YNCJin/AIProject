"""디스코드 테스트 봇 - MCP 서버와 분리된 별도 프로세스.

  디스코드 채널 ──(채팅 / `/후원 1000 메시지`)──▶ 이 봇 ──MCP──▶ StreamDirector 서버 ──MCP──▶ 게임
                ◀──────────── 이벤트 발동 알림 ────────────┘ (poll_events 롱폴링)

실행:  python -m streamdirector.discord_bot     (서버: python -m streamdirector.server 를 먼저 실행)
설정:  .env 의 DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_GUILD_ID, STREAMDIRECTOR_MCP_URL
채팅은 서버의 'active' 세션(가장 최근에 시작된 게임 판)으로 들어간다.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import AsyncExitStack
from typing import Any

from mcp import Client

from .collectors.discord_bot import DiscordCollector
from .config import settings
from .logging_setup import setup_logging
from .schemas import ChatMessage, Donation, GameEvent

log = logging.getLogger("streamdirector.discord_bot")


class BackendLink:
    """StreamDirector MCP 서버 연결 (끊기면 다음 호출 때 재연결)."""

    def __init__(self, url: str):
        self.url = url
        self._client: Client | None = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()

    async def _ensure(self) -> Client:
        async with self._lock:
            if self._client is None:
                self._stack = AsyncExitStack()
                self._client = await self._stack.enter_async_context(Client(self.url, read_timeout_seconds=20))
                log.info("connected to StreamDirector %s", self.url)
            return self._client

    async def reset(self) -> None:
        async with self._lock:
            if self._stack:
                try:
                    await self._stack.aclose()
                except Exception:
                    pass
            self._client = self._stack = None

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(2):
            try:
                res = await (await self._ensure()).call_tool(tool, args)
                if res.is_error:
                    raise RuntimeError(f"{tool} error: {res.content}")
                return res.structured_content or json.loads(res.content[0].text)
            except RuntimeError:
                raise
            except Exception:
                await self.reset()
                if attempt:
                    raise
        return {}


async def announce_loop(link: BackendLink, bot: DiscordCollector) -> None:
    """서버에서 발동된 이벤트를 디스코드 채널에 알린다. 게임 판이 바뀌면 새 세션부터 따라간다."""
    session_id, since = None, 0
    while True:
        try:
            r = await link.call("poll_events", {"session_id": "active", "since_seq": since, "wait_ms": 10000})
        except Exception as e:
            log.warning("poll_events failed: %s (retry in 3s)", e)
            await asyncio.sleep(3)
            continue
        if r["session_id"] != session_id:
            # 새 판: 이전 이벤트는 건너뛰고 지금부터 알림
            session_id, since = r["session_id"], r["last_seq"]
            continue
        for ev in r["events"]:
            await bot.announce(session_id, GameEvent.model_validate(ev))
        since = max(since, r["last_seq"])


async def run() -> None:
    setup_logging()
    if not settings.discord_bot_token:
        raise SystemExit(".env 에 DISCORD_BOT_TOKEN 을 입력하세요")
    if settings.discord_mode == "embedded":
        log.warning("DISCORD_MODE=embedded 이면 서버가 이미 봇을 실행합니다. 둘 중 하나만 쓰세요.")
    link = BackendLink(settings.streamdirector_mcp_url)

    async def on_chat(msg: ChatMessage) -> None:
        try:
            await link.call("ingest_chat", {"session_id": "active", "messages": [msg.model_dump(mode="json")]})
        except Exception as e:
            log.warning("ingest_chat failed: %s", e)

    async def on_donation(don: Donation) -> dict[str, Any]:
        try:
            return await link.call("ingest_donation", {"session_id": "active", "donation": don.model_dump(mode="json")})
        except Exception as e:
            log.warning("ingest_donation failed: %s", e)
            return {"mode": "error", "result": {"status": "error", "detail": "AI 서버 연결 실패"}}

    bot = DiscordCollector(settings.discord_bot_token, on_chat, on_donation,
                           settings.discord_channel_id, settings.discord_guild_id)
    bot.start()
    try:
        await announce_loop(link, bot)
    finally:
        await bot.stop()
        await link.reset()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
