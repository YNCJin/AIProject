"""StreamDirector 미들웨어 (1차: 채팅 / 후원 중계)

채팅 출처(Discord / 치지직 / 더미)에서 받은 채팅과 후원을 WebSocket(ws://localhost:8000/ws)으로 게임에 전달한다.
출처는 관리 화면(http://localhost:8000)에서 서버를 켠 채로 켜고 끌 수 있다.
나중에 이 사이에 전처리 -> LLM 이벤트 변환 단계가 들어갈 예정.

실행: python server.py
"""

import asyncio
import logging
import os
import random
import time
from contextlib import asynccontextmanager
from pathlib import Path

import discord
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from pydantic import BaseModel

load_dotenv()

from chzzk import ChzzkSource  # noqa: E402  (.env 를 먼저 읽은 뒤 import)

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
DISCORD_CHANNEL_IDS = {
    int(x) for x in os.getenv("DISCORD_CHANNEL_IDS", "").replace(" ", "").split(",") if x
}

MAX_USER_LEN = 20
MAX_TEXT_LEN = 100

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("middleware")


# ------------------------------------------------------------------ 채팅 출처 켜기 / 끄기

SOURCE_NAMES = ("discord", "chzzk", "dummy")
SOURCE_LABELS = {"discord": "Discord", "chzzk": "치지직", "dummy": "더미", "manual": "수동"}


def _initial_sources() -> dict[str, bool]:
    names = {x.strip() for x in os.getenv("CHAT_SOURCES", "discord,chzzk").split(",") if x.strip()}
    if os.getenv("DUMMY_CHAT", "0") == "1":     #  예전 설정 호환
        names.add("dummy")
    return {name: name in names for name in SOURCE_NAMES}


enabled_sources = _initial_sources()


# ------------------------------------------------------------------ WebSocket 허브

class Hub:
    """접속한 모든 게임 클라이언트(게임, 나중에 OBS 오버레이/대시보드)에 메시지를 뿌린다."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)
        log.info("클라이언트 접속 (현재 %d개)", len(self.clients))

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)
        log.info("클라이언트 종료 (현재 %d개)", len(self.clients))

    async def broadcast(self, message: dict) -> None:
        for ws in list(self.clients):
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(ws)


hub = Hub()


#  게임으로 보내는 메시지 형식
#  채팅: { type: "chat", platform, user, text, ts }
#  후원: { type: "donation", platform, user, amount, text, ts }
async def emit_chat(platform: str, user: str, text: str) -> None:
    if platform in enabled_sources and not enabled_sources[platform]:
        return      #  꺼진 출처는 무시 (manual 은 항상 통과)
    log.info("[%s] 채팅 %s: %s -> 게임 %d개로 전송", SOURCE_LABELS[platform], user, text, len(hub.clients))
    await hub.broadcast({
        "type": "chat", "platform": platform,
        "user": user[:MAX_USER_LEN], "text": text[:MAX_TEXT_LEN], "ts": time.time(),
    })


async def emit_donation(platform: str, user: str, amount: int, text: str) -> None:
    if platform in enabled_sources and not enabled_sources[platform]:
        return
    log.info("[%s] 후원 %s %s원: %s -> 게임 %d개로 전송", SOURCE_LABELS[platform], user, f"{amount:,}", text, len(hub.clients))
    await hub.broadcast({
        "type": "donation", "platform": platform,
        "user": user[:MAX_USER_LEN], "amount": amount, "text": text[:MAX_TEXT_LEN], "ts": time.time(),
    })


# ------------------------------------------------------------------ Discord 봇

intents = discord.Intents.default()
intents.message_content = True  # Developer Portal에서 "Message Content Intent"도 켜야 함
discord_client = discord.Client(intents=intents)


@discord_client.event
async def on_ready() -> None:
    log.info("Discord 로그인 완료: %s", discord_client.user)
    if DISCORD_CHANNEL_IDS:
        for channel_id in DISCORD_CHANNEL_IDS:
            channel = discord_client.get_channel(channel_id)
            if channel:
                log.info("수신 채널: #%s (%s)", channel, channel_id)
            else:
                log.warning(
                    "채널 %s 을(를) 찾을 수 없습니다. 채널 ID가 맞는지, 봇이 그 서버에 초대되어 있고 "
                    "채널 보기 권한이 있는지 확인하세요.", channel_id
                )
    else:
        log.info("수신 채널: 봇이 볼 수 있는 모든 채널")


@discord_client.event
async def on_message(message: discord.Message) -> None:
    if message.author.bot:
        return
    if DISCORD_CHANNEL_IDS and message.channel.id not in DISCORD_CHANNEL_IDS:
        log.info("무시: #%s (%s) 는 수신 채널이 아님", message.channel, message.channel.id)
        return

    text = message.clean_content.strip()  # 멘션(<@123>)을 @닉네임 형태로 변환
    if not text:
        log.warning("무시: 내용이 비어 있음 (Message Content Intent 가 꺼져 있거나 이미지/스티커만 보낸 경우)")
        return

    await emit_chat("discord", message.author.display_name, text)


def log_task_error(task: asyncio.Task) -> None:
    if task.cancelled() or not task.exception():
        return

    error = task.exception()
    if isinstance(error, discord.PrivilegedIntentsRequired):
        log.error(
            "Discord 연결 실패: Message Content Intent 가 꺼져 있습니다. "
            "Developer Portal > Bot > Privileged Gateway Intents 에서 "
            "'Message Content Intent' 를 켜고 저장(Save Changes)한 뒤 서버를 다시 실행하세요."
        )
    elif isinstance(error, discord.LoginFailure):
        log.error("Discord 연결 실패: 토큰이 올바르지 않습니다. .env 의 DISCORD_BOT_TOKEN 을 확인하세요.")
    else:
        log.error("Discord 연결 실패: %r", error)


# ------------------------------------------------------------------ 치지직

chzzk = ChzzkSource(
    on_chat=lambda user, text: emit_chat("chzzk", user, text),
    on_donation=lambda user, amount, text: emit_donation("chzzk", user, amount, text),
)


# ------------------------------------------------------------------ 더미 채팅 (테스트용)

DUMMY_USERS = ["철수", "영희", "민수", "지수", "뉴비123", "고인물", "치킨러버"]
DUMMY_TEXTS = [
    "ㅋㅋㅋㅋㅋ", "몹 더 풀어주세요", "힐 좀 줘라", "보스 소환 가즈아", "이거 어떻게 깸?",
    "와 컨트롤 미쳤다", "적 두 배로!", "살려줘ㅠㅠ", "속도 올려줘", "GG",
]


async def dummy_chat_loop() -> None:
    while True:
        await asyncio.sleep(random.uniform(1.0, 3.0))
        if enabled_sources["dummy"]:
            await emit_chat("dummy", random.choice(DUMMY_USERS), random.choice(DUMMY_TEXTS))


# ------------------------------------------------------------------ FastAPI 앱

@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks: list[asyncio.Task] = [asyncio.create_task(dummy_chat_loop())]

    if DISCORD_BOT_TOKEN:
        task = asyncio.create_task(discord_client.start(DISCORD_BOT_TOKEN))
        task.add_done_callback(log_task_error)
        tasks.append(task)
    else:
        log.warning("DISCORD_BOT_TOKEN 이 없어 Discord 연동 없이 실행합니다.")

    if not chzzk.configured:
        log.warning("CHZZK_CLIENT_ID / CHZZK_CLIENT_SECRET 이 없어 치지직 연동 없이 실행합니다.")
    elif not chzzk.authorized:
        log.info("치지직: 관리 화면(http://localhost:8000)에서 '치지직 연결' 을 눌러 로그인하세요.")
    else:
        chzzk.start()   #  저장된 토큰으로 자동 연결

    log.info("채팅 출처: %s", ", ".join(f"{SOURCE_LABELS[k]} {'ON' if v else 'OFF'}" for k, v in enabled_sources.items()))
    log.info("관리 화면: http://localhost:8000")

    yield

    await chzzk.close()
    if not discord_client.is_closed():
        await discord_client.close()
    for task in tasks:
        task.cancel()


app = FastAPI(title="StreamDirector Middleware", lifespan=lifespan)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()  # 지금은 클라이언트 -> 서버 메시지는 사용하지 않음
    except WebSocketDisconnect:
        hub.disconnect(ws)


@app.get("/", include_in_schema=False)
async def admin_page() -> FileResponse:
    """출처 켜기/끄기, 치지직 연결, 테스트 전송을 하는 관리 화면"""
    return FileResponse(Path(__file__).with_name("admin.html"))


# ---------------------------------------------------------- 출처 전환

class SourcesIn(BaseModel):
    discord: bool | None = None
    chzzk: bool | None = None
    dummy: bool | None = None


@app.get("/sources")
async def get_sources() -> dict:
    return {
        "discord": {"enabled": enabled_sources["discord"], "configured": bool(DISCORD_BOT_TOKEN),
                    "connected": discord_client.is_ready()},
        "chzzk": {"enabled": enabled_sources["chzzk"], **chzzk.status()},
        "dummy": {"enabled": enabled_sources["dummy"]},
        "clients": len(hub.clients),
    }


@app.post("/sources")
async def set_sources(body: SourcesIn) -> dict:
    """예: {"discord": false, "chzzk": true} -> Discord 끄고 치지직 켜기"""
    for name, value in body.model_dump(exclude_none=True).items():
        enabled_sources[name] = value
        log.info("채팅 출처 %s: %s", SOURCE_LABELS[name], "ON" if value else "OFF")
    return await get_sources()


# ---------------------------------------------------------- 치지직 로그인

@app.get("/chzzk/login", include_in_schema=False)
async def chzzk_login():
    if not chzzk.configured:
        return HTMLResponse(_message_page("치지직 연동 설정이 없습니다",
                                          ".env 에 CHZZK_CLIENT_ID 와 CHZZK_CLIENT_SECRET 을 넣고 서버를 다시 실행하세요."), 400)
    return RedirectResponse(chzzk.login_url())


@app.get("/chzzk/callback", include_in_schema=False)
async def chzzk_callback(code: str = "", state: str = "") -> HTMLResponse:
    try:
        await chzzk.handle_callback(code, state)
    except Exception as error:
        log.error("치지직 로그인 실패: %s", error)
        return HTMLResponse(_message_page("치지직 연결 실패", str(error)), 400)
    return HTMLResponse(_message_page("치지직 연결 완료", "이 창을 닫고 관리 화면으로 돌아가세요. 곧 채팅 수신이 시작됩니다."))


@app.post("/chzzk/logout")
async def chzzk_logout() -> dict:
    await chzzk.logout()
    return await get_sources()


def _message_page(title: str, body: str) -> str:
    return (f"<!doctype html><meta charset='utf-8'><title>{title}</title>"
            f"<body style='font-family:sans-serif;background:#0b0d22;color:#e8e2f0;padding:40px'>"
            f"<h2 style='color:#ffd27a'>{title}</h2><p>{body}</p><p><a style='color:#9fd3ff' href='/'>관리 화면으로</a></p>")


# ---------------------------------------------------------- 테스트 전송

class ChatIn(BaseModel):
    user: str
    text: str


class DonationIn(BaseModel):
    user: str
    amount: int
    text: str = ""


@app.post("/chat")
async def post_chat(chat: ChatIn) -> dict:
    """출처 없이 수동으로 채팅을 보내 테스트 (http://localhost:8000/docs 에서도 실행 가능)"""
    await emit_chat("manual", chat.user, chat.text)
    return {"ok": True, "clients": len(hub.clients)}


@app.post("/donation")
async def post_donation(donation: DonationIn) -> dict:
    """치지직 없이 후원을 흉내 내서 테스트 (게임에서 나방 여왕 소환)"""
    await emit_donation("manual", donation.user, donation.amount, donation.text)
    return {"ok": True, "clients": len(hub.clients)}


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "clients": len(hub.clients),
        "discord": discord_client.is_ready(),
        "chzzk": chzzk.connected,
        "sources": enabled_sources,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
