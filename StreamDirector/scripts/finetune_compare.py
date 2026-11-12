"""(B) 소형 LLM LoRA 미세조정 비교 - KcELECTRA 와 같은 학습 데이터·같은 평가셋.

각 모델(4비트 MLX)을 합성 의도 데이터(11코드)로 QLoRA 학습 -> 평가셋 40건(의도/잡담/무관)을 한 건씩 판정.
미세조정 후에는 긴 지시문이 필요 없으므로 프롬프트는 "채팅: ...\\n분류:" 한 줄뿐이다.
기준선으로 KcELECTRA 를 같은 방식(한 건씩)으로 측정한다.

사용: python scripts/finetune_compare.py [--iters 400] [--models kanana-2.1b exaone-2.4b qwen3-1.7b]
결과: logs/bench_finetune.json, models/lora/<model>/
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from streamdirector.training import transformers_compat  # noqa: E402
from streamdirector.training.intent_data import LABELS, build_dataset  # noqa: E402

transformers_compat.apply()  # Kanana(head_dim 명시 Llama) 로딩 버그 우회

MLX_DIR = ROOT / "models" / "mlx"
LORA_DIR = ROOT / "models" / "lora"
DATA_DIR = ROOT / "data" / "lora"
EVAL = [json.loads(l) for l in (ROOT / "tests" / "data" / "moderation_eval.jsonl").read_text().splitlines() if l.strip()]
EVAL40 = [r for r in EVAL if r["label"] in ("COMMAND", "REJECT")]


def prompt(text: str) -> str:
    return f"채팅: {text}\n분류:"


def correct(row: dict, code: str) -> bool:
    if row["label"] == "COMMAND":
        return code == row["intent"]
    return code in ("GAME_TALK", "OFF_TOPIC")


def prepare_data() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    rows = build_dataset(300, exclude={r["text"] for r in EVAL})  # KcELECTRA 와 동일 데이터
    random.Random(1).shuffle(rows)
    valid, train = rows[:200], rows[200:]
    for name, part in (("train", train), ("valid", valid)):
        with (DATA_DIR / f"{name}.jsonl").open("w") as f:
            for r in part:
                f.write(json.dumps({"text": f"{prompt(r['text'])} {r['label']}"}, ensure_ascii=False) + "\n")


LR = "2e-5"  # 2e-4 는 4비트 모델 + LoRA scale 20 에서 발산(모든 입력에 같은 출력)했음


def train(model: str, iters: int) -> dict:
    import re

    out = LORA_DIR / model
    meta_file = out / "train_meta.json"
    if meta_file.exists() and (out / "adapters.safetensors").exists():
        meta = json.loads(meta_file.read_text())
        if meta.get("lr") == LR and meta.get("iters") == iters:
            return {**meta, "reused": True}
    t = time.time()
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "mlx_convert_compat.py"), "lora", "--model", str(MLX_DIR / f"{model}-4bit"), "--train",
         "--data", str(DATA_DIR), "--iters", str(iters), "--batch-size", "16", "--num-layers", "16",
         "--learning-rate", LR, "--max-seq-length", "64", "--steps-per-report", "50",
         "--steps-per-eval", str(max(50, iters // 3)), "--val-batches", "10", "--adapter-path", str(out), "--trust-remote-code"],
        capture_output=True, text=True)
    log = re.sub(r"\x1b\[[0-9;]*m", "", proc.stdout + proc.stderr)
    (ROOT / "logs" / f"lora_{model}.log").write_text(log)
    if proc.returncode != 0:
        raise RuntimeError(log[-2000:])
    vals = re.findall(r"^\s*\d+\s+val\s+([\d.]+)", log, re.M)
    trains = re.findall(r"^\s*\d+\s+([\d.]+)\s+[▼▲]?", log, re.M)
    meta = {"lr": LR, "iters": iters, "train_sec": round(time.time() - t),
            "val_loss_first": float(vals[0]) if vals else None, "val_loss_final": float(vals[-1]) if vals else None,
            "train_loss_final": float(trains[-1]) if trains else None}
    meta_file.write_text(json.dumps(meta))
    return meta


def eval_lora(model: str) -> dict:
    import mlx.core as mx
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    m, tok = load(str(MLX_DIR / f"{model}-4bit"), adapter_path=str(LORA_DIR / model),
                  tokenizer_config={"trust_remote_code": True})
    greedy = make_sampler(temp=0.0)
    generate(m, tok, prompt(" 워밍업"), max_tokens=6, sampler=greedy)
    lat, ok, errors = [], 0, []
    for row in EVAL40:
        t = time.perf_counter()
        out = generate(m, tok, prompt(row["text"]), max_tokens=8, sampler=greedy)
        lat.append((time.perf_counter() - t) * 1000)
        code = out.strip().split()[0] if out.strip() else ""
        code = code if code in LABELS else out.strip()[:20]
        good = correct(row, code)
        ok += good
        if not good:
            errors.append({"text": row["text"], "gold": row.get("intent") or row["label"], "pred": code})
    del m
    mx.clear_cache()
    lat.sort()
    return {"latency_ms": {"mean": round(statistics.fmean(lat)), "p50": round(lat[len(lat) // 2]),
                           "p95": round(lat[int(len(lat) * 0.95)])},
            "accuracy_intent40": round(ok / len(EVAL40), 3), "errors": errors[:10]}


def eval_prompt_only(model: str) -> dict:
    """학습 전: 원본 모델 + 검열 에이전트와 같은 축소 프롬프트 (같은 MLX 런타임에서 전후 비교용)."""
    import mlx.core as mx
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    from streamdirector.agents.moderation_agent import LABEL_CODES, LOCAL_SYSTEM_PROMPT

    m, tok = load(str(MLX_DIR / f"{model}-4bit"), tokenizer_config={"trust_remote_code": True})
    greedy = make_sampler(temp=0.0)

    def chat(text: str) -> str:
        msgs = [{"role": "system", "content": LOCAL_SYSTEM_PROMPT}, {"role": "user", "content": text}]
        kw = {"enable_thinking": False} if "qwen3" in model else {}
        return tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, **kw)

    generate(m, tok, chat("워밍업"), max_tokens=4, sampler=greedy)
    lat, ok, errors = [], 0, []
    for row in EVAL40:
        t = time.perf_counter()
        out = generate(m, tok, chat(row["text"]), max_tokens=16, sampler=greedy)
        lat.append((time.perf_counter() - t) * 1000)
        code = next((c for c in sorted(LABEL_CODES, key=len, reverse=True) if c in out), out.strip()[:20])
        good = correct(row, code)
        ok += good
        if not good:
            errors.append({"text": row["text"], "gold": row.get("intent") or row["label"], "pred": code})
    del m
    mx.clear_cache()
    lat.sort()
    return {"latency_ms": {"mean": round(statistics.fmean(lat)), "p50": round(lat[len(lat) // 2]),
                           "p95": round(lat[int(len(lat) * 0.95)])},
            "accuracy_intent40": round(ok / len(EVAL40), 3), "errors": errors[:10]}


def eval_kcelectra() -> dict:
    from streamdirector.agents.local_models import IntentModel
    from streamdirector.config import settings

    im = IntentModel(settings.intent_model_dir)
    im.load()
    res = {}
    for label, texts_fn in (("one_at_a_time", lambda: [[r["text"]] for r in EVAL40]),
                            ("batch40", lambda: [[r["text"] for r in EVAL40]])):
        lat, preds = [], []
        for batch in texts_fn():
            t = time.perf_counter()
            preds += im.predict(batch)
            lat.append((time.perf_counter() - t) * 1000)
        if label == "one_at_a_time":
            ok = sum(correct(r, p.label) for r, p in zip(EVAL40, preds))
            res["accuracy_intent40"] = round(ok / len(EVAL40), 3)
        res[label + "_ms"] = round(statistics.fmean(lat), 2)
    res["device"] = im.device
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=300)
    ap.add_argument("--models", nargs="+", default=["kanana-2.1b", "exaone-2.4b", "qwen3-1.7b"])
    args = ap.parse_args()

    prepare_data()
    out_file = ROOT / "logs" / "bench_finetune.json"
    report = json.loads(out_file.read_text()) if out_file.exists() else {}
    report.setdefault("prompt_only", {})
    report.setdefault("lora", {})
    if "kcelectra" not in report:
        report["kcelectra"] = eval_kcelectra()
    print("KcELECTRA:", report["kcelectra"], flush=True)

    def save() -> None:
        out_file.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    for model in args.models:
        if not (MLX_DIR / f"{model}-4bit").exists():
            print(f"skip {model}: not converted")
            continue
        po = report["prompt_only"].get(model) or eval_prompt_only(model)
        report["prompt_only"][model] = po
        save()
        print(f"== {model} 학습 전(프롬프트만): 지연 평균 {po['latency_ms']['mean']}ms p95 {po['latency_ms']['p95']}ms | "
              f"정확도 {po['accuracy_intent40']:.1%}", flush=True)
        print(f"== {model} 학습 중 ({args.iters} iters)", flush=True)
        tr = train(model, args.iters)
        ev = eval_lora(model)
        report["lora"][model] = {**tr, **ev}
        save()
        print(f"   학습 {tr['train_sec']}s val_loss {tr.get('val_loss_first')}->{tr.get('val_loss_final')} | 지연 평균 {ev['latency_ms']['mean']}ms "
              f"p95 {ev['latency_ms']['p95']}ms | 정확도 {ev['accuracy_intent40']:.1%}", flush=True)
    save()
    print(f"saved {out_file}")


if __name__ == "__main__":
    main()
