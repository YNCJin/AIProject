/// <reference types="vite/client" />

interface ImportMetaEnv
{
    readonly VITE_MIDDLEWARE_WS?: string;           //  채팅 오버레이 WebSocket (기본 ws://localhost:8765/ws)
    readonly VITE_STREAMDIRECTOR_MCP?: string;      //  StreamDirector AI 서버 MCP (기본 http://localhost:8765/mcp)
}

interface ImportMeta
{
    readonly env: ImportMetaEnv;
}
