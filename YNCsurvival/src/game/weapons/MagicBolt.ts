import { MAGIC_BOLT, MAGIC_BOLT_LEVELS } from '../data/weapons';
import { Weapon, WeaponContext } from './Weapon';

type Sprite = Phaser.Physics.Arcade.Sprite;

const SPREAD_RAD = 0.2;     //  적보다 발사 수가 많을 때 같은 적에게 쏘는 탄의 벌어짐 각도

//  가장 가까운 적들에게 마법탄을 발사
export class MagicBolt extends Weapon
{
    readonly id = 'magicBolt';
    private bullets: Phaser.Physics.Arcade.Group;
    private nextFireAt = 0;

    constructor (ctx: WeaponContext)
    {
        super(ctx);

        this.bullets = ctx.scene.physics.add.group({ maxSize: 150 });
        ctx.scene.physics.add.overlap(this.bullets, ctx.targets.colliders, (bullet, enemy) => {
            this.onHit(bullet as Sprite, enemy as Sprite);
        });
    }

    update (time: number)
    {
        this.expireBullets(time);

        if (time < this.nextFireAt)
        {
            return;
        }

        const stats = MAGIC_BOLT_LEVELS[this.level - 1];
        const { player } = this.ctx;
        const targets = this.ctx.targets.findNearest(player.x, player.y, MAGIC_BOLT.range, stats.count);
        if (targets.length === 0)
        {
            return;
        }

        this.nextFireAt = time + stats.cooldownMs * this.ctx.stats.cooldownMultiplier;

        const damage = stats.damage * this.ctx.stats.damageMultiplier;
        for (let i = 0; i < stats.count; i++)
        {
            const target = targets[i % targets.length];
            //  적이 발사 수보다 적으면 같은 적에게 좌우로 벌려서 발사
            const round = Math.floor(i / targets.length);
            const offset = round === 0 ? 0 : Math.ceil(round / 2) * SPREAD_RAD * (round % 2 ? 1 : -1);
            const angle = Phaser.Math.Angle.Between(player.x, player.y, target.x, target.y) + offset;
            this.fire(angle, damage, time);
        }
    }

    private fire (angle: number, damage: number, time: number)
    {
        const { player } = this.ctx;
        const bullet = this.bullets.get(player.x, player.y, 'bullet') as Sprite | null;
        if (!bullet)
        {
            return;
        }

        bullet.enableBody(true, player.x, player.y, true, true);
        bullet.setData('expireAt', time + MAGIC_BOLT.lifeMs);
        bullet.setData('damage', damage);
        this.ctx.scene.physics.velocityFromRotation(angle, MAGIC_BOLT.speed, bullet.body!.velocity);
    }

    private onHit (bullet: Sprite, enemy: Sprite)
    {
        if (!bullet.active || !enemy.active)
        {
            return;
        }

        bullet.disableBody(true, true);
        this.ctx.targets.damage(enemy, bullet.getData('damage') as number);
    }

    private expireBullets (time: number)
    {
        for (const obj of this.bullets.getChildren())
        {
            const bullet = obj as Sprite;
            if (bullet.active && time >= (bullet.getData('expireAt') as number))
            {
                bullet.disableBody(true, true);
            }
        }
    }
}
