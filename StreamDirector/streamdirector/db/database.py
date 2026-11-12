"""SQLite 저장소 - 유저 플레이 데이터와 세이브 데이터만 저장한다.

AI 산출물(이벤트, 검열 결과)은 DB 에 넣지 않고 logs/*.jsonl 로만 남긴다.

테이블
- players         : 유저 기본 정보
- play_sessions   : 판(세션)별 플레이 기록 (시작/종료, 최종 웨이브, 점수, 처치 수, 결과 ...)
- play_snapshots  : 세션 중간 진행 기록 (웨이브 단위 등)
- saves           : 슬롯별 세이브 데이터 (JSON, 버전 기반 낙관적 잠금, 체크섬)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS players (
    player_id    TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL DEFAULT '',
    created_at   REAL NOT NULL,
    last_seen_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS play_sessions (
    session_id        TEXT PRIMARY KEY,
    player_id         TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    started_at        REAL NOT NULL,
    ended_at          REAL,
    status            TEXT NOT NULL DEFAULT 'playing',  -- playing | cleared | dead | quit
    final_wave        INTEGER NOT NULL DEFAULT 0,
    score             INTEGER NOT NULL DEFAULT 0,
    kills             INTEGER NOT NULL DEFAULT 0,
    level             INTEGER NOT NULL DEFAULT 1,
    play_time_sec     REAL NOT NULL DEFAULT 0,
    ai_events_applied INTEGER NOT NULL DEFAULT 0,
    extra_json        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON play_sessions(player_id, started_at DESC);

CREATE TABLE IF NOT EXISTS play_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES play_sessions(session_id) ON DELETE CASCADE,
    ts          REAL NOT NULL,
    wave        INTEGER NOT NULL,
    hp          REAL NOT NULL,
    level       INTEGER NOT NULL,
    score       INTEGER NOT NULL,
    kills       INTEGER NOT NULL,
    extra_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON play_snapshots(session_id, ts);

CREATE TABLE IF NOT EXISTS saves (
    player_id   TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    slot        INTEGER NOT NULL,
    data_json   TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    checksum    TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    updated_at  REAL NOT NULL,
    PRIMARY KEY (player_id, slot)
);
"""

MAX_SLOTS = 10


class SaveConflict(Exception):
    pass


class Database:
    def __init__(self, path: Path, max_save_bytes: int = 256 * 1024):
        self.path = path
        self.max_save_bytes = max_save_bytes
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None, timeout=5)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._lock = asyncio.Lock()

    async def _run(self, fn, *args):
        async with self._lock:
            return await asyncio.to_thread(fn, *args)

    def close(self) -> None:
        self._conn.close()

    # ------------------------------------------------------------------ players
    def _upsert_player(self, player_id: str, nickname: str = "") -> None:
        now = time.time()
        self._conn.execute(
            "INSERT INTO players(player_id, nickname, created_at, last_seen_at) VALUES (?,?,?,?) "
            "ON CONFLICT(player_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, "
            "nickname=CASE WHEN excluded.nickname != '' THEN excluded.nickname ELSE players.nickname END",
            (player_id, nickname, now, now),
        )

    # ------------------------------------------------------------------ play data
    async def start_session(self, player_id: str, nickname: str = "", session_id: str | None = None) -> dict:
        sid = session_id or uuid.uuid4().hex

        def fn():
            self._upsert_player(player_id, nickname)
            self._conn.execute("INSERT INTO play_sessions(session_id, player_id, started_at) VALUES (?,?,?)",
                               (sid, player_id, time.time()))
            return self._session_row(sid)

        return await self._run(fn)

    async def record_snapshot(self, session_id: str, wave: int, hp: float, level: int, score: int, kills: int,
                              ai_events_applied: int | None = None, extra: dict | None = None) -> dict:
        def fn():
            row = self._conn.execute("SELECT status FROM play_sessions WHERE session_id=?", (session_id,)).fetchone()
            if row is None:
                raise KeyError(f"unknown session {session_id}")
            now = time.time()
            self._conn.execute("BEGIN")
            try:
                self._conn.execute(
                    "INSERT INTO play_snapshots(session_id, ts, wave, hp, level, score, kills, extra_json) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (session_id, now, wave, hp, level, score, kills, json.dumps(extra or {}, ensure_ascii=False)))
                self._conn.execute(
                    "UPDATE play_sessions SET final_wave=MAX(final_wave, ?), score=?, kills=?, level=?, "
                    "play_time_sec=? - started_at, ai_events_applied=COALESCE(?, ai_events_applied) "
                    "WHERE session_id=?",
                    (wave, score, kills, level, now, ai_events_applied, session_id))
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            return self._session_row(session_id)

        return await self._run(fn)

    async def end_session(self, session_id: str, status: str, final_wave: int, score: int, kills: int,
                          level: int, ai_events_applied: int = 0, extra: dict | None = None) -> dict:
        if status not in ("cleared", "dead", "quit"):
            raise ValueError("status must be cleared | dead | quit")

        def fn():
            now = time.time()
            cur = self._conn.execute(
                "UPDATE play_sessions SET ended_at=?, status=?, final_wave=?, score=?, kills=?, level=?, "
                "ai_events_applied=?, play_time_sec=? - started_at, extra_json=? WHERE session_id=?",
                (now, status, final_wave, score, kills, level, ai_events_applied, now,
                 json.dumps(extra or {}, ensure_ascii=False), session_id))
            if cur.rowcount == 0:
                raise KeyError(f"unknown session {session_id}")
            return self._session_row(session_id)

        return await self._run(fn)

    def _session_row(self, session_id: str) -> dict:
        r = self._conn.execute("SELECT * FROM play_sessions WHERE session_id=?", (session_id,)).fetchone()
        d = dict(r)
        d["extra"] = json.loads(d.pop("extra_json"))
        return d

    async def player_stats(self, player_id: str, recent: int = 10) -> dict:
        def fn():
            p = self._conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
            if p is None:
                return {"player": None}
            agg = self._conn.execute(
                "SELECT COUNT(*) AS sessions, COALESCE(MAX(final_wave),0) AS best_wave, "
                "COALESCE(MAX(score),0) AS best_score, COALESCE(SUM(kills),0) AS total_kills, "
                "COALESCE(SUM(play_time_sec),0) AS total_play_sec, "
                "COALESCE(SUM(ai_events_applied),0) AS total_ai_events "
                "FROM play_sessions WHERE player_id=?", (player_id,)).fetchone()
            rows = self._conn.execute(
                "SELECT session_id FROM play_sessions WHERE player_id=? ORDER BY started_at DESC LIMIT ?",
                (player_id, recent)).fetchall()
            return {"player": dict(p), "summary": dict(agg),
                    "recent_sessions": [self._session_row(r["session_id"]) for r in rows]}

        return await self._run(fn)

    # ------------------------------------------------------------------ saves
    async def save(self, player_id: str, slot: int, data: dict[str, Any], expected_version: int | None = None,
                   label: str = "") -> dict:
        if not 0 <= slot < MAX_SLOTS:
            raise ValueError(f"slot must be 0..{MAX_SLOTS - 1}")
        if not isinstance(data, dict):
            raise ValueError("save data must be a JSON object")
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        if len(payload.encode()) > self.max_save_bytes:
            raise ValueError(f"save data too large (> {self.max_save_bytes} bytes)")
        checksum = hashlib.sha256(payload.encode()).hexdigest()

        def fn():
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._upsert_player(player_id)
                cur = self._conn.execute("SELECT version FROM saves WHERE player_id=? AND slot=?",
                                         (player_id, slot)).fetchone()
                current = cur["version"] if cur else 0
                if expected_version is not None and expected_version != current:
                    raise SaveConflict(f"version conflict: expected {expected_version}, current {current}")
                new_version = current + 1
                self._conn.execute(
                    "INSERT INTO saves(player_id, slot, data_json, version, checksum, label, updated_at) "
                    "VALUES (?,?,?,?,?,?,?) ON CONFLICT(player_id, slot) DO UPDATE SET "
                    "data_json=excluded.data_json, version=excluded.version, checksum=excluded.checksum, "
                    "label=excluded.label, updated_at=excluded.updated_at",
                    (player_id, slot, payload, new_version, checksum, label, time.time()))
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            return {"player_id": player_id, "slot": slot, "version": new_version, "checksum": checksum,
                    "bytes": len(payload.encode())}

        return await self._run(fn)

    async def load(self, player_id: str, slot: int) -> dict | None:
        def fn():
            r = self._conn.execute("SELECT * FROM saves WHERE player_id=? AND slot=?", (player_id, slot)).fetchone()
            if r is None:
                return None
            d = dict(r)
            raw = d.pop("data_json")
            d["data"] = json.loads(raw)
            d["integrity_ok"] = hashlib.sha256(raw.encode()).hexdigest() == d["checksum"]
            return d

        return await self._run(fn)

    async def list_saves(self, player_id: str) -> list[dict]:
        def fn():
            rows = self._conn.execute(
                "SELECT slot, version, label, updated_at, LENGTH(data_json) AS bytes FROM saves "
                "WHERE player_id=? ORDER BY slot", (player_id,)).fetchall()
            return [dict(r) for r in rows]

        return await self._run(fn)

    async def delete_save(self, player_id: str, slot: int) -> bool:
        def fn():
            return self._conn.execute("DELETE FROM saves WHERE player_id=? AND slot=?",
                                      (player_id, slot)).rowcount > 0

        return await self._run(fn)

    async def ping(self) -> float:
        t = time.perf_counter()
        await self._run(lambda: self._conn.execute("SELECT 1").fetchone())
        return round((time.perf_counter() - t) * 1000, 3)
