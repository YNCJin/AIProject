import { FINAL_BOSS, MID_BOSS } from '../config';
import { Boss, BossContext } from '../entities/Boss';
import { FinalBoss } from '../entities/FinalBoss';
import { MidBoss } from '../entities/MidBoss';
import { Player } from '../entities/Player';
import { pointAroundPlayer } from '../utils/spawn';

type Sprite = Phaser.Physics.Arcade.Sprite;

export interface BossHandlers
{
    onHitPlayer: (damage: number) => void;
    onBossSpawned: (boss: Boss) => void;
    onBossKilled: (boss: Boss) => void;
}

//  보스 생성(자동 주기 / 수동 호출) / 갱신 / 보스 탄환 관리
//  후원 전용 중간 보스, 시청자 이벤트 소환도 spawnMidBoss() / spawnFinalBoss() 를 호출하면 된다
export class BossManager
{
    readonly group: Phaser.Physics.Arcade.Group;
    private bullets: Phaser.Physics.Arcade.Group;
    private nextMidSpawnAt = MID_BOSS.spawnIntervalMs;
    private finalAutoSpawned = false;
    private now = 0;
    private ctx: BossContext;

    constructor (scene: Phaser.Scene, private player: Player, private handlers: BossHandlers)
    {
        this.group = scene.physics.add.group();
        this.bullets = scene.physics.add.group({ maxSize: 200 });

        this.ctx = {
            scene,
            player,
            fireBullet: (x, y, angle) => this.fireBullet(x, y, angle),
            hitPlayer: (damage) => handlers.onHitPlayer(damage)
        };

        scene.physics.add.overlap(player, this.bullets, (_player, bullet) => {
            const b = bullet as Sprite;
            if (b.active)
            {
                b.disableBody(true, true);
                handlers.onHitPlayer(b.getData('damage') as number);
            }
        });
    }

    //  now: 게임 경과 시간(ms)
    update (now: number)
    {
        this.now = now;

        //  자동 등장: 중간 보스는 최종 보스 등장 시간 전까지만 (10:00 에 둘이 겹치지 않게)
        if (now >= this.nextMidSpawnAt && now < FINAL_BOSS.spawnAtMs)
        {
            this.spawnMidBoss();
        }
        while (now >= this.nextMidSpawnAt)
        {
            this.nextMidSpawnAt += MID_BOSS.spawnIntervalMs;    //  밀린 주기가 있어도 한 마리만
        }
        if (!this.finalAutoSpawned && now >= FINAL_BOSS.spawnAtMs)
        {
            this.finalAutoSpawned = true;
            this.spawnFinalBoss();
        }

        for (const boss of this.activeBosses())
        {
            boss.update(now);
        }

        this.expireBullets(now);
    }

    //  생성되면 보스를, 최대 수 제한에 걸리면 null 을 돌려준다
    spawnMidBoss (): Boss | null
    {
        const alive = this.activeBosses().filter((b) => b.kind === 'mid').length;
        if (alive >= MID_BOSS.maxAlive)
        {
            return null;
        }

        const { x, y } = pointAroundPlayer(this.ctx.scene, this.player, 60);
        return this.add(new MidBoss(this.ctx, x, y, this.now));
    }

    //  최종 보스는 한 마리만
    spawnFinalBoss (): Boss | null
    {
        if (this.activeBosses().some((b) => b.kind === 'final'))
        {
            return null;
        }

        const { x, y } = pointAroundPlayer(this.ctx.scene, this.player, 100);
        return this.add(new FinalBoss(this.ctx, x, y, this.now));
    }

    damage (boss: Boss, amount: number)
    {
        if (!boss.active)
        {
            return;
        }

        if (boss.takeDamage(amount))
        {
            this.group.remove(boss, true, true);
            this.handlers.onBossKilled(boss);
        }
    }

    activeBosses (): Boss[]
    {
        return this.group.getChildren().filter((b) => b.active) as Boss[];
    }

    private add (boss: Boss): Boss
    {
        this.group.add(boss);
        this.handlers.onBossSpawned(boss);
        return boss;
    }

    private fireBullet (x: number, y: number, angle: number)
    {
        const bullet = this.bullets.get(x, y, 'bossBullet') as Sprite | null;
        if (!bullet)
        {
            return;
        }

        bullet.enableBody(true, x, y, true, true);
        bullet.setDepth(8);
        bullet.setData('damage', MID_BOSS.bulletDamage);
        bullet.setData('expireAt', this.now + MID_BOSS.bulletLifeMs);
        this.ctx.scene.physics.velocityFromRotation(angle, MID_BOSS.bulletSpeed, bullet.body!.velocity);
    }

    private expireBullets (now: number)
    {
        for (const obj of this.bullets.getChildren())
        {
            const bullet = obj as Sprite;
            if (bullet.active && now >= (bullet.getData('expireAt') as number))
            {
                bullet.disableBody(true, true);
            }
        }
    }
}
