"""검열 에이전트용 로컬 모델 (무료·무제한·외부 전송 없음).

- ToxicityModel : smilegate-ai/kor_unsmile (한국어 혐오/악플 다중 라벨 분류)
- IntentModel   : KcELECTRA 파인튜닝 모델 (scripts/train_intent.py 로 생성, models/intent-kcelectra)
- OllamaClient  : 로컬 LLM (예: gemma2:9b) - 위 두 모델로도 애매한 소수 문장만 판단

모델은 서버 기동 시 백그라운드로 로딩되며, 로딩 전/실패 시 검열 에이전트는 규칙 기반으로 동작한다.
추론은 스레드에서 실행해 이벤트 루프(MCP 응답)를 막지 않는다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from ..llm.gemini_client import LLMResponse, LLMUnavailable

log = logging.getLogger("streamdirector.local_models")

# kor_unsmile 라벨 중 '정상' 이외의 라벨
_CLEAN_LABELS = {"clean"}


def pick_device(pref: str = "auto") -> str:
    import torch

    if pref != "auto":
        return pref
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class _HFClassifier:
    """HF 시퀀스 분류 모델 공통 로딩/추론."""

    def __init__(self, model_id: str, device: str = "auto", max_length: int = 64):
        self.model_id = model_id
        self.device_pref = device
        self.max_length = max_length
        self.device = "cpu"
        self.tok = None
        self.model = None
        self.state = "idle"  # idle | loading | ready | error | missing
        self.error: str | None = None
        self.load_ms: float | None = None
        self._lock = threading.Lock()  # 동시 추론 직렬화 (MPS 안정성)

    @property
    def ready(self) -> bool:
        return self.state == "ready"

    def load(self) -> None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.state = "loading"
        t = time.perf_counter()
        try:
            self.device = pick_device(self.device_pref)
            try:  # 캐시 우선 (오프라인 기동, 허브 확인 지연 제거) -> 없으면 최초 1회 다운로드
                self.tok = AutoTokenizer.from_pretrained(self.model_id, local_files_only=True)
                model = AutoModelForSequenceClassification.from_pretrained(self.model_id, local_files_only=True)
            except OSError:
                self.tok = AutoTokenizer.from_pretrained(self.model_id)
                model = AutoModelForSequenceClassification.from_pretrained(self.model_id)
            self.model = model.eval().to(self.device)
            with torch.no_grad():  # 워밍업 (첫 추론 지연 제거)
                self._forward(["워밍업"])
            self.load_ms = round((time.perf_counter() - t) * 1000)
            self.state = "ready"
            log.info("%s loaded on %s in %sms", self.model_id, self.device, self.load_ms)
        except Exception as e:
            self.state, self.error = "error", f"{type(e).__name__}: {e}"
            log.warning("failed to load %s: %s", self.model_id, self.error)

    def _forward(self, texts: list[str]):
        import torch

        enc = self.tok(texts, padding=True, truncation=True, max_length=self.max_length, return_tensors="pt")
        enc = {k: v.to(self.device) for k, v in enc.items()}
        with torch.no_grad():
            return self.model(**enc).logits.float().cpu()

    def status(self) -> dict[str, Any]:
        return {"model": self.model_id, "state": self.state, "device": self.device, "load_ms": self.load_ms,
                "error": self.error}


@dataclass
class ToxicityVerdict:
    toxic: bool
    score: float
    label: str


class ToxicityModel(_HFClassifier):
    def __init__(self, model_id: str = "smilegate-ai/kor_unsmile", threshold: float = 0.6, device: str = "auto"):
        super().__init__(model_id, device)
        self.threshold = threshold

    def predict(self, texts: list[str]) -> list[ToxicityVerdict]:
        import torch

        with self._lock:
            probs = torch.sigmoid(self._forward(texts))
        id2label = self.model.config.id2label
        out = []
        for p in probs:
            best_label, best = "clean", 0.0
            for i, v in enumerate(p.tolist()):
                label = id2label[i]
                if label not in _CLEAN_LABELS and v > best:
                    best_label, best = label, v
            out.append(ToxicityVerdict(best >= self.threshold, round(best, 3), best_label))
        return out

    async def apredict(self, texts: list[str]) -> list[ToxicityVerdict]:
        return await asyncio.to_thread(self.predict, texts)


@dataclass
class IntentPrediction:
    label: str  # LABELS 중 하나 (의도 이름 또는 GAME_TALK / OFF_TOPIC)
    confidence: float


class IntentModel(_HFClassifier):
    def __init__(self, model_dir: Path, device: str = "auto"):
        super().__init__(str(model_dir), device, max_length=48)
        self.model_dir = model_dir

    def load(self) -> None:
        if not (self.model_dir / "config.json").exists():
            self.state = "missing"
            self.error = f"{self.model_dir} 없음 - scripts/train_intent.py 로 학습 필요"
            log.info(self.error)
            return
        super().load()

    def predict(self, texts: list[str]) -> list[IntentPrediction]:
        import torch

        with self._lock:
            probs = torch.softmax(self._forward(texts), -1)
        id2label = self.model.config.id2label
        return [IntentPrediction(id2label[int(p.argmax())], round(float(p.max()), 3)) for p in probs]

    async def apredict(self, texts: list[str]) -> list[IntentPrediction]:
        return await asyncio.to_thread(self.predict, texts)


class OllamaClient:
    """Ollama 로컬 LLM - GeminiClient.generate_json 과 같은 인터페이스."""

    def __init__(self, url: str, model: str):
        self.url = url.rstrip("/")
        self.model = model
        self.available: bool | None = None  # 첫 확인 전 None

    @property
    def mode(self) -> str:
        return "local" if self.model and self.available is not False else "off"

    async def check(self) -> dict[str, Any]:
        if not self.model:
            self.available = False
            return {"ok": False, "reason": "OLLAMA_MODEL 미설정"}
        try:
            async with httpx.AsyncClient(timeout=2) as http:
                tags = (await http.get(f"{self.url}/api/tags")).json()
            names = {m["name"] for m in tags.get("models", [])}
            self.available = self.model in names or f"{self.model}:latest" in names
            return {"ok": self.available, "model": self.model,
                    **({} if self.available else {"reason": f"모델 없음 - `ollama pull {self.model}`"})}
        except Exception as e:
            self.available = False
            return {"ok": False, "reason": f"Ollama 미실행 ({type(e).__name__})"}

    async def warmup(self) -> None:
        """모델을 메모리에 올려 첫 요청 지연(수 초)을 없앤다."""
        if self.available:
            try:
                async with httpx.AsyncClient(timeout=60) as http:
                    await http.post(f"{self.url}/api/generate", json={"model": self.model, "prompt": "",
                                                                      "keep_alive": "30m"})
            except Exception as e:
                log.warning("ollama warmup failed: %s", e)

    async def generate_json(self, *, model: str, system_prompt: str, user_prompt: str, json_schema: dict[str, Any],
                            timeout_sec: float, temperature: float = 0.0, max_output_tokens: int = 512,
                            mock_key: str = "") -> LLMResponse:
        if self.mode == "off":
            raise LLMUnavailable("ollama unavailable")
        start = time.perf_counter()
        body = {"model": self.model, "stream": False, "format": json_schema, "keep_alive": "30m",
                "options": {"temperature": temperature, "num_predict": max_output_tokens},
                "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]}
        try:
            async with httpx.AsyncClient(timeout=timeout_sec) as http:
                r = await http.post(f"{self.url}/api/chat", json=body)
            r.raise_for_status()
            raw = r.json()["message"]["content"]
            return LLMResponse(json.loads(raw), raw, f"ollama:{self.model}", (time.perf_counter() - start) * 1000, {})
        except httpx.TimeoutException as e:
            raise LLMUnavailable(f"ollama timeout after {timeout_sec}s") from e
        except Exception as e:
            raise LLMUnavailable(f"ollama error: {type(e).__name__}: {e}") from e
