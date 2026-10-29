import { PLAYER } from '../config';
import { PASSIVES, PassiveId } from '../data/passives';

//  패시브 레벨을 보관하고, 그 레벨이 반영된 최종 능력치를 계산한다
//  무기 / 플레이어는 여기 값을 읽어서 사용 (직접 계산하지 않음)
export class PlayerStats
{
    passiveLevels: Record<PassiveId, number> = { boots: 0, heart: 0, power: 0, clock: 0 };

    level (id: PassiveId): number
    {
        return this.passiveLevels[id];
    }

    levelUp (id: PassiveId)
    {
        this.passiveLevels[id] = Math.min(this.passiveLevels[id] + 1, PASSIVES[id].maxLevel);
    }

    get moveSpeed (): number
    {
        return PLAYER.baseSpeed * (1 + this.level('boots') * PASSIVES.boots.perLevel);
    }

    get maxHp (): number
    {
        return PLAYER.baseMaxHp + this.level('heart') * PASSIVES.heart.perLevel;
    }

    get damageMultiplier (): number
    {
        return 1 + this.level('power') * PASSIVES.power.perLevel;
    }

    get cooldownMultiplier (): number
    {
        return Math.max(0.2, 1 - this.level('clock') * PASSIVES.clock.perLevel);
    }
}
