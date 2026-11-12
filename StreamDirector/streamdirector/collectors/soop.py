"""숲(SOOP, 구 아프리카TV) 수집기 - 자격증명 미정으로 현재 비활성 자리표시자.

SOOP_CLIENT_ID / SOOP_CLIENT_SECRET 을 받으면 ChzzkCollector 와 같은 인터페이스
(start/stop/status, on_chat/on_donation 콜백)로 구현한다.
"""

from __future__ import annotations

import logging

log = logging.getLogger("streamdirector.soop")


class SoopCollector:
    def __init__(self, client_id: str = "", client_secret: str = "", on_chat=None, on_donation=None):
        self.client_id = client_id
        self.client_secret = client_secret
        self.on_chat = on_chat
        self.on_donation = on_donation
        self.status = {"state": "disabled", "reason": "SOOP 자격증명 미입력 (추후 연동 예정)"}

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def start(self) -> None:
        if not self.configured:
            log.info("SOOP collector disabled: credentials not set")
            return
        self.status = {"state": "not_implemented", "reason": "자격증명은 있으나 연동 미구현"}
        log.warning("SOOP collector not implemented yet")

    async def stop(self) -> None:
        pass
