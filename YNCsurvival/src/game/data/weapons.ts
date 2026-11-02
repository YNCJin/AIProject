//  무기 3종 (각 최대 5레벨)
//  1. 등불의 온기: 등불 빛이 닿는 몬스터에게 1초마다 작은 피해, 레벨업 시 빛 범위도 넓어짐
//  2. 불씨 탄: 손에 든 등불에서 가장 가까운 적에게 작은 불덩이 발사 (시작 무기)
//  3. 불씨 웅덩이: 주변 랜덤 위치에 작은 원형 장판을 만들어 안의 몬스터에게 피해를 주고 사라짐
//  새 무기는 WeaponId 에 추가하고 WEAPONS 에 정보를 넣은 뒤 weapons/ 폴더에 클래스를 만들고
//  scenes/Game.ts 의 createWeapon() 에 연결하면 레벨업 카드에 자동으로 등장

export type WeaponId = 'lanternAura' | 'emberShot' | 'emberPool';

export interface WeaponDef
{
    id: WeaponId;
    name: string;
    maxLevel: number;
    description: string;                                //  처음 얻을 때 카드 설명
    upgradeDescription: (nextLevel: number) => string;  //  레벨업 카드 설명
}

// ---------------------------------------------------------------- 1. 등불의 온기

export interface LanternAuraLevel
{
    damage: number;         //  1초마다 빛 안의 몬스터에게 주는 피해
    radiusBonus: number;    //  빛 반경 증가량
}

export const LANTERN_AURA = {
    tickMs: 1000,
    hitRadiusRatio: 0.85,   //  빛 반경의 이 비율 안에 있는 몬스터가 피해를 입음
};

export const LANTERN_AURA_LEVELS: LanternAuraLevel[] = [
    { damage: 5, radiusBonus: 0 },
    { damage: 7, radiusBonus: 15 },
    { damage: 9, radiusBonus: 30 },
    { damage: 12, radiusBonus: 45 },
    { damage: 16, radiusBonus: 60 },
];

// ---------------------------------------------------------------- 2. 불씨 탄

export interface EmberShotLevel
{
    damage: number;
    cooldownMs: number;
    count: number;          //  한 번에 발사하는 개수
}

export const EMBER_SHOT = {
    range: 500,
    speed: 450,
    lifeMs: 1500,
};

export const EMBER_SHOT_LEVELS: EmberShotLevel[] = [
    { damage: 10, cooldownMs: 500, count: 1 },
    { damage: 10, cooldownMs: 500, count: 2 },
    { damage: 14, cooldownMs: 450, count: 2 },
    { damage: 14, cooldownMs: 400, count: 3 },
    { damage: 20, cooldownMs: 350, count: 3 },
];

// ---------------------------------------------------------------- 3. 불씨 웅덩이

export interface EmberPoolLevel
{
    count: number;          //  한 번에 만드는 장판 수
    damage: number;
    radius: number;
    cooldownMs: number;
}

export const EMBER_POOL = {
    minDistance: 60,        //  플레이어로부터 이 거리 ~ maxDistance 사이 랜덤 위치
    maxDistance: 220,
    igniteMs: 250,          //  장판이 생기고 피해를 주기까지
    fadeMs: 450,
};

export const EMBER_POOL_LEVELS: EmberPoolLevel[] = [
    { count: 1, damage: 20, radius: 55, cooldownMs: 2600 },
    { count: 2, damage: 22, radius: 55, cooldownMs: 2400 },
    { count: 2, damage: 28, radius: 62, cooldownMs: 2200 },
    { count: 3, damage: 32, radius: 66, cooldownMs: 2000 },
    { count: 4, damage: 40, radius: 75, cooldownMs: 1700 },
];

// ---------------------------------------------------------------- 무기 목록

export const WEAPONS: Record<WeaponId, WeaponDef> = {
    lanternAura: {
        id: 'lanternAura',
        name: '등불의 온기',
        maxLevel: LANTERN_AURA_LEVELS.length,
        description: '등불 빛이 닿는 적에게\n1초마다 피해',
        upgradeDescription: (next) => describeDiff(LANTERN_AURA_LEVELS[next - 2], LANTERN_AURA_LEVELS[next - 1], {
            damage: ['데미지', ''], radiusBonus: ['빛 범위', ''],
        })
    },
    emberShot: {
        id: 'emberShot',
        name: '불씨 탄',
        maxLevel: EMBER_SHOT_LEVELS.length,
        description: '가장 가까운 적에게\n작은 불덩이 발사',
        upgradeDescription: (next) => describeDiff(EMBER_SHOT_LEVELS[next - 2], EMBER_SHOT_LEVELS[next - 1], {
            count: ['발사 수', ''], damage: ['데미지', ''], cooldownMs: ['쿨다운', 's'],
        })
    },
    emberPool: {
        id: 'emberPool',
        name: '불씨 웅덩이',
        maxLevel: EMBER_POOL_LEVELS.length,
        description: '주변에 불씨 장판을 만들어\n안의 적에게 피해',
        upgradeDescription: (next) => describeDiff(EMBER_POOL_LEVELS[next - 2], EMBER_POOL_LEVELS[next - 1], {
            count: ['장판 수', ''], damage: ['데미지', ''], radius: ['범위', ''], cooldownMs: ['쿨다운', 's'],
        })
    },
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

//  이전 레벨과 다음 레벨 수치를 비교해서 "발사 수 +1", "쿨다운 -0.05초" 같은 설명을 만든다
//  labels: { 필드: [표시 이름, 's' 면 ms 를 초로 표시] }
function describeDiff<T extends object> (prev: T, next: T, labels: Partial<Record<keyof T, [string, string]>>): string
{
    const lines: string[] = [];
    for (const key of Object.keys(labels) as (keyof T)[])
    {
        const [label, unit] = labels[key]!;
        const diff = (next[key] as number) - (prev[key] as number);
        if (diff === 0)
        {
            continue;
        }
        const sign = diff > 0 ? '+' : '-';
        const value = unit === 's' ? `${Math.abs(diff) / 1000}초` : `${Math.abs(diff)}`;
        lines.push(`${label} ${sign}${value}`);
    }
    return lines.join('\n');
}
