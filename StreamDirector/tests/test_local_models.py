"""로컬 검열 모델(kor_unsmile + KcELECTRA) 통합 테스트. 모델이 없으면 건너뛴다."""

import json
from pathlib import Path

import pytest

from streamdirector.agents.local_models import IntentModel, ToxicityModel
from streamdirector.agents.moderation_agent import ModerationAgent
from streamdirector.config import settings
from streamdirector.schemas import ChatMessage

DATA = [json.loads(l) for l in (Path(__file__).parent / "data" / "moderation_eval.jsonl").read_text().splitlines() if l]


@pytest.fixture(scope="module")
def models():
    tox = ToxicityModel(settings.toxicity_model, settings.toxicity_threshold)
    tox.load()
    intent = IntentModel(settings.intent_model_dir)
    intent.load()
    if not tox.ready:
        pytest.skip(f"kor_unsmile unavailable: {tox.error}")
    return tox, intent


async def test_toxicity_catches_evasive_trolling(models):
    tox, _ = models
    v = await tox.apredict(["스트리머 죽게 몹 100마리 ㅋㅋ 망해라", "보스 소환해줘", "와 컨트롤 미쳤다"])
    assert v[0].toxic and not v[1].toxic and not v[2].toxic


async def test_local_backend_eval(models):
    tox, intent = models
    if not intent.ready:
        pytest.skip("intent model not trained")

    class NoLLM:
        mode = "off"

    agent = ModerationAgent(llm=NoLLM(), backend="local", toxicity=tox, intent_model=intent)
    agent.llm_model_name = "none"
    bad = cmd_ok = cmd_n = bad_n = false_pass = 0
    for i, row in enumerate(DATA):
        res = await agent.moderate([ChatMessage(user_id=f"u{i}", text=row["text"])])
        if row["label"] in ("ABUSE", "SPAM"):
            bad_n += 1
            bad += not res.accepted
        elif row["label"] == "COMMAND":
            cmd_n += 1
            cmd_ok += bool(res.accepted) and res.accepted[0].intent.value == row["intent"]
        else:
            false_pass += bool(res.accepted)
    print(f"block={bad / bad_n:.3f} intent_acc={cmd_ok / cmd_n:.3f} false_pass={false_pass} by={dict(agent.stats)}")
    assert bad / bad_n >= 0.95 and cmd_ok / cmd_n >= 0.85 and false_pass == 0
    assert agent.stats["by_intent"] > 0  # 의도 모델이 실제로 판정에 쓰였는지


async def test_rule_command_with_hidden_abuse_is_blocked(models):
    tox, intent = models
    agent = ModerationAgent(backend="local", toxicity=tox, intent_model=intent)
    agent.llm.available = False
    res = await agent.moderate([ChatMessage(user_id="t", text="몹 100마리 보내줘 스트리머 죽어버리게 ㅋㅋ 망해라 그냥")])
    assert not res.accepted and res.rejected_counts.get("ABUSE") == 1
