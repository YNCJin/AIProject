"""LLM 이벤트 변환 엔진 (Google AI Studio / Gemini).

검증된 집단 의도 + 게임 상태 컨텍스트 -> 게임 이벤트 JSON.
- JSON Schema 강제 (Structured Output)
- 서버 측 2차 검증 + 값 범위 클램핑 (밸런스 안정성)
- LLM 장애·타임아웃·스키마 위반 시 규칙 기반 폴백 이벤트 생성
"""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import ValidationError

from ..config import settings
from ..llm.gemini_client import GeminiClient, LLMResponse, LLMUnavailable
from ..schemas import EventType, GameEvent, GameState, Intent
from .validator import ValidatedBatch

log = logging.getLogger("streamdirector.engine")

INTENT_TO_EVENT: dict[Intent, tuple[EventType, str]] = {
    Intent.SPAWN_ENEMIES: (EventType.SPAWN_ENEMIES, "normal"),
    Intent.SPAWN_BOSS: (EventType.SPAWN_BOSS, "boss"),
    Intent.HEAL_PLAYER: (EventType.HEAL_PLAYER, ""),
    Intent.BUFF_PLAYER: (EventType.BUFF_PLAYER, "attack"),
    Intent.DEBUFF_PLAYER: (EventType.DEBUFF_PLAYER, "slow"),
    Intent.DROP_ITEM: (EventType.DROP_ITEM, "random"),
    Intent.CHANGE_WEATHER: (EventType.CHANGE_WEATHER, "rain"),
    Intent.SPEED_UP_ENEMIES: (EventType.ENEMY_SPEED, "fast"),
    Intent.SLOW_DOWN_ENEMIES: (EventType.ENEMY_SPEED, "slow"),
}

VARIANTS: dict[EventType, list[str]] = {
    EventType.SPAWN_ENEMIES: ["normal", "fast", "tank", "ranged", "swarm"],
    EventType.SPAWN_BOSS: ["boss"],
    EventType.HEAL_PLAYER: [""],
    EventType.BUFF_PLAYER: ["attack", "speed", "shield", "invincible", "regen"],
    EventType.DEBUFF_PLAYER: ["slow", "weak", "blind", "no_regen"],
    EventType.DROP_ITEM: ["random", "weapon", "potion", "chest", "bomb"],
    EventType.CHANGE_WEATHER: ["rain", "snow", "fog", "storm", "night", "clear"],
    EventType.ENEMY_SPEED: ["fast", "slow"],
    EventType.NONE: [""],
}

# LLM 을 못 쓸 때(키 없음, 할당량 보호, 장애) 쓰는 기본 알림 문구
FALLBACK_TEXT: dict[tuple[EventType, str], str] = {
    (EventType.SPAWN_ENEMIES, ""): "적들이 몰려온다!",
    (EventType.SPAWN_BOSS, ""): "강적이 나타났다!",
    (EventType.HEAL_PLAYER, ""): "따뜻한 빛이 감싼다",
    (EventType.BUFF_PLAYER, ""): "힘이 솟구친다!",
    (EventType.DEBUFF_PLAYER, ""): "몸이 무거워진다…",
    (EventType.DROP_ITEM, ""): "보급품이 떨어졌다!",
    (EventType.CHANGE_WEATHER, ""): "하늘이 변한다",
    (EventType.ENEMY_SPEED, "fast"): "적들이 날뛴다!",
    (EventType.ENEMY_SPEED, "slow"): "적들이 느려진다",
}

HARMFUL = {EventType.SPAWN_ENEMIES, EventType.SPAWN_BOSS, EventType.DEBUFF_PLAYER}

SYSTEM_PROMPT = """너는 라이브 방송 게임의 '이벤트 디렉터'다.
시청자들의 집단 의도 집계와 현재 게임 상태를 보고, 지금 게임에 발동할 이벤트 1개를 JSON 으로 만든다.

원칙
- 다수 의견을 존중한다. 기본적으로 1위 의도를 따르되, 1·2위 차이가 근소하면 게임 상황에 더 재미있는 쪽을 골라도 된다.
- 반드시 집계에 등장한 의도 중 하나에 해당하는 event_type 을 고른다.
- 밸런스: 플레이어 체력이 낮으면 해로운 이벤트의 강도를 낮추고, 체력이 높고 쉬워 보이면 강도를 올린다.
- 웨이브가 낮을수록 스폰 수(count)를 작게 한다.
- overlay_text 는 방송 화면에 띄울 짧고 재미있는 한국어 문구(최대 30자), reason 은 판단 근거 한 문장.

event_type 별 필드 의미
- spawn_enemies: count=마리 수(1~30), variant=normal|fast|tank|ranged|swarm
- spawn_boss: count=1, variant=boss, intensity=보스 강도
- heal_player: intensity=회복량 단계(1=10% ~ 5=50%)
- buff_player: variant=attack|speed|shield|invincible|regen, duration_sec=5~30
- debuff_player: variant=slow|weak|blind|no_regen, duration_sec=5~20
- drop_item: count=1~5, variant=random|weapon|potion|chest|bomb
- change_weather: variant=rain|snow|fog|storm|night|clear, duration_sec=10~60
- enemy_speed: variant=fast|slow, duration_sec=5~20
"""

LLM_EVENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "event_type": {"type": "string", "enum": [e.value for e in EventType if e != EventType.NONE]},
        "intensity": {"type": "integer", "minimum": 1, "maximum": 5},
        "count": {"type": "integer", "minimum": 0, "maximum": 30},
        "duration_sec": {"type": "number", "minimum": 0, "maximum": 60},
        "variant": {"type": "string"},
        "overlay_text": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["event_type", "intensity", "count", "duration_sec", "variant", "overlay_text", "reason"],
}


def build_user_prompt(batch: ValidatedBatch, source: str, donor_text: str = "") -> str:
    gs = batch.game_state
    state = {
        "wave": gs.wave,
        "player_hp_ratio": round(gs.hp_ratio, 2),
        "player_level": gs.player_level,
        "enemies_alive": gs.enemies_alive,
        "score": gs.score,
        "elapsed_sec": round(gs.elapsed_sec),
        "difficulty": gs.difficulty,
        **({"extra": gs.extra} if gs.extra else {}),
    }
    tallies = [
        {"intent": t.intent.value, "votes": round(t.votes, 1), "voters": t.voters, "share": round(t.share, 2),
         "examples": t.samples}
        for t in batch.tallies[:5]
    ]
    parts = [
        f"[게임 상태]\n{json.dumps(state, ensure_ascii=False)}",
        f"[시청자 의도 집계] (총 {batch.total_voters}명)\n{json.dumps(tallies, ensure_ascii=False)}",
        f"[발동 경로] {source}",
    ]
    if donor_text:
        parts.append(f"[고액 후원 메시지] {donor_text}")
    return "\n\n".join(parts)


def mock_event_responder(_key: str, user_prompt: str) -> dict[str, Any]:
    """LLM_MODE=mock 용 결정적 응답: 1위 의도를 기본 파라미터로 변환."""
    try:
        tallies_json = user_prompt.split("[시청자 의도 집계]")[1].split("\n", 2)[1]
        top = Intent(json.loads(tallies_json)[0]["intent"])
    except (IndexError, ValueError, KeyError):
        top = Intent.SPAWN_ENEMIES
    et, variant = INTENT_TO_EVENT[top]
    return {"event_type": et.value, "intensity": 2, "count": 5 if et == EventType.SPAWN_ENEMIES else 1,
            "duration_sec": 10, "variant": variant, "overlay_text": f"시청자 투표: {et.value}!",
            "reason": "mock: 최다 득표 의도"}


class EventEngine:
    def __init__(self, llm: GeminiClient | None = None):
        self.llm = llm or GeminiClient(mock_responder=mock_event_responder)
        self.stats = {"llm_calls": 0, "llm_responses": 0, "llm_ok": 0, "schema_violations": 0, "fallbacks": 0, "clamped": 0}

    async def generate(
        self, batch: ValidatedBatch, source: str = "vote", donor_text: str = ""
    ) -> tuple[GameEvent, dict[str, Any]]:
        """반환: (클램핑된 이벤트, 로그용 메타데이터)."""
        meta: dict[str, Any] = {"model": None, "llm_latency_ms": None, "fallback": False, "raw": None,
                                "clamp_notes": [], "usage": {}}
        allowed = {INTENT_TO_EVENT[t.intent][0] for t in batch.tallies if t.intent in INTENT_TO_EVENT}
        event: GameEvent | None = None

        if self.llm.mode != "off":
            self.stats["llm_calls"] += 1
            try:
                resp: LLMResponse = await self.llm.generate_json(
                    model=settings.event_model,
                    system_prompt=SYSTEM_PROMPT,
                    user_prompt=build_user_prompt(batch, source, donor_text),
                    json_schema=LLM_EVENT_SCHEMA,
                    timeout_sec=settings.event_timeout_sec,
                    temperature=0.4,
                    max_output_tokens=300,
                    mock_key="event",
                )
                self.stats["llm_responses"] += 1
                meta.update(model=resp.model, llm_latency_ms=round(resp.latency_ms, 1), raw=resp.raw_text,
                            usage=resp.usage)
                event = GameEvent.model_validate({**resp.data, "source": source})
                if event.event_type not in allowed:
                    meta["clamp_notes"].append(f"LLM chose {event.event_type} not in voted intents -> override")
                    event = None
                else:
                    self.stats["llm_ok"] += 1
            except ValidationError as e:
                self.stats["schema_violations"] += 1
                meta["error"] = f"schema violation: {e.errors()[:3]}"
            except LLMUnavailable as e:
                meta["error"] = str(e)

        if event is None:
            self.stats["fallbacks"] += 1
            meta["fallback"] = True
            event = self._fallback(batch, source)

        top = batch.top
        event.supporters = batch.total_voters
        event.vote_share = round(top.share, 3) if top else 0.0
        event, notes = clamp_event(event, batch.game_state)
        if notes:
            self.stats["clamped"] += 1
        meta["clamp_notes"] += notes
        return event, meta

    @staticmethod
    def _fallback(batch: ValidatedBatch, source: str) -> GameEvent:
        top = batch.top
        intent = top.intent if top else Intent.SPAWN_ENEMIES
        et, variant = INTENT_TO_EVENT.get(intent, (EventType.SPAWN_ENEMIES, "normal"))
        intensity = 1 + min(4, int((top.voters if top else 1) / 5))
        if source == "donation":
            intensity = max(intensity, 3)  # 고액 후원은 존재감 있게
        # 누가 발동했는지(투표 인원 / 후원자)는 게임이 따로 표시하므로 문구는 이벤트 내용만
        return GameEvent(
            event_type=et, intensity=intensity, count=3 + batch.game_state.wave if et == EventType.SPAWN_ENEMIES else 1,
            duration_sec=10, variant=variant, overlay_text=FALLBACK_TEXT.get((et, variant), FALLBACK_TEXT.get((et, ""), "시청자 이벤트!")),
            reason="fallback: 최다 득표 의도 기본 매핑", source=source if source != "vote" else "fallback",
        )


def clamp_event(event: GameEvent, gs: GameState) -> tuple[GameEvent, list[str]]:
    """서버 측 값 범위 강제. LLM 이 무엇을 출력하든 게임 밸런스를 깨지 않도록 한다."""
    notes: list[str] = []
    e = event.model_copy()

    def setv(field: str, value: Any) -> None:
        if getattr(e, field) != value:
            notes.append(f"{field}: {getattr(e, field)!r} -> {value!r}")
            setattr(e, field, value)

    if e.variant not in VARIANTS[e.event_type]:
        setv("variant", VARIANTS[e.event_type][0])

    if e.event_type == EventType.SPAWN_ENEMIES:
        setv("count", max(1, min(e.count, 5 + gs.wave * 2, 30)))
        setv("duration_sec", 0.0)
    elif e.event_type == EventType.SPAWN_BOSS:
        setv("count", 1)
        setv("duration_sec", 0.0)
        if gs.wave < 3:
            setv("intensity", min(e.intensity, 2))
    elif e.event_type == EventType.HEAL_PLAYER:
        setv("count", 0)
        setv("duration_sec", 0.0)
        if gs.hp_ratio > 0.9:
            setv("intensity", 1)
    elif e.event_type == EventType.DROP_ITEM:
        setv("count", max(1, min(e.count, 5)))
        setv("duration_sec", 0.0)
    else:
        limits = {EventType.BUFF_PLAYER: (5, 30), EventType.DEBUFF_PLAYER: (5, 20),
                  EventType.CHANGE_WEATHER: (10, 60), EventType.ENEMY_SPEED: (5, 20)}
        lo, hi = limits.get(e.event_type, (0, 60))
        setv("count", 0)
        setv("duration_sec", float(max(lo, min(e.duration_sec or lo, hi))))
        if e.event_type == EventType.BUFF_PLAYER and e.variant == "invincible":
            setv("duration_sec", min(e.duration_sec, 8.0))

    # 위기 상황 보호: 체력 25% 미만이면 해로운 이벤트는 강도 1
    if e.event_type in HARMFUL and gs.hp_ratio < 0.25:
        setv("intensity", 1)
        if e.event_type == EventType.SPAWN_ENEMIES:
            setv("count", min(e.count, 3))

    setv("overlay_text", (e.overlay_text or "").strip()[:30] or f"{e.event_type.value}!")
    setv("reason", (e.reason or "")[:200])
    return e, notes
