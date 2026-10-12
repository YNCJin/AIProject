//  미들웨어 서버(middleware/server.py)와 WebSocket으로 연결해서 메시지를 받는다
//  주소는 .env.local 에 VITE_MIDDLEWARE_WS=ws://... 로 바꿀 수 있음
export const MIDDLEWARE_WS_URL: string = import.meta.env.VITE_MIDDLEWARE_WS ?? 'ws://localhost:8000/ws';

const RECONNECT_DELAY_MS = 3000;

export interface ChatMessage
{
    type: 'chat';
    platform: string;   //  'discord' | 'dummy' | 'manual' ...
    user: string;
    text: string;
    ts: number;
}

export interface ChatClientHandlers
{
    onChat: (message: ChatMessage) => void;
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

            if (isChatMessage(data))
            {
                this.handlers.onChat(data);
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
