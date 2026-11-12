"""Google AI Studio API 키/모델 점검 + 실제 Gemini 로 파이프라인 1회 실행.

사용: python scripts/check_gemini.py [--list]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from dummy_chat import generate  # noqa: E402

from streamdirector.config import settings  # noqa: E402


async def main(list_models: bool) -> int:
    if not settings.gemini_api_key:
        print(".env 에 GEMINI_API_KEY 를 입력하세요 (https://aistudio.google.com/apikey)")
        return 1
    if list_models:
        from google import genai

        client = genai.Client(api_key=settings.gemini_api_key)
        for m in client.models.list():
            if "generateContent" in (m.supported_actions or []):
                print(m.name)
        return 0

    from streamdirector.pipeline.orchestrator import Orchestrator
    from streamdirector.schemas import ChatMessage, GameState

    orch = Orchestrator()
    print("probe:", await orch.engine.llm.probe(settings.event_model))
    lat = []
    for i in range(5):
        msgs = [ChatMessage(**m) for m in generate(60, seed=100 + i)]
        msgs.append(ChatMessage(user_id="x1", text="비 오는 맵에서 싸우는거 보고싶다"))
        t = time.perf_counter()
        r = await orch.run_pipeline(f"gemini-check-{i}", msgs, game_state=GameState(wave=3 + i, player_hp=60))
        lat.append((time.perf_counter() - t) * 1000)
        print(f"[{i}] {r.status} {r.latency_ms}  event={json.dumps(r.event.model_dump(mode='json') if r.event else None, ensure_ascii=False)}")
    m = orch.metrics()
    print("pipeline p50/p95:", m["pipeline_latency_ms"], "schema_compliance:", m["schema_compliance"],
          "engine:", m["engine"], "moderation:", m["moderation"])
    print("상세 로그: logs/ai_results.jsonl, logs/moderation.jsonl")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="사용 가능한 모델 목록")
    sys.exit(asyncio.run(main(ap.parse_args().list)))
