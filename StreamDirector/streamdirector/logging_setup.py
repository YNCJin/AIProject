"""로그 설정.

- logs/server.log          : 일반 애플리케이션 로그
- logs/ai_results.jsonl    : 파이프라인 1회 실행(조회) 결과 - 입력 요약, 검증, LLM 원문, 최종 이벤트, 지연시간
- logs/moderation.jsonl    : 검열 에이전트의 메시지별 판정 (user_id는 해시로 익명화)
- logs/connection.jsonl    : 통신 상태 점검 결과

AI 산출 데이터는 DB가 아닌 위 JSONL 로그로만 남긴다.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from .config import settings

_lock = threading.Lock()
_configured = False


def setup_logging(level: int = logging.INFO) -> None:
    global _configured
    if _configured:
        return
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
    file_handler = RotatingFileHandler(
        settings.log_dir / "server.log", maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    root = logging.getLogger("streamdirector")
    root.setLevel(level)
    root.addHandler(file_handler)
    stream = logging.StreamHandler()
    stream.setFormatter(fmt)
    root.addHandler(stream)
    _configured = True


def anonymize(user_id: str) -> str:
    return hashlib.sha256(f"{settings.log_user_hash_salt}:{user_id}".encode()).hexdigest()[:12]


def write_jsonl(name: str, record: dict[str, Any]) -> None:
    """logs/<name>.jsonl 에 한 줄 추가. 10MB 초과 시 타임스탬프를 붙여 회전."""
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    path: Path = settings.log_dir / f"{name}.jsonl"
    record = {"logged_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **record}
    line = json.dumps(record, ensure_ascii=False, default=str)
    with _lock:
        if path.exists() and path.stat().st_size > 10 * 1024 * 1024:
            path.rename(path.with_name(f"{name}.{int(time.time())}.jsonl"))
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
