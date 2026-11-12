# StreamDirector 미들웨어

방송 채팅과 후원을 받아 WebSocket(`ws://localhost:8000/ws`)으로 게임에 전달하는 Python 서버입니다.
채팅 출처는 **치지직 / Discord / 더미** 세 가지이고, 관리 화면에서 서버를 켠 채로 켜고 끌 수 있습니다.

```
치지직 (공식 Open API) ─┐
Discord 봇            ─┼─▶ server.py (켜진 출처만 통과) ──WebSocket──▶ 게임 채팅창 / 후원 → 나방 여왕 소환
더미 채팅              ─┘
```

## 1. 설치 (처음 한 번)

```powershell
cd middleware
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
```

이미 설치한 PC에서 이 버전을 처음 받았다면 `pip install -r requirements.txt` 를 한 번 더 실행하세요. (치지직용 라이브러리 추가)

## 2. 실행과 관리 화면

```powershell
cd middleware
.\.venv\Scripts\python server.py
```

브라우저에서 **http://localhost:8000** 을 열면 관리 화면이 나옵니다.
- 출처별 **ON / OFF** 버튼: 누르는 즉시 적용 (서버 재시작 불필요)
- **치지직 연결** 버튼: 방송인 로그인 승인
- **테스트 전송**: 채팅 / 후원을 직접 보내 게임 반응 확인 (후원 → 나방 여왕 소환)

서버를 켤 때 어떤 출처를 켜 둘지는 `.env` 의 `CHAT_SOURCES=discord,chzzk,dummy` 로 정합니다.

## 3. 치지직 연결 (공식 Open API)

> ⚠️ **스트림 키는 필요 없습니다. 절대 입력하지 마세요.** 스트림 키는 방송 송출용 비밀번호입니다.

### 처음 한 번: 애플리케이션 등록
1. 치지직 개발자 센터(https://chzzk.gitbook.io/chzzk 의 안내)에서 애플리케이션을 등록합니다.
   - 앱 이름에 `chzzk`, `치지직`, `naver`, `네이버` 는 넣을 수 없습니다.
   - **로그인 리디렉션 URL**: `http://localhost:8000/chzzk/callback`
   - 권한(Scope): **채팅 메시지 조회**, **후원 조회**
2. 발급된 Client ID / Client Secret 을 `.env` 에 넣습니다.
   ```
   CHZZK_CLIENT_ID=발급받은값
   CHZZK_CLIENT_SECRET=발급받은값
   ```
3. 서버를 다시 실행합니다.

### 방송인 로그인 (처음 한 번)
1. 관리 화면에서 **치지직 연결** 클릭 → 치지직 로그인·승인
2. "치지직 연결 완료" 가 뜨면 창을 닫습니다. 관리 화면에 **연결됨 - 채팅·후원 수신 중** 이 표시됩니다.

이후에는 서버를 다시 켜도 자동으로 연결됩니다.
- 로그인 정보는 `middleware/.chzzk_token.json` 에 저장됩니다. (`.gitignore` 에 포함, 절대 공유 금지)
- Access Token(1일)은 만료 5분 전에 자동 갱신됩니다.
- 30일 넘게 쓰지 않았거나 방송인이 승인을 철회하면, 관리 화면에 다시 **치지직 연결** 버튼이 나타납니다.

## 4. Discord 봇 만들기 (처음 한 번)

1. https://discord.com/developers/applications 에서 **New Application** 클릭
2. 왼쪽 **Bot** 메뉴에서:
   - **Reset Token** 버튼으로 토큰을 발급받아 `.env`의 `DISCORD_BOT_TOKEN=`에 붙여넣기
   - **Privileged Gateway Intents**의 **Message Content Intent**를 켜기 (안 켜면 메시지 내용이 빈 문자열로 옴)
3. 왼쪽 **OAuth2 > URL Generator**에서:
   - Scopes: `bot`
   - Bot Permissions: `View Channels`, `Read Message History`
   - 생성된 URL로 접속해서 봇을 내 서버에 초대
4. (선택) 특정 채널만 받으려면 Discord **설정 > 고급 > 개발자 모드**를 켜고, 채널을 우클릭해서 **채널 ID 복사** → `.env`의 `DISCORD_CHANNEL_IDS=`에 입력

> ⚠️ 봇 토큰, 치지직 Client Secret 은 비밀번호와 같습니다. `.env`는 `.gitignore`에 포함되어 있으니 절대 커밋하거나 공유하지 마세요.

## 5. 테스트 (치지직 / Discord 없이)

- **관리 화면 테스트 전송**: http://localhost:8000 에서 채팅 / 후원 보내기
- **더미 채팅**: 관리 화면에서 더미 ON (1~3초마다 가짜 채팅)
- **API 직접 호출**: http://localhost:8000/docs 에서 `POST /chat`, `POST /donation`
- **상태 확인**: http://localhost:8000/health, http://localhost:8000/sources

## 게임으로 보내는 메시지 형식

```json
{ "type": "chat", "platform": "chzzk", "user": "닉네임", "text": "메시지 내용", "ts": 1791450000.12 }
{ "type": "donation", "platform": "chzzk", "user": "후원자", "amount": 10000, "text": "후원 메시지", "ts": 1791450000.12 }
```

- `platform`: `chzzk`, `discord`, `dummy`, `manual`(관리 화면·API 테스트)
- `user`는 최대 20자, `text`는 최대 100자로 잘립니다.
- 나중에 LLM 이벤트(`"type": "event"`)도 같은 WebSocket으로 보낼 예정입니다.

## 관련 API

| 주소 | 설명 |
|---|---|
| `GET /` | 관리 화면 |
| `GET /sources` | 출처별 상태 (켜짐, 연결, 오류) |
| `POST /sources` | 출처 켜기/끄기. 예: `{"discord": false, "chzzk": true}` |
| `GET /chzzk/login` | 치지직 로그인·승인 화면으로 이동 |
| `POST /chzzk/logout` | 치지직 연결 해제 (저장된 토큰 삭제) |
| `POST /chat` | 테스트 채팅 |
| `POST /donation` | 테스트 후원 `{"user": "이름", "amount": 10000, "text": ""}` |
