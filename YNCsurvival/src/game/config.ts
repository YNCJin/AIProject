//  게임 전체 밸런스 수치 - 난이도 조절은 여기서
//  무기 / 패시브 수치는 data/ 폴더에 있음

export const WORLD_SIZE = 4000;

export const PLAYER = {
    baseSpeed: 200,
    baseMaxHp: 100,
    invulnMs: 500,          //  피격 후 무적 시간
};

export const ENEMY = {
    speed: 80,
    hp: 30,
    contactDamage: 10,
    xp: 1,                  //  처치 시 떨어뜨리는 경험치
    maxCount: 300,
};

//  중간 보스: 일반 몬스터보다 단단하고, 주기적으로 플레이어를 향해 탄환을 부채꼴로 발사
export const MID_BOSS = {
    hp: 500,
    speed: 55,
    size: 48,
    contactDamage: 15,
    xp: 20,
    fireIntervalMs: 2200,   //  탄환 발사 주기
    bulletCount: 3,         //  한 번에 발사하는 탄 수 (부채꼴)
    bulletSpreadRad: 0.25,  //  탄 사이 각도
    bulletSpeed: 220,
    bulletDamage: 10,
    bulletLifeMs: 4000,
    spawnIntervalMs: 150_000,   //  자동 등장 주기 (2분 30초)
    maxAlive: 3,            //  동시에 존재할 수 있는 최대 수
};

//  최종 보스: 체력이 매우 높고, 느린 주기로 원형 / 직사각형 범위 공격 (예고 표시 후 발동)
export const FINAL_BOSS = {
    hp: 8000,
    speed: 35,
    contactDamage: 25,
    spawnAtMs: 600_000,     //  등장 시간 (10분), 처치하면 클리어
    attackIntervalMs: 3500, //  공격 사이 대기 시간
    telegraphMs: 1500,      //  범위 예고 시간 (이 시간 안에 피해야 함)
    circleRadius: 150,      //  원형: 플레이어 위치 중심
    circleDamage: 30,
    rectLength: 1000,       //  직사각형: 보스에서 플레이어 방향으로 뻗는 띠
    rectWidth: 140,
    rectDamage: 30,
};

//  화면 오른쪽 아래 보스 소환 테스트 버튼 표시 여부 (배포판 포함)
//  개발 모드에서만 보이게 하려면 import.meta.env.DEV 로 바꿀 것
export const SHOW_DEBUG_BUTTONS = true;

export const SPAWN = {
    startIntervalMs: 1000,  //  시작 시 적 생성 간격
    minIntervalMs: 150,     //  최소 생성 간격
    speedupPerSec: 8,       //  1초마다 생성 간격이 줄어드는 양(ms)
};

export const XP = {
    magnetRadius: 120,      //  이 거리 안의 보석은 플레이어에게 끌려옴
    collectRadius: 20,      //  이 거리 안에 들어오면 흡수
    pullSpeed: 450,
    maxGems: 400,
};

//  다음 레벨까지 필요한 경험치 (Lv.1 -> 2 는 10)
export function xpToNextLevel (level: number): number
{
    return 5 + level * 5;
}

//  레벨업 카드가 더 이상 없을 때(전부 최대 레벨) 나오는 회복 카드
export const FALLBACK_HEAL = 30;
