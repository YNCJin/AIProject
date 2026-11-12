"""데이터 확인 단계: 검열을 통과한 채팅이 LLM 에 보낼 만한지 검증하고 집계한다.

- 스키마/값 검증 (의도 enum, 가중치 범위, 게임 상태 범위)
- 의도별 득표 집계 (후원 가중치 반영, 1인 1의도 1표 원칙)
- 최소 참여 조건 미달 시 LLM 호출 생략 -> 비용·지연 절약
"""

from __future__ import annotations

from collections import defaultdict

from pydantic import BaseModel, Field

from ..schemas import GameState, Intent, ModeratedMessage, ModerationResult

MIN_VOTERS = 1
MAX_SAMPLES_PER_INTENT = 5
MAX_WEIGHT = 20.0


class IntentTally(BaseModel):
    intent: Intent
    votes: float
    voters: int
    share: float
    samples: list[str] = Field(default_factory=list)


class ValidatedBatch(BaseModel):
    ok: bool
    reason: str = ""
    tallies: list[IntentTally] = Field(default_factory=list)  # 득표순
    total_votes: float = 0
    total_voters: int = 0
    game_state: GameState
    issues: list[str] = Field(default_factory=list)

    @property
    def top(self) -> IntentTally | None:
        return self.tallies[0] if self.tallies else None

    def summary(self) -> dict:
        return {
            "ok": self.ok,
            "reason": self.reason,
            "total_votes": round(self.total_votes, 2),
            "total_voters": self.total_voters,
            "tallies": [{"intent": t.intent.value, "votes": round(t.votes, 2), "share": round(t.share, 3)}
                        for t in self.tallies],
            "issues": self.issues,
        }


def validate_batch(moderation: ModerationResult, game_state: GameState) -> ValidatedBatch:
    issues: list[str] = []
    # 한 사용자는 한 의도에 한 번만 투표 (같은 창에서 여러 번 외쳐도 1표, 후원 가중치는 최대값)
    best: dict[tuple[str, Intent], ModeratedMessage] = {}
    for m in moderation.accepted:
        if m.intent == Intent.NONE:
            issues.append(f"COMMAND without intent dropped: {m.text[:20]}")
            continue
        if not 0 < m.weight <= MAX_WEIGHT:
            issues.append(f"weight clamped {m.weight}")
            m = m.model_copy(update={"weight": max(1.0, min(MAX_WEIGHT, m.weight))})
        key = (m.user_id, m.intent)
        if key not in best or best[key].weight < m.weight:
            best[key] = m

    votes: dict[Intent, float] = defaultdict(float)
    voters: dict[Intent, set[str]] = defaultdict(set)
    samples: dict[Intent, list[str]] = defaultdict(list)
    for (user, intent), m in best.items():
        votes[intent] += m.weight
        voters[intent].add(user)
        if len(samples[intent]) < MAX_SAMPLES_PER_INTENT and m.text not in samples[intent]:
            samples[intent].append(m.text)

    total = sum(votes.values())
    all_voters = {u for (u, _) in best}
    tallies = sorted(
        (IntentTally(intent=i, votes=v, voters=len(voters[i]), share=v / total if total else 0, samples=samples[i])
         for i, v in votes.items()),
        key=lambda t: (-t.votes, -t.voters, t.intent.value),
    )

    if game_state.player_hp > game_state.player_max_hp:
        issues.append("player_hp > max_hp; clamped")
        game_state = game_state.model_copy(update={"player_hp": game_state.player_max_hp})

    if len(all_voters) < MIN_VOTERS:
        return ValidatedBatch(ok=False, reason="no valid commands", game_state=game_state, issues=issues)
    return ValidatedBatch(ok=True, tallies=tallies, total_votes=total, total_voters=len(all_voters),
                          game_state=game_state, issues=issues)
