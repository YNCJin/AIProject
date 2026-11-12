import pytest

from streamdirector.db.database import Database, SaveConflict


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "x.db")
    yield d
    d.close()


async def test_play_session_lifecycle(db):
    s = await db.start_session("p1", "닉")
    await db.record_snapshot(s["session_id"], wave=3, hp=50, level=2, score=300, kills=20)
    end = await db.end_session(s["session_id"], "dead", final_wave=5, score=900, kills=70, level=4, ai_events_applied=6)
    assert end["status"] == "dead" and end["final_wave"] == 5 and end["ended_at"]
    stats = await db.player_stats("p1")
    assert stats["summary"]["best_wave"] == 5 and stats["summary"]["total_ai_events"] == 6
    with pytest.raises(ValueError):
        await db.end_session(s["session_id"], "weird", 1, 1, 1, 1)


async def test_saves_version_conflict_and_integrity(db):
    r = await db.save("p1", 0, {"gold": 10, "items": ["sword"]})
    assert r["version"] == 1
    await db.save("p1", 0, {"gold": 20}, expected_version=1)
    with pytest.raises(SaveConflict):
        await db.save("p1", 0, {"gold": 30}, expected_version=1)
    loaded = await db.load("p1", 0)
    assert loaded["data"] == {"gold": 20} and loaded["integrity_ok"] and loaded["version"] == 2
    assert [s["slot"] for s in await db.list_saves("p1")] == [0]
    assert await db.delete_save("p1", 0) and await db.load("p1", 0) is None


async def test_save_limits(db):
    with pytest.raises(ValueError):
        await db.save("p1", 99, {})
    with pytest.raises(ValueError):
        await db.save("p1", 0, {"blob": "x" * (300 * 1024)})
