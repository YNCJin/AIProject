"""게임 화면 채팅 오버레이용 WebSocket (/ws).

게임의 기존 ChatClient(YNCsurvival/src/game/net/ChatClient.ts)와 같은 메시지 형식을 보내므로
게임은 접속 주소만 바꾸면 된다. AI 이벤트 자체는 MCP(poll_events)로 받고, 이 채널은 화면 표시용이다.

  {"type": "chat", "platform": "discord", "user": "닉네임", "text": "내용", "ts": 1791450000.1, "filtered": false}
  {"type": "donation", "platform": "discord", "user": "닉네임", "amount": 10000, "text": "보스 소환", "ts": ...}
  {"type": "event", "session_id": "...", "event_type": "spawn_boss", "overlay_text": "...", ...}

욕설·광고(규칙 기반 1차 판정)는 화면에 원문을 띄우지 않고 "(필터링된 메시지)"로 바꿔 보낸다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

from .agents import rules
from .schemas import ChatMessage, Donation, GameEvent

log = logging.getLogger("streamdirector.overlay")

MAX_USER_LEN = 20
MAX_TEXT_LEN = 100
FILTERED_TEXT = "(필터링된 메시지)"


def _clean(text: str) -> tuple[str, bool]:
    norm = rules.normalize(text)
    if rules.is_profane(norm) or rules.is_spam(norm):
        return FILTERED_TEXT, True
    return norm[:MAX_TEXT_LEN], False


class OverlayHub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.sent = 0

    async def endpoint(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)
        log.info("overlay client connected (%d)", len(self.clients))
        try:
            while True:
                await ws.receive_text()  # 클라이언트 메시지는 쓰지 않음 (연결 유지용)
        except WebSocketDisconnect:
            pass
        finally:
            self.clients.discard(ws)
            log.info("overlay client disconnected (%d)", len(self.clients))

    def publish(self, message: dict[str, Any]) -> None:
        """동기 콜백에서도 부를 수 있도록 전송은 태스크로 넘긴다."""
        if not self.clients:
            return
        try:
            asyncio.get_running_loop().create_task(self._broadcast(message))
        except RuntimeError:
            pass

    async def _broadcast(self, message: dict[str, Any]) -> None:
        for ws in list(self.clients):
            try:
                await ws.send_json(message)
                self.sent += 1
            except Exception:
                self.clients.discard(ws)

    # ------------------------------------------------------------------ 오케스트레이터 콜백
    def on_chat(self, kind: str, payload: Any) -> None:
        if kind == "chat" and isinstance(payload, ChatMessage):
            text, filtered = _clean(payload.text)
            self.publish({"type": "chat", "platform": payload.platform, "user": (payload.nickname or "익명")[:MAX_USER_LEN],
                          "text": text, "ts": payload.ts, "filtered": filtered})
        elif kind == "donation" and isinstance(payload, Donation):
            text, filtered = _clean(payload.text)
            self.publish({"type": "donation", "platform": "donation", "user": (payload.nickname or "익명")[:MAX_USER_LEN],
                          "amount": payload.amount, "text": text, "ts": payload.ts, "filtered": filtered})

    def on_event(self, session_id: str, event: GameEvent) -> None:
        self.publish({"type": "event", "session_id": session_id, **event.model_dump(mode="json"), "ts": time.time()})
