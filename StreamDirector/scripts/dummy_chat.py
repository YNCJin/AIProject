"""테스트용 더미 채팅 생성기 (명령 / 잡담 / 무관 / 욕설 / 광고 / 도배 혼합)."""

from __future__ import annotations

import random
import time

COMMANDS = [
    "보스 소환해줘", "보스 나와라", "보스 한번 보고싶다", "몹 더 보내줘", "좀비 소환 ㄱㄱ", "몬스터 많이 보내",
    "힐 해줘", "체력 회복 시켜줘", "살려주세요", "버프 줘", "공격력 강화 해줘", "쉴드 줘", "디버프 걸어",
    "아이템 드랍 해줘", "보급 상자 줘", "비 오게 해줘", "폭풍 불러", "적 빠르게", "몹 느리게 해줘",
    "너무 쉬워보이는데 좀 어렵게 해봐", "체력 너무 없는데 좀 채워주자",
]
GAME_TALK = ["와 컨트롤 미쳤다", "몇 웨이브임?", "오 잘한다", "이번판 클리어 가능?", "무기 뭐 쓰는거임", "보스 개쎄네 ㄷㄷ"]
OFF_TOPIC = ["밥 먹었어?", "오늘 날씨 좋다", "어제 축구 봤음?", "ㅋㅋㅋㅋㅋㅋ", "안녕하세요~", "?????", "퇴근하고싶다"]
ABUSE = ["시발 노잼", "ㅅㅂ 뭐하냐", "병신같이 하네", "개새끼야", "스트리머 존나 못하네", "씨1발 꺼져", "fuck this"]
SPAM = ["www.free-coin.com 무료 코인", "오픈카톡 들어오세요 부업 수익보장", "맞팔 구독 해주세요", "아아아아아아아아아아아아"]

MIX = [(COMMANDS, 0.45), (GAME_TALK, 0.15), (OFF_TOPIC, 0.2), (ABUSE, 0.1), (SPAM, 0.1)]


def generate(n: int, users: int = 50, seed: int | None = None) -> list[dict]:
    rng = random.Random(seed)
    pools, weights = zip(*MIX)
    now = time.time()
    out = []
    for _ in range(n):
        pool = rng.choices(pools, weights)[0]
        uid = rng.randrange(users)
        out.append({"user_id": f"viewer{uid}", "nickname": f"시청자{uid}", "text": rng.choice(pool),
                    "ts": now, "platform": "dummy"})
    return out


if __name__ == "__main__":
    import json

    for m in generate(10, seed=1):
        print(json.dumps(m, ensure_ascii=False))
