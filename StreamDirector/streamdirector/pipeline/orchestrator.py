"""파이프라인 오케스트레이터.

채팅 수집 -> [검열 에이전트] -> [데이터 확인] -> [Gemini 이벤트 엔진] -> 쿨다운/예산 -> 이벤트 큐 -> 게임(MCP)
모든 실행 결과는 logs/ai_results.jsonl 에 기록된다 (DB 저장 없음).
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import statistics
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from ..agents.moderation_agent import ModerationAgent
from ..agents.remote import RemoteModerationAgent
from ..config import settings
from ..logging_setup import anonymize, write_jsonl
from ..schemas import ChatMessage, Donation, EventType, GameEvent, GameState, PipelineResult
from .event_engine import EventEngine
from .validator import validate_batch

log = logging.getLogger("streamdirector.orchestrator")


@dataclass
class SessionState:
    session_id: str
    game_state: GameState = field(default_factory=GameState)
    buffer: list[ChatMessage] = field(default_factory=list)
    buffer_weights: dict[int, float] = field(default_factory=dict)
    events: deque[GameEvent] = field(default_factory=lambda: deque(maxlen=200))
    seq: int = 0
    last_event_at: dict[str, float] = field(default_factory=dict)
    event_times: deque[float] = field(default_factory=lambda: deque(maxlen=100))
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)
    last_seen: float = field(default_factory=time.time)
    # 수집기(치지직/디스코드)가 보내준 최근 원본 채팅 수 - 대시보드용
    ingested: int = 0
    # 현재 윈도우의 첫 메시지 도착 시각 (고정 주기가 아니라 첫 채팅 기준으로 윈도우를 연다)
    window_started_at: float | None = None


class Orchestrator:
    def __init__(self, moderation: ModerationAgent | RemoteModerationAgent | None = None,
                 engine: EventEngine | None = None):
        if moderation is None:
            moderation = (RemoteModerationAgent(settings.moderation_agent_url)
                          if settings.moderation_agent_url else ModerationAgent())
        self.moderation = moderation
        self.engine = engine or EventEngine()
        self.sessions: dict[str, SessionState] = {}
        self.latencies_ms: deque[float] = deque(maxlen=1000)  # 파이프라인 처리 시간
        self.chat_to_event_ms: deque[float] = deque(maxlen=1000)  # 채팅 발생 ~ 이벤트 큐 적재
        self.counters = {"runs": 0, "events": 0, "no_event": 0, "throttled": 0, "errors": 0,
                         "messages": 0, "blocked_messages": 0}
        self._loop_task: asyncio.Task | None = None
        self._flush_tasks: set[asyncio.Task] = set()
        # 이벤트 발동 시 호출되는 콜백 (디스코드 알림, 오버레이 등)
        self.listeners: list[Any] = []
        # 외부 채팅 수집기(치지직/디스코드)가 채팅을 넣을 대상 게임 세션
        self.active_session_id = "default"
        # 채팅/후원이 들어올 때 호출되는 콜백 (게임 화면 채팅 오버레이 /ws 등)
        self.chat_listeners: list[Any] = []

    def resolve(self, session_id: str) -> str:
        """'active' 는 현재 방송 채팅이 연결된 게임 세션을 뜻한다 (디스코드 봇 등 외부 프로세스용)."""
        return self.active_session_id if session_id in ("", "active") else session_id

    def _notify_chat(self, kind: str, payload: Any) -> None:
        for cb in self.chat_listeners:
            try:
                cb(kind, payload)
            except Exception:
                log.exception("chat listener failed")

    # ------------------------------------------------------------------ 세션
    def session(self, session_id: str) -> SessionState:
        s = self.sessions.get(session_id)
        if s is None:
            s = self.sessions[session_id] = SessionState(session_id)
        s.last_seen = time.time()
        return s

    def update_game_state(self, session_id: str, state: GameState) -> None:
        self.session(session_id).game_state = state

    # ------------------------------------------------------------------ 입력
    def ingest_chat(self, session_id: str, messages: list[ChatMessage]) -> int:
        session_id = self.resolve(session_id)
        s = self.session(session_id)
        for m in messages:
            self._notify_chat("chat", m)
        room = settings.max_messages_per_window * 2 - len(s.buffer)
        accepted = messages[: max(0, room)]
        if accepted and not s.buffer:
            s.window_started_at = time.monotonic()
        s.buffer.extend(accepted)
        s.ingested += len(messages)
        return len(accepted)

    async def ingest_donation(self, session_id: str, donation: Donation) -> dict[str, Any]:
        """소액: 다음 윈도우 투표에 가중치로 반영 / 고액: 즉시 발동."""
        session_id = self.resolve(session_id)
        s = self.session(session_id)
        self._notify_chat("donation", donation)
        msg = ChatMessage(user_id=donation.user_id, nickname=donation.nickname, text=donation.text or "",
                          ts=donation.ts, platform="donation")
        weight = 1.0 + donation.amount / max(1, settings.donation_vote_unit)
        if donation.amount >= settings.donation_instant_threshold and donation.text.strip():
            result = await self.run_pipeline(session_id, [msg], {0: min(weight, 20.0)}, source="donation",
                                             donor=donation)
            return {"mode": "instant", "result": result.model_dump()}
        if donation.text.strip():
            if not s.buffer:
                s.window_started_at = time.monotonic()
            s.buffer.append(msg)
            s.buffer_weights[len(s.buffer) - 1] = min(weight, 20.0)
        return {"mode": "vote", "weight": round(min(weight, 20.0), 2)}

    # ------------------------------------------------------------------ 윈도우 처리
    async def flush_window(self, session_id: str) -> PipelineResult | None:
        s = self.session(session_id)
        if not s.buffer:
            return None
        msgs, weights = s.buffer, s.buffer_weights
        s.buffer, s.buffer_weights, s.window_started_at = [], {}, None
        return await self.run_pipeline(session_id, msgs, weights, source="vote")

    async def window_loop(self) -> None:
        """첫 채팅 도착 후 window_sec 가 지나면 해당 세션 윈도우를 마감·처리 (어떤 채팅도 window_sec 이상 대기하지 않음)."""
        tick = min(0.1, settings.window_sec / 4)
        while True:
            await asyncio.sleep(tick)
            now = time.monotonic()
            for sid, s in list(self.sessions.items()):
                if s.buffer and s.window_started_at is not None and now - s.window_started_at >= settings.window_sec:
                    task = asyncio.create_task(self._safe_flush(sid))
                    self._flush_tasks.add(task)
                    task.add_done_callback(self._flush_tasks.discard)
                    s.window_started_at = None  # 중복 마감 방지
            # 1시간 이상 비활성 세션 정리
            now = time.time()
            for sid, s in list(self.sessions.items()):
                if now - s.last_seen > 3600 and not s.buffer:
                    del self.sessions[sid]

    async def _safe_flush(self, sid: str) -> None:
        try:
            await self.flush_window(sid)
        except Exception:
            log.exception("window flush failed for %s", sid)

    def start(self) -> None:
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self.window_loop())

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
        if isinstance(self.moderation, RemoteModerationAgent):
            await self.moderation.close()

    # ------------------------------------------------------------------ 핵심 파이프라인
    async def run_pipeline(self, session_id: str, messages: list[ChatMessage], weights: dict[int, float] | None = None,
                           source: str = "vote", donor: Donation | None = None,
                           game_state: GameState | None = None) -> PipelineResult:
        t0 = time.perf_counter()
        request_id = uuid.uuid4().hex[:12]
        s = self.session(session_id)
        if game_state is not None:
            s.game_state = game_state
        gs = s.game_state
        lat: dict[str, float] = {}
        log_rec: dict[str, Any] = {"request_id": request_id, "session_id": session_id, "source": source,
                                   "input_messages": len(messages), "game_state": gs.model_dump()}
        if donor:
            log_rec["donation"] = {"user": anonymize(donor.user_id), "amount": donor.amount, "text": donor.text}
        self.counters["runs"] += 1
        self.counters["messages"] += len(messages)

        try:
            # 1) 검열 에이전트
            t = time.perf_counter()
            mod = await self.moderation.moderate(messages, weights, session_id=session_id)
            lat["moderation"] = round((time.perf_counter() - t) * 1000, 2)
            self.counters["blocked_messages"] += sum(mod.rejected_counts.get(k, 0)
                                                     for k in ("ABUSE", "SPAM", "BLOCKED"))
            mod_summary = {"total": mod.total, "accepted": len(mod.accepted), "rejected": mod.rejected_counts,
                           "llm_used": mod.llm_used}

            # 2) 데이터 확인
            t = time.perf_counter()
            batch = validate_batch(mod, gs)
            lat["validation"] = round((time.perf_counter() - t) * 1000, 2)
            log_rec.update(moderation=mod_summary, validation=batch.summary())

            if not batch.ok:
                return self._finish(log_rec, t0, lat, PipelineResult(
                    request_id=request_id, session_id=session_id, event=None, status="no_event",
                    detail=batch.reason, moderation=mod_summary, validation=batch.summary()))

            # 3) 쿨다운 / 개입 예산 (LLM 호출 전에 검사해 비용 절약)
            throttle = self._throttle_reason(s, batch.top.intent.value if batch.top else "", source)
            if throttle:
                self.counters["throttled"] += 1
                return self._finish(log_rec, t0, lat, PipelineResult(
                    request_id=request_id, session_id=session_id, event=None, status="throttled",
                    detail=throttle, moderation=mod_summary, validation=batch.summary()))

            # 4) Gemini 이벤트 생성 + 클램핑
            t = time.perf_counter()
            event, meta = await self.engine.generate(batch, source=source,
                                                     donor_text=donor.text if donor else "")
            lat["llm"] = round((time.perf_counter() - t) * 1000, 2)
            log_rec["llm"] = meta
            if donor:
                event.donor = donor.nickname or anonymize(donor.user_id)
                event.donation_amount = donor.amount

            # 5) 이벤트 큐 적재 + 대기 중인 게임 클라이언트 깨우기
            await self._publish(s, event, request_id)
            if messages:
                earliest = min(m.ts for m in messages)
                self.chat_to_event_ms.append((time.time() - earliest) * 1000)
            return self._finish(log_rec, t0, lat, PipelineResult(
                request_id=request_id, session_id=session_id, event=event, status="event",
                moderation=mod_summary, validation=batch.summary()))
        except Exception as e:
            log.exception("pipeline error")
            self.counters["errors"] += 1
            return self._finish(log_rec, t0, lat, PipelineResult(
                request_id=request_id, session_id=session_id, event=None, status="error",
                detail=f"{type(e).__name__}: {e}"))

    def _throttle_reason(self, s: SessionState, intent: str, source: str) -> str:
        now = time.time()
        while s.event_times and now - s.event_times[0] > 60:
            s.event_times.popleft()
        budget = settings.max_events_per_minute + (2 if source == "donation" else 0)
        if len(s.event_times) >= budget:
            return f"intervention budget exceeded ({budget}/min)"
        if source != "donation":  # 고액 후원은 쿨다운 무시
            last = s.last_event_at.get(intent, 0)
            if now - last < settings.event_cooldown_sec:
                return f"cooldown for {intent}: {settings.event_cooldown_sec - (now - last):.1f}s left"
        return ""

    async def _publish(self, s: SessionState, event: GameEvent, request_id: str) -> None:
        s.seq += 1
        event.seq = s.seq
        event.event_id = request_id
        s.events.append(event)
        now = time.time()
        s.event_times.append(now)
        from .event_engine import INTENT_TO_EVENT  # 쿨다운 키는 의도 기준
        for intent, (et, variant) in INTENT_TO_EVENT.items():
            if et == event.event_type and (et != EventType.ENEMY_SPEED or variant == event.variant):
                s.last_event_at[intent.value] = now
        self.counters["events"] += 1
        async with s.cond:
            s.cond.notify_all()
        for cb in self.listeners:
            try:
                r = cb(s.session_id, event)
                if inspect.isawaitable(r):
                    asyncio.create_task(r)
            except Exception:
                log.exception("event listener failed")

    def _finish(self, rec: dict[str, Any], t0: float, lat: dict[str, float], result: PipelineResult) -> PipelineResult:
        lat["total"] = round((time.perf_counter() - t0) * 1000, 2)
        result.latency_ms = lat
        self.latencies_ms.append(lat["total"])
        if result.status == "no_event":
            self.counters["no_event"] += 1
        rec.update(status=result.status, detail=result.detail, latency_ms=lat,
                   event=result.event.model_dump() if result.event else None)
        write_jsonl("ai_results", rec)
        return result

    # ------------------------------------------------------------------ 출력
    async def poll_events(self, session_id: str, since_seq: int = 0, wait_ms: int = 0) -> list[GameEvent]:
        """since_seq 이후 이벤트 반환. wait_ms>0 이면 새 이벤트가 생길 때까지 최대 그만큼 대기(롱폴링)."""
        s = self.session(self.resolve(session_id))

        def newer() -> list[GameEvent]:
            return [e for e in s.events if e.seq > since_seq]

        found = newer()
        if found or wait_ms <= 0:
            return found
        try:
            async with s.cond:
                await asyncio.wait_for(s.cond.wait_for(lambda: bool(newer())), timeout=wait_ms / 1000)
        except TimeoutError:
            pass
        return newer()

    async def block_user(self, user_id: str) -> None:
        r = self.moderation.block_user(user_id)
        if inspect.isawaitable(r):
            await r

    async def unblock_user(self, user_id: str) -> None:
        r = self.moderation.unblock_user(user_id)
        if inspect.isawaitable(r):
            await r

    def metrics(self) -> dict[str, Any]:
        def pct(values: deque[float], p: float) -> float | None:
            if not values:
                return None
            v = sorted(values)
            return round(v[min(len(v) - 1, int(len(v) * p))], 2)

        mod_stats = dict(getattr(self.moderation, "stats", {}))
        total_msgs = self.counters["messages"] or 1
        eng = self.engine.stats
        return {
            "counters": self.counters,
            "pipeline_latency_ms": {"p50": pct(self.latencies_ms, 0.5), "p95": pct(self.latencies_ms, 0.95),
                                    "max": max(self.latencies_ms) if self.latencies_ms else None,
                                    "mean": round(statistics.fmean(self.latencies_ms), 2) if self.latencies_ms else None},
            "chat_to_event_ms": {"p50": pct(self.chat_to_event_ms, 0.5), "p95": pct(self.chat_to_event_ms, 0.95)},
            "block_rate": round(self.counters["blocked_messages"] / total_msgs, 4),
            "engine": eng,
            # 모델이 응답한 것 중 스키마를 지킨 비율 (타임아웃/네트워크 오류는 제외)
            "schema_compliance": round(1 - eng["schema_violations"] / eng["llm_responses"], 4)
            if eng["llm_responses"] else None,
            "moderation": mod_stats,
            "sessions": {sid: {"buffered": len(s.buffer), "events": s.seq, "ingested": s.ingested}
                         for sid, s in self.sessions.items()},
        }
