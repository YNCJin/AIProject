import { sound } from '../audio/Sound';
import { ART_SCALE } from '../display';
import { DEPTH } from '../config';
import { EMBER_POOL, EMBER_POOL_LEVELS } from '../data/weapons';
import { Weapon } from './Weapon';

const POOL_TEXTURE_SIZE = 128 * ART_SCALE;
const MAX_TARGETS = 999;

interface Pool
{
    x: number;
    y: number;
    radius: number;
    damage: number;
    igniteAt: number;
    image: Phaser.GameObjects.Image;
}

//  불씨 웅덩이: 플레이어 주변 랜덤 위치에 작은 원형 장판을 만들고,
//  잠시 뒤 장판 안의 몬스터에게 피해를 준 다음 사라진다
export class EmberPool extends Weapon
{
    readonly id = 'emberPool';
    private nextCastAt = 0;
    private pools: Pool[] = [];

    update (time: number)
    {
        this.ignitePools(time);

        if (time < this.nextCastAt)
        {
            return;
        }

        const level = EMBER_POOL_LEVELS[this.level - 1];
        this.nextCastAt = time + level.cooldownMs * this.ctx.stats.cooldownMultiplier;

        for (let i = 0; i < level.count; i++)
        {
            this.cast(level.radius, level.damage * this.ctx.stats.damageMultiplier, time);
        }
        sound.play('poolCast');
    }

    private cast (radius: number, damage: number, time: number)
    {
        const { player, scene } = this.ctx;
        const angle = Math.random() * Math.PI * 2;
        const dist = Phaser.Math.FloatBetween(EMBER_POOL.minDistance, EMBER_POOL.maxDistance);
        const x = player.x + Math.cos(angle) * dist;
        const y = player.y + Math.sin(angle) * dist;

        const image = scene.add.image(x, y, 'emberPool')
            .setDepth(DEPTH.projectile)
            .setBlendMode(Phaser.BlendModes.ADD)
            .setScale(0)
            .setAlpha(0.95);
        scene.tweens.add({ targets: image, scale: (radius * 2) / POOL_TEXTURE_SIZE, duration: 150, ease: 'Back.easeOut' });

        this.pools.push({ x, y, radius, damage, igniteAt: time + EMBER_POOL.igniteMs, image });
    }

    private ignitePools (time: number)
    {
        const { targets, scene } = this.ctx;

        for (const pool of this.pools)
        {
            if (time < pool.igniteAt)
            {
                continue;
            }

            sound.play('poolIgnite');
            targets.findNearest(pool.x, pool.y, pool.radius, MAX_TARGETS)
                .forEach((target) => targets.damage(target, pool.damage));

            scene.tweens.add({
                targets: pool.image,
                alpha: 0,
                duration: EMBER_POOL.fadeMs,
                onComplete: () => pool.image.destroy()
            });
        }

        this.pools = this.pools.filter((pool) => time < pool.igniteAt);
    }
}
