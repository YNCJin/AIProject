from streamdirector.pipeline.event_engine import EventEngine, clamp_event
from streamdirector.pipeline.validator import validate_batch
from streamdirector.schemas import (ChatLabel, EventType, GameEvent, GameState, Intent, ModeratedMessage,
                                    ModerationResult)


def _mod(*pairs):
    return ModerationResult(accepted=[ModeratedMessage(user_id=u, text=t, label=ChatLabel.COMMAND, intent=i, weight=w)
                                      for u, t, i, w in pairs])


def test_one_vote_per_user_and_donation_weight():
    b = validate_batch(_mod(("a", "보스", Intent.SPAWN_BOSS, 1), ("a", "보스!!", Intent.SPAWN_BOSS, 1),
                            ("b", "힐", Intent.HEAL_PLAYER, 1), ("c", "힐", Intent.HEAL_PLAYER, 1),
                            ("d", "보스", Intent.SPAWN_BOSS, 5)), GameState())
    assert b.ok and b.top.intent == Intent.SPAWN_BOSS and b.top.votes == 6 and b.total_voters == 4


def test_empty_batch_skips_llm():
    assert not validate_batch(ModerationResult(), GameState()).ok


def test_clamping_protects_balance():
    gs = GameState(wave=1, player_hp=10, player_max_hp=100)
    e, notes = clamp_event(GameEvent(event_type=EventType.SPAWN_ENEMIES, intensity=5, count=50, variant="dragon"), gs)
    assert e.count <= 3 and e.intensity == 1 and e.variant == "normal" and notes
    e, _ = clamp_event(GameEvent(event_type=EventType.BUFF_PLAYER, variant="invincible", duration_sec=60), GameState())
    assert e.duration_sec <= 8
    e, _ = clamp_event(GameEvent(event_type=EventType.SPAWN_BOSS, count=9, intensity=5), GameState(wave=1))
    assert e.count == 1 and e.intensity <= 2


async def test_engine_rejects_off_vote_event_and_falls_back():
    from streamdirector.llm.gemini_client import GeminiClient
    llm = GeminiClient(mock_responder=lambda k, p: {"event_type": "spawn_boss", "intensity": 5, "count": 1,
                                                    "duration_sec": 0, "variant": "boss", "overlay_text": "x",
                                                    "reason": "x"})
    eng = EventEngine(llm=llm)
    b = validate_batch(_mod(("a", "힐", Intent.HEAL_PLAYER, 1)), GameState())
    ev, meta = await eng.generate(b)
    assert ev.event_type == EventType.HEAL_PLAYER and meta["fallback"]


async def test_engine_schema_violation_counted():
    from streamdirector.llm.gemini_client import GeminiClient
    eng = EventEngine(llm=GeminiClient(mock_responder=lambda k, p: {"event_type": "explode_world"}))
    b = validate_batch(_mod(("a", "보스", Intent.SPAWN_BOSS, 1)), GameState())
    ev, meta = await eng.generate(b)
    assert ev.event_type == EventType.SPAWN_BOSS and eng.stats["schema_violations"] == 1
