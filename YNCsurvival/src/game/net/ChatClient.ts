//  채팅 서버와 WebSocket으로 연결해서 화면에 띄울 메시지를 받는다
//  기본: StreamDirector AI 서버의 채팅 오버레이 (ws://localhost:8765/ws)
//  예전 미들웨어(middleware/server.py)를 쓰려면 .env.local 에 VITE_MIDDLEWARE_WS=ws://localhost:8000/ws
export const MIDDLEWARE_WS_URL: string = import.meta.env.VITE_MIDDLEWARE_WS ?? 'ws://localhost:8765/ws';

const RECONNECT_DELAY_MS = 3000;

export interface ChatMessage
{
    type: 'chat';
    platform: string;   //  'discord' | 'dummy' | 'manual' ...
    user: string;
    text: string;
    ts: number;
    filtered?: boolean; //  욕설·광고라서 원문 대신 "(필터링된 메시지)"로 바뀐 경우
}

export interface DonationMessage
{
    type: 'donation';
    user: string;
    amount: number;
    text: string;
    filtered?: boolean;
}

//  AI 이벤트가 발동됐다는 알림 (게임 적용은 MCP 로 받고, 이건 화면 표시용)
export interface EventNotice
{
    type: 'event';
    event_type: string;
    overlay_text: string;
    source: string;
    donor: string | null;
}

export interface ChatClientHandlers
{
    onChat: (message: ChatMessage) => void;
    onDonation?: (message: DonationMessage) => void;
    onEvent?: (message: EventNotice) => void;
    onStatus?: (connected: boolean) => void;
}

export class ChatClient
{
    private ws: WebSocket | null = null;
    private reconnectTimer: number | undefined;
    private closedByUser = false;

    constructor (private url: string, private handlers: ChatClientHandlers)
    {
    }

    connect ()
    {
        this.closedByUser = false;
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => this.handlers.onStatus?.(true);

        this.ws.onmessage = (event) => {
            let data: unknown;
            try
            {
                data = JSON.parse(event.data);
            }
            catch
            {
                return;
            }

            const type = (data as { type?: string } | null)?.type;
            if (isChatMessage(data))
            {
                this.handlers.onChat(data);
            }
            else if (type === 'donation')
            {
                this.handlers.onDonation?.(data as DonationMessage);
            }
            else if (type === 'event')
            {
                this.handlers.onEvent?.(data as EventNotice);
            }
        };

        //  서버가 꺼져 있거나 끊기면 일정 시간 후 자동 재연결
        this.ws.onclose = () => {
            this.ws = null;
            this.handlers.onStatus?.(false);
            if (!this.closedByUser)
            {
                this.reconnectTimer = window.setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
            }
        };
    }

    close ()
    {
        this.closedByUser = true;
        window.clearTimeout(this.reconnectTimer);
        this.ws?.close();
    }
}

function isChatMessage (data: unknown): data is ChatMessage
{
    const m = data as ChatMessage;
    return typeof m === 'object' && m !== null && m.type === 'chat'
        && typeof m.user === 'string' && typeof m.text === 'string';
}
