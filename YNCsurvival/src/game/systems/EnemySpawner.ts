import { ENEMY, SPAWN } from '../config';
import { Player } from '../entities/Player';
import { pointAroundPlayer } from '../utils/spawn';

type Sprite = Phaser.Physics.Arcade.Sprite;

export type EnemyKilledHandler = (x: number, y: number, xp: number) => void;

//  일반 몬스터 생성 / 추적 / 피해 처리 (보스는 systems/BossManager.ts)
export class EnemySpawner
{
    readonly group: Phaser.Physics.Arcade.Group;
    private spawnAccMs = 0;

    constructor (
        private scene: Phaser.Scene,
        private player: Player,
        private onKilled: EnemyKilledHandler
    )
    {
        //  오브젝트 풀로 재사용 (매번 생성·삭제하지 않음)
        this.group = scene.physics.add.group({ maxSize: ENEMY.maxCount });
        //  적끼리 서로 밀어내서 한 점에 겹치지 않게
        scene.physics.add.collider(this.group, this.group);
    }

    update (delta: number, elapsedMs: number)
    {
        this.updateSpawn(delta, elapsedMs);

        for (const enemy of this.activeEnemies())
        {
            this.scene.physics.moveToObject(enemy, this.player, ENEMY.speed);
        }
    }

    private updateSpawn (delta: number, elapsedMs: number)
    {
        const interval = Math.max(
            SPAWN.minIntervalMs,
            SPAWN.startIntervalMs - (elapsedMs / 1000) * SPAWN.speedupPerSec
        );

        this.spawnAccMs += delta;
        while (this.spawnAccMs >= interval)
        {
            this.spawnAccMs -= interval;
            this.spawnAroundPlayer();
        }
    }

    //  화면 바로 바깥의 원 위에서 랜덤 위치에 생성
    spawnAroundPlayer ()
    {
        const { x, y } = pointAroundPlayer(this.scene, this.player);

        const enemy = this.group.get(x, y, 'enemy') as Sprite | null;
        if (!enemy)
        {
            return;     //  풀이 가득 참 (최대 마릿수 도달)
        }

        enemy.enableBody(true, x, y, true, true);
        enemy.clearTint();
        enemy.setData('hp', ENEMY.hp);
    }

    //  무기가 적에게 피해를 줄 때 호출
    damage (enemy: Sprite, amount: number)
    {
        if (!enemy.active)
        {
            return;
        }

        const hp = (enemy.getData('hp') as number) - amount;
        enemy.setData('hp', hp);

        if (hp <= 0)
        {
            enemy.disableBody(true, true);
            this.onKilled(enemy.x, enemy.y, ENEMY.xp);
            return;
        }

        //  피격 시 잠깐 하얗게 번쩍
        enemy.setTintFill(0xffffff);
        this.scene.time.delayedCall(60, () => enemy.clearTint());
    }

    *activeEnemies (): Generator<Sprite>
    {
        for (const obj of this.group.getChildren())
        {
            if (obj.active)
            {
                yield obj as Sprite;
            }
        }
    }
}
