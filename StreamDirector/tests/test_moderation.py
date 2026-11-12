import json
from pathlib import Path

from streamdirector.agents.moderation_agent import ModerationAgent
from streamdirector.llm.gemini_client import GeminiClient
from streamdirector.schemas import ChatLabel, ChatMessage

DATA = [json.loads(l) for l in (Path(__file__).parent / "data" / "moderation_eval.jsonl").read_text().splitlines() if l]


async def _classify_each(agent, use_llm):
    out = []
    for i, row in enumerate(DATA):
        res = await agent.moderate([ChatMessage(user_id=f"u{i}", text=row["text"])], use_llm=use_llm)
        out.append((row, res))
    return out


async def _eval(use_llm: bool):
    agent = ModerationAgent()
    results = await _classify_each(agent, use_llm)
    bad = [(r, m) for r, m in results if r["label"] in ("ABUSE", "SPAM")]
    blocked = sum(1 for r, m in bad if not m.accepted)
    cmds = [(r, m) for r, m in results if r["label"] == "COMMAND"]
    correct = sum(1 for r, m in cmds if m.accepted and m.accepted[0].intent.value == r["intent"])
    rejects = [(r, m) for r, m in results if r["label"] == "REJECT"]
    false_pass = [r["text"] for r, m in rejects if m.accepted]
    return blocked / len(bad), correct / len(cmds), false_pass, [r["text"] for r, m in cmds if not m.accepted
                                                                  or m.accepted[0].intent.value != r["intent"]]


async def test_inappropriate_block_rate_rules_only():
    block_rate, intent_acc, false_pass, misses = await _eval(use_llm=False)
    print(f"block={block_rate:.3f} intent_acc={intent_acc:.3f} false_pass={false_pass} misses={misses}")
    assert block_rate >= 0.95  # 목표: 부적절 입력 차단율 95% 이상
    assert intent_acc >= 0.85  # 목표: 의도 분류 정확도 85% 이상
    assert not false_pass


async def test_with_mock_llm():
    block_rate, intent_acc, false_pass, _ = await _eval(use_llm=True)
    assert block_rate >= 0.95 and intent_acc >= 0.85


async def test_per_user_flood_and_duplicates():
    agent = ModerationAgent()
    msgs = [ChatMessage(user_id="spammer", text="보스 소환해줘") for _ in range(10)]
    msgs += [ChatMessage(user_id="spammer", text=f"보스 소환해줘 {i}번") for i in range(10)]
    res = await agent.moderate(msgs, use_llm=False)
    assert len(res.accepted) <= 3
    assert res.rejected_counts.get("SPAM", 0) >= 17


async def test_auto_mute_and_block():
    agent = ModerationAgent()
    for i in range(3):
        await agent.moderate([ChatMessage(user_id="troll", text=f"시발 {i}")], use_llm=False)
    res = await agent.moderate([ChatMessage(user_id="troll", text="보스 소환해줘")], use_llm=False)
    assert res.rejected_counts.get("BLOCKED") == 1
    agent.unblock_user("troll")
    res = await agent.moderate([ChatMessage(user_id="troll", text="보스 소환해줘")], use_llm=False)
    assert len(res.accepted) == 1
    agent.block_user("x")
    res = await agent.moderate([ChatMessage(user_id="x", text="힐 줘")], use_llm=False)
    assert not res.accepted


async def test_llm_failure_falls_back():
    class Broken(GeminiClient):
        @property
        def mode(self):
            return "live"

        async def generate_json(self, **kw):
            from streamdirector.llm.gemini_client import LLMUnavailable
            raise LLMUnavailable("down")

    agent = ModerationAgent(llm=Broken())
    res = await agent.moderate([ChatMessage(user_id="a", text="보스 한번 보고싶다"),
                                ChatMessage(user_id="b", text="오늘 저녁 뭐먹지")])
    assert [m.intent.value for m in res.accepted] == ["spawn_boss"]
    assert agent.stats["llm_failures"] == 1
