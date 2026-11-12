"""검열 에이전트의 규칙 기반 1차 필터 (LLM 호출 없이 수 ms 안에 처리).

정규화 -> 욕설/혐오 -> 광고/링크 -> 무의미 반응 -> 명령 의도 키워드 순으로 판정한다.
"""

from __future__ import annotations

import re
import unicodedata

from ..schemas import Intent

# 제로폭 문자 등 필터 우회용 문자
_INVISIBLE = re.compile(r"[​-‏⁠-⁯﻿­]")
_REPEAT = re.compile(r"(.)\1{3,}")
_SPACES = re.compile(r"\s+")
# 욕설 우회 표기 탐지용: 한글 자모/음절과 영문만 남김 ("시1발", "씨.발", "ㅅ ㅂ" 대응)
_SQUASH = re.compile(r"[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]")
_SQUASH_DIGITS = re.compile(r"[0-9]")


def _nfkc_keep_jamo(text: str) -> str:
    # NFKC 는 호환 자모(ㅋ, ㅅ U+3131~318E)를 첫가끝 자모(U+1100~)로 바꿔 ㅅㅂ 같은 패턴을 깨뜨리므로 제외
    return "".join(ch if "\u3131" <= ch <= "\u318e" else unicodedata.normalize("NFKC", ch) for ch in text)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", _nfkc_keep_jamo(text))
    text = _INVISIBLE.sub("", text)
    text = _REPEAT.sub(r"\1\1", text)  # ㅋㅋㅋㅋㅋ -> ㅋㅋ, !!!!!! -> !!
    return _SPACES.sub(" ", text).strip()


def squash(text: str) -> str:
    return _SQUASH_DIGITS.sub("", _SQUASH.sub("", text)).lower()


# ---------------------------------------------------------------------------
# 욕설 / 혐오 / 성적 표현 (squash 된 문자열에 적용)
# ---------------------------------------------------------------------------
_PROFANITY = re.compile(
    "|".join(
        [
            r"[시씨쉬싀][발빨벌뻘바팔펄]",
            r"ㅅㅂ|ㅆㅂ|ㅆㅃ|ㅅㅃ|ㅂㅅ|ㅄ|ㅈㄹ|ㄱㅅㄲ|ㅁㅊㄴ|ㅈ같|ㅈㄴ",
            r"씹|좆|존나|존내|졸라|쥰나",
            r"[병븅빙][신쉰딱]",
            r"개[새세쉐색][끼기키]|[새쌔섀][끼기]",
            r"미친[놈년새]|미친것|또라이|돌아이",
            r"지랄|염병|엠창|느금|니[애에]미|니미|[애에]미[없뒤]|[애에]비[없뒤]|패드립",
            r"닥쳐|꺼져|뒤져|뒈져|죽어라|자살",
            r"등신|찐따|애자|장애인새|한남충|한녀|김치녀|틀딱|급식충|맘충|[가-힣]{1,3}충들",
            r"섹스|섹드립|야스|보지|자지|딸딸이|강간",
            r"fuck|shit|bitch|asshole|cunt|nigg|retard|motherf|dick",
        ]
    )
)
# 오탐 방지 (예: 시발점, 시발역)
_PROFANITY_WHITELIST = re.compile(r"시발점|시발역|시발택시|발바닥|새끼손가락|새끼발가락")

# ---------------------------------------------------------------------------
# 광고 / 링크 / 홍보
# ---------------------------------------------------------------------------
_SPAM = re.compile(
    r"(https?://|www\.|\.(com|net|kr|gg|io|me|ly|xyz)\b|discord\.gg|bit\.ly|open\.kakao|오픈\s?카톡|오픈채팅"
    r"|텔레그램|텔레\s?@|카톡\s?id|선팔|맞팔|팔로우\s?해|구독\s?해\s?주|홍보|광고|부업|수익\s?보장|010[-\s]?\d{3,4})",
    re.IGNORECASE,
)

# 자모/이모지/문장부호만으로 된 반응 (ㅋㅋ, ㄷㄷ, ?? 등)
_REACTION_ONLY = re.compile(r"^[\sㄱ-ㅎㅏ-ㅣ!?.~^;:,\-_()\[\]<>♡♥☆★\U0001F000-\U0001FFFF]*$")

# 부정 표현 -> 의도가 뒤집힐 수 있으므로 LLM 판단으로 넘김
_NEGATION = re.compile(r"하지\s?마|하지\s?말|ㄴㄴ|안\s?돼|안\s?됨|말아|금지|싫어|그만|멈춰|빼\s?줘")

# ---------------------------------------------------------------------------
# 명령 의도: strong = 행동 동사까지 있는 확실한 요청 / loose = 키워드만 있는 후보
# ---------------------------------------------------------------------------
_ACT = r"(소환|불러|부르|등장|내보내|보내|나와|나오|줘|주세요|가자|ㄱㄱ|ㄱ$|해라|해줘|하자|시켜|plz|please)"

_STRONG: list[tuple[Intent, re.Pattern[str]]] = [
    (Intent.SPAWN_BOSS, re.compile(rf"(보스|boss|네임드).{{0,8}}{_ACT}", re.I)),
    (Intent.SPAWN_ENEMIES, re.compile(rf"(몬스터|몹|(?<![가-힣])적|좀비|해골|슬라임|웨이브|enemy|enemies|mob).{{0,8}}{_ACT}", re.I)),
    (Intent.SPAWN_ENEMIES, re.compile(r"(몹|몬스터|(?<![가-힣])적).{0,4}(더|많이|추가|두배|폭탄)", re.I)),
    (Intent.HEAL_PLAYER, re.compile(rf"(힐|회복|체력|피\s?채|포션|heal).{{0,8}}{_ACT}|살려\s?(줘|주세요)", re.I)),
    (Intent.BUFF_PLAYER, re.compile(rf"((?<!디)버프|강화|파워\s?업|무적|공격력|공속|쉴드|보호막|buff).{{0,8}}{_ACT}", re.I)),
    (Intent.DEBUFF_PLAYER, re.compile(rf"(디버프|약화|너프|저주|debuff|curse).{{0,8}}{_ACT}", re.I)),
    (Intent.DROP_ITEM, re.compile(rf"(아이템|상자|보급|드랍|드롭|무기|선물|item|loot).{{0,8}}{_ACT}", re.I)),
    (Intent.CHANGE_WEATHER, re.compile(rf"((?<![가-힣])(비|눈|밤)|폭풍|안개|번개|날씨).{{0,8}}{_ACT}", re.I)),
    (Intent.CHANGE_WEATHER, re.compile(r"(비|눈)\s?(와라|내려라|오게\s?해|내리게)|밤으로\s?바꿔", re.I)),
    (Intent.SPEED_UP_ENEMIES, re.compile(r"((?<![가-힣])적|몹|몬스터).{0,6}(빠르게|가속|속도\s?업|빨리)", re.I)),
    (Intent.SLOW_DOWN_ENEMIES, re.compile(r"((?<![가-힣])적|몹|몬스터).{0,6}(느리게|감속|슬로우|천천히)|슬로우\s?모션", re.I)),
]

_LOOSE: list[tuple[Intent, re.Pattern[str]]] = [
    (Intent.SPAWN_BOSS, re.compile(r"보스|boss|네임드", re.I)),
    (Intent.SPAWN_ENEMIES, re.compile(r"몬스터|몹|좀비|해골|슬라임|웨이브|소환|enemy|mob", re.I)),
    (Intent.HEAL_PLAYER, re.compile(r"힐|회복|체력|포션|heal|살려", re.I)),
    (Intent.BUFF_PLAYER, re.compile(r"(?<!디)버프|강화|파워|무적|공격력|쉴드|보호막|buff", re.I)),
    (Intent.DEBUFF_PLAYER, re.compile(r"디버프|약화|너프|저주|고난|하드\s?모드|debuff", re.I)),
    (Intent.DROP_ITEM, re.compile(r"아이템|상자|보급|드랍|드롭|무기|선물|item", re.I)),
    (Intent.CHANGE_WEATHER, re.compile(r"날씨|폭풍|안개|번개|비가|눈이", re.I)),
    (Intent.SPEED_UP_ENEMIES, re.compile(r"빠르게|가속|속도", re.I)),
    (Intent.SLOW_DOWN_ENEMIES, re.compile(r"느리게|감속|슬로우", re.I)),
]


def is_profane(text: str) -> bool:
    lowered = _PROFANITY_WHITELIST.sub("", text.lower())
    return bool(_PROFANITY.search(squash(lowered))) or bool(_PROFANITY.search(lowered))


def is_spam(text: str) -> bool:
    return bool(_SPAM.search(text))


def is_reaction_only(text: str) -> bool:
    return bool(_REACTION_ONLY.match(text))


def is_low_entropy(text: str) -> bool:
    """'아아아아아아아아' 같은 의미 없는 반복 / 긴 복붙 문자열."""
    compact = text.replace(" ", "")
    return len(compact) >= 10 and len(set(compact)) / len(compact) < 0.2


def has_negation(text: str) -> bool:
    return bool(_NEGATION.search(text))


def strong_intents(text: str) -> set[Intent]:
    return resolve({intent for intent, p in _STRONG if p.search(text)})


def loose_intents(text: str) -> set[Intent]:
    return resolve({intent for intent, p in _LOOSE if p.search(text)})


# 요청 형태 (폴백 모드에서 키워드만 있는 채팅을 명령으로 인정할지 판단)
_REQUEST_SHAPE = re.compile(r"(줘|주세요|해라|해봐|하자|가자|ㄱㄱ|ㄱ$|시켜|불러|보내|나와|와라|내려|보고\s?싶|원해|plz|please)", re.I)
# 더 구체적인 의도가 있으면 일반 의도(몹 소환)를 버린다: "몹 느리게 해줘", "보스 몬스터 소환"
_SPECIFIC_OVER_GENERIC = {Intent.SPAWN_BOSS, Intent.SPEED_UP_ENEMIES, Intent.SLOW_DOWN_ENEMIES}


def is_request_shaped(text: str) -> bool:
    return bool(_REQUEST_SHAPE.search(text)) and not text.rstrip().endswith("?")


def resolve(intents: set[Intent]) -> set[Intent]:
    if Intent.SPAWN_ENEMIES in intents and intents & _SPECIFIC_OVER_GENERIC:
        intents = intents - {Intent.SPAWN_ENEMIES}
    return intents
