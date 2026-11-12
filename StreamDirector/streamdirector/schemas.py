"""게임 <-> AI 간 주고받는 데이터 규격 (게임 비종속 이벤트 JSON 포함)."""

from __future__ import annotations

import time
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# 입력: 채팅 / 후원 / 게임 상태
# ---------------------------------------------------------------------------
class ChatMessage(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    nickname: str = Field(default="", max_length=64)
    text: str = Field(max_length=2000)
    ts: float = Field(default_factory=time.time, description="UNIX epoch seconds")
    platform: str = Field(default="dummy", max_length=32)


class Donation(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    nickname: str = Field(default="", max_length=64)
    amount: int = Field(ge=0, description="후원 금액(원)")
    text: str = Field(default="", max_length=2000)
    ts: float = Field(default_factory=time.time)


class GameState(BaseModel):
    """LLM 프롬프트에 주입되는 게임 상태 컨텍스트. 게임별 추가 정보는 extra에."""

    wave: int = Field(default=1, ge=0)
    player_hp: float = Field(default=100, ge=0)
    player_max_hp: float = Field(default=100, gt=0)
    player_level: int = Field(default=1, ge=0)
    enemies_alive: int = Field(default=0, ge=0)
    score: int = Field(default=0, ge=0)
    elapsed_sec: float = Field(default=0, ge=0)
    difficulty: str = Field(default="normal", max_length=16)
    extra: dict[str, Any] = Field(default_factory=dict)

    @property
    def hp_ratio(self) -> float:
        return max(0.0, min(1.0, self.player_hp / self.player_max_hp))


# ---------------------------------------------------------------------------
# 검열(전처리) 에이전트 결과
# ---------------------------------------------------------------------------
class ChatLabel(StrEnum):
    COMMAND = "COMMAND"  # 게임에 반영할 수 있는 요청
    GAME_TALK = "GAME_TALK"  # 게임 관련 잡담 (반영 대상 아님)
    OFF_TOPIC = "OFF_TOPIC"  # 게임과 무관한 채팅
    ABUSE = "ABUSE"  # 욕설 / 혐오 / 성희롱 / 인신공격
    SPAM = "SPAM"  # 도배 / 광고 / 링크 / 중복


class Intent(StrEnum):
    SPAWN_ENEMIES = "spawn_enemies"
    SPAWN_BOSS = "spawn_boss"
    HEAL_PLAYER = "heal_player"
    BUFF_PLAYER = "buff_player"
    DEBUFF_PLAYER = "debuff_player"
    DROP_ITEM = "drop_item"
    CHANGE_WEATHER = "change_weather"
    SPEED_UP_ENEMIES = "speed_up_enemies"
    SLOW_DOWN_ENEMIES = "slow_down_enemies"
    NONE = "none"


class ModeratedMessage(BaseModel):
    user_id: str
    nickname: str = ""
    text: str  # 정규화된 텍스트
    label: ChatLabel
    intent: Intent = Intent.NONE
    weight: float = 1.0  # 후원 가중치 반영
    decided_by: str = "rule"  # rule | llm | fallback


class ModerationResult(BaseModel):
    accepted: list[ModeratedMessage] = Field(default_factory=list)  # COMMAND 만
    rejected_counts: dict[str, int] = Field(default_factory=dict)  # label -> count
    total: int = 0
    llm_used: bool = False
    latency_ms: float = 0.0


# ---------------------------------------------------------------------------
# 출력: 게임 이벤트 (게임 비종속 규격)
# ---------------------------------------------------------------------------
class EventType(StrEnum):
    SPAWN_ENEMIES = "spawn_enemies"
    SPAWN_BOSS = "spawn_boss"
    HEAL_PLAYER = "heal_player"
    BUFF_PLAYER = "buff_player"
    DEBUFF_PLAYER = "debuff_player"
    DROP_ITEM = "drop_item"
    CHANGE_WEATHER = "change_weather"
    ENEMY_SPEED = "enemy_speed"
    NONE = "none"


class GameEvent(BaseModel):
    event_id: str = ""
    seq: int = 0
    event_type: EventType
    intensity: int = Field(default=1, ge=1, le=5, description="1(약)~5(강)")
    count: int = Field(default=0, ge=0, le=50, description="스폰 수 / 아이템 수")
    duration_sec: float = Field(default=0, ge=0, le=60, description="지속형 효과 시간")
    variant: str = Field(default="", max_length=32, description="적 종류 / 아이템 종류 / 날씨 등 세부값")
    overlay_text: str = Field(default="", max_length=60, description="방송 오버레이 표시 문구")
    reason: str = Field(default="", max_length=200)
    source: str = "vote"  # vote | donation | fallback
    supporters: int = 0
    vote_share: float = 0.0
    donor: str | None = None
    donation_amount: int | None = None  # 후원 발동 시 금액 (게임이 보스 강도 등에 사용)
    created_at: float = Field(default_factory=time.time)


class PipelineResult(BaseModel):
    request_id: str
    session_id: str
    event: GameEvent | None
    status: str  # event | no_event | throttled | error
    detail: str = ""
    moderation: dict[str, Any] = Field(default_factory=dict)
    validation: dict[str, Any] = Field(default_factory=dict)
    latency_ms: dict[str, float] = Field(default_factory=dict)
