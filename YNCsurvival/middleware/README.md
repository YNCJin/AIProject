# StreamDirector 미들웨어

Discord 채팅을 받아 WebSocket(`ws://localhost:8000/ws`)으로 게임에 전달하는 Python 서버입니다.

```
Discord 채널 ──▶ server.py (discord.py 봇 + FastAPI) ──WebSocket──▶ 게임 화면 채팅 오버레이
```

## 1. 설치 (처음 한 번)

```powershell
cd middleware
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
```

## 2. Discord 봇 만들기 (처음 한 번)

1. https://discord.com/developers/applications 에서 **New Application** 클릭
2. 왼쪽 **Bot** 메뉴에서:
   - **Reset Token** 버튼으로 토큰을 발급받아 `.env`의 `DISCORD_BOT_TOKEN=`에 붙여넣기
   - **Privileged Gateway Intents**의 **Message Content Intent**를 켜기 (안 켜면 메시지 내용이 빈 문자열로 옴)
3. 왼쪽 **OAuth2 > URL Generator**에서:
   - Scopes: `bot`
   - Bot Permissions: `View Channels`, `Read Message History`
   - 생성된 URL로 접속해서 봇을 내 서버에 초대
4. (선택) 특정 채널만 받으려면 Discord **설정 > 고급 > 개발자 모드**를 켜고, 채널을 우클릭해서 **채널 ID 복사** → `.env`의 `DISCORD_CHANNEL_IDS=`에 입력

> ⚠️ 봇 토큰은 비밀번호와 같습니다. `.env`는 `.gitignore`에 포함되어 있으니 절대 커밋하거나 공유하지 마세요.

## 3. 실행

```powershell
cd middleware
.\.venv\Scripts\python server.py
```

그다음 다른 터미널에서 게임을 실행합니다. (`npm run dev-nolog` → http://localhost:8080)

## 테스트 (Discord 없이)

- **더미 채팅**: `.env`에 `DUMMY_CHAT=1`을 넣으면 1~3초마다 가짜 채팅이 생성됩니다.
- **수동 전송**: http://localhost:8000/docs 에서 `POST /chat`을 열고 **Try it out**을 누른 뒤 `{"user": "이름", "text": "내용"}`을 보냅니다.
- **상태 확인**: http://localhost:8000/health

## 게임으로 보내는 메시지 형식

```json
{ "type": "chat", "platform": "discord", "user": "닉네임", "text": "메시지 내용", "ts": 1791450000.12 }
```

- `user`는 최대 20자, `text`는 최대 100자로 잘립니다.
- 나중에 LLM 이벤트(`"type": "event"`)도 같은 WebSocket으로 보낼 예정입니다.
