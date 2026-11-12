"""치지직(CHZZK) Open API 채팅·후원 수집기.

흐름
  1) (최초 1회) OAuth: /chzzk/login -> 치지직 계정 연동 -> /chzzk/callback 에서 토큰 발급·저장
  2) GET /open/v1/sessions/auth (유저 Access Token) -> 소켓 URL
  3) Socket.IO v2 (Engine.IO v3) 웹소켓 접속 -> SYSTEM{type:connected, sessionKey}
  4) POST /open/v1/sessions/events/subscribe/chat|donation?sessionKey=...
  5) CHAT / DONATION 이벤트 -> 오케스트레이터로 전달

치지직은 socket.io-client 1.0~2.0.3 만 지원하므로 python-socketio(EIO4) 대신
Engine.IO v3 프레이밍을 직접 처리한다. (0=open, 2=ping, 3=pong, 40=connect, 42=event)
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlencode, urlparse

import httpx
import websockets

from ..config import ROOT_DIR
from ..schemas import ChatMessage, Donation

log = logging.getLogger("streamdirector.chzzk")

API = "https://openapi.chzzk.naver.com"
TOKEN_FILE = ROOT_DIR / "data" / "chzzk_tokens.json"

ChatSink = Callable[[ChatMessage], Awaitable[None] | None]
DonationSink = Callable[[Donation], Awaitable[None] | None]


class ChzzkAuth:
    """OAuth 토큰 발급/갱신/보관 (data/chzzk_tokens.json - 비밀값이므로 공유 금지)."""

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str,
                 access_token: str = "", refresh_token: str = "", token_file: Path = TOKEN_FILE):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.token_file = token_file
        self.access_token = access_token
        self.refresh_token = refresh_token
        self._state = ""
        if not access_token and token_file.exists():
            data = json.loads(token_file.read_text())
            self.access_token = data.get("accessToken", "")
            self.refresh_token = data.get("refreshToken", "")

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def client_headers(self) -> dict[str, str]:
        return {"Client-Id": self.client_id, "Client-Secret": self.client_secret,
                "Content-Type": "application/json"}

    def user_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}", "Content-Type": "application/json"}

    def login_url(self) -> str:
        self._state = secrets.token_urlsafe(16)
        q = urlencode({"clientId": self.client_id, "redirectUri": self.redirect_uri, "state": self._state})
        return f"https://chzzk.naver.com/account-interlock?{q}"

    async def exchange_code(self, code: str, state: str) -> None:
        if not self._state or state != self._state:
            raise ValueError("OAuth state mismatch")
        await self._token_request({"grantType": "authorization_code", "clientId": self.client_id,
                                   "clientSecret": self.client_secret, "code": code, "state": state})

    async def refresh(self) -> None:
        if not self.refresh_token:
            raise RuntimeError("refresh token 없음 - /chzzk/login 으로 다시 연동 필요")
        await self._token_request({"grantType": "refresh_token", "refreshToken": self.refresh_token,
                                   "clientId": self.client_id, "clientSecret": self.client_secret})

    async def _token_request(self, body: dict) -> None:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(f"{API}/auth/v1/token", json=body)
        data = r.json()
        content = data.get("content") or {}
        if r.status_code != 200 or "accessToken" not in content:
            raise RuntimeError(f"CHZZK token error: {data.get('code')} {data.get('message')}")
        self.access_token = content["accessToken"]
        self.refresh_token = content.get("refreshToken", self.refresh_token)
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        self.token_file.write_text(json.dumps({"accessToken": self.access_token, "refreshToken": self.refresh_token,
                                               "obtainedAt": time.time()}))
        self.token_file.chmod(0o600)
        log.info("CHZZK token stored")


async def _api(method: str, path: str, headers: dict, **kw) -> dict:
    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.request(method, f"{API}{path}", headers=headers, **kw)
    data = r.json() if r.content else {}
    if r.status_code != 200:
        raise PermissionError(f"{r.status_code} {data.get('code')} {data.get('message')}") \
            if r.status_code in (401, 403) else RuntimeError(f"{r.status_code} {data}")
    return data.get("content") or {}


def socket_ws_url(session_url: str) -> str:
    """https://ssio07.nchat.naver.com:443?auth=XXX -> wss://ssio07.nchat.naver.com:443/socket.io/?auth=XXX&EIO=3&transport=websocket"""
    u = urlparse(session_url)
    scheme = "wss" if u.scheme == "https" else "ws"
    return f"{scheme}://{u.netloc}/socket.io/?{u.query}&EIO=3&transport=websocket"


def _parse_payload(raw):
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
    return raw


class ChzzkCollector:
    def __init__(self, auth: ChzzkAuth, on_chat: ChatSink, on_donation: DonationSink, use_client_session: bool = False):
        self.auth = auth
        self.on_chat = on_chat
        self.on_donation = on_donation
        # True: 클라이언트 인증 세션(연결 점검용, 구독은 유저 토큰 필요)
        self.use_client_session = use_client_session
        self.status: dict = {"state": "idle", "session_key": None, "subscribed": [], "last_error": None,
                             "chats": 0, "donations": 0, "connected_at": None, "last_event_at": None}
        self._task: asyncio.Task | None = None
        self.connected = asyncio.Event()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        self.status["state"] = "stopped"

    async def _run_forever(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self._run_once()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except PermissionError as e:
                self.status["last_error"] = str(e)
                try:
                    await self.auth.refresh()
                    continue
                except Exception as e2:
                    self.status.update(state="auth_required", last_error=f"{e} / refresh: {e2}")
                    log.warning("CHZZK auth required: %s", e2)
                    await asyncio.sleep(30)
            except Exception as e:
                self.status.update(state="reconnecting", last_error=f"{type(e).__name__}: {e}")
                log.warning("CHZZK connection error: %s (retry in %.0fs)", e, backoff)
            self.connected.clear()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _run_once(self) -> None:
        if self.use_client_session:
            content = await _api("GET", "/open/v1/sessions/auth/client", self.auth.client_headers())
        else:
            if not self.auth.access_token:
                raise PermissionError("access token 없음 - /chzzk/login 으로 계정 연동 필요")
            content = await _api("GET", "/open/v1/sessions/auth", self.auth.user_headers())
        url = socket_ws_url(content["url"])
        self.status["state"] = "connecting"
        async with websockets.connect(url, open_timeout=5, ping_interval=None, max_size=2 ** 22) as ws:
            ping_interval = 25.0
            pinger: asyncio.Task | None = None
            try:
                async for frame in ws:
                    if not isinstance(frame, str) or not frame:
                        continue
                    kind = frame[0]
                    if kind == "0":  # open
                        ping_interval = json.loads(frame[1:]).get("pingInterval", 25000) / 1000
                        pinger = asyncio.create_task(self._ping(ws, ping_interval))
                    elif kind == "3":  # pong
                        continue
                    elif kind == "2":  # server ping (EIO4 스타일 대비)
                        await ws.send("3")
                    elif frame.startswith("42"):
                        name, *args = json.loads(frame[2:])
                        await self._handle(name, _parse_payload(args[0]) if args else {})
                    elif frame.startswith("41"):
                        raise ConnectionError("server closed socket.io namespace")
            finally:
                if pinger:
                    pinger.cancel()

    async def _ping(self, ws, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            await ws.send("2")

    async def _handle(self, name: str, data: dict) -> None:
        self.status["last_event_at"] = time.time()
        if name == "SYSTEM":
            typ = data.get("type")
            payload = data.get("data") or {}
            if typ == "connected":
                self.status.update(state="connected", session_key=payload.get("sessionKey"),
                                   connected_at=time.time(), last_error=None)
                self.connected.set()
                if not self.use_client_session:
                    await self._subscribe(payload["sessionKey"])
            elif typ == "subscribed":
                self.status["subscribed"].append(payload.get("eventType"))
                log.info("CHZZK subscribed %s (channel %s)", payload.get("eventType"), payload.get("channelId"))
            elif typ == "revoked":
                self.status["subscribed"] = [e for e in self.status["subscribed"] if e != payload.get("eventType")]
                log.warning("CHZZK subscription revoked: %s", payload)
        elif name == "CHAT":
            self.status["chats"] += 1
            msg = ChatMessage(
                user_id=str(data.get("senderChannelId", "unknown")),
                nickname=(data.get("profile") or {}).get("nickname", ""),
                text=str(data.get("content", ""))[:2000],
                ts=(data.get("messageTime") or time.time() * 1000) / 1000,
                platform="chzzk",
            )
            r = self.on_chat(msg)
            if asyncio.iscoroutine(r):
                await r
        elif name == "DONATION":
            self.status["donations"] += 1
            try:
                amount = int(str(data.get("payAmount", "0")).replace(",", ""))
            except ValueError:
                amount = 0
            don = Donation(user_id=str(data.get("donatorChannelId") or "anonymous"),
                           nickname=data.get("donatorNickname", ""), amount=amount,
                           text=str(data.get("donationText", ""))[:2000])
            r = self.on_donation(don)
            if asyncio.iscoroutine(r):
                await r

    async def _subscribe(self, session_key: str) -> None:
        for ev in ("chat", "donation"):
            await _api("POST", f"/open/v1/sessions/events/subscribe/{ev}", self.auth.user_headers(),
                       params={"sessionKey": session_key})
