# 채팅 의도 분류 - 로컬 모델 비교 (2026-10-08, Apple M1 Pro 32GB)

평가셋: `tests/data/moderation_eval.jsonl` 중 의도/잡담/무관 40건 (욕설·광고는 규칙 + kor_unsmile 이 담당하므로 제외).
지연은 **채팅 1건을 단독으로 판정**할 때의 평균. 학습 데이터는 모두 동일한 합성 데이터 3,100건 (평가셋 문장 제외).

## 결과

| 모델 | 방식 | 런타임 | 지연 평균 (p95) | 정확도 |
|---|---|---|---|---|
| **KcELECTRA-base** (현재 사용) | 분류 모델 파인튜닝 | PyTorch MPS | **9.8ms** · 40건 묶음 117ms | 97.5% |
| Qwen3 1.7B | LoRA 학습 후 | MLX 4bit | 136ms (158) | 100% |
| Kanana 1.5 2.1B | LoRA 학습 후 | MLX 4bit | 170ms (198) | 97.5% |
| EXAONE 3.5 2.4B | LoRA 학습 후 | MLX 4bit | 179ms (218) | 100% |
| Qwen3 1.7B | 프롬프트만 | Ollama Q4 | 303ms | 80.0% |
| Qwen3 1.7B | 프롬프트만 | MLX 4bit | 336ms | 65.0% |
| Kanana 1.5 2.1B | 프롬프트만 | Ollama Q4 (형식 강제 불가) | 396ms | 70.0% |
| Kanana 1.5 2.1B | 프롬프트만 | MLX 4bit | 457ms | 60.0% |
| EXAONE 3.5 2.4B | 프롬프트만 | MLX 4bit | 507ms | 70.0% |
| gemma2 9B | 프롬프트만 (축소 프롬프트) | Ollama Q4 | 1,590ms | 72.5% |
| gemma2 9B | 프롬프트만 (기존 긴 프롬프트, 6건 묶음) | Ollama Q4 | 4,814ms/묶음 | 라벨 개수 오류 11회 중 10회 |

LoRA 학습: 300회(약 1.5 에포크), lr 2e-5, rank 8, 상위 16층. 학습 시간 8~10분/모델.
검증 손실: Kanana 8.07→0.71, EXAONE 6.45→0.77, Qwen3 7.74→0.77.

## 해석

- **학습(LoRA)은 소형 LLM 을 빠르고 정확하게 만든다.** 긴 지시문이 필요 없어져 지연이 2.5~3배 줄고 정확도가 60~80% → 97.5~100%.
- 그래도 **KcELECTRA 가 13~18배 빠르고** 정확도는 사실상 같다 (40건 중 1건 차이 - 표본이 작아 유의미한 차이로 보기 어려움).
  KcELECTRA 가 유일하게 틀린 `기적!` 은 검열 에이전트의 안전장치(키워드·요청형 없는 명령 예측 보류)로 이미 걸러진다.
- 평가셋이 작고 학습 데이터와 문체가 비슷하므로 실제 방송 채팅에서는 모든 모델의 정확도가 낮아질 수 있다.
  실제 로그 500건 라벨링 후 재평가 필요.

## 라이선스 / 운영 메모

| 모델 | 라이선스 | 비고 |
|---|---|---|
| Qwen3 1.7B | Apache 2.0 | Ollama 공식 지원, 생각 모드(think)를 꺼야 빠름 |
| Kanana 1.5 2.1B | Apache 2.0 | Ollama 는 커뮤니티 GGUF, JSON 형식 강제 미지원. transformers 5.x 설정 검증 버그 우회 필요 (`streamdirector/training/transformers_compat.py`) |
| EXAONE 3.5 2.4B | **비상업 연구용** | 이 장비의 Ollama KV 캐시 설정(q8_0)과 head 차원(80) 불일치로 Ollama 실행 불가 → MLX 로만 측정 |

## 재현

```bash
.venv/bin/python scripts/bench_ollama_models.py gemma2:9b exaone3.5:2.4b qwen3:1.7b hf.co/DevQuasar/kakaocorp.kanana-1.5-2.1b-instruct-2505-GGUF:Q4_K_M
.venv/bin/python scripts/finetune_compare.py --iters 300
```
결과: `logs/bench_ollama.json`, `logs/bench_finetune.json`, 학습 로그 `logs/lora_<model>.log`, 어댑터 `models/lora/<model>/`
