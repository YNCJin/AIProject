//  「마지막 등불」 밸런스 수치 - 난이도 조절은 여기서
//  무기 / 패시브 수치는 data/ 폴더, 색과 그림은 art/ 폴더에 있음

export const PLAYER = {
    baseSpeed: 200,
    baseMaxHp: 100,
    invulnMs: 500,          //  피격 후 무적 시간
};

//  등불 시야: 화면은 어둠으로 덮이고 등불 주변만 밝게 보인다
export const LIGHT = {
    baseRadius: 170,        //  기본 빛 반경 (등불의 온기 무기로 넓어짐)
    darkness: 0.8,          //  어둠의 짙기 (0 = 완전히 밝음, 1 = 완전히 깜깜)
    finalDarkness: 0.93,    //  최종 보스 등장 후 어둠
};

//  일반 몬스터: 그을린 짐승 (들개 / 늑대)
//  빛 밖에서는 눈만 보이고, 등불 범위에 들어오면 검은 연기 형체가 드러난다
export const BEASTS = {
    dog: { hp: 30, speed: 85, contactDamage: 10, xp: 1 },
    wolf: { hp: 45, speed: 100, contactDamage: 12, xp: 1 },
    wolfRatioStart: 0.15,   //  시작 시 늑대 비율
    wolfRatioPerMin: 0.06,  //  1분마다 늘어나는 늑대 비율
    wolfRatioMax: 0.6,
    maxCount: 300,
};

export const SPAWN = {
    startIntervalMs: 1000,  //  시작 시 적 생성 간격
    minIntervalMs: 150,     //  최소 생성 간격
    speedupPerSec: 8,       //  1초마다 생성 간격이 줄어드는 양(ms)
    recycleMargin: 300,     //  화면에서 이만큼 더 멀어진 짐승은 화면 가장자리로 다시 배치
};

//  중간 보스: 밀랍 순례자 - 느리지만 매우 단단하고, 머리 위 심지에서 느린 밀랍 탄환을 쏴서 맞으면 둔화
export const PILGRIM = {
    hp: 800,
    speed: 60,
    contactDamage: 15,
    xp: 20,
    fireIntervalMs: 2500,
    bulletCount: 3,
    bulletSpreadRad: 0.3,
    bulletSpeed: 130,
    bulletDamage: 10,
    slowFactor: 0.55,       //  둔화 시 이동 속도 배율
    slowMs: 2000,
    spawnIntervalMs: 150_000,   //  자동 등장 주기 (2분 30초)
    maxAlive: 3,
};

//  중간 보스 2: 재의 나방 여왕 (후원 전용)
//  재 가루로 빛 범위를 좁히고, 주기적으로 등불을 향해 일직선 돌진
//  후원 금액이 높을수록 체력과 피해량 증가
export const MOTH = {
    hp: 900,
    speed: 70,
    contactDamage: 20,
    ashIntervalMs: 8000,
    ashLightFactor: 0.55,   //  재 가루를 맞으면 빛 반경 배율
    ashMs: 4000,
    dashIntervalMs: 6000,
    dashTelegraphMs: 700,
    dashSpeed: 650,
    dashMs: 1000,
    dropEmbers: 30,         //  처치 시 불씨(경험치 1) 30개 = 일반 몬스터 30마리 분량
    maxAlive: 2,
    hpPerWon: 1 / 20_000,   //  후원 2만 원마다 체력 +100%
    hpMultMax: 4,
    damagePerWon: 1 / 40_000,   //  후원 4만 원마다 피해 +100%
    damageMultMax: 2.5,
};

//  최종 보스: 긴 밤 (일식) - 하늘에 떠서 전장 전체를 지배, 3페이즈
export const FINAL = {
    hp: 15000,
    spawnAtMs: 600_000,     //  등장 시간 (10분), 처치하면 새벽 엔딩
    skyOffsetY: 215,        //  플레이어(화면 중앙)보다 이만큼 위 하늘에 떠 있음
    skyScale: 0.8,
    phase2At: 0.66,         //  남은 체력 비율이 이 아래로 내려가면 2페이즈
    phase3At: 0.33,

    //  1페이즈 (2페이즈에도 반복)
    fanIntervalMs: 5000,    //  패턴1: 플레이어를 향한 부채꼴 장판
    fanTelegraphMs: 1300,
    fanSpreadRad: 0.5,
    fanDamage: 25,
    edgeShotIntervalMs: 1000,   //  패턴2: 화면 가장자리에서 밀랍 탄환 1~3발
    edgeShotSpeed: 170,
    edgeShotDamage: 8,
    edgeShotSlowMs: 800,
    meteorIntervalMs: 20_000,   //  패턴3: 플레이어 위치에 운석 5회
    meteorCount: 5,
    meteorGapMs: 200,
    meteorTelegraphMs: 900,
    meteorRadius: 65,
    meteorDamage: 20,

    //  2페이즈 추가: 중간 보스 2종의 패턴을 번갈아 시전
    bossPatternIntervalMs: 15_000,

    //  3페이즈: 옛 태양의 얼굴, 발악 패턴
    graspIntervalMs: 5000,  //  패턴1: 어둠의 손아귀
    graspTelegraphMs: 500,
    graspSpeed: 380,
    graspDamage: 30,
    novaIntervalMs: 10_000, //  패턴2: 맵 전체 공격, 맞으면 0.2초 멈춤
    novaTelegraphMs: 1500,
    novaDamage: 15,
    novaStunMs: 200,
};

export const XP = {
    magnetRadius: 120,      //  이 거리 안의 불씨는 플레이어에게 끌려옴
    collectRadius: 20,      //  이 거리 안에 들어오면 흡수
    pullSpeed: 450,
    maxGems: 400,
    despawnDistance: 2500,  //  이보다 멀리 남겨진 불씨는 정리
};

//  다음 레벨까지 필요한 경험치 (Lv.1 -> 2 는 10)
export function xpToNextLevel (level: number): number
{
    return 5 + level * 5;
}

//  레벨업 카드가 더 이상 없을 때(전부 최대 레벨) 나오는 회복 카드
export const FALLBACK_HEAL = 30;

//  화면 오른쪽 아래 보스 소환 테스트 버튼 표시 여부 (배포판 포함)
//  개발 모드에서만 보이게 하려면 import.meta.env.DEV 로 바꿀 것
export const SHOW_DEBUG_BUTTONS = true;

//  그리는 순서 (숫자가 클수록 위). 어둠(DARKNESS)보다 위에 있는 것은 어둠 속에서도 보인다
export const DEPTH = {
    ground: 0,
    lanternGlow: 2,
    beast: 8,
    player: 10,
    playerHpBar: 12,
    darkness: 20,
    beastEyes: 21,
    embers: 22,
    hazardArea: 23,
    boss: 24,
    projectile: 25,
    sky: 30,
    hud: 100,
    announce: 150,
    debug: 200,
    ending: 300,
};
