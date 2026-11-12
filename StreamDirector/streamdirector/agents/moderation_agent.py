"""채팅 전처리(검열) 에이전트.

게임과 무관한 채팅(분탕, 욕설, 도배, 광고, 잡담)을 걸러내고 게임에 반영 가능한
'명령(COMMAND)' 만 의도(Intent)와 함께 다음 단계로 넘긴다.

처리 단계 (MODERATION_BACKEND=local 기준, 모두 무료·로컬)
  1) 운영자 차단 / 자동 뮤트 사용자 제외
  2) 정규화 + 길이 제한 + 사용자별 중복·도배 제거
  3) 규칙 기반 판정 (욕설·광고·무의미 반응·확실한 명령)
  4) kor_unsmile 로 규칙을 통과한 채팅의 우회 욕설·비하·분탕 판별 (묶음 추론)
  5) KcELECTRA 의도 분류 - 확신도 INTENT_CONFIDENCE 이상이면 확정
  6) 그래도 애매한 소수 문장만 LLM(Ollama 로컬, 또는 backend=gemini 면 Gemini) 1회 호출 (LRU 캐시)
  7) 모델 미로딩/LLM 장애 시 보수적 규칙 폴백

이 클래스는 독립 에이전트로서 자체 모델/프롬프트/로그를 가지며,
`streamdirector.moderation_server` 로 별도 MCP 서버 프로세스로도 띄울 수 있다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict, defaultdict
from typing import Any

from ..config import settings
from ..llm.gemini_client import GeminiClient, LLMUnavailable
from ..logging_setup import anonymize, write_jsonl
from ..schemas import ChatLabel, ChatMessage, Intent, ModeratedMessage, ModerationResult
from . import rules
from .local_models import IntentModel, OllamaClient, ToxicityModel

log = logging.getLogger("streamdirector.moderation")

MAX_LLM_ITEMS = 80  # Gemini: 한 번에 분류할 최대 문장 수
MAX_LOCAL_LLM_ITEMS = 6  # Ollama: 생성 속도가 느리므로 소수만 (나머지는 폴백)
ABUSE_STRIKES_TO_MUTE = 3
AUTO_MUTE_SEC = 300

SYSTEM_PROMPT = """너는 라이브 게임 방송의 채팅 검열 에이전트다.
게임은 2D 웨이브 서바이벌이고, 시청자는 채팅으로 게임에 개입할 수 있다.
각 채팅을 아래 라벨 중 하나로 분류하고, COMMAND 이면 의도(intent)도 고른다.

라벨
- COMMAND  : 게임 진행에 영향을 주길 요청하는 채팅 (몬스터/보스 소환, 회복, 버프, 디버프, 아이템, 날씨, 적 속도)
- GAME_TALK: 게임 관련 감상/응원/질문이지만 요청은 아님 ("오 잘한다", "몇 웨이브임?")
- OFF_TOPIC: 게임과 무관한 대화 (밥 먹었어?, 다른 방송 얘기, 정치 등)
- ABUSE    : 욕설, 비하, 혐오, 성적 발언, 스트리머/시청자 인신공격, 우회 표기 욕설
- SPAM     : 광고, 홍보, 링크, 의미 없는 도배

intent (COMMAND 가 아니면 none)
spawn_enemies, spawn_boss, heal_player, buff_player, debuff_player, drop_item,
change_weather, speed_up_enemies, slow_down_enemies, none

규칙
- 부정문("보스 소환하지마")은 해당 요청이 아니다. 반대 의도가 명확하지 않으면 GAME_TALK.
- 요청 형태라도 욕설이 섞이면 ABUSE.
- 게임 개입을 빌미로 한 분탕(예: "스트리머 죽게 몹 100마리 ㅋㅋ 망해라")은 ABUSE.
- 판단이 어려우면 COMMAND 로 올리지 말고 GAME_TALK 로 둔다.

예시
"보스 한번 보고싶다" -> COMMAND spawn_boss
"체력 너무 없는데 좀 채워주자" -> COMMAND heal_player
"너무 쉬워보이는데 좀 어렵게 해봐" -> COMMAND debuff_player
"비 오는 맵에서 싸우면 멋있겠다" -> COMMAND change_weather
"오늘 저녁 뭐 먹지" -> OFF_TOPIC
"와 컨트롤 미쳤다" -> GAME_TALK
"이 방송 노잼 ㅗㅗ" -> ABUSE
"""

# 출력 토큰을 줄이기 위해 입력 순서대로 라벨 코드 배열만 받는다 (로컬 LLM 생성 속도 고려)
LABEL_CODES = [i.value for i in Intent if i != Intent.NONE] + ["GAME_TALK", "OFF_TOPIC", "ABUSE", "SPAM"]
RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"labels": {"type": "array", "items": {"type": "string", "enum": LABEL_CODES}}},
    "required": ["labels"],
}
OUTPUT_GUIDE = """
출력: {"labels": [...]} - 사용자 메시지에 번호로 주어진 채팅만, 입력 순서대로 각 1개 (위 예시는 분류하지 말 것).
labels 길이는 반드시 입력 채팅 수와 같아야 한다.
코드: COMMAND 이면 intent 이름(spawn_boss 등), 아니면 GAME_TALK / OFF_TOPIC / ABUSE / SPAM.
"""


# 로컬 LLM 용 축소 프롬프트 (약 240토큰). gemma2:9b 실측: 긴 프롬프트 대비 1.8배 빠르고 정확도도 높았음.
# 로컬 LLM 은 여러 건을 한 번에 주면 라벨 개수를 자주 틀리므로(11회 중 10회) 한 건씩 판정한다.
LOCAL_SYSTEM_PROMPT = """라이브 게임 방송 채팅 분류기. 채팅 1개에 코드 1개:
게임 요청이면 의도 - spawn_enemies(몹 소환) spawn_boss(보스) heal_player(회복) buff_player(강화) debuff_player(약화/어렵게) drop_item(아이템) change_weather(날씨) speed_up_enemies slow_down_enemies
아니면 GAME_TALK(게임 감상·질문·부정문 "소환하지마") OFF_TOPIC(무관) ABUSE(욕설·비하) SPAM(광고·도배)
애매하면 GAME_TALK. 출력 {"label": "코드"}"""
SINGLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"label": {"type": "string", "enum": LABEL_CODES}},
    "required": ["label"],
}


def code_to_label(code: str) -> tuple[ChatLabel, Intent]:
    if code in ("GAME_TALK", "OFF_TOPIC", "ABUSE", "SPAM"):
        return ChatLabel(code), Intent.NONE
    return ChatLabel.COMMAND, Intent(code)


def mock_moderation_responder(_key: str, user_prompt: str) -> dict[str, Any]:
    """LLM_MODE=mock 용: 키워드 후보 기반으로 LLM 응답 형태를 흉내낸다."""
    labels = []
    for line in user_prompt.splitlines():
        if not line[:1].isdigit() or ": " not in line:
            continue
        text = line.split(": ", 1)[1]
        loose = rules.loose_intents(text)
        labels.append(sorted(loose)[0].value if loose and not rules.has_negation(text) else "GAME_TALK")
    return {"labels": labels}


class ModerationAgent:
    def __init__(self, llm: GeminiClient | OllamaClient | None = None, backend: str | None = None,
                 toxicity: ToxicityModel | None = None, intent_model: IntentModel | None = None):
        self.backend = backend or settings.moderation_backend
        self.toxicity = toxicity
        self.intent_model = intent_model
        if self.backend == "local":
            self.toxicity = toxicity or ToxicityModel(settings.toxicity_model, settings.toxicity_threshold,
                                                      settings.local_device)
            self.intent_model = intent_model or IntentModel(settings.intent_model_dir, settings.local_device)
            self.llm = llm or OllamaClient(settings.ollama_url, settings.ollama_model)
            self.llm_model_name = settings.ollama_model
            self.llm_timeout = settings.ollama_timeout_sec
            self.max_llm_items = MAX_LOCAL_LLM_ITEMS
        else:
            self.llm = llm or GeminiClient(mock_responder=mock_moderation_responder)
            self.llm_model_name = settings.moderation_model
            self.llm_timeout = settings.moderation_timeout_sec
            self.max_llm_items = MAX_LLM_ITEMS
        self.blocked_users: set[str] = set()
        self._muted_until: dict[str, float] = {}
        self._abuse_strikes: dict[str, int] = defaultdict(int)
        self._refine_task: asyncio.Task | None = None
        self._cache: OrderedDict[str, tuple[ChatLabel, Intent]] = OrderedDict()
        self._cache_max = 5000
        self.stats = defaultdict(int)

    async def load_models(self) -> dict[str, Any]:
        """로컬 모델 로딩 (무거우므로 서버 기동 후 백그라운드에서 호출). 로딩 중에도 규칙 기반으로 동작."""
        for m in (self.toxicity, self.intent_model):
            if m is not None and m.state == "idle":
                await asyncio.to_thread(m.load)
        if isinstance(self.llm, OllamaClient):
            await self.llm.check()
            await self.llm.warmup()
        return self.status()

    def status(self) -> dict[str, Any]:
        st: dict[str, Any] = {"backend": self.backend, "llm": {"mode": self.llm.mode, "model": self.llm_model_name}}
        if self.toxicity is not None:
            st["toxicity"] = self.toxicity.status()
        if self.intent_model is not None:
            st["intent"] = self.intent_model.status()
        return st

    # ------------------------------------------------------------------ 운영자 제어
    def block_user(self, user_id: str) -> None:
        self.blocked_users.add(user_id)

    def unblock_user(self, user_id: str) -> None:
        self.blocked_users.discard(user_id)
        self._muted_until.pop(user_id, None)
        self._abuse_strikes.pop(user_id, None)

    def _is_muted(self, user_id: str, now: float) -> bool:
        if user_id in self.blocked_users:
            return True
        until = self._muted_until.get(user_id)
        return until is not None and until > now

    def _strike(self, user_id: str, now: float) -> None:
        self._abuse_strikes[user_id] += 1
        if self._abuse_strikes[user_id] >= ABUSE_STRIKES_TO_MUTE:
            self._muted_until[user_id] = now + AUTO_MUTE_SEC
            self._abuse_strikes[user_id] = 0
            log.info("auto-muted user %s for %ss", anonymize(user_id), AUTO_MUTE_SEC)

    # ------------------------------------------------------------------ 메인
    async def moderate(
        self,
        messages: list[ChatMessage],
        weights: dict[int, float] | None = None,
        session_id: str = "",
        use_llm: bool = True,
    ) -> ModerationResult:
        """weights: messages 인덱스 -> 후원 가중치 (후원 메시지용)."""
        start = time.perf_counter()
        now = time.time()
        weights = weights or {}
        rejected: dict[str, int] = defaultdict(int)
        decided: list[ModeratedMessage | None] = [None] * len(messages)
        pending: list[tuple[int, str]] = []  # (index, normalized text) -> LLM 판단 필요
        per_user_count: dict[str, int] = defaultdict(int)
        per_user_seen: dict[str, set[str]] = defaultdict(set)

        for idx, msg in enumerate(messages[: settings.max_messages_per_window]):
            if self._is_muted(msg.user_id, now):
                rejected["BLOCKED"] += 1
                continue
            text = rules.normalize(msg.text)[: settings.max_message_len]
            if not text:
                rejected[ChatLabel.SPAM] += 1
                continue

            key = rules.squash(text) or text
            if key in per_user_seen[msg.user_id] or per_user_count[msg.user_id] >= settings.max_msgs_per_user_per_window:
                rejected[ChatLabel.SPAM] += 1  # 같은 사용자 중복/도배
                continue
            per_user_seen[msg.user_id].add(key)
            per_user_count[msg.user_id] += 1

            def mk(label: ChatLabel, intent: Intent = Intent.NONE, by: str = "rule") -> ModeratedMessage:
                return ModeratedMessage(user_id=msg.user_id, nickname=msg.nickname, text=text, label=label,
                                        intent=intent, weight=weights.get(idx, 1.0), decided_by=by)

            if rules.is_profane(text):
                decided[idx] = mk(ChatLabel.ABUSE)
                self._strike(msg.user_id, now)
            elif rules.is_spam(text) or rules.is_low_entropy(text):
                decided[idx] = mk(ChatLabel.SPAM)
            elif rules.is_reaction_only(text):
                decided[idx] = mk(ChatLabel.OFF_TOPIC)
            elif text in self._cache:
                label, intent = self._cache[text]
                self._cache.move_to_end(text)
                decided[idx] = mk(label, intent, "cache")
            else:
                strong = rules.strong_intents(text)
                if len(strong) == 1 and not rules.has_negation(text):
                    decided[idx] = mk(ChatLabel.COMMAND, next(iter(strong)))
                else:
                    pending.append((idx, text))

        # 4) 로컬 욕설/비하 모델: 규칙을 통과한 명령 후보 + 미결 채팅만 검사
        if self.toxicity is not None and self.toxicity.ready:
            check = [i for i, m in enumerate(decided) if m is not None and m.label == ChatLabel.COMMAND
                     and m.decided_by == "rule"] + [i for i, _ in pending]
            if check:
                texts = [decided[i].text if decided[i] is not None else rules.normalize(messages[i].text)
                         [: settings.max_message_len] for i in check]
                verdicts = await self.toxicity.apredict(texts)
                toxic = set()
                for i, text, v in zip(check, texts, verdicts):
                    if v.toxic:
                        toxic.add(i)
                        msg = messages[i]
                        decided[i] = ModeratedMessage(user_id=msg.user_id, nickname=msg.nickname, text=text,
                                                      label=ChatLabel.ABUSE, weight=weights.get(i, 1.0),
                                                      decided_by=f"toxicity:{v.label}:{v.score}")
                        self._strike(msg.user_id, now)
                pending = [(i, t) for i, t in pending if i not in toxic]

        # 5) 로컬 의도 분류 모델: 확신도가 높으면 확정
        if pending and self.intent_model is not None and self.intent_model.ready:
            preds = await self.intent_model.apredict([t for _, t in pending])
            still: list[tuple[int, str]] = []
            for (i, text), pred in zip(pending, preds):
                is_cmd = pred.label not in ("GAME_TALK", "OFF_TOPIC")
                # 안전장치: 부정문이 섞였거나, 게임 키워드도 요청 형태도 없는데("기적!") 명령으로 예측하면
                # 학습 분포 밖 입력에 대한 과신일 수 있으므로 확정하지 않고 LLM/폴백으로 넘김
                suspicious = is_cmd and (rules.has_negation(text) or not (rules.loose_intents(text)
                                                                          or rules.is_request_shaped(text)))
                if pred.confidence >= settings.intent_confidence and not suspicious:
                    label, intent = code_to_label(pred.label)
                    msg = messages[i]
                    decided[i] = ModeratedMessage(user_id=msg.user_id, nickname=msg.nickname, text=text,
                                                  label=label, intent=intent, weight=weights.get(i, 1.0),
                                                  decided_by=f"intent:{pred.confidence}")
                else:
                    still.append((i, text))
            pending = still

        llm_used = False
        if pending:
            llm_used = await self._classify_pending(messages, pending, decided, weights,
                                                    use_llm and self.backend != "rules")

        accepted: list[ModeratedMessage] = []
        for m in decided:
            if m is None:
                continue
            if m.label == ChatLabel.COMMAND and m.intent != Intent.NONE:
                accepted.append(m)
            else:
                rejected[m.label.value if m.label != ChatLabel.COMMAND else ChatLabel.GAME_TALK.value] += 1
            self.stats[m.label.value] += 1
            self.stats["by_" + m.decided_by.split(":")[0]] += 1
        self.stats["total"] += len(messages)
        self.stats["blocked"] += rejected.get("BLOCKED", 0)

        result = ModerationResult(
            accepted=accepted,
            rejected_counts={str(k): v for k, v in rejected.items()},
            total=len(messages),
            llm_used=llm_used,
            latency_ms=round((time.perf_counter() - start) * 1000, 2),
        )
        write_jsonl("moderation", {
            "session_id": session_id,
            "total": result.total,
            "accepted": len(accepted),
            "rejected": result.rejected_counts,
            "llm_used": llm_used,
            "latency_ms": result.latency_ms,
            "decisions": [
                {"user": anonymize(m.user_id), "text": m.text, "label": m.label.value,
                 "intent": m.intent.value, "by": m.decided_by}
                for m in decided if m is not None
            ],
        })
        return result

    async def _classify_pending(
        self,
        messages: list[ChatMessage],
        pending: list[tuple[int, str]],
        decided: list[ModeratedMessage | None],
        weights: dict[int, float],
        use_llm: bool,
    ) -> bool:
        # 같은 문장은 한 번만 분류
        unique_texts: list[str] = list(OrderedDict.fromkeys(t for _, t in pending))[: self.max_llm_items]
        verdicts: dict[str, tuple[ChatLabel, Intent, str]] = {}
        llm_used = False

        if use_llm and self.llm.mode != "off":
            if self.backend == "local" and settings.ollama_mode == "async":
                # 실시간 경로는 기다리지 않음: 아래 폴백으로 즉시 처리, 로컬 LLM 판단은 백그라운드로 캐시에 반영
                self._schedule_refine(unique_texts)
            else:
                try:
                    verdicts = await self._llm_classify(unique_texts, self.llm_timeout)
                    llm_used = True
                except LLMUnavailable as e:
                    self.stats["llm_failures"] += 1
                    log.warning("moderation LLM unavailable, using fallback: %s", e)

        for idx, text in pending:
            if text in verdicts:
                label, intent, by = verdicts[text]
            else:
                label, intent, by = self._fallback(text)
            msg = messages[idx]
            decided[idx] = ModeratedMessage(user_id=msg.user_id, nickname=msg.nickname, text=text, label=label,
                                            intent=intent, weight=weights.get(idx, 1.0), decided_by=by)
            if label == ChatLabel.ABUSE:
                self._strike(msg.user_id, time.time())
        return llm_used

    async def _llm_classify(self, texts: list[str], timeout: float) -> dict[str, tuple[ChatLabel, Intent, str]]:
        if self.backend == "local":
            return await self._llm_classify_each(texts, timeout)
        prompt = "다음 채팅들을 분류하라. 형식: 번호: 채팅\n" + "\n".join(f"{i}: {t}" for i, t in enumerate(texts))
        resp = await self.llm.generate_json(
            model=self.llm_model_name,
            system_prompt=SYSTEM_PROMPT + OUTPUT_GUIDE,
            user_prompt=prompt,
            json_schema=RESPONSE_SCHEMA,
            timeout_sec=timeout,
            temperature=0.0,
            max_output_tokens=8 * len(texts) + 32,
            mock_key="moderation",
        )
        labels = resp.data.get("labels", [])
        if len(labels) != len(texts):
            # 개수가 다르면 어느 라벨이 어느 채팅 것인지 알 수 없으므로 전부 버림
            self.stats["llm_length_mismatch"] += 1
            raise LLMUnavailable(f"label count mismatch {len(labels)} != {len(texts)}")
        verdicts: dict[str, tuple[ChatLabel, Intent, str]] = {}
        by = "llm:" + resp.model
        for text, code in zip(texts, labels):
            try:
                label, intent = code_to_label(code)
            except ValueError:
                continue
            verdicts[text] = (label, intent, by)
            self._remember(text, label, intent)
        return verdicts

    async def _llm_classify_each(self, texts: list[str], timeout: float) -> dict[str, tuple[ChatLabel, Intent, str]]:
        """로컬 LLM: 한 건씩 판정 (전체 timeout 안에서 끝난 것만 반영)."""
        verdicts: dict[str, tuple[ChatLabel, Intent, str]] = {}
        deadline = time.perf_counter() + timeout
        for text in texts:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            try:
                resp = await self.llm.generate_json(
                    model=self.llm_model_name, system_prompt=LOCAL_SYSTEM_PROMPT, user_prompt=text,
                    json_schema=SINGLE_SCHEMA, timeout_sec=remaining, temperature=0.0, max_output_tokens=16,
                    mock_key="moderation_single",
                )
                label, intent = code_to_label(resp.data.get("label", ""))
            except ValueError:
                continue
            except LLMUnavailable:
                if not verdicts:
                    raise
                break
            verdicts[text] = (label, intent, "llm:" + resp.model)
            self._remember(text, label, intent)
        return verdicts

    def _schedule_refine(self, texts: list[str]) -> None:
        """로컬 LLM 백그라운드 보정. 한 번에 하나만 실행해 로컬 자원을 과점하지 않는다."""
        texts = [t for t in texts if t not in self._cache]
        if not texts or (self._refine_task is not None and not self._refine_task.done()):
            self.stats["refine_skipped"] += bool(texts)
            return

        async def run() -> None:
            t0 = time.perf_counter()
            try:
                verdicts = await self._llm_classify(texts, settings.ollama_async_timeout_sec)
                self.stats["refined"] += len(verdicts)
                write_jsonl("moderation_refine", {
                    "model": self.llm_model_name, "latency_ms": round((time.perf_counter() - t0) * 1000),
                    "results": [{"text": t, "label": v[0].value, "intent": v[1].value} for t, v in verdicts.items()],
                })
            except LLMUnavailable as e:
                self.stats["llm_failures"] += 1
                log.info("background refine failed: %s", e)

        self._refine_task = asyncio.create_task(run())

    @staticmethod
    def _fallback(text: str) -> tuple[ChatLabel, Intent, str]:
        """LLM 불가 시: 확실한 명령 1개 또는 키워드 후보 1개일 때만 명령으로 인정."""
        if rules.has_negation(text):
            return ChatLabel.GAME_TALK, Intent.NONE, "fallback"
        strong = rules.strong_intents(text)
        if len(strong) == 1:
            return ChatLabel.COMMAND, next(iter(strong)), "fallback"
        loose = rules.loose_intents(text)
        # 키워드만 있는 경우는 요청 형태("~해줘", "~보고싶다")일 때만 명령으로 인정
        if len(loose) == 1 and rules.is_request_shaped(text):
            return ChatLabel.COMMAND, next(iter(loose)), "fallback"
        return ChatLabel.GAME_TALK if loose else ChatLabel.OFF_TOPIC, Intent.NONE, "fallback"

    def _remember(self, text: str, label: ChatLabel, intent: Intent) -> None:
        self._cache[text] = (label, intent)
        self._cache.move_to_end(text)
        while len(self._cache) > self._cache_max:
            self._cache.popitem(last=False)
