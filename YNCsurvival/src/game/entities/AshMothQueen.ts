import { DEPTH, MOTH } from '../config';
import { Boss, BossContext } from './Boss';

type Mode = 'chase' | 'telegraph' | 'dash';

//  중간 보스 2: 재의 나방 여왕 (후원 전용)
//  - 날개에서 재 가루를 흩뿌려 등불의 빛 범위를 잠시 좁힌다
//  - 주기적으로 등불을 향해 일직선으로 돌진 (돌진 경로를 먼저 회색으로 예고)
//  - 후원 금액이 높을수록 체력과 피해량 증가, 처치 시 일반 몬스터 30마리 분량의 불씨를 쏟아냄
export class AshMothQueen extends Boss
{
    readonly kind = 'moth';
    readonly donation: number;
    private mode: Mode = 'chase';
    private modeUntil = 0;
    private dashAngle = 0;
    private nextAshAt: number;
    private nextDashAt: number;
    private ash: Phaser.GameObjects.Particles.ParticleEmitter;

    constructor (ctx: BossContext, x: number, y: number, now: number, donation: number, donor?: string)
    {
        const hpMult = Math.min(MOTH.hpMultMax, 1 + donation * MOTH.hpPerWon);
        super(ctx, x, y, 'moth', Math.round(MOTH.hp * hpMult));

        const damageMult = Math.min(MOTH.damageMultMax, 1 + donation * MOTH.damagePerWon);
        this.donation = donation;
        this.contactDamage = Math.round(MOTH.contactDamage * damageMult);
        this.body!.setSize(80, 50);
        this.nextAshAt = now + 3000;
        this.nextDashAt = now + MOTH.dashIntervalMs;

        const who = donor ? `${donor}님 ` : '';
        this.showLabel(`재의 나방 여왕\n${who}후원 ${donation.toLocaleString()}원`);

        //  날갯짓
        this.scene.tweens.add({ targets: this, scaleY: 0.82, duration: 160, yoyo: true, repeat: -1 });

        this.ash = this.scene.add.particles(0, 0, 'ash', {
            speed: { min: 40, max: 180 },
            lifespan: { min: 900, max: 1600 },
            alpha: { start: 0.9, end: 0 },
            scale: { start: 1.4, end: 0.4 },
            emitting: false
        }).setDepth(DEPTH.projectile);
    }

    update (now: number)
    {
        switch (this.mode)
        {
            case 'chase':
                this.chase(MOTH.speed);
                if (now >= this.nextAshAt)
                {
                    this.scatterAsh(now);
                }
                if (now >= this.nextDashAt)
                {
                    this.startTelegraph(now);
                }
                break;

            case 'telegraph':
                this.setVelocity(0, 0);
                if (now >= this.modeUntil)
                {
                    this.mode = 'dash';
                    this.modeUntil = now + MOTH.dashMs;
                    this.scene.physics.velocityFromRotation(this.dashAngle, MOTH.dashSpeed, this.body!.velocity);
                }
                break;

            case 'dash':
                if (now >= this.modeUntil)
                {
                    this.mode = 'chase';
                    this.nextDashAt = now + MOTH.dashIntervalMs;
                }
                break;
        }

        this.drawHpBar();
    }

    private scatterAsh (now: number)
    {
        this.nextAshAt = now + MOTH.ashIntervalMs;
        this.ctx.lighting.applyAsh(MOTH.ashLightFactor, MOTH.ashMs);
        this.ash.explode(50, this.x, this.y);
        this.ash.explode(30, this.ctx.player.x, this.ctx.player.y);
    }

    //  돌진 경로 예고 (피해 없는 경고 표시) 후 그 방향으로 돌진
    private startTelegraph (now: number)
    {
        const { player, hazards } = this.ctx;
        this.dashAngle = Phaser.Math.Angle.Between(this.x, this.y, player.x, player.y);
        this.mode = 'telegraph';
        this.modeUntil = now + MOTH.dashTelegraphMs;

        hazards.addArea({
            shape: 'rect', x: this.x, y: this.y, angle: this.dashAngle,
            length: MOTH.dashSpeed * (MOTH.dashMs / 1000), width: 70,
            telegraphMs: MOTH.dashTelegraphMs, damage: 0, color: 0xc8c2d0
        });
    }

    destroy (fromScene?: boolean)
    {
        this.ash?.destroy();
        super.destroy(fromScene);
    }
}
