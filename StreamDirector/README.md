# StreamDirector — AI · 백엔드

**LLM 기반 실시간 시청자 참여형 게임 상호작용 AX 시스템**의 AI/백엔드 부분입니다.
방송 채팅과 후원을 실시간으로 수집하고, **로컬 모델(무료·무제한)** 로 게임과 무관한 채팅을 걸러낸 뒤
Google AI Studio(Gemini, 무료 할당량 내)로 게임 이벤트(JSON)를 만들어 **MCP**로 게임에 전달합니다.
게임 클라이언트는 별도 저장소에 있습니다.

> 비용 원칙: 채팅 전처리는 모두 로컬(규칙 + kor_unsmile + KcELECTRA + Ollama)에서 처리해 외부 호출이 없고,
> Gemini 는 분당 최대 6회 수준의 이벤트 생성에만 쓰며 `GEMINI_RPM_LIMIT`/`GEMINI_DAILY_LIMIT` 가드로
> 무료 한도를 넘기 전에 규칙 기반 이벤트로 대체합니다.

```
 치지직 / 디스코드(테스트) / 숲(예정)
          │ 채팅·후원
          ▼
 ┌────────────────────── MCP 서버 (streamdirector.server, :8765/mcp) ──────────────────────┐
 │ 윈도우 배칭(첫 채팅 후 2초)                                                                │
 │   → ① 검열 에이전트 (로컬: 규칙 → kor_unsmile → KcELECTRA → [Ollama 백그라운드 보정])      │
 │        별도 MCP 프로세스로 분리 가능 :8766                                                │
 │   → ② 데이터 확인 (1인 1표, 후원 가중치, 최소 참여 조건 → 미달 시 LLM 호출 생략)            │
 │   → ③ 쿨다운 / 분당 개입 예산                                                             │
 │   → ④ Gemini 이벤트 생성 (JSON Schema 강제, 할당량 가드) → 클램핑 → 실패/한도 시 규칙 폴백 │
 │   → ⑤ 이벤트 큐 → poll_events 롱폴링                                                      │
 │ 로그: logs/ai_results.jsonl · moderation.jsonl · connection.jsonl   (AI 산출물은 로그만)  │
 │ DB  : data/streamdirector.db (SQLite) — 유저 플레이 데이터 · 세이브 데이터만               │
 └──────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                 │ MCP (Streamable HTTP)
                                                 ▼
                                   웹 게임 (TypeScript + Phaser 3)
```

## 빠른 시작

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/train_intent.py      # KcELECTRA 의도 분류 모델 학습 (M1 Pro 약 3분, models/ 에 저장)
ollama pull gemma2:9b                          # (선택) 백그라운드 보정용 로컬 LLM - 이미 설치됨
```

외장 HDD(exFAT)에서 pip 설치 후 `transformers` import 가 `UnicodeDecodeError` 로 실패하면 macOS 메타데이터 파일 때문이니
`find .venv -name '._*' -delete` 로 정리하세요. kor_unsmile 은 첫 실행 때 한 번만 자동으로 받습니다.

`.env`에 **`GEMINI_API_KEY`**(https://aistudio.google.com/apikey)를 넣습니다. 키가 없어도 서버는 규칙 기반 폴백으로 동작합니다.

```bash
.venv/bin/python -m streamdirector.server
```

| 명령 | 용도 |
|---|---|
| `.venv/bin/python -m pytest -q` | 단위/통합 테스트 (검열 정확도·차단율, 클램핑, DB, MCP 흐름) |
| `.venv/bin/python scripts/verify_connection.py` | **MCP 통신 상태 점검** (실서버 기동 후 지연·동시성·실시간 경로 측정) |
| `.venv/bin/python scripts/verify_connection.py --remote-moderation` | 검열 에이전트를 별도 프로세스로 두고 점검 |
| `.venv/bin/python scripts/check_gemini.py` | API 키 확인 + 실제 Gemini로 파이프라인 실행 (`--list` 모델 목록) |
| `.venv/bin/python scripts/train_intent.py` | 의도 분류 모델 (재)학습 — 실제 로그를 라벨링해 `data/intent_labeled.jsonl` 에 넣으면 함께 학습 |
| `.venv/bin/python -m streamdirector.moderation_server` | 검열 에이전트 단독 MCP 서버 (:8766) — 메인 서버에 `MODERATION_AGENT_URL` 지정 |

## 구성

| 경로 | 내용 |
|---|---|
| `streamdirector/agents/moderation_agent.py` | **채팅 전처리 에이전트** — 차단/뮤트 → 정규화 → 사용자별 중복·도배 제거 → 규칙 판정 → kor_unsmile(우회 욕설·비하·분탕) → KcELECTRA 의도 분류(확신도 0.75↑ 확정, 키워드·요청형 없는 명령 예측은 보류) → 남은 소수만 Ollama 백그라운드 보정(결과는 캐시·학습 데이터로 축적) → 규칙 폴백. 욕설 3회 시 5분 자동 뮤트 |
| `streamdirector/agents/local_models.py` | kor_unsmile / KcELECTRA / Ollama 래퍼 (백그라운드 로딩, 스레드 추론, Apple GPU 자동 사용) |
| `streamdirector/training/`, `scripts/train_intent.py` | 의도 분류 학습 데이터(합성 + `data/intent_labeled.jsonl` 실제 라벨) 및 파인튜닝 |
| `streamdirector/llm/quota.py` | Gemini 무료 할당량 가드 (분당/일일, 태평양시 자정 초기화, 재시작해도 유지) |
| `streamdirector/agents/rules.py` | 욕설(우회 표기 `시1발`, `ㅅ ㅂ`, 전각 문자 포함)·광고·링크·무의미 반복·명령 의도 규칙 |
| `streamdirector/pipeline/validator.py` | 데이터 확인 — 의도 집계, 1인 1표, 가중치 범위, 게임 상태 보정 |
| `streamdirector/pipeline/event_engine.py` | Gemini 이벤트 생성, 투표에 없는 이벤트 거부, 값 범위 클램핑, 폴백 |
| `streamdirector/pipeline/orchestrator.py` | 윈도우 배칭, 후원(소액=가중치 / 고액=즉시 발동), 쿨다운·예산, 이벤트 큐, 지표, 로그 |
| `streamdirector/llm/gemini_client.py` | Google AI Studio 호출 (Structured Output, 타임아웃, mock 모드) |
| `streamdirector/db/database.py` | SQLite: `players`, `play_sessions`, `play_snapshots`, `saves` |
| `streamdirector/collectors/` | 치지직(Open API 세션 + Socket.IO v2 직접 구현), 디스코드 테스트 봇, 숲(자리표시자) |
| `streamdirector/server.py` | 게임용 MCP 서버 (도구 20개) + `/health`, `/metrics`, `/chzzk/login` |
| `docs/game_integration.md` | **게임 개발자용 연동 가이드 · 이벤트 JSON 규격 · 도구 목록** |

## 채팅 소스 설정

### 디스코드 (테스트용)
1. https://discord.com/developers/applications 에서 봇을 만들고 **Bot → MESSAGE CONTENT INTENT** 를 켭니다.
2. OAuth2 URL Generator에서 `bot`, `applications.commands` 범위와 메시지 읽기/보내기 권한을 골라 서버에 초대합니다.
3. `.env`에 `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`(채팅으로 쓸 채널), `DISCORD_GUILD_ID`(슬래시 명령을 바로 반영할 서버)를 넣습니다.
4. 봇은 **AI 서버와 별도 프로세스**입니다. 서버를 먼저 켜고, 다른 터미널에서 봇을 실행합니다. 봇은 MCP로 서버에 채팅·후원을 넣고, 발동된 이벤트를 채널에 알립니다.
   ```bash
   .venv/bin/python -m streamdirector.discord_bot
   ```
   (서버 안에서 함께 돌리려면 `.env`에 `DISCORD_MODE=embedded` - 이때는 별도 봇을 실행하지 마세요. 같은 토큰으로 두 번 접속하면 메시지가 중복 처리됩니다)
5. 채널의 일반 메시지는 시청자 채팅으로 들어갑니다. **`/후원 1000 보스 소환해줘`** 는 후원으로 처리됩니다(슬래시 명령과 텍스트 입력 모두 지원).
   1000원당 투표 가중치가 +1 되고, 10,000원 이상이면 즉시 발동합니다. 발동된 이벤트는 같은 채널에 공지됩니다.

### 치지직
- Client ID/Secret은 `.env`에 들어 있고, 클라이언트 인증 세션 발급과 소켓 연결(sessionKey 수신)까지 확인했습니다.
- 채팅·후원을 **구독**하려면 방송 채널 소유자의 계정 연동(OAuth)이 한 번 필요합니다.
  1. 치지직 개발자 센터 앱 설정의 로그인 리디렉션 URL에 `http://localhost:8765/chzzk/callback` 을 등록하고, 스코프에서 **채팅 메시지 조회 · 후원 조회**를 켭니다.
  2. 서버를 실행한 뒤 브라우저에서 `http://localhost:8765/chzzk/login` 을 엽니다. 연동이 끝나면 토큰이 `data/chzzk_tokens.json`에 저장되고 자동으로 갱신됩니다.

### 숲(SOOP)
`SOOP_CLIENT_ID` / `SOOP_CLIENT_SECRET` 은 비워 두었습니다. 수집기는 비활성 상태로 표시됩니다.

## 게임 연동 (「마지막 등불」, `YNCsurvival/`)

| 통신 | 방식 | 내용 |
|---|---|---|
| 게임 ↔ AI | **MCP** (`http://localhost:8765/mcp`) | 판 시작/종료, 2초마다 게임 상태, `poll_events` 롱폴링으로 AI 이벤트 수신, 플레이 기록, 세이브 |
| 게임 화면 채팅창 | WebSocket (`ws://localhost:8765/ws`) | 채팅(욕설·광고는 "(필터링된 메시지)"), 후원, 이벤트 발동 알림 - 기존 `ChatClient` 형식 그대로 |

게임에 적용되는 이벤트 (`YNCsurvival/src/game/systems/AudienceEvents.ts`)

| 이벤트 | 게임 반영 |
|---|---|
| `spawn_enemies` | 짐승 N마리 소환 (fast=빠른 늑대, tank=큰 늑대 체력 3배, swarm=들개 떼) |
| `spawn_boss` | 채팅 투표 → 밀랍 순례자 / 후원 → 재의 나방 여왕 (금액에 따라 강해짐) |
| `drop_item` | 불씨 상자(경험치) / 물약(회복) / 무기 상자(즉시 레벨업) / 폭탄(빛 범위 안 짐승 처치) |
| `heal_player`, `buff_player`, `debuff_player` | 회복, 공격력·속도·무적·재생 / 둔화·약화·시야 축소 |
| `change_weather`, `enemy_speed` | 비·눈·폭풍·안개·밤·맑음, 짐승 가속·감속 |

게임 화면 오른쪽 아래 TEST 버튼 중 `AI: ...` 버튼으로 디스코드 없이 연동을 확인할 수 있습니다.

## 로그

| 파일 | 내용 |
|---|---|
| `logs/ai_results.jsonl` | 파이프라인 1회 실행마다: 입력 수, 검열 요약, 데이터 확인 결과, Gemini 모델·원문·토큰, 클램핑 내역, 최종 이벤트, 단계별 지연 |
| `logs/moderation.jsonl` | 메시지별 판정(라벨·의도·판정 주체 rule/toxicity/intent/llm/cache/fallback + 점수). 사용자 ID는 해시로 익명화 |
| `logs/moderation_refine.jsonl` | Ollama 백그라운드 보정 결과 — 검수 후 `data/intent_labeled.jsonl` 로 옮겨 재학습에 사용 |
| `logs/connection.jsonl`, `logs/connection_report.json` | health_check 및 통신 점검 결과 |
| `logs/server.log` | 애플리케이션 로그 |

## 검열 백엔드 선택 (`MODERATION_BACKEND`)

| 값 | 구성 | 비용 | 비고 |
|---|---|---|---|
| `local` (기본) | 규칙 + kor_unsmile + KcELECTRA + Ollama(비동기) | 무료·무제한, 채팅이 외부로 나가지 않음 | 100건 처리 p95 ≈ 0.4s (M1 Pro, MPS) |
| `gemini` | 규칙 + Gemini 분류 | 무료 할당량 소모 (이벤트 생성과 공유) | 할당량 가드 적용 |
| `rules` | 규칙만 | 무료 | 모델 없이 가장 가벼움 |

Ollama 의 gemma2:9b 는 이 장비에서 4~5초가 걸려 실시간 경로에 넣지 않고 `OLLAMA_MODE=async`(기본)로
백그라운드 보정만 합니다. 더 작은 모델(예: `qwen2.5:3b`)을 받으면 `OLLAMA_MODE=sync` 로 바로 반영할 수도 있습니다.

## 목표 대비 검증

| 정량 목표 | 결과 | 근거 |
|---|---|---|
| 채팅 발생 ~ 게임 반영 3초 이내 | p95 ≈ 2.3s (윈도우 2s + 로컬 검열 모델 포함, 이벤트 LLM 은 mock) | `verify_connection.py` |
| 부적절 입력 차단율 95% 이상 | 평가셋 100% (로컬 백엔드) | `tests/test_local_models.py` |
| 의도 분류 정확도 85% 이상 | 평가셋 96.6% (로컬 백엔드), KcELECTRA 단독 97.5% | 〃 · `models/intent-kcelectra/eval_report.json` |
| JSON 스키마 준수율 99% 이상 | Structured Output + 서버 검증; 위반 시 폴백으로 게임에는 항상 유효 JSON | `get_metrics().schema_compliance` |

평가셋은 66건으로 작고 학습용 합성 데이터와 문체가 비슷해 실제 방송 기준보다 낙관적입니다.
과제 계획대로 실제 채팅 로그 500건을 라벨링해 평가·재학습해야 합니다.

실제 Gemini 지연은 API 키를 넣은 뒤 `scripts/check_gemini.py`, `verify_connection.py --deep` 으로 측정합니다.
