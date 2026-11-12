import asyncio
import time

from mcp import Client

from streamdirector.server import create_server, create_state


async def _client():
    state = create_state()
    await state.start(collectors=False)
    return state, Client(create_server(state))


async def test_full_game_flow_over_mcp():
    state, client = await _client()
    async with client as c:
        assert (await c.call_tool("ping", {"client_ts": time.time()})).structured_content["pong"]
        h = (await c.call_tool("health_check", {})).structured_content
        assert h["db"]["ok"] and h["llm"]["mode"] == "mock"

        sid = (await c.call_tool("start_play_session", {"player_id": "p9", "nickname": "t"})).structured_content["session_id"]
        await c.call_tool("update_game_state", {"session_id": sid, "game_state": {"wave": 5, "player_hp": 90}})

        # 윈도우 배칭 -> 롱폴링으로 이벤트 수신
        msgs = [{"user_id": f"u{i}", "text": "보스 소환해줘"} for i in range(5)] + [{"user_id": "x", "text": "시발"}]
        await c.call_tool("ingest_chat", {"session_id": sid, "messages": msgs})
        t = time.perf_counter()
        polled = (await c.call_tool("poll_events", {"session_id": sid, "since_seq": 0, "wait_ms": 5000})).structured_content
        assert polled["events"] and polled["events"][0]["event_type"] == "spawn_boss"
        assert time.perf_counter() - t < 3.0

        # 같은 의도는 쿨다운
        r = (await c.call_tool("process_chat_batch", {"session_id": sid, "messages": msgs[:3]})).structured_content
        assert r["status"] == "throttled"

        # 고액 후원 = 쿨다운 무시 즉시 발동, 소액 = 가중치
        big = (await c.call_tool("ingest_donation", {"session_id": sid, "donation": {
            "user_id": "rich", "nickname": "큰손", "amount": 10000, "text": "보스 소환해줘"}})).structured_content
        assert big["mode"] == "instant" and big["result"]["event"]["donor"] == "큰손"
        small = (await c.call_tool("ingest_donation", {"session_id": sid, "donation": {
            "user_id": "s", "amount": 1000, "text": "힐 줘"}})).structured_content
        assert small == {"mode": "vote", "weight": 2.0}

        # 욕설 후원은 이벤트 없음
        bad = (await c.call_tool("ingest_donation", {"session_id": sid, "donation": {
            "user_id": "b", "amount": 50000, "text": "시발 보스"}})).structured_content
        assert bad["result"]["status"] == "no_event"

        # 플레이/세이브 데이터
        await c.call_tool("record_play_data", {"session_id": sid, "wave": 5, "hp": 40, "level": 3, "score": 500, "kills": 30})
        await c.call_tool("save_game", {"player_id": "p9", "slot": 1, "data": {"gold": 5}})
        conflict = await c.call_tool("save_game", {"player_id": "p9", "slot": 1, "data": {"gold": 6}, "expected_version": 0})
        assert conflict.is_error
        loaded = (await c.call_tool("load_game", {"player_id": "p9", "slot": 1})).structured_content
        assert loaded["found"] and loaded["save"]["data"] == {"gold": 5}
        end = (await c.call_tool("end_play_session", {"session_id": sid, "status": "cleared", "final_wave": 6,
                                                      "score": 800, "kills": 50, "level": 4, "ai_events_applied": 2})).structured_content
        assert end["status"] == "cleared"

        m = (await c.call_tool("get_metrics", {})).structured_content
        assert m["counters"]["events"] >= 2 and m["schema_compliance"] == 1.0
    await state.stop()


async def test_poll_timeout_returns_empty():
    state, client = await _client()
    async with client as c:
        t = time.perf_counter()
        r = (await c.call_tool("poll_events", {"session_id": "empty", "wait_ms": 300})).structured_content
        assert r["events"] == [] and 0.25 < time.perf_counter() - t < 1.5
    await state.stop()
