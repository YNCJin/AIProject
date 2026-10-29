import { Boss } from '../entities/Boss';
import { BossManager } from './BossManager';
import { EnemySpawner } from './EnemySpawner';

type Sprite = Phaser.Physics.Arcade.Sprite;

//  무기가 공격할 수 있는 대상(일반 몬스터 + 보스)을 하나로 묶어서 제공
//  무기는 일반 몬스터인지 보스인지 신경 쓰지 않고 이 클래스만 사용하면 된다
export class Targets
{
    constructor (private enemies: EnemySpawner, private bosses: BossManager)
    {
    }

    //  physics.add.overlap(무기탄, targets.colliders, ...) 에 사용
    get colliders (): Phaser.Physics.Arcade.Group[]
    {
        return [this.enemies.group, this.bosses.group];
    }

    damage (target: Sprite, amount: number)
    {
        if (target instanceof Boss)
        {
            this.bosses.damage(target, amount);
        }
        else
        {
            this.enemies.damage(target, amount);
        }
    }

    //  (x, y) 에서 range 안에 있는 대상을 가까운 순으로 최대 count 개
    findNearest (x: number, y: number, range: number, count: number): Sprite[]
    {
        const rangeSq = range * range;
        const inRange: { target: Sprite; distSq: number }[] = [];

        const consider = (target: Sprite) => {
            const distSq = Phaser.Math.Distance.Squared(x, y, target.x, target.y);
            if (distSq <= rangeSq)
            {
                inRange.push({ target, distSq });
            }
        };

        for (const enemy of this.enemies.activeEnemies())
        {
            consider(enemy);
        }
        this.bosses.activeBosses().forEach(consider);

        inRange.sort((a, b) => a.distSq - b.distSq);
        return inRange.slice(0, count).map((e) => e.target);
    }
}
