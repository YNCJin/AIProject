"""Gemini 무료 티어 보호용 호출 상한.

Google AI Studio 무료 할당량은 프로젝트 단위(분당/일일)이며 일일 한도는 태평양 시간 자정에 초기화된다.
상한에 닿으면 API 를 호출하지 않고 즉시 거절해(-> 호출자가 규칙 기반 폴백) 429 오류나 과금 전환을 막는다.
일일 카운트는 data/gemini_usage.json 에 저장해 서버를 재시작해도 유지된다.
"""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

_PACIFIC = ZoneInfo("America/Los_Angeles")


class QuotaGuard:
    def __init__(self, rpm_limit: int, daily_limit: int, path: Path):
        self.rpm_limit = rpm_limit
        self.daily_limit = daily_limit
        self.path = path
        self._lock = threading.Lock()
        self._minute: deque[float] = deque()
        self._day, self._count = self._today(), 0
        self.rejected = 0
        if path.exists():
            try:
                data = json.loads(path.read_text())
                if data.get("day") == self._day:
                    self._count = int(data.get("count", 0))
            except (ValueError, OSError):
                pass

    @staticmethod
    def _today() -> str:
        return datetime.now(_PACIFIC).strftime("%Y-%m-%d")

    def try_acquire(self) -> str:
        """허용되면 "" , 거절되면 사유 문자열."""
        with self._lock:
            now = time.time()
            today = self._today()
            if today != self._day:
                self._day, self._count = today, 0
            while self._minute and now - self._minute[0] > 60:
                self._minute.popleft()
            if self.daily_limit and self._count >= self.daily_limit:
                self.rejected += 1
                return f"daily quota guard ({self._count}/{self.daily_limit})"
            if self.rpm_limit and len(self._minute) >= self.rpm_limit:
                self.rejected += 1
                return f"rpm quota guard ({len(self._minute)}/{self.rpm_limit})"
            self._minute.append(now)
            self._count += 1
            self._persist()
            return ""

    def _persist(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"day": self._day, "count": self._count}))
        except OSError:
            pass

    def usage(self) -> dict:
        with self._lock:
            now = time.time()
            return {"day_pacific": self._day, "today": self._count, "daily_limit": self.daily_limit,
                    "last_minute": sum(1 for t in self._minute if now - t <= 60), "rpm_limit": self.rpm_limit,
                    "rejected_by_guard": self.rejected}
