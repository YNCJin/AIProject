import os
import tempfile

# settings 는 import 시점에 읽히므로 streamdirector import 전에 테스트 환경을 고정한다
_tmp = tempfile.mkdtemp(prefix="sd-test-")
os.environ.update({
    "LLM_MODE": "mock",
    "DB_PATH": os.path.join(_tmp, "test.db"),
    "LOG_DIR": os.path.join(_tmp, "logs"),
    "COLLECTORS_ENABLED": "0",
    "MODERATION_AGENT_URL": "",
    "MODERATION_BACKEND": "gemini",  # 기본 테스트는 mock LLM 경로, 로컬 모델은 test_local_models.py
    "GEMINI_RPM_LIMIT": "0",
    "GEMINI_DAILY_LIMIT": "0",
    "EVENT_COOLDOWN_SEC": "8",
    "CHAT_WINDOW_SEC": "0.3",
})
