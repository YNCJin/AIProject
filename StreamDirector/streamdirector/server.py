"""게임 <-> AI 통신용 MCP 서버 (Streamable HTTP, 기본 http://127.0.0.1:8765/mcp).

게임 클라이언트(MCP Client)는 이 서버의 도구(tool)를 호출해
  - 게임 상태 전달 / 채팅·후원 입력 / AI 이벤트 수신(롱폴링)
  - 플레이 기록·세이브 데이터 저장/조회
  - 통신 상태 점검(ping, health_check)
을 수행한다. 별도 HTTP 엔드포인트: GET /health, GET /metrics, GET /chzzk/login, GET /chzzk/callback
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from mcp.server.mcpserver import MCPServer
from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import WebSocketRoute
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from . import __version__
from .collectors.chzzk import ChzzkAuth, ChzzkCollector
from .collectors.discord_bot import DiscordCollector
from .collectors.soop import SoopCollector
from .config import settings
from .db.database import Database, SaveConflict
from .llm.gemini_client import quota_guard
from .logging_setup import setup_logging, write_jsonl
from .overlay_ws import OverlayHub
from .pipeline.orchestrator import Orchestrator
from .schemas import ChatMessage, Donation, GameState

log = logging.getLogger("streamdirector.server")

INSTRUCTIONS = """StreamDirector AI 백엔드.
권장 흐름: start_play_session -> (주기적으로) update_game_state -> poll_events(wait_ms 롱폴링)로 AI 이벤트 수신
-> 이벤트 적용 -> record_play_data / save_game -> end_play_session.
채팅은 치지직/디스코드 수집기가 자동 입력하며, 직접 넣으려면 ingest_chat / ingest_donation 사용."""


@dataclass
class AppState:
    db: Database
    orch: Orchestrator
    chzzk_auth: ChzzkAuth
    chzzk: ChzzkCollector | None = None
    discord: DiscordCollector | None = None
    soop: SoopCollector | None = None
    overlay: OverlayHub = field(default_factory=OverlayHub)
    started_at: float = field(default_factory=time.time)
    running: bool = False

    async def start(self, collectors: bool = True) -> None:
        if self.running:
            return
        self.running = True
        self.orch.start()
        # 게임 화면 채팅 오버레이(/ws)로 채팅·후원·이벤트 전달
        self.orch.chat_listeners.append(self.overlay.on_chat)
        self.orch.listeners.append(self.overlay.on_event)
        # 로컬 검열 모델(kor_unsmile, KcELECTRA, Ollama)은 무거우므로 백그라운드 로딩 - 그동안은 규칙 기반
        if hasattr(self.orch.moderation, "load_models"):
            self._model_task = asyncio.create_task(self.orch.moderation.load_models())
        if not collectors:
            return
        orch = self.orch

        def on_chat(msg: ChatMessage) -> None:
            orch.ingest_chat(orch.active_session_id, [msg])

        async def on_donation(don: Donation) -> dict[str, Any]:
            return await orch.ingest_donation(orch.active_session_id, don)

        if settings.chzzk_enabled and self.chzzk_auth.configured:
            self.chzzk = ChzzkCollector(self.chzzk_auth, on_chat, on_donation)
            if self.chzzk_auth.access_token:
                self.chzzk.start()
            else:
                self.chzzk.status["state"] = "auth_required"
                log.info("CHZZK: 브라우저에서 http://%s:%s/chzzk/login 으로 계정 연동 필요",
                         settings.host, settings.port)
        self.soop = SoopCollector(settings.soop_client_id, settings.soop_client_secret, on_chat, on_donation)
        self.soop.start()
        # 디스코드 봇은 기본적으로 별도 프로세스(python -m streamdirector.discord_bot)로 실행한다.
        # DISCORD_MODE=embedded 일 때만 서버 안에서 함께 실행 (같은 토큰으로 두 번 띄우지 않도록)
        if settings.discord_bot_token and settings.discord_mode == "embedded":
            self.discord = DiscordCollector(settings.discord_bot_token, on_chat, on_donation,
                                            settings.discord_channel_id, settings.discord_guild_id)
            orch.listeners.append(self.discord.announce)
            self.discord.start()

    async def stop(self) -> None:
        for c in (self.chzzk, self.discord, self.soop):
            if c:
                await c.stop()
        await self.orch.stop()
        self.running = False

    def collectors_status(self) -> dict[str, Any]:
        st: dict[str, Any] = {
            "chzzk": self.chzzk.status if self.chzzk else
            {"state": "disabled" if not self.chzzk_auth.configured else "not_started"},
            "soop": self.soop.status if self.soop else {"state": "disabled"},
            "discord": self.discord.status if self.discord else {
                "state": "standalone" if settings.discord_mode != "embedded" else "disabled",
                "reason": "별도 프로세스(python -m streamdirector.discord_bot)로 실행" if settings.discord_mode != "embedded"
                else "DISCORD_BOT_TOKEN 미설정"},
            "overlay_clients": len(self.overlay.clients),
            "active_session_id": self.orch.active_session_id,
        }
        if self.discord:
            st["discord"] = {**self.discord.status, "latency_ms": self.discord.latency_ms()}
        return st


def create_state() -> AppState:
    return AppState(
        db=Database(settings.db_path, settings.max_save_bytes),
        orch=Orchestrator(),
        chzzk_auth=ChzzkAuth(settings.chzzk_client_id, settings.chzzk_client_secret, settings.chzzk_redirect_uri,
                             settings.chzzk_access_token, settings.chzzk_refresh_token),
    )


async def moderation_status(mod: Any) -> dict[str, Any]:
    if hasattr(mod, "status_async"):
        return await mod.status_async()
    return mod.status() if hasattr(mod, "status") else {}


def create_server(state: AppState) -> MCPServer:
    mcp = MCPServer(name="streamdirector", title="StreamDirector AI Backend", version=__version__,
                    instructions=INSTRUCTIONS)
    db, orch = state.db, state.orch

    # ------------------------------------------------------------------ 통신 점검
    @mcp.tool(description="왕복 지연 측정용 경량 ping. 게임은 주기적으로 호출해 통신 상태를 확인한다.")
    async def ping(client_ts: float = 0.0) -> dict[str, Any]:
        now = time.time()
        return {"pong": True, "server_ts": now, "client_ts": client_ts, "uptime_sec": round(now - state.started_at, 1)}

    @mcp.tool(description="DB·LLM·검열 에이전트·채팅 수집기 상태 종합 점검. deep=true 면 Gemini 실제 호출로 확인.")
    async def health_check(deep: bool = False) -> dict[str, Any]:
        result: dict[str, Any] = {"server": "ok", "version": __version__, "uptime_sec": round(time.time() - state.started_at, 1)}
        try:
            result["db"] = {"ok": True, "latency_ms": await db.ping()}
        except Exception as e:
            result["db"] = {"ok": False, "error": str(e)}
        llm = orch.engine.llm
        result["llm"] = await llm.probe(settings.event_model) if deep else {"mode": llm.mode,
                                                                          "event_model": settings.event_model,
                                                                          "moderation_model": settings.moderation_model}
        mod = orch.moderation
        result["moderation_agent"] = {"type": type(mod).__name__, "url": getattr(mod, "url", "in-process"),
                                      **(await moderation_status(mod))}
        result["gemini_quota"] = quota_guard.usage()
        result["collectors"] = state.collectors_status()
        write_jsonl("connection", {"kind": "health_check", "deep": deep, **result})
        return result

    @mcp.tool(description="파이프라인 지표 (지연 p50/p95, 차단율, 스키마 준수율, 이벤트 수).")
    async def get_metrics() -> dict[str, Any]:
        return {**orch.metrics(), "gemini_quota": quota_guard.usage()}

    # ------------------------------------------------------------------ 플레이 세션 / 게임 상태
    @mcp.tool(description="새 플레이 세션 시작. 반환된 session_id 로 이후 도구를 호출한다. "
                          "bind_chat=true 면 방송 채팅이 이 세션으로 들어온다.")
    async def start_play_session(player_id: str, nickname: str = "", bind_chat: bool = True) -> dict[str, Any]:
        row = await db.start_session(player_id, nickname)
        orch.session(row["session_id"])
        if bind_chat:
            orch.active_session_id = row["session_id"]
        return row

    @mcp.tool(description="방송 채팅/후원이 들어갈 게임 세션 지정.")
    async def set_chat_target(session_id: str) -> dict[str, Any]:
        orch.session(session_id)
        orch.active_session_id = session_id
        return {"active_session_id": session_id}

    @mcp.tool(description="현재 게임 상태를 전달 (LLM 컨텍스트 주입용, 1~3초마다 권장). "
                          "snapshot=true 면 플레이 기록(play_snapshots)에도 저장.")
    async def update_game_state(session_id: str, game_state: GameState,
                                snapshot: bool = False, kills: int = 0) -> dict[str, Any]:
        state_ = game_state
        orch.update_game_state(session_id, state_)
        # 서버 재시작 등으로 방송 채팅이 연결된 판이 없으면, 상태를 보내오는 판에 다시 연결
        if orch.active_session_id not in orch.sessions or orch.active_session_id == "default":
            orch.active_session_id = session_id
        out: dict[str, Any] = {"ok": True}
        if snapshot:
            out["session"] = await db.record_snapshot(session_id, state_.wave, state_.player_hp, state_.player_level,
                                                      state_.score, kills, orch.session(session_id).seq)
        return out

    @mcp.tool(description="플레이 진행 기록 저장 (웨이브 클리어 시점 등).")
    async def record_play_data(session_id: str, wave: int, hp: float, level: int, score: int, kills: int,
                               ai_events_applied: int | None = None, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            return await db.record_snapshot(session_id, wave, hp, level, score, kills, ai_events_applied, extra)
        except KeyError as e:
            raise ValueError(str(e)) from e

    @mcp.tool(description="플레이 세션 종료. status: cleared | dead | quit")
    async def end_play_session(session_id: str, status: str, final_wave: int, score: int, kills: int, level: int,
                               ai_events_applied: int = 0, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            return await db.end_session(session_id, status, final_wave, score, kills, level, ai_events_applied, extra)
        except KeyError as e:
            raise ValueError(str(e)) from e

    @mcp.tool(description="유저 누적 플레이 통계 + 최근 세션.")
    async def get_player_stats(player_id: str, recent: int = 10) -> dict[str, Any]:
        return await db.player_stats(player_id, max(1, min(recent, 50)))

    # ------------------------------------------------------------------ 세이브 데이터
    @mcp.tool(description="세이브 저장 (slot 0~9). expected_version 을 주면 버전 충돌 시 거부(다중 기기 덮어쓰기 방지).")
    async def save_game(player_id: str, slot: int, data: dict[str, Any], expected_version: int | None = None,
                        label: str = "") -> dict[str, Any]:
        try:
            return await db.save(player_id, slot, data, expected_version, label)
        except SaveConflict as e:
            raise ValueError(str(e)) from e

    @mcp.tool(description="세이브 불러오기. 없으면 found=false. integrity_ok 로 무결성 확인.")
    async def load_game(player_id: str, slot: int) -> dict[str, Any]:
        save = await db.load(player_id, slot)
        return {"found": save is not None, "save": save}

    @mcp.tool(description="세이브 슬롯 목록.")
    async def list_saves(player_id: str) -> dict[str, Any]:
        return {"saves": await db.list_saves(player_id)}

    @mcp.tool(description="세이브 슬롯 삭제.")
    async def delete_save(player_id: str, slot: int) -> dict[str, Any]:
        return {"deleted": await db.delete_save(player_id, slot)}

    # ------------------------------------------------------------------ 채팅 / AI 이벤트
    @mcp.tool(description="채팅 입력 (윈도우 배칭 대기열에 추가, CHAT_WINDOW_SEC 마다 자동 처리).")
    async def ingest_chat(session_id: str, messages: list[ChatMessage]) -> dict[str, Any]:
        return {"queued": orch.ingest_chat(session_id, messages)}

    @mcp.tool(description="후원 입력. 소액=다음 투표 가중치, 고액(DONATION_INSTANT_THRESHOLD 이상)=즉시 발동.")
    async def ingest_donation(session_id: str, donation: Donation) -> dict[str, Any]:
        return await orch.ingest_donation(session_id, donation)

    @mcp.tool(description="채팅 묶음을 즉시 전체 파이프라인(검열->검증->Gemini->클램핑)으로 처리하고 결과 반환.")
    async def process_chat_batch(session_id: str, messages: list[ChatMessage],
                                 game_state: GameState | None = None) -> dict[str, Any]:
        result = await orch.run_pipeline(session_id, messages, game_state=game_state)
        return result.model_dump(mode="json")

    @mcp.tool(description="since_seq 이후 생성된 AI 이벤트 조회. wait_ms(최대 10000) 동안 새 이벤트를 기다리는 롱폴링. "
                          "session_id='active' 는 현재 방송 채팅이 연결된 세션 (응답의 session_id 로 실제 세션 확인).")
    async def poll_events(session_id: str, since_seq: int = 0, wait_ms: int = 0) -> dict[str, Any]:
        sid = orch.resolve(session_id)
        events = await orch.poll_events(sid, since_seq, max(0, min(wait_ms, 10000)))
        s = orch.session(sid)
        return {"session_id": sid, "events": [e.model_dump(mode="json") for e in events], "last_seq": s.seq,
                "server_ts": time.time()}

    @mcp.tool(description="검열 에이전트만 단독 실행 (디버그/대시보드용).")
    async def moderate_chat(messages: list[ChatMessage]) -> dict[str, Any]:
        res = await orch.moderation.moderate(messages, session_id="debug")
        return res.model_dump(mode="json")

    @mcp.tool(description="운영자 수동 차단.")
    async def block_user(user_id: str) -> dict[str, Any]:
        await orch.block_user(user_id)
        return {"blocked": user_id}

    @mcp.tool(description="운영자 차단 해제 (자동 뮤트도 해제).")
    async def unblock_user(user_id: str) -> dict[str, Any]:
        await orch.unblock_user(user_id)
        return {"unblocked": user_id}

    # ------------------------------------------------------------------ HTTP 라우트
    @mcp.custom_route("/health", methods=["GET"])
    async def http_health(_: Request) -> Response:
        mod = orch.moderation
        return JSONResponse({"ok": True, "uptime_sec": round(time.time() - state.started_at, 1),
                             "llm_mode": orch.engine.llm.mode, "gemini_quota": quota_guard.usage(),
                             "moderation": await moderation_status(mod),
                             "collectors": state.collectors_status()})

    @mcp.custom_route("/metrics", methods=["GET"])
    async def http_metrics(_: Request) -> Response:
        return JSONResponse(orch.metrics())

    @mcp.custom_route("/chzzk/login", methods=["GET"])
    async def chzzk_login(_: Request) -> Response:
        if not state.chzzk_auth.configured:
            return JSONResponse({"error": "CHZZK_CLIENT_ID/SECRET 미설정"}, status_code=400)
        return RedirectResponse(state.chzzk_auth.login_url())

    @mcp.custom_route("/chzzk/callback", methods=["GET"])
    async def chzzk_callback(request: Request) -> Response:
        code, st = request.query_params.get("code", ""), request.query_params.get("state", "")
        try:
            await state.chzzk_auth.exchange_code(code, st)
        except Exception as e:
            return HTMLResponse(f"<h3>치지직 연동 실패</h3><p>{type(e).__name__}</p>", status_code=400)
        if state.chzzk is None:
            await _start_chzzk_after_login(state)
        else:
            state.chzzk.start()
        return HTMLResponse("<h3>치지직 연동 완료</h3><p>이 창을 닫아도 됩니다. 채팅/후원 수신을 시작합니다.</p>")

    return mcp


async def _start_chzzk_after_login(state: AppState) -> None:
    orch = state.orch

    def on_chat(msg: ChatMessage) -> None:
        orch.ingest_chat(orch.active_session_id, [msg])

    async def on_donation(don: Donation) -> dict[str, Any]:
        return await orch.ingest_donation(orch.active_session_id, don)

    state.chzzk = ChzzkCollector(state.chzzk_auth, on_chat, on_donation)
    state.chzzk.start()


class PrivateNetworkAccessMiddleware:
    """사설망 접근 사전 요청(preflight)에 Access-Control-Allow-Private-Network 헤더를 붙인다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "OPTIONS":
            return await self.app(scope, receive, send)

        async def send_with_header(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [(b"access-control-allow-private-network", b"true")]
            await send(message)

        await self.app(scope, receive, send_with_header)


def build_app(state: AppState | None = None, collectors: bool | None = None) -> tuple[Starlette, AppState]:
    """uvicorn 으로 띄울 ASGI 앱. 파이프라인 루프와 수집기는 앱 lifespan 에서 시작된다."""
    setup_logging()
    state = state or create_state()
    mcp = create_server(state)
    app = mcp.streamable_http_app(json_response=True, host=settings.host)
    inner_lifespan = app.router.lifespan_context
    use_collectors = settings.collectors_enabled if collectors is None else collectors

    @contextlib.asynccontextmanager
    async def lifespan(a: Starlette):
        await state.start(collectors=use_collectors)
        log.info("StreamDirector MCP server ready on http://%s:%s/mcp (LLM mode=%s)",
                 settings.host, settings.port, state.orch.engine.llm.mode)
        try:
            async with inner_lifespan(a):
                yield
        finally:
            await state.stop()
            state.db.close()

    app.router.lifespan_context = lifespan
    app.router.routes.append(WebSocketRoute("/ws", state.overlay.endpoint))
    origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
                       allow_headers=["*"], expose_headers=["Mcp-Session-Id", "Mcp-Protocol-Version"])
    # GitHub Pages(https) 에 배포된 게임이 내 PC 의 localhost 서버에 접속할 수 있도록 (Chrome Private Network Access)
    # CORS 가 preflight 에 직접 응답하므로 그보다 바깥(나중에 추가)에 둬야 헤더가 붙는다
    app.add_middleware(PrivateNetworkAccessMiddleware)
    return app, state


def main() -> None:
    import uvicorn

    app, _ = build_app()
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
