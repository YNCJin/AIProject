"""디스코드 테스트 수집기 - 방송 플랫폼 없이 채팅 연동/후원을 시험하기 위한 봇.

- 지정 채널(DISCORD_CHANNEL_ID, 비우면 모든 채널)의 일반 메시지 -> 시청자 채팅
- 슬래시 명령어 `/후원 금액 메시지`  -> 후원 (예: /후원 1000 보스 소환해줘)
- 텍스트로 `/후원 1000 메시지` 를 입력해도 동일하게 처리 (슬래시 명령 동기화 전 대비)
- 이벤트가 발동되면 같은 채널에 결과를 알려준다

디스코드 개발자 포털에서 봇의 'MESSAGE CONTENT INTENT' 를 켜야 한다.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import discord
from discord import app_commands

from ..schemas import ChatMessage, Donation, GameEvent

log = logging.getLogger("streamdirector.discord")

DONATION_TEXT = re.compile(r"^/후원\s+([0-9][0-9,]*)\s*(.*)$", re.S)
MAX_TEST_DONATION = 1_000_000

ChatSink = Callable[[ChatMessage], Awaitable[None] | None]
DonationSink = Callable[[Donation], Awaitable[dict[str, Any]]]


def parse_donation_text(text: str) -> tuple[int, str] | None:
    m = DONATION_TEXT.match(text.strip())
    if not m:
        return None
    return int(m.group(1).replace(",", "")), m.group(2).strip()


def describe_donation_result(amount: int, res: dict[str, Any]) -> str:
    if res.get("mode") == "error":
        return f"⚠️ {amount:,}원 후원을 처리하지 못했습니다 ({res.get('result', {}).get('detail', '서버 오류')})"
    if res.get("mode") == "instant":
        r = res.get("result", {})
        ev = r.get("event")
        if ev:
            return f"💸 {amount:,}원 고액 후원 → 즉시 발동: **{ev['event_type']}** ({ev.get('overlay_text', '')})"
        return f"💸 {amount:,}원 후원 접수 - 이벤트 미발동 ({r.get('status')}: {r.get('detail', '')})"
    return f"💸 {amount:,}원 후원 접수 → 다음 투표에 가중치 x{res.get('weight')} 반영"


class DiscordCollector:
    def __init__(self, token: str, on_chat: ChatSink, on_donation: DonationSink,
                 channel_id: int | None = None, guild_id: int | None = None):
        self.token = token
        self.on_chat = on_chat
        self.on_donation = on_donation
        self.channel_id = channel_id
        self.guild_id = guild_id
        self.status: dict[str, Any] = {"state": "idle", "chats": 0, "donations": 0, "last_error": None,
                                       "user": None, "latency_ms": None}
        intents = discord.Intents.default()
        intents.message_content = True
        self.client = discord.Client(intents=intents)
        self.tree = app_commands.CommandTree(self.client)
        self._task: asyncio.Task | None = None
        self._register()

    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _register(self) -> None:
        client, tree = self.client, self.tree

        @tree.command(name="후원", description="테스트 후원 (예: /후원 1000 보스 소환해줘)")
        @app_commands.describe(금액="후원 금액(원)", 메시지="후원 메시지 (게임 요청)")
        async def donate(interaction: discord.Interaction, 금액: app_commands.Range[int, 1, MAX_TEST_DONATION],
                         메시지: str = "") -> None:
            await interaction.response.defer(thinking=True)
            don = Donation(user_id=f"discord:{interaction.user.id}", nickname=interaction.user.display_name,
                           amount=금액, text=메시지)
            self.status["donations"] += 1
            res = await self.on_donation(don)
            await interaction.followup.send(f"{interaction.user.display_name}: {메시지}\n"
                                            + describe_donation_result(금액, res))

        @client.event
        async def on_ready() -> None:
            self.status.update(state="connected", user=str(client.user), last_error=None)
            try:
                if self.guild_id:
                    guild = discord.Object(id=self.guild_id)
                    tree.copy_global_to(guild=guild)
                    await tree.sync(guild=guild)  # 길드 동기화는 즉시 반영
                else:
                    await tree.sync()
            except Exception as e:
                log.warning("slash command sync failed: %s", e)
            log.info("Discord bot ready as %s", client.user)

        @client.event
        async def on_message(message: discord.Message) -> None:
            if message.author.bot:
                return
            if self.channel_id and message.channel.id != self.channel_id:
                return
            text = message.content or ""
            parsed = parse_donation_text(text)
            if parsed:
                amount, body = parsed
                if not 0 < amount <= MAX_TEST_DONATION:
                    await message.reply("금액은 1 ~ 1,000,000 사이로 입력해주세요.")
                    return
                self.status["donations"] += 1
                res = await self.on_donation(Donation(user_id=f"discord:{message.author.id}",
                                                      nickname=message.author.display_name, amount=amount, text=body))
                await message.reply(describe_donation_result(amount, res))
                return
            if not text.strip():
                return
            self.status["chats"] += 1
            r = self.on_chat(ChatMessage(user_id=f"discord:{message.author.id}",
                                         nickname=message.author.display_name, text=text[:2000],
                                         ts=message.created_at.timestamp(), platform="discord"))
            if asyncio.iscoroutine(r):
                await r

    async def announce(self, session_id: str, event: GameEvent) -> None:
        """이벤트 발동 알림을 테스트 채널에 게시."""
        if not self.channel_id or not self.client.is_ready():
            return
        ch = self.client.get_channel(self.channel_id)
        if ch is None:
            return
        extra = f" x{event.count}" if event.count else (f" {event.duration_sec:.0f}s" if event.duration_sec else "")
        who = f" (후원: {event.donor})" if event.donor else f" (참여 {event.supporters}명, {event.vote_share:.0%})"
        await ch.send(f"🎮 [{session_id}] **{event.event_type.value}** {event.variant}{extra} · 강도 {event.intensity}"
                      f"{who}\n> {event.overlay_text}")

    def start(self) -> None:
        if not self.configured:
            self.status["state"] = "disabled"
            return
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        self.status["state"] = "connecting"
        try:
            await self.client.start(self.token)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.status.update(state="error", last_error=f"{type(e).__name__}: {e}")
            log.error("Discord bot stopped: %s", e)

    async def stop(self) -> None:
        if not self.client.is_closed():
            await self.client.close()
        if self._task:
            self._task.cancel()
        self.status["state"] = "stopped"

    def latency_ms(self) -> float | None:
        lat = self.client.latency
        return round(lat * 1000, 1) if lat == lat and lat != float("inf") else None
