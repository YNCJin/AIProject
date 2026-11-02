import { LANTERN_AURA, LANTERN_AURA_LEVELS } from '../data/weapons';
import { Weapon, WeaponContext } from './Weapon';

const MAX_TARGETS = 999;

//  등불의 온기: 등불 빛이 닿는 몬스터에게 1초마다 작은 피해
//  레벨이 오를수록 빛 자체가 넓어져서 시야도 함께 넓어진다 ("등불을 지키던 사람이 등불이 되어간다")
export class LanternAura extends Weapon
{
    readonly id = 'lanternAura';
    private nextTickAt = 0;

    constructor (ctx: WeaponContext)
    {
        super(ctx);
        this.applyRadius();
    }

    levelUp ()
    {
        super.levelUp();
        this.applyRadius();
    }

    private applyRadius ()
    {
        this.ctx.lighting.bonusRadius = LANTERN_AURA_LEVELS[this.level - 1].radiusBonus;
    }

    update (time: number)
    {
        if (time < this.nextTickAt)
        {
            return;
        }
        this.nextTickAt = time + LANTERN_AURA.tickMs * this.ctx.stats.cooldownMultiplier;

        const { player, lighting, targets, stats } = this.ctx;
        const damage = LANTERN_AURA_LEVELS[this.level - 1].damage * stats.damageMultiplier;
        const hit = targets.findNearest(player.x, player.y, lighting.radius * LANTERN_AURA.hitRadiusRatio, MAX_TARGETS);

        hit.forEach((target) => targets.damage(target, damage));
        if (hit.length > 0)
        {
            lighting.pulse();
        }
    }
}
