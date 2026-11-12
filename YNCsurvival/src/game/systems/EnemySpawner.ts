import { artScale, SCREEN } from '../display';
import { BEAST_EYE_OFFSET } from '../art/Textures';
import { BEASTS, beastHp, DEPTH, EARLY_GAME, SPAWN, spawnIntervalMs } from '../config';
import { Player } from '../entities/Player';
import { pointAroundPlayer } from '../utils/spawn';

type Sprite = Phaser.Physics.Arcade.Sprite;
type Image = Phaser.GameObjects.Image;

export type BeastKind = 'dog' | 'wolf';
export type EnemyKilledHandler = (x: number, y: number, xp: number) => void;

//  일반 몬스터: 그을린 짐승 (들개 / 늑대) 생성 / 추적 / 피해 처리 (보스는 systems/BossManager.ts)
//  - 몸은 어둠 막 아래에 그려져서 등불 범위 안에서만 드러나고, 눈은 어둠 위에 그려져 멀리서도 보인다
//  - 맵이 끝없이 이어지므로 너무 멀어진 짐승은 없애지 않고 화면 가장자리로 다시 데려온다
export class EnemySpawner
{
    readonly group: Phaser.Physics.Arcade.Group;
    private eyes: Phaser.GameObjects.Group;
    private spawnAccMs = 0;
    spawning = true;

    constructor (
        private scene: Phaser.Scene,
        private player: Player,
        private onKilled: EnemyKilledHandler
    )
    {
        //  오브젝트 풀로 재사용 (매번 생성·삭제하지 않음)
        this.group = scene.physics.add.group({ maxSize: BEASTS.maxCount });
        this.eyes = scene.add.group({ maxSize: BEASTS.maxCount });
        //  짐승끼리 서로 밀어내서 한 점에 겹치지 않게
        scene.physics.add.collider(this.group, this.group);
    }

    update (delta: number, elapsedMs: number)
    {
        if (this.spawning)
        {
            this.updateSpawn(delta, elapsedMs);
        }

        const { width, height } = SCREEN;
        const recycleDist = Math.hypot(width, height) / 2 + SPAWN.recycleMargin;
        const recycleSq = recycleDist * recycleDist;
        const speedMult = elapsedMs < EARLY_GAME.untilMs ? EARLY_GAME.beastSpeedMult : 1;

        for (const enemy of this.activeEnemies())
        {
            const kind = enemy.getData('kind') as BeastKind;
            this.scene.physics.moveToObject(enemy, this.player, BEASTS[kind].speed * speedMult);
            enemy.setFlipX(enemy.body!.velocity.x < 0);

            if (Phaser.Math.Distance.Squared(enemy.x, enemy.y, this.player.x, this.player.y) > recycleSq)
            {
                const p = pointAroundPlayer(this.scene, this.player);
                enemy.body!.reset(p.x, p.y);
            }
        }
    }

    //  물리 이동이 반영된 뒤(POST_UPDATE)에 호출: 눈을 몸 위치에 맞춤 (앞에서 하면 한 프레임 늦어 떨림)
    render ()
    {
        for (const enemy of this.activeEnemies())
        {
            const offset = BEAST_EYE_OFFSET[enemy.getData('kind') as BeastKind];
            (enemy.getData('eye') as Image).setPosition(enemy.x + (enemy.flipX ? -offset.x : offset.x), enemy.y + offset.y);
        }
    }

    private updateSpawn (delta: number, elapsedMs: number)
    {
        const interval = spawnIntervalMs(elapsedMs);

        this.spawnAccMs += delta;
        while (this.spawnAccMs >= interval)
        {
            this.spawnAccMs -= interval;
            this.spawnAroundPlayer(elapsedMs);
        }
    }

    //  화면 바로 바깥의 원 위에서 랜덤 위치에 생성. 시간이 지날수록 늑대 비율이 늘어난다
    spawnAroundPlayer (elapsedMs = 0)
    {
        const wolfRatio = Math.min(
            BEASTS.wolfRatioMax,
            BEASTS.wolfRatioStart + (elapsedMs / 60_000) * BEASTS.wolfRatioPerMin
        );
        const kind: BeastKind = Math.random() < wolfRatio ? 'wolf' : 'dog';
        const { x, y } = pointAroundPlayer(this.scene, this.player);

        const enemy = this.group.get(x, y, kind) as Sprite | null;
        if (!enemy)
        {
            return;     //  풀이 가득 참 (최대 마릿수 도달)
        }

        enemy.setTexture(kind);
        enemy.enableBody(true, x, y, true, true);
        enemy.body!.setSize(enemy.width * 0.8, enemy.height * 0.8);
        enemy.setDepth(DEPTH.beast).setScale(artScale());
        enemy.clearTint();
        enemy.setData('kind', kind);
        enemy.setData('hp', beastHp(kind, elapsedMs));

        let eye = enemy.getData('eye') as Image | undefined;
        if (!eye)
        {
            eye = this.scene.add.image(x, y, 'beastEyes').setDepth(DEPTH.beastEyes).setScale(artScale());
            this.eyes.add(eye);
            enemy.setData('eye', eye);
        }
        eye.setVisible(true).setActive(true);
    }

    contactDamage (enemy: Sprite): number
    {
        return BEASTS[enemy.getData('kind') as BeastKind].contactDamage;
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
            this.remove(enemy);
            this.onKilled(enemy.x, enemy.y, BEASTS[enemy.getData('kind') as BeastKind].xp);
            return;
        }

        //  피격 시 잠깐 주황빛으로 번쩍
        enemy.setTintFill(0xffb070);
        this.scene.time.delayedCall(60, () => enemy.clearTint());
    }

    //  최종 보스 등장 시: 모든 짐승이 사라짐
    clearAll ()
    {
        for (const enemy of [...this.activeEnemies()])
        {
            this.remove(enemy);
        }
    }

    private remove (enemy: Sprite)
    {
        enemy.disableBody(true, true);
        (enemy.getData('eye') as Image).setVisible(false).setActive(false);
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
