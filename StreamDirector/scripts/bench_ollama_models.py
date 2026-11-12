"""(A) 프롬프트 방식 로컬 LLM 비교 - Ollama, 축소 프롬프트, 한 건씩 판정 (검열 에이전트와 동일 조건).

측정: 1건당 지연(평균/p95), 프롬프트 처리 토큰·시간(접두 캐시 재사용 여부), 생성 속도, 정확도
정확도: 전체 66건(욕설·광고 포함 13코드) / 의도 40건(KcELECTRA 와 같은 기준: 명령 의도 + 무관/잡담)

사용: python scripts/bench_ollama_models.py gemma2:9b exaone3.5:2.4b qwen3:1.7b <kanana>
결과: logs/bench_ollama.json
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from streamdirector.agents.moderation_agent import LOCAL_SYSTEM_PROMPT, SINGLE_SCHEMA  # noqa: E402

URL = "http://127.0.0.1:11434/api/chat"
ROWS = [json.loads(l) for l in (ROOT / "tests" / "data" / "moderation_eval.jsonl").read_text().splitlines() if l.strip()]


def correct(row: dict, code: str) -> bool:
    if row["label"] == "COMMAND":
        return code == row["intent"]
    if row["label"] == "REJECT":
        return code in ("GAME_TALK", "OFF_TOPIC")
    return code in ("ABUSE", "SPAM")


LABEL_CODES = SINGLE_SCHEMA["properties"]["label"]["enum"]
NO_FORMAT: set[str] = set()  # 형식 강제(format)가 템플릿과 충돌하는 모델 -> 자유 출력에서 라벨 추출


def extract_code(content: str) -> str:
    try:
        return json.loads(content).get("label", "")
    except (json.JSONDecodeError, AttributeError):
        for code in sorted(LABEL_CODES, key=len, reverse=True):
            if code in content:
                return code
        return ""


def call(model: str, text: str) -> dict:
    body = {"model": model, "stream": False, "keep_alive": "30m",
            "options": {"temperature": 0, "num_predict": 16},
            "messages": [{"role": "system", "content": LOCAL_SYSTEM_PROMPT}, {"role": "user", "content": text}]}
    if model not in NO_FORMAT:
        body["format"] = SINGLE_SCHEMA
    if model.startswith("qwen3"):
        body["think"] = False  # 생각 모드 끄기 (켜면 수백 토큰을 더 생성)
    t = time.perf_counter()
    r = httpx.post(URL, json=body, timeout=120).json()
    if "error" in r and "format" in body and "format" in r["error"]:
        NO_FORMAT.add(model)
        return call(model, text)
    r["_wall_ms"] = (time.perf_counter() - t) * 1000
    return r


def bench(model: str) -> dict:
    call(model, "워밍업")  # 모델 로딩 + 시스템 프롬프트 캐시
    lat, ptoks, pms, gen_tps, ok_all, ok_intent, n_intent, bad_json = [], [], [], [], 0, 0, 0, 0
    errors = []
    for row in ROWS:
        r = call(model, row["text"])
        lat.append(r["_wall_ms"])
        ptoks.append(r.get("prompt_eval_count", 0))
        pms.append(r.get("prompt_eval_duration", 0) / 1e6)
        if r.get("eval_duration"):
            gen_tps.append(r["eval_count"] / (r["eval_duration"] / 1e9))
        if "error" in r or "message" not in r:
            code, bad_json = "", bad_json + 1
            errors.append({"text": row["text"], "error": str(r.get("error"))[:200]})
        else:
            code = extract_code(r["message"]["content"])
        ok = correct(row, code)
        ok_all += ok
        if row["label"] in ("COMMAND", "REJECT"):
            n_intent += 1
            ok_intent += ok
        if not ok:
            errors.append({"text": row["text"], "gold": row.get("intent") or row["label"], "pred": code})
    lat.sort()
    return {
        "model": model,
        "latency_ms": {"mean": round(statistics.fmean(lat)), "p50": round(lat[len(lat) // 2]),
                       "p95": round(lat[int(len(lat) * 0.95)]), "max": round(lat[-1])},
        "prompt_tokens": {"min": min(ptoks), "max": max(ptoks)},
        "prompt_eval_ms_mean": round(statistics.fmean(pms)),
        "structured_output": model not in NO_FORMAT,
        "gen_tok_per_s": round(statistics.fmean(gen_tps), 1) if gen_tps else None,
        "accuracy_all66": round(ok_all / len(ROWS), 3),
        "accuracy_intent40": round(ok_intent / n_intent, 3),
        "bad_json": bad_json,
        "errors": errors[:15],
    }


def main() -> None:
    models = sys.argv[1:] or ["gemma2:9b"]
    results = []
    for m in models:
        print(f"== {m}", flush=True)
        res = bench(m)
        results.append(res)
        print(f"   지연 평균 {res['latency_ms']['mean']}ms p95 {res['latency_ms']['p95']}ms | "
              f"프롬프트처리 {res['prompt_eval_ms_mean']}ms 형식강제={res['structured_output']} | 생성 {res['gen_tok_per_s']} tok/s | "
              f"정확도 전체 {res['accuracy_all66']:.1%} 의도 {res['accuracy_intent40']:.1%}", flush=True)
        # 다음 모델 측정에 메모리 경합이 없도록 언로드
        httpx.post("http://127.0.0.1:11434/api/generate", json={"model": m, "keep_alive": 0}, timeout=30)
    out = ROOT / "logs" / "bench_ollama.json"
    prev = {r["model"]: r for r in json.loads(out.read_text())} if out.exists() else {}
    prev.update({r["model"]: r for r in results})
    out.write_text(json.dumps(list(prev.values()), ensure_ascii=False, indent=2))
    print(f"saved {out}")


if __name__ == "__main__":
    main()
