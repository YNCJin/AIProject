"""환경 변수 기반 설정. 프로젝트 루트의 .env 파일을 자동으로 읽는다."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")


def _env(name: str, default: str) -> str:
    return os.getenv(name, default).strip()


def _env_int(name: str, default: int) -> int:
    return int(_env(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(_env(name, str(default)))


def _env_bool(name: str, default: bool) -> bool:
    return _env(name, "1" if default else "0").lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    # --- Google AI Studio (Gemini) ---
    gemini_api_key: str = field(default_factory=lambda: _env("GEMINI_API_KEY", _env("GOOGLE_API_KEY", "")))
    # 이벤트 생성 모델과 검열 에이전트 모델을 분리해 둔다 (둘 다 저지연 경량 모델 권장).
    event_model: str = field(default_factory=lambda: _env("GEMINI_EVENT_MODEL", "gemini-2.5-flash-lite"))
    moderation_model: str = field(default_factory=lambda: _env("GEMINI_MODERATION_MODEL", "gemini-2.5-flash-lite"))
    # live: 실제 API 호출 / mock: 오프라인 결정적 응답(테스트·시연용) / off: LLM 미사용(규칙 기반만)
    llm_mode: str = field(default_factory=lambda: _env("LLM_MODE", "live"))
    event_timeout_sec: float = field(default_factory=lambda: _env_float("EVENT_LLM_TIMEOUT_SEC", 2.0))
    moderation_timeout_sec: float = field(default_factory=lambda: _env_float("MODERATION_LLM_TIMEOUT_SEC", 1.2))

    # --- 채팅 파이프라인 ---
    window_sec: float = field(default_factory=lambda: _env_float("CHAT_WINDOW_SEC", 2.0))
    max_messages_per_window: int = field(default_factory=lambda: _env_int("MAX_MESSAGES_PER_WINDOW", 300))
    max_msgs_per_user_per_window: int = field(default_factory=lambda: _env_int("MAX_MSGS_PER_USER_PER_WINDOW", 3))
    max_message_len: int = field(default_factory=lambda: _env_int("MAX_MESSAGE_LEN", 120))
    # 별도 프로세스로 띄운 검열 에이전트(MCP) 주소. 비워두면 같은 프로세스에서 실행.
    moderation_agent_url: str = field(default_factory=lambda: _env("MODERATION_AGENT_URL", ""))

    # --- 후원 / 개입 예산 ---
    donation_vote_unit: int = field(default_factory=lambda: _env_int("DONATION_VOTE_UNIT", 1000))
    donation_instant_threshold: int = field(default_factory=lambda: _env_int("DONATION_INSTANT_THRESHOLD", 10000))
    event_cooldown_sec: float = field(default_factory=lambda: _env_float("EVENT_COOLDOWN_SEC", 8.0))
    max_events_per_minute: int = field(default_factory=lambda: _env_int("MAX_EVENTS_PER_MINUTE", 6))

    # --- 서버 / 저장소 ---
    host: str = field(default_factory=lambda: _env("MCP_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("MCP_PORT", 8765))
    moderation_port: int = field(default_factory=lambda: _env_int("MODERATION_PORT", 8766))
    cors_origins: str = field(default_factory=lambda: _env("CORS_ORIGINS", "*"))
    db_path: Path = field(default_factory=lambda: Path(_env("DB_PATH", str(ROOT_DIR / "data" / "streamdirector.db"))))
    log_dir: Path = field(default_factory=lambda: Path(_env("LOG_DIR", str(ROOT_DIR / "logs"))))
    max_save_bytes: int = field(default_factory=lambda: _env_int("MAX_SAVE_BYTES", 256 * 1024))
    log_user_hash_salt: str = field(default_factory=lambda: _env("LOG_USER_HASH_SALT", "streamdirector"))

    # --- Gemini 무료 할당량 보호 (0 = 제한 없음). 무료 티어 한도보다 낮게 두어 429/과금 방지 ---
    gemini_rpm_limit: int = field(default_factory=lambda: _env_int("GEMINI_RPM_LIMIT", 20))
    gemini_daily_limit: int = field(default_factory=lambda: _env_int("GEMINI_DAILY_LIMIT", 800))

    # --- 검열 에이전트 백엔드 ---
    # local : 규칙 + kor_unsmile(욕설) + KcELECTRA(의도) + Ollama(애매한 것만)  ← 기본, 무료·무제한
    # gemini: 규칙 + Gemini 분류 (무료 할당량 소모)
    # rules : 규칙만
    moderation_backend: str = field(default_factory=lambda: _env("MODERATION_BACKEND", "local"))
    toxicity_model: str = field(default_factory=lambda: _env("TOXICITY_MODEL", "smilegate-ai/kor_unsmile"))
    toxicity_threshold: float = field(default_factory=lambda: _env_float("TOXICITY_THRESHOLD", 0.6))
    intent_model_dir: Path = field(default_factory=lambda: Path(_env("INTENT_MODEL_DIR", str(ROOT_DIR / "models" / "intent-kcelectra"))))
    intent_confidence: float = field(default_factory=lambda: _env_float("INTENT_CONFIDENCE", 0.75))
    local_device: str = field(default_factory=lambda: _env("LOCAL_DEVICE", "auto"))  # auto | mps | cuda | cpu
    ollama_url: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://127.0.0.1:11434"))
    ollama_model: str = field(default_factory=lambda: _env("OLLAMA_MODEL", "gemma2:9b"))  # 비우면 미사용
    ollama_timeout_sec: float = field(default_factory=lambda: _env_float("OLLAMA_TIMEOUT_SEC", 2.5))
    # async: 실시간 경로는 폴백으로 즉시 처리하고 Ollama 판단은 백그라운드에서 캐시에 반영 (지연 0, 권장)
    # sync : Ollama 응답을 기다림 (작고 빠른 모델일 때만, 예: qwen2.5:3b)
    ollama_mode: str = field(default_factory=lambda: _env("OLLAMA_MODE", "async"))
    ollama_async_timeout_sec: float = field(default_factory=lambda: _env_float("OLLAMA_ASYNC_TIMEOUT_SEC", 20.0))

    # --- 채팅 수집기 ---
    chzzk_client_id: str = field(default_factory=lambda: _env("CHZZK_CLIENT_ID", ""))
    chzzk_client_secret: str = field(default_factory=lambda: _env("CHZZK_CLIENT_SECRET", ""))
    chzzk_redirect_uri: str = field(default_factory=lambda: _env("CHZZK_REDIRECT_URI", "http://localhost:8765/chzzk/callback"))
    chzzk_access_token: str = field(default_factory=lambda: _env("CHZZK_ACCESS_TOKEN", ""))
    chzzk_refresh_token: str = field(default_factory=lambda: _env("CHZZK_REFRESH_TOKEN", ""))
    chzzk_enabled: bool = field(default_factory=lambda: _env_bool("CHZZK_ENABLED", True))
    soop_client_id: str = field(default_factory=lambda: _env("SOOP_CLIENT_ID", ""))
    soop_client_secret: str = field(default_factory=lambda: _env("SOOP_CLIENT_SECRET", ""))
    discord_bot_token: str = field(default_factory=lambda: _env("DISCORD_BOT_TOKEN", ""))
    discord_channel_id: int | None = field(default_factory=lambda: int(_env("DISCORD_CHANNEL_ID", "0") or 0) or None)
    # standalone: 별도 프로세스(python -m streamdirector.discord_bot) / embedded: MCP 서버 안에서 실행
    discord_mode: str = field(default_factory=lambda: _env("DISCORD_MODE", "standalone"))
    streamdirector_mcp_url: str = field(default_factory=lambda: _env("STREAMDIRECTOR_MCP_URL", "http://127.0.0.1:8765/mcp"))
    discord_guild_id: int | None = field(default_factory=lambda: int(_env("DISCORD_GUILD_ID", "0") or 0) or None)
    # 테스트/검증 시 외부 수집기를 끄기 위한 스위치
    collectors_enabled: bool = field(default_factory=lambda: _env_bool("COLLECTORS_ENABLED", True))

    @property
    def llm_enabled(self) -> bool:
        if self.llm_mode == "mock":
            return True
        return self.llm_mode == "live" and bool(self.gemini_api_key)


settings = Settings()
