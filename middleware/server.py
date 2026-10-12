"""StreamDirector 미들웨어 (1차: 채팅 중계)

Discord 채팅을 받아 WebSocket(ws://localhost:8000/ws)으로 게임 클라이언트에 전달한다.
나중에 이 사이에 전처리 -> LLM 이벤트 변환 단계가 들어갈 예정.

실행: python server.py
"""

import asyncio
import logging
import os
import random
import time
from contextlib import asynccontextmanager

import discord
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

load_dotenv()

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
DISCORD_CHANNEL_IDS = {
    int(x) for x in os.getenv("DISCORD_CHANNEL_IDS", "").replace(" ", "").split(",") if x
}
DUMMY_CHAT = os.getenv("DUMMY_CHAT", "0") == "1"

MAX_USER_LEN = 20
MAX_TEXT_LEN = 100

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("middleware")


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


def make_chat(platform: str, user: str, text: str) -> dict:
    """게임으로 보내는 채팅 메시지 형식"""
    return {
        "type": "chat",
        "platform": platform,
        "user": user[:MAX_USER_LEN],
        "text": text[:MAX_TEXT_LEN],
        "ts": time.time(),
    }


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

    log.info("채팅 수신 #%s %s: %s -> 게임 %d개로 전송", message.channel, message.author.display_name, text, len(hub.clients))
    await hub.broadcast(make_chat("discord", message.author.display_name, text))


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


# ------------------------------------------------------------------ 더미 채팅 (테스트용)

DUMMY_USERS = ["철수", "영희", "민수", "지수", "뉴비123", "고인물", "치킨러버"]
DUMMY_TEXTS = [
    "ㅋㅋㅋㅋㅋ", "몹 더 풀어주세요", "힐 좀 줘라", "보스 소환 가즈아", "이거 어떻게 깸?",
    "와 컨트롤 미쳤다", "적 두 배로!", "살려줘ㅠㅠ", "속도 올려줘", "GG",
]


async def dummy_chat_loop() -> None:
    while True:
        await asyncio.sleep(random.uniform(1.0, 3.0))
        user, text = random.choice(DUMMY_USERS), random.choice(DUMMY_TEXTS)
        log.info("더미 채팅 %s: %s -> 게임 %d개로 전송", user, text, len(hub.clients))
        await hub.broadcast(make_chat("dummy", user, text))


# ------------------------------------------------------------------ FastAPI 앱

@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks: list[asyncio.Task] = []

    if DISCORD_BOT_TOKEN:
        task = asyncio.create_task(discord_client.start(DISCORD_BOT_TOKEN))
        task.add_done_callback(log_task_error)
        tasks.append(task)
    else:
        log.warning("DISCORD_BOT_TOKEN 이 없어 Discord 연동 없이 실행합니다.")

    if DUMMY_CHAT:
        log.info("더미 채팅 생성기 ON")
        tasks.append(asyncio.create_task(dummy_chat_loop()))

    yield

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


class ChatIn(BaseModel):
    user: str
    text: str


@app.post("/chat")
async def post_chat(chat: ChatIn) -> dict:
    """Discord 없이 수동으로 채팅을 보내 테스트할 때 사용 (http://localhost:8000/docs 에서 실행 가능)"""
    log.info("수동 채팅 %s: %s -> 게임 %d개로 전송", chat.user, chat.text, len(hub.clients))
    await hub.broadcast(make_chat("manual", chat.user, chat.text))
    return {"ok": True, "clients": len(hub.clients)}


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "clients": len(hub.clients),
        "discord": discord_client.is_ready(),
        "dummy_chat": DUMMY_CHAT,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
