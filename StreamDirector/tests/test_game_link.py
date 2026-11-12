"""게임 연동용 기능: /ws 채팅 오버레이, 'active' 세션 별칭, 디스코드 봇 알림 루프."""

import asyncio

from starlette.testclient import TestClient

from streamdirector.discord_bot import announce_loop
from streamdirector.schemas import ChatMessage, Donation, GameEvent
from streamdirector.server import build_app


def test_overlay_ws_relays_chat_filters_abuse_and_sends_events():
    app, state = build_app(collectors=False)
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        orch = state.orch
        client.portal.call(lambda: orch.ingest_chat("active", [ChatMessage(user_id="a", nickname="시청자", text="보스 소환해줘")]))
        chat = ws.receive_json()
        assert (chat["type"], chat["user"], chat["text"], chat["filtered"]) == ("chat", "시청자", "보스 소환해줘", False)
        client.portal.call(lambda: orch.ingest_chat("active", [ChatMessage(user_id="b", nickname="t", text="시발 노잼")]))
        bad = ws.receive_json()
        assert bad["filtered"] and "시발" not in bad["text"]

        client.portal.call(lambda: orch.ingest_donation("active", Donation(user_id="c", nickname="큰손", amount=10000,
                                                                           text="보스 소환해줘")))
        assert ws.receive_json()["type"] == "donation"
        ev = ws.receive_json()
        assert ev["type"] == "event" and ev["donor"] == "큰손" and ev["donation_amount"] == 10000


def test_active_alias_follows_latest_session():
    app, state = build_app(collectors=False)
    orch = state.orch
    orch.active_session_id = "s1"
    orch.ingest_chat("active", [ChatMessage(user_id="u", text="힐 줘")])
    assert len(orch.sessions["s1"].buffer) == 1
    assert orch.resolve("active") == "s1" and orch.resolve("other") == "other"


async def test_discord_announce_loop_skips_old_session_events():
    calls = []
    responses = [
        {"session_id": "s1", "events": [], "last_seq": 5},  # 첫 응답: 기존 이벤트는 건너뜀
        {"session_id": "s1", "events": [GameEvent(event_type="spawn_boss", seq=6).model_dump(mode="json")], "last_seq": 6},
    ]

    class Link:
        async def call(self, tool, args):
            calls.append(args["since_seq"])
            if not responses:
                raise asyncio.CancelledError
            return responses.pop(0)

    announced = []

    class Bot:
        async def announce(self, sid, ev):
            announced.append((sid, ev.event_type.value))

    try:
        await announce_loop(Link(), Bot())
    except asyncio.CancelledError:
        pass
    assert calls == [0, 5, 6] and announced == [("s1", "spawn_boss")]
