import { FALLBACK_HEAL } from '../config';
import { PASSIVE_IDS, PASSIVES, PassiveId } from '../data/passives';
import { WEAPON_IDS, WEAPONS, WeaponId } from '../data/weapons';
import { Weapon } from '../weapons/Weapon';
import { PlayerStats } from './PlayerStats';

//  레벨업 카드 한 장
export type UpgradeChoice =
    | { kind: 'weapon'; id: WeaponId; name: string; levelText: string; description: string }
    | { kind: 'passive'; id: PassiveId; name: string; levelText: string; description: string }
    | { kind: 'heal'; name: string; levelText: string; description: string };

const CHOICE_COUNT = 3;

//  현재 보유 상태를 보고 고를 수 있는 카드 중 무작위 3장을 뽑는다
//  (최대 레벨인 항목은 제외, 고를 게 없으면 회복 카드)
export function rollUpgradeChoices (weapons: Weapon[], stats: PlayerStats): UpgradeChoice[]
{
    const pool: UpgradeChoice[] = [];

    for (const id of WEAPON_IDS)
    {
        const def = WEAPONS[id];
        const owned = weapons.find((w) => w.id === id);
        if (!owned)
        {
            pool.push({ kind: 'weapon', id, name: def.name, levelText: 'NEW', description: def.description });
        }
        else if (!owned.isMaxLevel)
        {
            const next = owned.level + 1;
            pool.push({
                kind: 'weapon', id, name: def.name,
                levelText: `Lv.${owned.level} → ${next}`,
                description: def.upgradeDescription(next)
            });
        }
    }

    for (const id of PASSIVE_IDS)
    {
        const def = PASSIVES[id];
        const level = stats.level(id);
        if (level < def.maxLevel)
        {
            pool.push({
                kind: 'passive', id, name: def.name,
                levelText: level === 0 ? 'NEW' : `Lv.${level} → ${level + 1}`,
                description: def.description
            });
        }
    }

    if (pool.length === 0)
    {
        return [{ kind: 'heal', name: '회복', levelText: '', description: `HP ${FALLBACK_HEAL} 회복` }];
    }

    return Phaser.Utils.Array.Shuffle(pool).slice(0, CHOICE_COUNT);
}
