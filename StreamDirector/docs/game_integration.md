# 게임 연동 가이드 (MCP) · 이벤트 JSON 규격

게임 클라이언트(TypeScript + Phaser 3)는 **MCP 클라이언트**로 AI 백엔드(MCP 서버)에 접속합니다.

- 엔드포인트: `http://127.0.0.1:8765/mcp` (Streamable HTTP, JSON 응답 모드, CORS 허용)
- 프로토콜: MCP `2026-07-28` (구버전 `2025-06-18` initialize 핸드셰이크도 호환)
- 상태 확인용 일반 HTTP: `GET /health`, `GET /metrics`

## 1. 접속 (TypeScript)

```bash
npm i @modelcontextprotocol/sdk
```

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "wave-survival", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8765/mcp")));

// 도구 호출 헬퍼 - 결과는 structuredContent 에 JSON 으로 들어있음
async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(JSON.stringify(res.content));
  return res.structuredContent as T;
}
```

## 2. 권장 흐름

```ts
// (1) 판 시작 - 방송 채팅이 이 세션으로 라우팅됨
const { session_id } = await call("start_play_session", { player_id: "user-123", nickname: "플레이어" });

// (2) 게임 상태를 1~3초마다 전달 (LLM 이 상황에 맞는 이벤트를 고르는 근거)
setInterval(() => call("update_game_state", {
  session_id,
  game_state: { wave, player_hp: hp, player_max_hp: maxHp, player_level: lv, enemies_alive, score, elapsed_sec },
}), 2000);

// (3) AI 이벤트 수신 - 롱폴링 (새 이벤트가 생기면 즉시 응답, 없으면 wait_ms 후 빈 배열)
let lastSeq = 0;
async function eventLoop() {
  while (playing) {
    const { events, last_seq } = await call("poll_events", { session_id, since_seq: lastSeq, wait_ms: 5000 });
    lastSeq = last_seq;
    for (const ev of events) applyEvent(ev); // 아래 규격 참고
  }
}

// (4) 진행 기록 / 세이브
await call("record_play_data", { session_id, wave, hp, level: lv, score, kills, ai_events_applied });
await call("save_game", { player_id: "user-123", slot: 0, data: saveObj, expected_version: currentVersion });
const { found, save } = await call("load_game", { player_id: "user-123", slot: 0 });

// (5) 판 종료
await call("end_play_session", { session_id, status: "dead", final_wave: wave, score, kills, level: lv, ai_events_applied });
```

통신 상태 표시는 `ping` 을 주기적으로 호출해 왕복 시간을 재면 됩니다 (로컬 기준 p95 ≈ 2ms).

## 3. 이벤트 JSON 규격 (게임 비종속)

```json
{
  "event_id": "80f800be2e1b",
  "seq": 12,
  "event_type": "spawn_boss",
  "intensity": 2,
  "count": 1,
  "duration_sec": 0,
  "variant": "boss",
  "overlay_text": "시청자들이 보스를 불렀다!",
  "reason": "보스 소환 요청이 75%로 압도적",
  "source": "vote",
  "supporters": 4,
  "vote_share": 0.75,
  "donor": null,
  "created_at": 1791445261.82
}
```

| 필드 | 설명 |
|---|---|
| `seq` | 세션 내 단조 증가 번호. `poll_events(since_seq)` 에 사용 |
| `event_type` | 아래 표 참고 |
| `intensity` | 1(약) ~ 5(강) |
| `count` | 스폰 수 / 아이템 수 (해당 없으면 0) |
| `duration_sec` | 지속형 효과 시간 (해당 없으면 0) |
| `variant` | 세부 종류 |
| `overlay_text` | 방송 오버레이 표시 문구 (≤30자) |
| `source` | `vote`(채팅 투표) · `donation`(고액 후원 즉시 발동) · `fallback`(LLM 장애 시 규칙 기반) |
| `supporters`, `vote_share` | 참여 인원, 1위 의도 득표율 |
| `donor` | 후원 발동 시 후원자 닉네임 |

| event_type | count | duration_sec | variant |
|---|---|---|---|
| `spawn_enemies` | 1 ~ min(5+웨이브×2, 30) | 0 | normal · fast · tank · ranged · swarm |
| `spawn_boss` | 1 | 0 | boss (웨이브 3 미만이면 강도 ≤2) |
| `heal_player` | 0 | 0 | — (강도 1=10% ~ 5=50% 회복 권장) |
| `buff_player` | 0 | 5 ~ 30 (무적은 ≤8) | attack · speed · shield · invincible · regen |
| `debuff_player` | 0 | 5 ~ 20 | slow · weak · blind · no_regen |
| `drop_item` | 1 ~ 5 | 0 | random · weapon · potion · chest · bomb |
| `change_weather` | 0 | 10 ~ 60 | rain · snow · fog · storm · night · clear |
| `enemy_speed` | 0 | 5 ~ 20 | fast · slow |

서버가 위 범위를 **강제(클램핑)** 하므로 게임은 값 검증 없이 적용해도 됩니다.
플레이어 체력이 25% 미만이면 해로운 이벤트(스폰/디버프)는 강도 1, 스폰 3마리 이하로 자동 완화됩니다.

## 4. MCP 도구 목록

| 분류 | 도구 | 설명 |
|---|---|---|
| 통신 점검 | `ping(client_ts)` | 왕복 지연 측정 |
| | `health_check(deep)` | DB·LLM·검열 에이전트·수집기 상태 (`deep=true` 면 Gemini 실제 호출) |
| | `get_metrics()` | 지연 p50/p95, 차단율, 스키마 준수율 |
| 플레이 데이터 | `start_play_session(player_id, nickname, bind_chat)` | 세션 시작 |
| | `update_game_state(session_id, game_state, snapshot, kills)` | 상태 전달 (snapshot=true 면 DB 기록) |
| | `record_play_data(...)` / `end_play_session(...)` | 진행 기록 / 종료 |
| | `get_player_stats(player_id)` | 누적 통계 + 최근 세션 |
| 세이브 | `save_game` / `load_game` / `list_saves` / `delete_save` | 슬롯 0~9, 버전 충돌 감지, 체크섬 |
| AI 이벤트 | `poll_events(session_id, since_seq, wait_ms)` | 롱폴링 이벤트 수신 |
| | `ingest_chat` / `ingest_donation` | 채팅·후원 직접 입력 (수집기 대신) |
| | `process_chat_batch` | 채팅 묶음 즉시 처리 (테스트용) |
| | `set_chat_target(session_id)` | 방송 채팅을 받을 세션 지정 |
| 운영 | `moderate_chat` / `block_user` / `unblock_user` | 검열 단독 실행, 수동 차단 |
