"""치지직(CHZZK) 공식 Open API 연동 - 방송 채팅 / 후원 실시간 수신

흐름
1. 방송인이 관리 화면(http://localhost:8000)에서 "치지직 연결" 을 누름
2. 치지직 로그인·승인 화면 -> 승인하면 /chzzk/callback 으로 인증 코드가 돌아옴
3. 인증 코드로 Access Token(1일) / Refresh Token(30일, 1회용) 을 받아 파일에 저장
4. 토큰으로 세션 주소를 받아 Socket.IO 로 연결 -> sessionKey 로 채팅 / 후원 이벤트 구독
5. 이후에는 서버를 다시 켜도 저장된 토큰으로 자동 연결 (만료 전에 자동 갱신)

공식 문서: https://chzzk.gitbook.io/chzzk  (명세가 바뀔 수 있으니 문제가 생기면 먼저 문서를 확인)
"""

import asyncio
import json
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urlencode

import aiohttp
import socketio

log = logging.getLogger("middleware.chzzk")

ChatHandler = Callable[[str, str], Awaitable[None]]                 # (닉네임, 내용)
DonationHandler = Callable[[str, int, str], Awaitable[None]]        # (닉네임, 금액, 메시지)

TOKEN_REFRESH_MARGIN_SEC = 300      #  만료 5분 전에 미리 갱신
RECONNECT_DELAY_SEC = 5
STATE_TTL_SEC = 600                 #  로그인 요청 후 10분 안에 승인해야 함


class LoginRequired(Exception):
    """로그인 정보가 만료·철회되어 방송인이 다시 '치지직 연결' 을 눌러야 하는 상태"""


class ChzzkSource:
    def __init__(self, on_chat: ChatHandler, on_donation: DonationHandler) -> None:
        self.client_id = os.getenv("CHZZK_CLIENT_ID", "").strip()
        self.client_secret = os.getenv("CHZZK_CLIENT_SECRET", "").strip()
        self.redirect_uri = os.getenv("CHZZK_REDIRECT_URI", "http://localhost:8000/chzzk/callback").strip()
        #  테스트용 가짜 서버를 쓸 때만 바꿈
        self.api_base = os.getenv("CHZZK_API_BASE", "https://openapi.chzzk.naver.com").rstrip("/")
        self.auth_url = os.getenv("CHZZK_AUTH_URL", "https://chzzk.naver.com/account-interlock")
        self.token_file = Path(__file__).with_name(".chzzk_token.json")

        self.on_chat = on_chat
        self.on_donation = on_donation

        self.tokens: dict | None = self._load_tokens()
        self.connected = False
        self.last_error = ""
        self._states: dict[str, float] = {}
        self._task: asyncio.Task | None = None
        self._sio: socketio.AsyncClient | None = None
        self._http: aiohttp.ClientSession | None = None

    # ------------------------------------------------------------------ 상태

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    @property
    def authorized(self) -> bool:
        return self.tokens is not None

    def status(self) -> dict:
        return {
            "configured": self.configured,
            "authorized": self.authorized,
            "connected": self.connected,
            "error": self.last_error,
        }

    # ------------------------------------------------------------------ 로그인 (OAuth)

    def login_url(self) -> str:
        state = secrets.token_urlsafe(16)
        self._states[state] = time.time() + STATE_TTL_SEC
        query = urlencode({"clientId": self.client_id, "redirectUri": self.redirect_uri, "state": state})
        return f"{self.auth_url}?{query}"

    async def handle_callback(self, code: str, state: str) -> None:
        expires = self._states.pop(state, 0)
        if expires < time.time():
            raise ValueError("로그인 요청이 만료되었거나 올바르지 않습니다. 관리 화면에서 다시 연결해 주세요.")

        data = await self._post_token({
            "grantType": "authorization_code",
            "clientId": self.client_id,
            "clientSecret": self.client_secret,
            "code": code,
            "state": state,
        })
        self._save_tokens(data)
        log.info("치지직 로그인 승인 완료")
        self.start()

    async def logout(self) -> None:
        await self.stop()
        self.last_error = ""
        self.tokens = None
        self.token_file.unlink(missing_ok=True)
        log.info("치지직 연결 해제 (저장된 토큰 삭제)")

    # ------------------------------------------------------------------ 토큰

    def _load_tokens(self) -> dict | None:
        try:
            return json.loads(self.token_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return None

    def _save_tokens(self, data: dict) -> None:
        self.tokens = {
            "accessToken": data["accessToken"],
            "refreshToken": data["refreshToken"],
            "expiresAt": time.time() + int(data.get("expiresIn", 86400)),
        }
        self.token_file.write_text(json.dumps(self.tokens), encoding="utf-8")

    async def _post_token(self, body: dict) -> dict:
        async with self._session().post(f"{self.api_base}/auth/v1/token", json=body) as res:
            payload = await res.json(content_type=None)
            if res.status in (400, 401) and body.get("grantType") == "refresh_token":
                raise LoginRequired(f"로그인이 만료되었습니다. 관리 화면에서 다시 '치지직 연결' 을 눌러 주세요. ({payload})")
            if res.status != 200:
                raise RuntimeError(f"토큰 요청 실패 ({res.status}): {payload}")
        return payload.get("content", payload)     #  공통 응답 형식 { code, message, content }

    async def _refresh_if_needed(self, force: bool = False) -> None:
        if not self.tokens:
            raise LoginRequired("치지직 로그인이 필요합니다.")
        if not force and self.tokens["expiresAt"] - TOKEN_REFRESH_MARGIN_SEC > time.time():
            return

        #  Refresh Token 은 1회용 -> 받은 새 토큰을 반드시 저장
        data = await self._post_token({
            "grantType": "refresh_token",
            "refreshToken": self.tokens["refreshToken"],
            "clientId": self.client_id,
            "clientSecret": self.client_secret,
        })
        self._save_tokens(data)
        log.info("치지직 Access Token 갱신")

    async def _api(self, method: str, path: str, params: dict | None = None) -> dict:
        await self._refresh_if_needed()
        for attempt in range(2):
            headers = {"Authorization": f"Bearer {self.tokens['accessToken']}", "Content-Type": "application/json"}
            async with self._session().request(method, f"{self.api_base}{path}", params=params, headers=headers) as res:
                payload = await res.json(content_type=None)
                if res.status == 401 and attempt == 0:
                    await self._refresh_if_needed(force=True)   #  토큰이 만료된 경우 한 번 갱신 후 재시도
                    continue
                if res.status != 200:
                    raise RuntimeError(f"{method} {path} 실패 ({res.status}): {payload}")
                return (payload or {}).get("content") or {}
        raise RuntimeError(f"{method} {path} 실패: 인증 오류")

    def _session(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession()
        return self._http

    # ------------------------------------------------------------------ 세션 연결

    def start(self) -> None:
        if not self.configured or not self.authorized:
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None
        if self._sio and self._sio.connected:
            await self._sio.disconnect()
        self.connected = False

    async def close(self) -> None:
        await self.stop()
        if self._http and not self._http.closed:
            await self._http.close()

    async def _run(self) -> None:
        while True:
            try:
                session = await self._api("GET", "/open/v1/sessions/auth")
                await self._connect(session["url"])
                await self._sio.wait()      #  연결이 끊길 때까지 대기
                log.warning("치지직 세션 연결이 끊어졌습니다. %d초 후 다시 연결합니다.", RECONNECT_DELAY_SEC)
            except asyncio.CancelledError:
                raise
            except LoginRequired as error:
                #  재시도해도 소용없으므로 멈추고 저장된 토큰을 지움 -> 관리 화면에 '치지직 연결' 버튼이 다시 나타남
                self.last_error = str(error)
                self.connected = False
                self.tokens = None
                self.token_file.unlink(missing_ok=True)
                log.error("치지직: %s", error)
                return
            except Exception as error:
                self.last_error = str(error)
                log.error("치지직 연결 실패: %s (%d초 후 재시도)", error, RECONNECT_DELAY_SEC)
            self.connected = False
            await asyncio.sleep(RECONNECT_DELAY_SEC)

    async def _connect(self, url: str) -> None:
        #  공식 소켓은 Socket.IO 2.x 서버 -> python-socketio 4.x 클라이언트 사용, 재연결은 직접 처리
        sio = socketio.AsyncClient(reconnection=False)
        self._sio = sio

        @sio.on("SYSTEM")
        async def on_system(data):
            message = _parse(data)
            kind = message.get("type")
            if kind == "connected":
                session_key = message["data"]["sessionKey"]
                await self._subscribe(session_key)
            elif kind == "revoked":
                log.warning("치지직 권한 철회: %s", message.get("data"))
                await self.logout()
                self.last_error = "방송인이 권한을 철회했습니다. 관리 화면에서 다시 '치지직 연결' 을 눌러 주세요."

            else:
                log.info("치지직 시스템 메시지: %s", kind)

        @sio.on("CHAT")
        async def on_chat(data):
            message = _parse(data)
            nickname = (message.get("profile") or {}).get("nickname") or "익명"
            content = (message.get("content") or "").strip()
            if content:
                await self.on_chat(nickname, content)

        @sio.on("DONATION")
        async def on_donation(data):
            message = _parse(data)
            try:
                amount = int(str(message.get("payAmount", "0")).replace(",", ""))
            except ValueError:
                amount = 0
            await self.on_donation(message.get("donatorNickname") or "익명", amount, message.get("donationText") or "")

        await sio.connect(url, transports=["websocket"])

    async def _subscribe(self, session_key: str) -> None:
        for event in ("chat", "donation"):
            await self._api("POST", f"/open/v1/sessions/events/subscribe/{event}", params={"sessionKey": session_key})
        self.connected = True
        self.last_error = ""
        log.info("치지직 연결 완료: 채팅 / 후원 수신 시작")


def _parse(data) -> dict:
    """이벤트 데이터가 JSON 문자열로 오든 객체로 오든 dict 로 변환"""
    if isinstance(data, str):
        try:
            return json.loads(data)
        except ValueError:
            return {}
    return data if isinstance(data, dict) else {}
