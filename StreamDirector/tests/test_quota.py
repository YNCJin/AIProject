import asyncio

from streamdirector.llm.quota import QuotaGuard


def test_rpm_and_daily_limits(tmp_path):
    g = QuotaGuard(rpm_limit=3, daily_limit=5, path=tmp_path / "u.json")
    assert [g.try_acquire() == "" for _ in range(4)] == [True, True, True, False]
    g._minute.clear()  # 1분 경과 가정
    assert g.try_acquire() == "" and g.try_acquire() == ""
    assert "daily" in g.try_acquire()
    # 재시작해도 일일 카운트 유지
    g2 = QuotaGuard(rpm_limit=0, daily_limit=5, path=tmp_path / "u.json")
    assert g2.usage()["today"] == 5 and "daily" in g2.try_acquire()


async def test_engine_uses_fallback_when_guard_blocks(monkeypatch):
    from streamdirector.llm import gemini_client
    from streamdirector.pipeline.event_engine import EventEngine
    from streamdirector.pipeline.validator import validate_batch
    from streamdirector.schemas import ChatLabel, GameState, Intent, ModeratedMessage, ModerationResult

    class Live(gemini_client.GeminiClient):
        @property
        def mode(self):
            return "live"

    monkeypatch.setattr(gemini_client, "quota_guard", QuotaGuard(0, 1, gemini_client.settings.db_path.parent / "q.json"))
    gemini_client.quota_guard.try_acquire()  # 한도 소진
    called = False

    class Fake:
        class aio:
            class models:
                @staticmethod
                async def generate_content(**kw):
                    nonlocal called
                    called = True

    llm = Live()
    llm._client = Fake()
    eng = EventEngine(llm=llm)
    b = validate_batch(ModerationResult(accepted=[ModeratedMessage(user_id="a", text="보스", label=ChatLabel.COMMAND,
                                                                   intent=Intent.SPAWN_BOSS)]), GameState())
    ev, meta = await eng.generate(b)
    assert meta["fallback"] and "quota guard" in meta["error"] and not called
