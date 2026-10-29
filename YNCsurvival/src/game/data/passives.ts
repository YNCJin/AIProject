//  패시브 강화 4종 (각 최대 5레벨)
//  효과 계산은 systems/PlayerStats.ts 에서 perLevel 값을 사용

export type PassiveId = 'boots' | 'heart' | 'power' | 'clock';

export interface PassiveDef
{
    id: PassiveId;
    name: string;
    maxLevel: number;
    perLevel: number;
    description: string;    //  레벨업 카드에 표시되는 1레벨당 효과
}

export const PASSIVES: Record<PassiveId, PassiveDef> = {
    boots: {
        id: 'boots', name: '신발', maxLevel: 5, perLevel: 0.08,
        description: '이동 속도 +8%'
    },
    heart: {
        id: 'heart', name: '심장', maxLevel: 5, perLevel: 20,
        description: '최대 HP +20\n선택 즉시 HP 20 회복'
    },
    power: {
        id: 'power', name: '힘', maxLevel: 5, perLevel: 0.10,
        description: '모든 무기 데미지 +10%'
    },
    clock: {
        id: 'clock', name: '시계', maxLevel: 5, perLevel: 0.08,
        description: '모든 무기 쿨다운 -8%'
    },
};

export const PASSIVE_IDS = Object.keys(PASSIVES) as PassiveId[];
