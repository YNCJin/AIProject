import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

//  StreamDirector AI 서버(MCP)와 통신한다.
//  - 판 시작/종료, 게임 상태 전송, AI 이벤트 수신(롱폴링), 플레이 기록, 세이브
//  - 서버가 꺼져 있어도 게임은 그대로 진행되고, 켜지면 자동으로 다시 연결된다
//  주소는 .env.local 에 VITE_STREAMDIRECTOR_MCP=http://... 로 바꿀 수 있음
export const STREAMDIRECTOR_MCP_URL: string = import.meta.env.VITE_STREAMDIRECTOR_MCP ?? 'http://localhost:8765/mcp';

const RETRY_MS = 5000;
const POLL_WAIT_MS = 5000;
const PLAYER_ID_KEY = 'streamdirector.playerId';

//  서버가 보내는 게임 이벤트 (StreamDirector docs/game_integration.md 의 이벤트 JSON 규격)
export type AudienceEventType =
    | 'spawn_enemies' | 'spawn_boss' | 'heal_player' | 'buff_player' | 'debuff_player'
    | 'drop_item' | 'change_weather' | 'enemy_speed' | 'none';

export interface AudienceEvent
{
    event_id: string;
    seq: number;
    event_type: AudienceEventType;
    intensity: number;          //  1 ~ 5
    count: number;
    duration_sec: number;
    variant: string;
    overlay_text: string;
    reason: string;
    source: 'vote' | 'donation' | 'fallback';
    supporters: number;
    vote_share: number;
    donor: string | null;
    donation_amount: number | null;
}

export interface GameStateReport
{
    wave: number;
    player_hp: number;
    player_max_hp: number;
    player_level: number;
    enemies_alive: number;
    score: number;
    elapsed_sec: number;
    difficulty?: string;
    extra?: Record<string, unknown>;
}

export interface PlayRecord
{
    status: 'cleared' | 'dead' | 'quit';
    final_wave: number;
    score: number;
    kills: number;
    level: number;
    ai_events_applied: number;
    extra?: Record<string, unknown>;
}

type ToolResult = Record<string, unknown>;

export class StreamDirectorClient
{
    readonly playerId: string;
    sessionId: string | null = null;
    connected = false;

    private client: Client | null = null;
    private connecting: Promise<Client | null> | null = null;
    private starting: Promise<string | null> | null = null;
    private polling = false;
    private onEvent: ((event: AudienceEvent) => void) | null = null;
    private lastSeq = 0;
    private nextRetryAt = 0;

    constructor (private url: string = STREAMDIRECTOR_MCP_URL, private onStatus?: (connected: boolean) => void)
    {
        this.playerId = loadPlayerId();
    }

    // ---------------------------------------------------------------- 연결

    private async ensure (): Promise<Client | null>
    {
        if (this.client)
        {
            return this.client;
        }
        if (Date.now() < this.nextRetryAt)
        {
            return null;
        }
        this.connecting ??= (async () => {
            try
            {
                const client = new Client({ name: 'last-lantern', version: '1.0.0' });
                await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
                this.client = client;
                this.setConnected(true);
                return client;
            }
            catch
            {
                this.nextRetryAt = Date.now() + RETRY_MS;
                this.setConnected(false);
                return null;
            }
            finally
            {
                this.connecting = null;
            }
        })();
        return this.connecting;
    }

    private setConnected (value: boolean)
    {
        if (this.connected !== value)
        {
            this.connected = value;
            this.onStatus?.(value);
        }
    }

    //  도구 호출. 실패하면 null (게임 진행에는 영향 없음)
    async call<T = ToolResult> (name: string, args: Record<string, unknown> = {}): Promise<T | null>
    {
        const client = await this.ensure();
        if (!client)
        {
            return null;
        }
        try
        {
            const res = await client.callTool({ name, arguments: args });
            if (res.isError)
            {
                console.warn(`[StreamDirector] ${name} 오류`, res.content);
                return null;
            }
            return (res.structuredContent ?? {}) as T;
        }
        catch (err)
        {
            //  연결이 끊긴 경우: 다음 호출 때 새로 연결
            console.warn(`[StreamDirector] ${name} 실패 - 재연결 예정`, err);
            this.client = null;
            this.nextRetryAt = Date.now() + RETRY_MS;
            this.setConnected(false);
            return null;
        }
    }

    // ---------------------------------------------------------------- 판(세션)

    async startSession (nickname: string): Promise<string | null>
    {
        //  같은 판에서 동시에 여러 번 불려도 세션은 하나만 만든다
        this.starting ??= (async () => {
            const row = await this.call<{ session_id: string }>('start_play_session', {
                player_id: this.playerId, nickname, bind_chat: true
            });
            this.sessionId = row?.session_id ?? null;
            this.lastSeq = 0;
            this.starting = null;
            return this.sessionId;
        })();
        return this.starting;
    }

    //  세션이 없으면(서버가 나중에 켜진 경우) 여기서 다시 시작을 시도한다
    async reportState (state: GameStateReport, nickname: string)
    {
        if (!this.sessionId && !(await this.startSession(nickname)))
        {
            return;
        }
        await this.call('update_game_state', { session_id: this.sessionId, game_state: state });
    }

    async recordProgress (wave: number, hp: number, level: number, score: number, kills: number, aiEvents: number)
    {
        if (this.sessionId)
        {
            await this.call('record_play_data', {
                session_id: this.sessionId, wave, hp, level, score, kills, ai_events_applied: aiEvents
            });
        }
    }

    async endSession (record: PlayRecord)
    {
        if (this.sessionId)
        {
            await this.call('end_play_session', { session_id: this.sessionId, ...record });
        }
        this.sessionId = null;
    }

    // ---------------------------------------------------------------- AI 이벤트 수신 (롱폴링)

    //  이벤트 수신 루프는 게임 전체에서 하나만 돌고, 받는 쪽(현재 Game 씬)만 바꿔 끼운다
    startEvents (onEvent: (event: AudienceEvent) => void)
    {
        this.onEvent = onEvent;
        if (this.polling)
        {
            return;
        }
        this.polling = true;

        const loop = async () => {
            while (this.polling)
            {
                if (!this.sessionId)
                {
                    await sleep(1000);
                    continue;
                }
                const sid = this.sessionId;
                const res = await this.call<{ events: AudienceEvent[]; last_seq: number }>('poll_events', {
                    session_id: sid, since_seq: this.lastSeq, wait_ms: POLL_WAIT_MS
                });
                if (!res)
                {
                    await sleep(RETRY_MS);
                    continue;
                }
                if (!this.polling || sid !== this.sessionId)
                {
                    continue;
                }
                this.lastSeq = Math.max(this.lastSeq, res.last_seq);
                for (const event of res.events)
                {
                    this.onEvent?.(event);
                }
            }
        };
        void loop();
    }

    stopEvents ()
    {
        this.polling = false;
        this.onEvent = null;
    }

    // ---------------------------------------------------------------- 세이브 (서버 DB)

    async load<T> (slot: number): Promise<{ data: T; version: number } | null>
    {
        const res = await this.call<{ found: boolean; save: { data: T; version: number } | null }>('load_game', {
            player_id: this.playerId, slot
        });
        return res?.found && res.save ? { data: res.save.data, version: res.save.version } : null;
    }

    async save (slot: number, data: Record<string, unknown>, expectedVersion?: number, label = '')
    {
        return this.call('save_game', {
            player_id: this.playerId, slot, data, label,
            ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {})
        });
    }
}

//  브라우저마다 고정된 플레이어 ID (로그인 기능이 생기면 계정 ID 로 교체)
function loadPlayerId (): string
{
    try
    {
        let id = localStorage.getItem(PLAYER_ID_KEY);
        if (!id)
        {
            id = `player-${crypto.randomUUID()}`;
            localStorage.setItem(PLAYER_ID_KEY, id);
        }
        return id;
    }
    catch
    {
        return `player-${Math.random().toString(36).slice(2)}`;
    }
}

function sleep (ms: number)
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

//  게임 전체에서 하나의 연결을 공유 (씬이 다시 시작돼도 재접속하지 않음)
let shared: StreamDirectorClient | null = null;

export function getStreamDirector (onStatus?: (connected: boolean) => void): StreamDirectorClient
{
    shared ??= new StreamDirectorClient(STREAMDIRECTOR_MCP_URL, onStatus);
    return shared;
}
