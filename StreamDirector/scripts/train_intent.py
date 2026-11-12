"""KcELECTRA 채팅 의도 분류 모델 파인튜닝 (무료 로컬 학습, Apple GPU(MPS)/CUDA/CPU 자동 선택).

데이터: 합성 데이터(streamdirector/training/intent_data.py) + data/intent_labeled.jsonl(실제 로그 라벨, 있으면)
평가:   tests/data/moderation_eval.jsonl 중 COMMAND/REJECT(욕설·광고 제외) 문장 - 학습에서 제외됨
출력:   models/intent-kcelectra/  (+ eval_report.json)

사용: python scripts/train_intent.py [--epochs 3] [--per-class 300]
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import torch  # noqa: E402
from torch.utils.data import DataLoader  # noqa: E402
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup  # noqa: E402

from streamdirector.training.intent_data import LABELS, build_dataset  # noqa: E402

BASE_MODEL = "beomi/KcELECTRA-base-v2022"
OUT_DIR = ROOT / "models" / "intent-kcelectra"
EVAL_FILE = ROOT / "tests" / "data" / "moderation_eval.jsonl"
LABELED_FILE = ROOT / "data" / "intent_labeled.jsonl"


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_eval() -> list[dict]:
    rows = []
    for line in EVAL_FILE.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r["label"] == "COMMAND":
            rows.append({"text": r["text"], "label": r["intent"]})
        elif r["label"] == "REJECT":
            rows.append({"text": r["text"], "label": "REJECT"})  # GAME_TALK/OFF_TOPIC 어느 쪽이든 정답
    return rows


def evaluate(model, tok, rows, device) -> dict:
    model.eval()
    correct, errors = 0, []
    with torch.no_grad():
        for i in range(0, len(rows), 64):
            chunk = rows[i:i + 64]
            enc = tok([r["text"] for r in chunk], padding=True, truncation=True, max_length=48,
                      return_tensors="pt").to(device)
            probs = torch.softmax(model(**enc).logits, -1).cpu()
            for r, p in zip(chunk, probs):
                pred = LABELS[int(p.argmax())]
                ok = pred == r["label"] or (r["label"] == "REJECT" and pred in ("GAME_TALK", "OFF_TOPIC"))
                correct += ok
                if not ok:
                    errors.append({"text": r["text"], "gold": r["label"], "pred": pred, "conf": round(float(p.max()), 3)})
    return {"accuracy": round(correct / len(rows), 4), "n": len(rows), "errors": errors}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--per-class", type=int, default=300)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=5e-5)
    args = ap.parse_args()

    random.seed(0)
    torch.manual_seed(0)
    device = pick_device()
    eval_rows = load_eval()
    exclude = {r["text"] for r in eval_rows}
    train = build_dataset(args.per_class, exclude=exclude)
    if LABELED_FILE.exists():
        real = [json.loads(l) for l in LABELED_FILE.read_text().splitlines() if l.strip()]
        real = [r for r in real if r.get("label") in LABELS and r["text"] not in exclude]
        train += real * 3  # 실제 데이터 가중
        print(f"실제 라벨 데이터 {len(real)}건 추가")
    random.shuffle(train)
    print(f"device={device} train={len(train)} eval={len(eval_rows)} labels={len(LABELS)}")

    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL, num_labels=len(LABELS), id2label=dict(enumerate(LABELS)),
        label2id={l: i for i, l in enumerate(LABELS)}).to(device)
    label2id = {l: i for i, l in enumerate(LABELS)}

    def collate(batch):
        enc = tok([b["text"] for b in batch], padding=True, truncation=True, max_length=48, return_tensors="pt")
        enc["labels"] = torch.tensor([label2id[b["label"]] for b in batch])
        return enc

    loader = DataLoader(train, batch_size=args.batch, shuffle=True, collate_fn=collate)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    total = len(loader) * args.epochs
    sched = get_linear_schedule_with_warmup(opt, int(total * 0.1), total)

    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        running = 0.0
        for step, batch in enumerate(loader):
            batch = {k: v.to(device) for k, v in batch.items()}
            loss = model(**batch).loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            running += loss.item()
        ev = evaluate(model, tok, eval_rows, device)
        print(f"epoch {epoch + 1}/{args.epochs} loss={running / len(loader):.4f} eval_acc={ev['accuracy']} "
              f"({time.time() - t0:.0f}s)")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(OUT_DIR)
    tok.save_pretrained(OUT_DIR)
    report = {"base_model": BASE_MODEL, "device": device, "train_size": len(train), "epochs": args.epochs,
              "labels": LABELS, "eval": ev, "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
              "note": "평가셋은 소규모(템플릿과 문체가 비슷)라 실제 방송 로그 기준 정확도보다 낙관적일 수 있음"}
    (OUT_DIR / "eval_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"saved -> {OUT_DIR}  eval_acc={ev['accuracy']}  errors={ev['errors'][:10]}")


if __name__ == "__main__":
    main()
