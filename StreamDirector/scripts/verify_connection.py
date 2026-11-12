"""게임 <-> AI MCP 통신 상태 점검.

실제 서버를 HTTP(Streamable HTTP)로 띄우고, 게임과 같은 방식으로 MCP 클라이언트로 접속해 측정한다.

  1) HTTP /health 응답
  2) MCP 핸드셰이크(연결) 시간
  3) ping 왕복 지연 (순차 N회) p50/p95/max
  4) 동시 접속 (클라이언트 C개 x 각 M회 ping)
  5) DB 도구 왕복 (save_game/load_game)
  6) 전체 AI 파이프라인 (process_chat_batch, 더미 채팅 100건)
  7) 실시간 경로: ingest_chat -> 윈도우 배칭 -> poll_events 롱폴링 수신
  8) 재연결 (세션 종료 후 재접속)
  (옵션) --remote-moderation : 검열 에이전트를 별도 MCP 프로세스로 띄워 경유 측정

사용:  python scripts/verify_connection.py            (이미 떠 있는 서버를 쓰려면 --url)
결과:  logs/connection_report.json, logs/connection.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from mcp import Client  # noqa: E402

from dummy_chat import generate  # noqa: E402

TARGETS = {
    "ping_p95_ms": 50.0,
    "concurrent_p95_ms": 150.0,
    "db_p95_ms": 100.0,
    "pipeline_p95_ms": 3000.0,  # 채팅 묶음 처리 ~ 이벤트 산출
    "chat_to_game_p95_ms": 3000.0,  # 채팅 발생 ~ 게임 수신 (과제 정량 목표)
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def pct(values: list[float], p: float) -> float:
    v = sorted(values)
    return round(v[min(len(v) - 1, int(len(v) * p))], 2)


def summary(values: list[float]) -> dict:
    return {"n": len(values), "p50": pct(values, 0.5), "p95": pct(values, 0.95), "max": round(max(values), 2),
            "mean": round(statistics.fmean(values), 2)}


async def wait_http(url: str, timeout: float = 20) -> float:
    start = time.perf_counter()
    async with httpx.AsyncClient() as http:
        while time.perf_counter() - start < timeout:
            try:
                r = await http.get(url, timeout=1)
                if r.status_code == 200:
                    return (time.perf_counter() - start) * 1000
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.1)
    raise TimeoutError(f"server not responding: {url}")


async def wait_models(url: str, timeout: float = 120) -> float | None:
    """로컬 검열 모델(kor_unsmile/KcELECTRA) 로딩 완료까지 대기 - 측정이 규칙 폴백 상태에서 이뤄지지 않도록."""
    start = time.perf_counter()
    async with httpx.AsyncClient() as http:
        while time.perf_counter() - start < timeout:
            mod = (await http.get(url, timeout=2)).json().get("moderation", {})
            states = [mod[k]["state"] for k in ("toxicity", "intent") if k in mod]
            if not states or all(s in ("ready", "error", "missing") for s in states):
                return round((time.perf_counter() - start) * 1000, 1) if states else None
            await asyncio.sleep(0.5)
    return None


def spawn(module: str, env: dict) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-m", module], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


async def run(args) -> dict:
    procs: list[subprocess.Popen] = []
    report: dict = {"started_at": time.strftime("%Y-%m-%d %H:%M:%S"), "checks": {}, "targets": TARGETS}
    base = args.url.rstrip("/").removesuffix("/mcp") if args.url else None
    window_sec = args.window
    try:
        if base is None:
            port = free_port()
            env = {**os.environ, "MCP_PORT": str(port), "MCP_HOST": "127.0.0.1",
                   "COLLECTORS_ENABLED": "1" if args.with_collectors else "0",
                   "CHAT_WINDOW_SEC": str(window_sec), "EVENT_COOLDOWN_SEC": "0", "MAX_EVENTS_PER_MINUTE": "1000",
                   "DB_PATH": str(ROOT / "data" / "verify.db")}
            if args.llm_mode:
                env["LLM_MODE"] = args.llm_mode
            if args.remote_moderation:
                mport = free_port()
                procs.append(spawn("streamdirector.moderation_server", {**env, "MODERATION_PORT": str(mport)}))
                env["MODERATION_AGENT_URL"] = f"http://127.0.0.1:{mport}/mcp"
                await asyncio.sleep(1.5)
            procs.append(spawn("streamdirector.server", env))
            base = f"http://127.0.0.1:{port}"
            report["server_boot_ms"] = round(await wait_http(f"{base}/health"), 1)
            report["model_load_ms"] = await wait_models(f"{base}/health")
        url = f"{base}/mcp"
        report["url"] = url

        # 1) HTTP health
        async with httpx.AsyncClient() as http:
            t = time.perf_counter()
            h = (await http.get(f"{base}/health", timeout=5)).json()
            report["checks"]["http_health"] = {"ok": h.get("ok", False), "ms": round((time.perf_counter() - t) * 1000, 2),
                                               "llm_mode": h.get("llm_mode")}

        # 2) 핸드셰이크
        t = time.perf_counter()
        async with Client(url, read_timeout_seconds=15) as c:
            report["checks"]["handshake_ms"] = round((time.perf_counter() - t) * 1000, 2)
            report["protocol_version"] = c.protocol_version
            tools = await c.list_tools()
            report["checks"]["tools"] = len(tools.tools)
            hc = (await c.call_tool("health_check", {"deep": args.deep})).structured_content
            report["checks"]["health_check"] = hc

            # 3) ping
            for _ in range(5):  # warm-up
                await c.call_tool("ping", {})
            lat = []
            for _ in range(args.pings):
                t = time.perf_counter()
                r = await c.call_tool("ping", {"client_ts": time.time()})
                lat.append((time.perf_counter() - t) * 1000)
                assert r.structured_content["pong"]
            report["checks"]["ping"] = summary(lat)

            # 5) DB 왕복
            db_lat = []
            for i in range(20):
                t = time.perf_counter()
                await c.call_tool("save_game", {"player_id": "verify", "slot": 9, "data": {"i": i, "inv": ["a"] * 20}})
                r = await c.call_tool("load_game", {"player_id": "verify", "slot": 9})
                db_lat.append((time.perf_counter() - t) * 1000 / 2)
                assert r.structured_content["save"]["data"]["i"] == i
            await c.call_tool("delete_save", {"player_id": "verify", "slot": 9})
            report["checks"]["db_roundtrip"] = summary(db_lat)

            # 6) 전체 파이프라인
            sid = (await c.call_tool("start_play_session", {"player_id": "verify", "nickname": "검증"})).structured_content["session_id"]
            pipe_lat, statuses, server_lat = [], {}, []
            for i in range(args.batches):
                msgs = generate(100, users=60, seed=i)
                t = time.perf_counter()
                r = (await c.call_tool("process_chat_batch", {"session_id": sid, "messages": msgs,
                                                              "game_state": {"wave": 1 + i, "player_hp": 70}})).structured_content
                pipe_lat.append((time.perf_counter() - t) * 1000)
                server_lat.append(r["latency_ms"]["total"])
                statuses[r["status"]] = statuses.get(r["status"], 0) + 1
            report["checks"]["pipeline"] = {**summary(pipe_lat), "server_side": summary(server_lat), "statuses": statuses,
                                            "last_result": {k: r[k] for k in ("status", "event", "moderation", "latency_ms")}}

            # 7) 실시간 경로 (윈도우 배칭 + 롱폴링)
            rt, rt_window = [], []
            last_seq = (await c.call_tool("poll_events", {"session_id": sid})).structured_content["last_seq"]
            for i in range(args.realtime_rounds):
                msgs = [{"user_id": f"rt{i}-{k}", "text": t} for k, t in
                        enumerate(["보스 소환해줘", "힐 해줘", "버프 줘", "몹 더 보내줘"][i % 4:] + ["보스 나와라"] * 3)]
                t_send = time.time()
                await c.call_tool("ingest_chat", {"session_id": sid, "messages": msgs})
                got = None
                while got is None and time.time() - t_send < window_sec + 8:
                    r = (await c.call_tool("poll_events", {"session_id": sid, "since_seq": last_seq,
                                                           "wait_ms": 5000})).structured_content
                    if r["events"]:
                        got = r["events"][-1]
                        last_seq = r["last_seq"]
                if got is None:
                    rt.append(float("inf"))
                    continue
                t_recv = time.time()
                rt.append((t_recv - t_send) * 1000)
                # 이벤트 생성(파이프라인 종료) ~ 게임 수신 = 큐 적재 + 롱폴링 응답 전송 지연
                rt_window.append((t_recv - got["created_at"]) * 1000)
            ok_rt = [x for x in rt if x != float("inf")]
            report["checks"]["realtime"] = {
                "window_sec": window_sec,
                "chat_to_game": summary(ok_rt) if ok_rt else None,
                "event_to_game_transport": summary(rt_window) if rt_window else None,
                "missed": len(rt) - len(ok_rt),
            }
            metrics = (await c.call_tool("get_metrics", {})).structured_content
            report["server_metrics"] = {k: metrics[k] for k in ("pipeline_latency_ms", "chat_to_event_ms", "block_rate",
                                                                "schema_compliance", "engine")}
            await c.call_tool("end_play_session", {"session_id": sid, "status": "quit", "final_wave": 1, "score": 0,
                                                   "kills": 0, "level": 1})

        # 4) 동시 접속
        async def worker(n: int) -> list[float]:
            out = []
            async with Client(url, read_timeout_seconds=15) as cc:
                for _ in range(args.concurrent_pings):
                    t = time.perf_counter()
                    await cc.call_tool("ping", {})
                    out.append((time.perf_counter() - t) * 1000)
            return out

        t = time.perf_counter()
        results = await asyncio.gather(*(worker(i) for i in range(args.clients)), return_exceptions=True)
        errors = [str(r) for r in results if isinstance(r, BaseException)]
        flat = [x for r in results if not isinstance(r, BaseException) for x in r]
        report["checks"]["concurrency"] = {"clients": args.clients, "errors": errors[:3], "error_count": len(errors),
                                           "wall_ms": round((time.perf_counter() - t) * 1000, 1),
                                           **(summary(flat) if flat else {})}

        # 8) 재연결
        t = time.perf_counter()
        async with Client(url, read_timeout_seconds=15) as c2:
            await c2.call_tool("ping", {})
        report["checks"]["reconnect_ms"] = round((time.perf_counter() - t) * 1000, 2)
    finally:
        for p in procs:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
            if p.returncode not in (0, -15, None) and p.stderr:
                err = p.stderr.read().decode(errors="replace")[-2000:]
                if err.strip():
                    report.setdefault("server_stderr", []).append(err)

    # 판정
    ch = report["checks"]
    rt = ch["realtime"]
    verdict = {
        "http_health": ch["http_health"]["ok"],
        "ping_p95": ch["ping"]["p95"] <= TARGETS["ping_p95_ms"],
        "concurrency": ch["concurrency"]["error_count"] == 0 and ch["concurrency"].get("p95", 1e9) <= TARGETS["concurrent_p95_ms"],
        "db_p95": ch["db_roundtrip"]["p95"] <= TARGETS["db_p95_ms"],
        "pipeline_p95": ch["pipeline"]["p95"] <= TARGETS["pipeline_p95_ms"],
        "realtime_no_miss": rt["missed"] == 0,
        # 과제 목표: 채팅 발생 ~ 게임 반영 3초 이내 (윈도우 대기 포함)
        "chat_to_game_p95<=3s": bool(rt["chat_to_game"]) and rt["chat_to_game"]["p95"] <= TARGETS["chat_to_game_p95_ms"],
    }
    report["verdict"] = verdict
    report["passed"] = all(verdict.values())
    return report


def print_report(r: dict) -> None:
    ch = r["checks"]
    line = "-" * 64
    print(line)
    print(f" StreamDirector MCP 통신 점검  {r['started_at']}   {r['url']}")
    print(line)
    if "server_boot_ms" in r:
        print(f" 서버 기동            {r['server_boot_ms']:>8} ms   로컬 모델 로딩 {r.get('model_load_ms')} ms")
    print(f" HTTP /health         {ch['http_health']['ms']:>8} ms   llm_mode={ch['http_health']['llm_mode']}")
    print(f" MCP 핸드셰이크       {ch['handshake_ms']:>8} ms   protocol={r.get('protocol_version')} tools={ch['tools']}")
    p = ch["ping"]
    print(f" ping x{p['n']:<4}          p50 {p['p50']:>6}  p95 {p['p95']:>6}  max {p['max']:>7} ms")
    c = ch["concurrency"]
    print(f" 동시 {c['clients']}클라이언트      p50 {c.get('p50', '-'):>6}  p95 {c.get('p95', '-'):>6}  "
          f"max {c.get('max', '-'):>7} ms  errors={c['error_count']}")
    d = ch["db_roundtrip"]
    print(f" DB save/load         p50 {d['p50']:>6}  p95 {d['p95']:>6}  max {d['max']:>7} ms")
    pl = ch["pipeline"]
    print(f" AI 파이프라인(100건) p50 {pl['p50']:>6}  p95 {pl['p95']:>6}  max {pl['max']:>7} ms  {pl['statuses']}")
    rt = ch["realtime"]
    if rt["chat_to_game"]:
        ct = rt["chat_to_game"]
        print(f" 채팅->게임 수신      p50 {ct['p50']:>6}  p95 {ct['p95']:>6}  max {ct['max']:>7} ms  "
              f"(윈도우 {rt['window_sec']}s 포함, 누락 {rt['missed']})")
    print(f" 재연결               {ch['reconnect_ms']:>8} ms")
    hc = ch["health_check"]
    print(f" DB={hc['db']}  LLM={hc['llm']}")
    ma = hc["moderation_agent"]
    print(f" 검열 에이전트: {ma.get('type')} backend={ma.get('backend')} "
          f"toxicity={ma.get('toxicity', {}).get('state')}@{ma.get('toxicity', {}).get('device')} "
          f"intent={ma.get('intent', {}).get('state')} llm={ma.get('llm')}")
    print(f" Gemini 할당량: {hc.get('gemini_quota')}")
    sm = r.get("server_metrics", {})
    print(f" 차단율={sm.get('block_rate')}  스키마 준수율={sm.get('schema_compliance')}  엔진={sm.get('engine')}")
    print(line)
    for k, v in r["verdict"].items():
        print(f"  [{'PASS' if v else 'FAIL'}] {k}")
    print(f"  => {'모든 통신 점검 통과' if r['passed'] else '일부 항목 실패'}")
    print(line)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="이미 실행 중인 서버 (예: http://127.0.0.1:8765/mcp)")
    ap.add_argument("--pings", type=int, default=200)
    ap.add_argument("--clients", type=int, default=20)
    ap.add_argument("--concurrent-pings", type=int, default=20)
    ap.add_argument("--batches", type=int, default=10)
    ap.add_argument("--realtime-rounds", type=int, default=5)
    ap.add_argument("--window", type=float, default=float(os.getenv("CHAT_WINDOW_SEC", "2.0")))
    ap.add_argument("--llm-mode", choices=["live", "mock", "off"], help="서버 LLM_MODE 덮어쓰기")
    ap.add_argument("--deep", action="store_true", help="health_check 에서 Gemini 실제 호출")
    ap.add_argument("--remote-moderation", action="store_true", help="검열 에이전트를 별도 MCP 프로세스로 실행")
    ap.add_argument("--with-collectors", action="store_true", help="치지직/디스코드 수집기도 함께 기동")
    args = ap.parse_args()

    report = asyncio.run(run(args))
    print_report(report)
    out = ROOT / "logs" / "connection_report.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    from streamdirector.logging_setup import write_jsonl
    write_jsonl("connection", {"kind": "verify_connection", "passed": report["passed"], "verdict": report["verdict"],
                               "checks": {k: v for k, v in report["checks"].items() if k != "health_check"}})
    print(f" 보고서: {out}")
    sys.exit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
