//  무기 3종: 매직 볼트 / 회전 오브 / 충격파
//  지금은 매직 볼트만 구현됨. 새 무기는 WeaponId 에 추가하고 WEAPONS 에 정보를 넣은 뒤
//  weapons/ 폴더에 클래스를 만들고 scenes/Game.ts 의 createWeapon() 에 연결하면 레벨업 카드에 자동으로 등장

export type WeaponId = 'magicBolt';     //  추가 예정: 'orbit' | 'shockwave'

export interface WeaponDef
{
    id: WeaponId;
    name: string;
    maxLevel: number;
    description: string;                        //  처음 얻을 때 카드 설명
    upgradeDescription: (nextLevel: number) => string;  //  레벨업 카드 설명
}

// ---------------------------------------------------------------- 매직 볼트

export interface MagicBoltLevel
{
    damage: number;
    cooldownMs: number;
    count: number;          //  한 번에 발사하는 개수
}

//  index 0 = Lv.1
export const MAGIC_BOLT_LEVELS: MagicBoltLevel[] = [
    { damage: 10, cooldownMs: 500, count: 1 },
    { damage: 10, cooldownMs: 500, count: 2 },
    { damage: 14, cooldownMs: 450, count: 2 },
    { damage: 14, cooldownMs: 400, count: 3 },
    { damage: 20, cooldownMs: 350, count: 3 },
];

export const MAGIC_BOLT = {
    range: 500,
    speed: 450,
    lifeMs: 1500,
};

// ---------------------------------------------------------------- 무기 목록

export const WEAPONS: Record<WeaponId, WeaponDef> = {
    magicBolt: {
        id: 'magicBolt',
        name: '매직 볼트',
        maxLevel: MAGIC_BOLT_LEVELS.length,
        description: '가장 가까운 적에게 마법탄 발사',
        upgradeDescription: (nextLevel) => describeLevelDiff(
            MAGIC_BOLT_LEVELS[nextLevel - 2], MAGIC_BOLT_LEVELS[nextLevel - 1]
        )
    },
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

//  이전 레벨과 다음 레벨 수치를 비교해서 "발사 수 +1" 같은 설명을 만든다
function describeLevelDiff (prev: MagicBoltLevel, next: MagicBoltLevel): string
{
    const lines: string[] = [];
    if (next.count > prev.count) lines.push(`발사 수 +${next.count - prev.count}`);
    if (next.damage > prev.damage) lines.push(`데미지 +${next.damage - prev.damage}`);
    if (next.cooldownMs < prev.cooldownMs) lines.push(`쿨다운 -${(prev.cooldownMs - next.cooldownMs) / 1000}초`);
    return lines.join('\n');
}
